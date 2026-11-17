import type { IMcpParamSchema, McpToolAccess, McpToolPermissionQuery } from "../server-src~/src/contracts";
export type { IMcpParamSchema, McpToolAccess, McpToolPermissionQuery };

export interface IMcpToolOptions {
    /**
     * Declares the strongest side effect performed by this tool.
     *
     * Tools that omit this declaration are treated as `write` by the built-in
     * LayaAir MCP so an unclassified tool cannot bypass Scene-side permission checks.
     */
    access?: McpToolAccess;

    /**
     * Optional access declaration for action-dispatch tools. The callback's
     * `action` argument is matched against this map before the fallback
     * `access` value is used.
     */
    actionAccess?: Readonly<Record<string, McpToolAccess>>;
}

export interface IMcpPlugin {
    /**
        * Decorator function for registering a MCP tool.
        * @param name The name of the tool. The name is used to identify the tool.
        * @param params The parameters of the tool. The key is t`he name of the parameter. The value can be a string or an IMcpParamSchema. If it is a string, it should represent the description of the parameter.
        * @returns The tool decorator function.
        */
    tool(
        name: string,
        params?: Record<string, string | IMcpParamSchema>,
        options?: IMcpToolOptions,
    ): MethodDecorator;
    /**
     * Decorator function for registering a MCP tool.
     * @param name The name of the tool. The name is used to identify the tool.
     * @param desc The description of the tool.
     * @param params The parameters of the tool. The key is the name of the parameter. The value can be a string or an IMcpParamSchema. If it is a string, it should represent the description of the parameter.
     * @returns The tool decorator function.
     */
    tool(
        name: string,
        desc: string,
        params?: Record<string, string | IMcpParamSchema>,
        options?: IMcpToolOptions,
    ): MethodDecorator;

    /**
     * Decorator function for registering a MCP prompt.
     * @param name The name of the prompt. The name is used to identify the prompt. 
     * @param params The parameters of the prompt. The key is the name of the parameter. The value can be a string or an IMcpParamSchema. If it is a string, it should represent the description of the parameter.
     * @returns The prompt decorator function.
     */
    prompt(name: string, params: Record<string, string | IMcpParamSchema>): MethodDecorator;

    /**
     * Decorator function for registering a MCP prompt.
     * @param name The name of the prompt. The name is used to identify the prompt. 
     * @param desc The description of the prompt.
     * @param params The parameters of the prompt. The key is the name of the parameter. The value can be a string or an IMcpParamSchema. If it is a string, it should represent the description of the parameter.
     * @returns The prompt decorator function.
     */
    prompt(name: string, desc: string, params?: Record<string, string | IMcpParamSchema>): MethodDecorator;
}

/** @internal */
export interface IMcpServer {
    reload(): void | Promise<void>;
}

export interface McpToolPermissionResult extends McpToolPermissionQuery {
    decision: "allow" | "deny";
    reason?: "user-allowed" | "user-denied" | "ui-unavailable" | "host-error" | "auto-authorized" | "timeout";
}

export type RegisterMcpContribution = (
    credential: string,
    registerTools: (registrar: IMcpPlugin) => void,
    authorize: (query: McpToolPermissionQuery) => Promise<McpToolPermissionResult>,
) => { generation: string; dispose(): void };

declare global {
    namespace IEditor {
        var standaloneMcp: IMcpPlugin & { registerAgent?: RegisterMcpContribution };
        var mcp: IMcpPlugin;
    }

    namespace IEditorEnv {
        var standaloneMcp: IMcpPlugin & { server: IMcpServer };
        var mcp: IMcpPlugin & { server: IMcpServer };
    }
}
