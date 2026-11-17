import { randomUUID } from "node:crypto";
import { startPluginScriptInvocation, pollPluginScriptInvocation, clearPluginScriptInvocations } from "./scripts/PluginScriptInvocation";
import type { PluginScriptEditorStart, PluginScriptOperationStatus } from "../shared/contracts";
import {
    type McpEditorCallbackInvocation,
    type McpEditorHandlerSnapshot,
    type McpEditorHandlerSyncResult,
    type McpEditorHandlerSyncRequest,
    type McpToolPermissionQuery,
    type McpToolPermissionResult,
    MCP_SCENE_COMMANDS,
    MCP_EDITOR_SYNC_STATE_KEY,
} from "../shared/contracts";
import { initializeEditorI18n, t, uiText } from "./i18n";
import { editorMcpRegistry as registry } from "./McpRegistry";
import { FrameDebugger } from "./performance/FrameDebugger";
import { apiKnowledge } from "./ApiKnowledge";
import { mcpStatusBar } from "./McpStatusBar";
import { registerApiKnowledgeTools } from "./tools/ApiKnowledgeTools";
import { Profiler } from "./performance/Profiler";
import { SceneManagement } from "./tools/SceneManagement";
import { ThemeManagement } from "./tools/ThemeManagement";

const MCP_EDITOR_SYNC_STATE_SYMBOL = Symbol.for(MCP_EDITOR_SYNC_STATE_KEY);
const syncOwner = Symbol("mcp-editor-module");

interface EditorHandlerSyncState {
    owner?: symbol;
    generation: number;
    requested: boolean;
    running: boolean;
    revision: number;
    snapshotProvider?: () => McpEditorHandlerSnapshot;
}

interface EditorHandlerSyncScope {
    [key: symbol]: EditorHandlerSyncState | undefined;
}

function getEditorHandlerSyncState(): EditorHandlerSyncState {
    const scope = globalThis as typeof globalThis & EditorHandlerSyncScope;
    let state = scope[MCP_EDITOR_SYNC_STATE_SYMBOL];
    if (!state) {
        state = {
            generation: 0,
            requested: false,
            running: false,
            revision: Date.now() * 1000,
        };
        scope[MCP_EDITOR_SYNC_STATE_SYMBOL] = state;
    }
    else if (!Number.isSafeInteger(state.revision) || state.revision < 0) {
        state.revision = Date.now() * 1000;
    }
    return state;
}

const syncState = getEditorHandlerSyncState();

interface AgentContribution {
    generation: string;
    credential: string;
    authorize: (query: McpToolPermissionQuery) => Promise<McpToolPermissionResult>;
    unregister: () => void;
}

let unregisterApiKnowledge: (() => void) | undefined;

let agentContribution: AgentContribution | undefined;

IEditor.standaloneMcp.registerAgent = (credential, registerTools, authorize) => {
    if (!/^[a-f0-9]{64}$/.test(credential)) throw new Error("Invalid Agent MCP credential");
    agentContribution?.unregister();
    agentContribution = undefined;
    const generation = randomUUID();
    const unregister = registry.registerContribution(registerTools);
    agentContribution = { generation, credential, authorize, unregister };
    void StandaloneMcpEditor.refreshHandlers();
    return {
        generation,
        dispose() {
            if (agentContribution?.generation !== generation) return;
            agentContribution = undefined;
            unregister();
        },
    };
};

@IEditor.regClass()
export class StandaloneMcpEditor {
    static reportServiceEndpoint(endpoint: string | null): void {
        if (!mcpStatusBar.setEndpoint(endpoint) && endpoint) {
            console.info(`[LayaAir MCP] ${uiText("serviceStarted")} ${endpoint}`);
        }
    }

    @IEditor.onLoad
    static onLoad(): void {
        initializeEditorI18n();
        mcpStatusBar.start();
        // IDE feature packs finish onLoad before package and project scripts run onLoad.
        SceneManagement.register();
        ThemeManagement.register();
        FrameDebugger.register();
        Profiler.register();
        unregisterApiKnowledge?.();
        unregisterApiKnowledge = registry.registerContribution(registerApiKnowledgeTools);
        apiKnowledge.start();
        registry.setChangeListener(() => this.scheduleHandlerSync());
        syncState.running = false;
        syncState.owner = syncOwner;
        syncState.generation += 1;
        syncState.revision = Math.max(syncState.revision + 1, Date.now() * 1000);
        syncState.snapshotProvider = () => this.getHandlerSnapshot();
        this.scheduleHandlerSync();
    }

