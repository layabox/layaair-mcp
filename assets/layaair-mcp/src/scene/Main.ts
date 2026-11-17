import { timingSafeEqual } from "node:crypto";
import {
    MCP_EDITOR_COMMANDS,
    type McpEditorCallbackInvocation,
    type McpEditorHandlerSnapshot,
    type McpEditorHandlerSyncResult,
    type McpToolPermissionQuery,
    type McpToolPermissionResult,
    type McpServerStatus,
    type McpServiceCommand,
    type McpServiceState,
} from "../shared/contracts";
import { McpServiceControl } from "./McpServiceControl";
import { initializeSceneI18n } from "./i18n";
import {
    McpPermissionGate,
    type McpPermissionAuthorizer,
} from "./permission/McpPermissionGate";
import { McpServer } from "../../server-dist/mcp-server.mjs";
import { EditorHandlerSync } from "./server/EditorHandlerSync";
import { invokePluginScript } from "./server/PluginScriptBridge";
import { SERVER_INSTRUCTIONS } from "./server/ServerInstructions";
import manifest from "../../package.json";
import { SceneMcpRegistry } from "./server/SceneMcpRegistry";
import { AssetResourceProvider } from "./scripts/AssetResourceProvider";
import "./scripts/AssetSceneSupport";
import "./scripts/BuildHelper";
import "./scripts/PrefabSceneSupport";
import "./scripts/PluginScriptScene";

const permissionAuthorizer: McpPermissionAuthorizer = {
    authorize(query: McpToolPermissionQuery, agentGeneration: string): Promise<McpToolPermissionResult> {
        return EditorEnv.runUIScript(MCP_EDITOR_COMMANDS.requestToolPermission, query, agentGeneration);
    },
};
const permissionGate = new McpPermissionGate(permissionAuthorizer);
const server = new McpServer({
    name: "LayaAirIDE",
    version: manifest.version,
    instructions: SERVER_INSTRUCTIONS,
    resources: new AssetResourceProvider(),
    getProductVersion: () => EditorEnv.ipc.invoke("GetVersion"),
    assertAllowed: (query, agentGeneration) => permissionGate.assertAllowed(query, agentGeneration),
    getAgentGeneration: () => handlerSync.agent?.generation,
    identifyAgent(request) {
        const agent = handlerSync.agent;
        const supplied = request.headers["x-layaair-agent-mcp"];
        if (!agent || typeof supplied !== "string" || !/^[a-f0-9]{64}$/.test(supplied)) return undefined;
        return timingSafeEqual(Buffer.from(supplied), Buffer.from(agent.credential)) ? agent.generation : undefined;
    },
    invokeRemoteHandler(name, callbackId, args) {
        if (name === "ExecutePluginScript") return invokePluginScript(callbackId, args);
        const invocation: McpEditorCallbackInvocation = { callbackId, args };
        return EditorEnv.runUIScript(MCP_EDITOR_COMMANDS.invokeCallback, invocation);
    },
});
const handlerSync: EditorHandlerSync = new EditorHandlerSync(server);
const registry = new SceneMcpRegistry(server);
const control = new McpServiceControl(server);

@IEditorEnv.regClass()
export class StandaloneMcpScene {
    static getServerStatus(): McpServerStatus {
        return server.getStatus();
    }

    static serviceSettings(command: McpServiceCommand): Promise<McpServiceState> {
        return control.command(command);
    }

    @IEditorEnv.onLoad
    static onLoad(): void {
        initializeSceneI18n();
        control.load();
    }

    @IEditorEnv.onUserScriptsLoad
    static onUserScriptsLoad(): void {
        server.reload();
        handlerSync.requestAfterScriptReload();
    }

    @IEditorEnv.onUnload
    static async onUnload(): Promise<void> {
        // Editor cannot call Scene scripts once the IDE has unregistered them.
        handlerSync.dispose();
        await control.dispose();
        await registry.clearScope("editor");
    }

    @IEditorEnv.onUserScriptsUnload
    static async onUserScriptsUnload(): Promise<void> {
        await registry.clearScope("scene");
        if (EditorEnv.extensionManager.loadingPackages) await registry.clearScope("package");
    }

    static async syncEditorHandlers(
        snapshot: McpEditorHandlerSnapshot,
    ): Promise<McpEditorHandlerSyncResult> {
        handlerSync.accept(snapshot);
        control.reportReady();
        return { accepted: true, revision: snapshot.revision };
    }
}

IEditorEnv.mcp = registry.api;
IEditorEnv.standaloneMcp = registry.api;
