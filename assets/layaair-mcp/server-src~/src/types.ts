import type { IncomingMessage, ServerResponse } from "node:http";
import type { IMcpParamSchema, McpServerStatus, McpToolAccess, McpToolPermissionQuery } from "./contracts";

export type McpHandlerCallback = (...args: unknown[]) => unknown;
export type McpHandlerScope = "scene" | "editor" | "package";

export interface McpHandlerDefinition {
    kind: "tool" | "prompt";
    name: string;
    description: string;
    params: Record<string, string | IMcpParamSchema>;
    callback: string | McpHandlerCallback;
    access: McpToolAccess;
    actionAccess?: Readonly<Record<string, McpToolAccess>>;
}

export interface McpHandlerStore {
    readonly handlers: Record<McpHandlerScope, McpHandlerDefinition[]>;
    clearHandlers(scope: McpHandlerScope): void;
    upsertHandler(scope: McpHandlerScope, handler: McpHandlerDefinition): void;
    reload(): void | Promise<void>;
}

export type McpResourceVariables = Record<string, string | string[]>;
export type McpResourceContent = { uri: string; mimeType?: string } & ({ text: string } | { blob: string });
export interface McpResourceResult {
    contents: McpResourceContent[];
    [key: string]: unknown;
}

export interface McpResourceReader {
    read(uri: URL, variables: McpResourceVariables): Promise<McpResourceResult>;
}

export interface McpServerOptions {
    name: string;
    version: string;
    instructions: string;
    resources: McpResourceReader;
    getProductVersion(): Promise<unknown>;
    assertAllowed(query: McpToolPermissionQuery, agentGeneration?: string): Promise<void>;
    identifyAgent(request: McpRouteRequest): string | undefined;
    getAgentGeneration(): string | undefined;
    invokeRemoteHandler(name: string, callbackId: string, args: unknown[]): Promise<unknown>;
}

export type McpRouteRequest = IncomingMessage & { body?: unknown };
export type McpRouteHandler = (request: McpRouteRequest, response: ServerResponse) => void;

export interface McpLiveServer {
    readonly url: string;
    readonly expressApp: {
        get(path: string, handler: McpRouteHandler): unknown;
        post(path: string, handler: McpRouteHandler): unknown;
        delete(path: string, handler: McpRouteHandler): unknown;
    };
}

export interface McpServerInstance extends McpHandlerStore {
    start(liveServer: McpLiveServer): void;
    stop(): Promise<void>;
    dispose(): Promise<void>;
    getStatus(): McpServerStatus;
    replaceEditorHandlers(handlers: McpHandlerDefinition[]): void;
}