    @IEditor.onUnload
    static onUnload(): void {
        mcpStatusBar.stop();
        registry.setChangeListener(undefined);
        apiKnowledge.stop();
        unregisterApiKnowledge?.();
        unregisterApiKnowledge = undefined;
        const contribution = agentContribution;
        agentContribution = undefined;
        contribution?.unregister();
        clearPluginScriptInvocations();
        if (syncState.owner !== syncOwner) return;
        syncState.owner = undefined;
        syncState.generation += 1;
        syncState.running = false;
        syncState.requested = false;
        syncState.snapshotProvider = undefined;
    }

    static startPluginScript(request: PluginScriptEditorStart): PluginScriptOperationStatus {
        return startPluginScriptInvocation(request.operationId, () => registry.invokeCallback(request.invocation));
    }

    static pollPluginScript(operationId: string): PluginScriptOperationStatus {
        return pollPluginScriptInvocation(operationId);
    }

    static invokeCallback(invocation: McpEditorCallbackInvocation): unknown {
        return registry.invokeCallback(invocation);
    }

    static getHandlerSnapshot(): McpEditorHandlerSnapshot {
        const snapshot = registry.getHandlerSnapshot(++syncState.revision);
        if (agentContribution) {
            const { generation, credential } = agentContribution;
            snapshot.agent = { generation, credential };
        }
        return snapshot;
    }

    static requestHandlerSync(request: McpEditorHandlerSyncRequest): boolean {
        if (syncState.owner !== syncOwner) return false;
        const requestId = request?.requestId?.trim();
        if (!requestId) throw new Error(t("mcpEditor.syncRequestIdRequired"));
        const generation = syncState.generation;
        const snapshot = syncState.snapshotProvider?.();
        if (!snapshot) throw new Error(t("mcpEditor.snapshotNotReady"));
        void StandaloneMcpEditor.syncEditorHandlersWhenSceneReady(
            generation,
            { ...snapshot, requestId },
            1,
        ).catch((error: unknown) => {
            if (generation === syncState.generation && syncState.owner === syncOwner) {
                console.debug(t("mcpEditor.confirmationPending"), error);
            }
        });
        return true;
    }

    static async requestToolPermission(query: McpToolPermissionQuery, agentGeneration: string): Promise<McpToolPermissionResult> {
        const contribution = agentContribution;
        if (!contribution || contribution.generation !== agentGeneration) {
            return { ...query, decision: "deny", reason: "ui-unavailable" };
        }
        const result = await contribution.authorize(query);
        return agentContribution === contribution ? result : { ...query, decision: "deny", reason: "ui-unavailable" };
    }

    static refreshHandlers(): void {
        this.scheduleHandlerSync();
    }

    private static scheduleHandlerSync(): void {
        if (syncState.owner !== syncOwner) return;
        syncState.requested = true;
        if (syncState.running) return;
        void this.drainHandlerSync(syncState.generation);
    }

    private static async drainHandlerSync(generation: number): Promise<void> {
        syncState.running = true;
        try {
            while (generation === syncState.generation && syncState.requested) {
                syncState.requested = false;
                const snapshot = syncState.snapshotProvider?.();
                if (!snapshot) return;
                try {
                    await this.syncEditorHandlersWhenSceneReady(generation, snapshot);
                }
                catch (error) {
                    if (generation === syncState.generation && syncState.owner === syncOwner) {
                        console.warn(t("mcpEditor.syncFailed"), error);
                    }
                    return;
                }
            }
        }
        finally {
            if (generation === syncState.generation) {
                syncState.running = false;
                if (syncState.requested) {
                    void this.drainHandlerSync(generation);
                }
            }
        }
    }

    private static async syncEditorHandlersWhenSceneReady(
        generation: number,
        snapshot: McpEditorHandlerSnapshot,
        maxAttempts = 20,
    ): Promise<void> {
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            if (generation !== syncState.generation) {
                throw new Error(t("mcpEditor.lifecycleReplaced"));
            }
            try {
                const result = await withTimeout(
                    Editor.sceneManager.runSceneScript(
                        MCP_SCENE_COMMANDS.syncEditorHandlers,
                        snapshot,
                    ),
                    1000,
                    t("mcpEditor.syncTimeout"),
                );
                if (!isHandlerSyncResult(result, snapshot.revision)) {
                    throw new Error(t("mcpEditor.snapshotNotConfirmed"));
                }
                return;
            }
            catch (error) {
                if (generation !== syncState.generation || attempt === maxAttempts) {
                    throw error;
                }
                await new Promise<void>((resolve) => setTimeout(resolve, 100));
            }
        }
    }
}

function isHandlerSyncResult(
    value: unknown,
    revision: number,
): value is McpEditorHandlerSyncResult {
    if (!value || typeof value !== "object") return false;
    const result = value as Partial<McpEditorHandlerSyncResult>;
    return result.accepted === true && result.revision === revision;
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
        operation.then(
            (value) => {
                clearTimeout(timeout);
                resolve(value);
            },
            (error: unknown) => {
                clearTimeout(timeout);
                reject(error);
            },
        );
    });
}
