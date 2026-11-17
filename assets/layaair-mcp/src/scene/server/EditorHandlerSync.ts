import { randomUUID } from "node:crypto";
import {
    MCP_EDITOR_COMMANDS,
    type McpEditorHandlerSnapshot,
    type McpEditorHandlerSyncRequest,
} from "../../shared/contracts";
import type { IMcpParamSchema, McpToolAccess } from "../../shared/types";
import { t } from "../i18n";
import type { McpHandlerDefinition, McpServerInstance } from "../../../server-src~/src/types";

export class EditorHandlerSync {
    private lastEditorSnapshotRevision = -1;
    agent?: McpEditorHandlerSnapshot["agent"];
    private editorSyncRequested = false;
    private editorSyncRequest?: Promise<void>;
    private readonly editorSyncConfirmations = new Map<string, () => void>();
    private disposed = false;

    constructor(private readonly server: McpServerInstance) {}

    dispose(): void {
        this.disposed = true;
        this.editorSyncRequested = false;
        for (const confirm of this.editorSyncConfirmations.values()) confirm();
        this.editorSyncConfirmations.clear();
    }

    requestAfterScriptReload(): void {
        // On a fresh load, Editor publishes its first snapshot once its own scripts are registered.
        if (this.lastEditorSnapshotRevision >= 0) void this.request();
    }

    request(): Promise<void> {
        if (this.disposed) return Promise.resolve();
        this.editorSyncRequested = true;
        if (this.editorSyncRequest) return this.editorSyncRequest;
        const request = this.drainEditorHandlerSyncRequests().finally(() => {
            if (this.editorSyncRequest === request) this.editorSyncRequest = undefined;
            if (this.editorSyncRequested) void this.request();
        });
        this.editorSyncRequest = request;
        return request;
    }

    private async drainEditorHandlerSyncRequests(): Promise<void> {
        while (!this.disposed && this.editorSyncRequested) {
            this.editorSyncRequested = false;
            await this.performEditorHandlerSyncRequest();
        }
    }

    private async performEditorHandlerSyncRequest(): Promise<void> {
        const deadline = Date.now() + 60_000;
        let lastError: unknown;
        do {
            const request: McpEditorHandlerSyncRequest = { requestId: randomUUID() };
            const confirmation = new Promise<void>((resolve) => {
                this.editorSyncConfirmations.set(request.requestId, resolve);
            });
            try {
                const dispatched = await withTimeout(
                    EditorEnv.runUIScript(
                        MCP_EDITOR_COMMANDS.dispatchHandlerSync,
                        request,
                    ),
                    1000,
                    t("editorSync.bridgeTimeout"),
                );
                if (dispatched !== true) throw new Error(t("editorSync.bridgeNotReady"));
                await withTimeout(confirmation, 2000, t("editorSync.snapshotTimeout"));
                return;
            }
            catch (error) {
                lastError = error;
            }
            finally {
                this.editorSyncConfirmations.delete(request.requestId);
            }
            if (Date.now() < deadline) {
                await new Promise<void>((resolve) => setTimeout(resolve, 250));
            }
        } while (!this.disposed && Date.now() < deadline);
        if (!this.disposed) console.warn(t("editorSync.failed"), lastError);
    }

    accept(snapshot: McpEditorHandlerSnapshot): void {
        let revision: number;
        try {
            revision = editorSnapshotRevision(snapshot);
        }
        catch (error) {
            this.agent = undefined;
            this.server.clearHandlers("editor");
            this.server.reload();
            void this.request();
            throw error;
        }
        if (revision <= this.lastEditorSnapshotRevision) {
            if (snapshot.requestId) {
                try {
                    this.validateEditorSnapshot(snapshot);
                    this.confirmEditorHandlerSync(snapshot.requestId);
                } catch {
                    // Ignore malformed stale acknowledgements without disturbing current handlers.
                }
            }
            return;
        }
        let handlers: McpHandlerDefinition[];
        try {
            handlers = this.validateEditorSnapshot(snapshot);
        }
        catch (error) {
            this.agent = undefined;
            this.server.clearHandlers("editor");
            this.server.reload();
            void this.request();
            throw error;
        }
        this.lastEditorSnapshotRevision = revision;
        this.server.replaceEditorHandlers(handlers);
        this.agent = snapshot.agent;
        if (snapshot.requestId) this.confirmEditorHandlerSync(snapshot.requestId);
    }

