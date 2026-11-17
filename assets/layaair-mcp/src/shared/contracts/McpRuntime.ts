import type { McpServerStatus } from "../../../server-src~/src/contracts";
import type { IMcpParamSchema, McpToolAccess } from "../types";

export type { McpServerStatus };

export const MCP_EDITOR_COMMANDS = {
    getHandlerSnapshot: "StandaloneMcpEditor.getHandlerSnapshot",
    startPluginScript: "StandaloneMcpEditor.startPluginScript",
    pollPluginScript: "StandaloneMcpEditor.pollPluginScript",
    invokeCallback: "StandaloneMcpEditor.invokeCallback",
    requestToolPermission: "StandaloneMcpEditor.requestToolPermission",
    dispatchHandlerSync: "StandaloneMcpEditor.requestHandlerSync",
    reportServiceEndpoint: "StandaloneMcpEditor.reportServiceEndpoint",
} as const;

export const MCP_EDITOR_SYNC_STATE_KEY = "com.layaair.mcp.mcp-editor-sync-state";

export const MCP_SCENE_COMMANDS = {
    syncEditorHandlers: "StandaloneMcpScene.syncEditorHandlers",
    getServerStatus: "StandaloneMcpScene.getServerStatus",
    serviceSettings: "StandaloneMcpScene.serviceSettings",
} as const;

export interface McpServiceSettings {
    autoStart: boolean;
}

export type McpServiceCommand =
    | { action: "read" | "start" | "stop" }
    | { action: "save"; settings: McpServiceSettings };

export interface McpServiceState {
    status: McpServerStatus;
    settings: McpServiceSettings;
    error?: string;
}

/** Editor-to-Scene commands used by built-in LayaAir MCP tools. */
export const MCP_TOOL_SCENE_COMMANDS = {
    pluginScript: "StandaloneMcpPluginScriptScene.dispatch",
    buildProject: "StandaloneMcpBuildHelper.buildAndWait",
    waitAssetManager: "StandaloneMcpPrefabScene.waitAssetMgrBusy",
    flushAssetDatabase: "StandaloneMcpAssetScene.flushAssetDatabase",
    unpackModel: "StandaloneMcpAssetScene.unpackModel",
    validateHierarchy: "StandaloneMcpDocumentValidation.validate",
    bindAnimators: "StandaloneMcpAnimatorScene.bindAnimators",
    addAnimatorComponent: "StandaloneMcpAnimatorScene.addAnimatorComponent",
    unpackPrefab: "unpackPrefab",
    unpackPrefabCompletely: "unpackPrefabCompletely",
    applyPrefabChanges: "StandaloneMcpPrefabScene.applyChangesToPrefab",
    restorePrefab: "StandaloneMcpPrefabScene.restorePrefab",
} as const;

/** Read-only hierarchy validation through the Scene process's IDE validator. */
export interface McpHierarchyValidationRequest {
    document: unknown;
    extension: ".ls" | ".lh";
}

/** Only serializable diagnostics cross the Editor/Scene boundary. */
export interface McpHierarchyValidationResult {
    errors: string[];
}

export type McpCapabilityKind = "tool" | "prompt";

/** Serializable Editor-to-Scene MCP registration data. */
export interface McpEditorHandlerSnapshotItem {
    kind: McpCapabilityKind;
    name: string;
    description: string;
    params: Record<string, string | IMcpParamSchema>;
    callbackId: string;
    access: McpToolAccess;
    actionAccess?: Record<string, McpToolAccess>;
}

/** Versioned snapshot transferred from the Editor process to the Scene process. */
export interface McpEditorHandlerSnapshot {
    version: 2;
    revision: number;
    requestId?: string;
    handlers: McpEditorHandlerSnapshotItem[];
    agent?: { generation: string; credential: string };
}

/** Scene acknowledgement proving that an Editor handler snapshot was applied. */
export interface McpEditorHandlerSyncResult {
    accepted: true;
    revision: number;
}

/** Scene request asking Editor to push a fresh handler snapshot asynchronously. */
export interface McpEditorHandlerSyncRequest {
    requestId: string;
}

/** Serializable Scene-to-Editor callback invocation. */
export interface McpEditorCallbackInvocation {
    callbackId: string;
    args: unknown[];
}

/** One trusted, transient plugin execution, potentially spanning both IDE processes. */
export interface PluginScriptRequest {
    editorCode?: string;
    sceneCode?: string;
    args?: unknown;
    timeoutMs?: number;
}

export interface PluginScriptLog {
    taskId: string;
    process: "editor" | "scene";
    level: "log" | "info" | "warn" | "error" | "debug";
    message: string;
    timestamp: number;
}

export interface PluginScriptResult {
    taskId: string;
    value?: unknown;
    logs: PluginScriptLog[];
    error?: string;
}

/** Commands are internal, reached only after MCP execute authorization. */
export type PluginScriptSceneOperation =
    | { action: "install"; taskId: string; code: string; deadline: number }
    | { action: "call"; taskId: string; name: string; args?: unknown }
    | { action: "dispose"; taskId: string };

export interface PluginScriptSceneResult {
    taskId: string;
    success: boolean;
    value?: unknown;
    logs: PluginScriptLog[];
    error?: string;
}

/** Short RPC envelopes: handlers must never wait for script completion. */
export type PluginScriptOperationStatus<T = unknown> =
    | { operationId: string; status: "pending" }
    | { operationId: string; status: "completed"; result: T }
    | { operationId: string; status: "failed"; error: string };

export interface PluginScriptEditorStart {
    operationId: string;
    invocation: McpEditorCallbackInvocation;
}

export type PluginScriptSceneRequest =
    | { action: "start"; operationId: string; operation: PluginScriptSceneOperation }
    | { action: "poll"; operationId: string; taskId: string };