    private confirmEditorHandlerSync(requestId: string): void {
        const confirmation = this.editorSyncConfirmations.get(requestId);
        if (!confirmation) return;
        this.editorSyncConfirmations.delete(requestId);
        confirmation();
    }

    private validateEditorSnapshot(value: unknown): McpHandlerDefinition[] {
        if (!value || typeof value !== "object") throw new Error(t("editorSnapshot.invalid"));
        const snapshot = value as Partial<McpEditorHandlerSnapshot>;
        if (snapshot.version !== 2
            || !Number.isSafeInteger(snapshot.revision)
            || snapshot.revision < 0
            || (snapshot.requestId !== undefined
                && (typeof snapshot.requestId !== "string" || !snapshot.requestId.trim()))
            || !Array.isArray(snapshot.handlers)) {
            throw new Error(t("editorSnapshot.versionInvalid"));
        }
        if (snapshot.agent !== undefined && (!snapshot.agent
            || typeof snapshot.agent.generation !== "string"
            || !/^[a-f0-9-]{36}$/.test(snapshot.agent.generation)
            || typeof snapshot.agent.credential !== "string"
            || !/^[a-f0-9]{64}$/.test(snapshot.agent.credential))) {
            throw new Error("Invalid Agent MCP registration");
        }
        const handlers: McpHandlerDefinition[] = [];
        for (const value of snapshot.handlers) {
            if (!value || typeof value !== "object") throw new Error(t("editorSnapshot.handlerInvalid"));
            const candidate = value as unknown as Record<string, unknown>;
            if (candidate.kind !== "tool" && candidate.kind !== "prompt") {
                throw new Error(t("editorSnapshot.kindInvalid"));
            }
            if (typeof candidate.name !== "string" || !candidate.name.trim()) {
                throw new Error(t("editorSnapshot.nameMissing"));
            }
            if (typeof candidate.callbackId !== "string" || !candidate.callbackId) {
                throw new Error(t("editorSnapshot.callbackMissing", { name: candidate.name }));
            }
            if (!candidate.params || typeof candidate.params !== "object" || Array.isArray(candidate.params)) {
                throw new Error(t("editorSnapshot.paramsInvalid", { name: candidate.name }));
            }
            if (!isMcpToolAccess(candidate.access)) {
                throw new Error(t("editorSnapshot.accessInvalid", { name: candidate.name }));
            }
            const actionAccess = parseActionAccess(candidate.actionAccess, candidate.name);
            handlers.push({
                kind: candidate.kind,
                name: candidate.name,
                description: typeof candidate.description === "string" ? candidate.description : "",
                params: candidate.params as Record<string, string | IMcpParamSchema>,
                callback: candidate.callbackId,
                access: candidate.kind === "prompt" ? "read" : candidate.access,
                actionAccess: candidate.kind === "prompt" ? undefined : actionAccess,
            });
        }
        return handlers;
    }

}

function editorSnapshotRevision(value: unknown): number {
    if (!value || typeof value !== "object") throw new Error(t("editorSnapshot.invalid"));
    const revision = (value as Partial<McpEditorHandlerSnapshot>).revision;
    if (!Number.isSafeInteger(revision) || (revision ?? -1) < 0) {
        throw new Error(t("editorSnapshot.revisionInvalid"));
    }
    return revision as number;
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

function isMcpToolAccess(value: unknown): value is McpToolAccess {
    return value === "read" || value === "write" || value === "delete" || value === "execute";
}

function parseActionAccess(
    value: unknown,
    toolName: unknown,
): Record<string, McpToolAccess> | undefined {
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(t("editorSnapshot.actionAccessInvalid", { name: String(toolName) }));
    }

    const result: Record<string, McpToolAccess> = {};
    for (const [action, access] of Object.entries(value)) {
        if (!action || !isMcpToolAccess(access)) {
            throw new Error(t("editorSnapshot.actionAccessTypeInvalid", { name: String(toolName) }));
        }
        result[action] = access;
    }
    return result;
}
