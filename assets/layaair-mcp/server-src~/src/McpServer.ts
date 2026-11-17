import type { ServerResponse } from "node:http";
import { attachMcpRoute, readMcpJson, type McpLiveRoute } from "./McpLiveRoute";
import { randomUUID } from "crypto";
import type { ZodType } from "zod";
import {
    McpServer as RealMcpServer,
    ResourceTemplate,
    StreamableHTTPServerTransport,
    isInitializeRequest,
    z,
} from "./McpSdk";
import type { RegisteredPrompt, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
    type CallToolResult,
    type GetPromptResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpServerStatus, McpToolAccess } from "./contracts";
import { toZodType } from "./McpParamSchema";
import { toCallToolResult } from "./McpToolResult";
import type {
    McpHandlerCallback,
    McpHandlerDefinition,
    McpHandlerScope,
    McpLiveServer,
    McpRouteRequest,
    McpServerInstance,
    McpServerOptions,
} from "./types";

interface IRegisteredHandlerInfo {
    kind: "tool" | "prompt";
    name: string;
    description: string;
    params: Record<string, ZodType>;
    compareKey: Array<string>;
    callback: string | McpHandlerCallback;
    access: McpToolAccess;
    actionAccess?: Readonly<Record<string, McpToolAccess>>;
    source: McpHandlerScope;
}

interface IServerInfo {
    server: RealMcpServer;
    transport: StreamableHTTPServerTransport;
    tools: Map<string, RegisteredTool>;
    prompts: Map<string, RegisteredPrompt>;
    ready: Promise<void>;
    agentGeneration?: string;
}

export class McpServer implements McpServerInstance {
    readonly handlers: Record<McpHandlerScope, McpHandlerDefinition[]>;
    private route?: McpLiveRoute;
    private editorHandlersReady = false;
    private disposed = false;

    private _servers: Map<string, IServerInfo>;
    private _registeredHandlers: Map<string, IRegisteredHandlerInfo>;

    constructor(private readonly options: McpServerOptions) {
        this._servers = new Map();
        this.handlers = { scene: [], editor: [], package: [] };
        this._registeredHandlers = new Map();
    }

    start(liveServer: McpLiveServer): void {
        if (this.disposed || this.route?.active) return;
        this.route = attachMcpRoute(liveServer, (route, req, res) => this.handleRequest(route, req, res));
    }

    getStatus(): McpServerStatus {
        const endpoint = this.route?.active ? this.route.endpoint : "";
        const handlers = [...this._registeredHandlers.values()];
        return {
            state: !endpoint ? "stopped" : this.editorHandlersReady ? "running" : "starting",
            endpoint,
            agentGeneration: this.editorHandlersReady ? this.options.getAgentGeneration() : undefined,
            // Every session also exposes the built-in product-version tool and greeting prompt.
            toolCount: 1 + handlers.filter((handler) => handler.kind === "tool").length,
            promptCount: 1 + handlers.filter((handler) => handler.kind === "prompt").length,
        };
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        await this.stop();
    }

    async stop(): Promise<void> {
        this.route?.release();
        this.route = undefined;
        const sessions = [...this._servers.values()];
        this._servers.clear();
        await Promise.allSettled(sessions.map(({ server }) => server.close()));
    }

    private async handleRequest(route: McpLiveRoute, req: McpRouteRequest, res: ServerResponse): Promise<void> {
        try {
            if (!this.editorHandlersReady || !route.active) {
                this.sendErrorResponse(res, 503, "LayaAir MCP is starting or reloading");
                return;
            }
            const agentGeneration = this.options.identifyAgent(req);
            if (req.headers["x-layaair-agent-mcp"] !== undefined && !agentGeneration) {
                this.sendErrorResponse(res, 403, "Agent MCP registration is unavailable");
                return;
            }
            const body = req.method === "POST" ? await readMcpJson(req).catch((): undefined => undefined) : undefined;
            if (req.method === "POST" && body === undefined) {
                this.sendErrorResponse(res, 400, "Missing or invalid MCP JSON request");
                return;
            }
            const sessionId = this.getSessionId(req);
            const info = sessionId ? this._servers.get(sessionId) : undefined;
            if (info) {
                if (info.agentGeneration !== agentGeneration) {
                    this.sendErrorResponse(res, 404, "Unknown MCP session");
                    return;
                }
                await info.ready;
                if (route.active && this.editorHandlersReady) await info.transport.handleRequest(req, res, body);
                else this.sendErrorResponse(res, 503, "LayaAir MCP is starting or reloading");
                return;
            }

            if (req.method === "POST" && !sessionId && isInitializeRequest(body)) {
                if (route.active && this.editorHandlersReady) await this.initializeSession(route, req, res, body, agentGeneration);
                else this.sendErrorResponse(res, 503, "LayaAir MCP is starting or reloading");
                return;
            }

            if (req.method === "GET" && !sessionId) {
                res.setHeader("Allow", "POST");
                res.statusCode = 405;
                res.end();
                return;
            }

            this.sendErrorResponse(
                res,
                sessionId ? 404 : 400,
                sessionId ? "Unknown MCP session" : "Missing MCP session or initialize request",
            );
        }
        catch (error) {
            console.error("MCP request failed", error);
            if (!res.headersSent)
                this.sendErrorResponse(res, 500, "Internal MCP server error");
        }
    }

    private async initializeSession(route: McpLiveRoute, req: McpRouteRequest, res: ServerResponse, body: unknown, agentGeneration?: string): Promise<void> {
        let info: IServerInfo;
        let resolveReady = (): void => { };
        const ready = new Promise<void>((resolve) => {
            resolveReady = resolve;
        });
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            onsessioninitialized: (sessionId) => {
                if (route.active) this._servers.set(sessionId, info);
            },
            onsessionclosed: (sessionId) => {
                this._servers.delete(sessionId);
            },
        });
        const { name, version, instructions } = this.options;
        const server = new RealMcpServer({ name, version }, { instructions });
        info = {
            server,
            transport,
            tools: new Map(),
            prompts: new Map(),
            ready,
            agentGeneration,
        };
        transport.onclose = () => {
            const sessionId = transport.sessionId;
            if (sessionId) this._servers.delete(sessionId);
            console.debug("mcp client closed");
        };

        this.setupServer(info);
        try {
            await server.connect(transport);
            if (!route.active || !this.editorHandlersReady) {
                this.sendErrorResponse(res, 503, "LayaAir MCP is starting or reloading");
                resolveReady();
                await server.close();
                return;
            }
            await transport.handleRequest(req, res, body);
            setTimeout(() => {
                try {
                    this.applyHandlersWithoutNotifications(info);
                }
                catch (error) {
                    console.error("MCP handlers initialization failed", error);
                }
                finally {
                    resolveReady();
                }
            }, 0);
        }
        catch (error) {
            resolveReady();
            const sessionId = transport.sessionId;
            if (sessionId) this._servers.delete(sessionId);
            await server.close().catch((): void => { });
            throw error;
        }
    }

    private getSessionId(req: McpRouteRequest): string | undefined {
        const value = req.headers["mcp-session-id"];
        return Array.isArray(value) ? value[0] : value;
    }

    private sendErrorResponse(res: ServerResponse, status: number, message: string): void {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message },
            id: null,
        }));
    }

    private setupServer(info: IServerInfo): void {
        const { server } = info;
        server.registerResource("asset", new ResourceTemplate("res://{uuid}", { list: undefined }), {},
            (uri, variables) => this.options.resources.read(uri, variables));

        // Register built-ins before applying session handlers.
        server.registerTool("get-product-version", { description: "Get product version" }, async () => {
            await this.options.assertAllowed({
                toolName: "get-product-version",
                access: "read",
                source: "scene",
            });
            const version = await this.options.getProductVersion();
            return { content: [{ type: "text", text: "The version is " + version }] };
        });

        server.registerPrompt("greeting", {
            description: "A friendly greeting prompt",
            argsSchema: { name: z.string() },
        }, ({ name }) => {
            return {
                messages: [
                    {
                        role: "assistant",
                        content: {
                            type: "text",
                            text: `Hello, ${name}! Is there anything I can help you with today?`
                        }
                    }
                ]
            };
        });

    }

    reload(): void {
        this.applyHandlers();
    }

    clearHandlers(scope: McpHandlerScope): void {
        if (scope === "editor") this.editorHandlersReady = false;
        this.handlers[scope].length = 0;
    }

    upsertHandler(scope: McpHandlerScope, handler: McpHandlerDefinition): void {
        const handlers = this.handlers[scope];
        const existingIndex = handlers.findIndex((item) => (
            item.kind === handler.kind && item.name === handler.name
        ));
        if (existingIndex >= 0) handlers[existingIndex] = handler;
        else handlers.push(handler);
    }

    replaceEditorHandlers(handlers: McpHandlerDefinition[]): void {
        this.handlers.editor = handlers;
        this.applyHandlers();
        this.editorHandlersReady = true;
    }

    private applyHandlers(): void {
        const allHandlers = this.scopedHandlers();

        for (const { handler: item, scope } of allHandlers) {
            const registrationKey = this.registrationKey(item);
            const compareKey = [
                item.kind,
                item.name,
                item.description,
                item.access,
                JSON.stringify(item.actionAccess ?? {}),
                scope,
            ];
            const params: Record<string, ZodType> = {};

            for (let k in item.params) {
                const v = item.params[k];
                if (typeof v === "string") {
                    compareKey.push(k, v);
                    params[k] = z.string().describe(v);

                }
                else {
                    compareKey.push(k, JSON.stringify(v));
                    params[k] = toZodType(v);
                }
            }

            const oldItem = this._registeredHandlers.get(registrationKey);
            if (!oldItem || !sameKeys(compareKey, oldItem.compareKey)) {
                const newItem: IRegisteredHandlerInfo = {
                    kind: item.kind,
                    name: item.name,
                    compareKey,
                    params,
                    description: item.description,
                    callback: item.callback,
                    access: item.access,
                    actionAccess: item.actionAccess,
                    source: scope,
                };
                this._registeredHandlers.set(registrationKey, newItem);

                if (item.kind === "prompt") {
                    for (const info of this._servers.values()) this.upsertPrompt(info, item.name, newItem);
                }
                else {
                    for (const info of this._servers.values()) this.upsertTool(info, item.name, newItem);
                }
            }
            else {
                oldItem.callback = item.callback;
            }
        }

        const activeKeys = new Set(allHandlers.map(({ handler }) => this.registrationKey(handler)));
        for (const [registrationKey, handler] of this._registeredHandlers) {
            if (!activeKeys.has(registrationKey)) {
                for (const info of this._servers.values()) {
                    if (handler.kind === "prompt") {
                        info.prompts.get(handler.name)?.remove();
                        info.prompts.delete(handler.name);
                    }
                    else {
                        info.tools.get(handler.name)?.remove();
                        info.tools.delete(handler.name);
                    }
                }
                this._registeredHandlers.delete(registrationKey);
            }
        }
    }

    private applyHandlersWithoutNotifications(info: IServerInfo): void {
        const sendToolListChanged = info.server.sendToolListChanged;
        const sendPromptListChanged = info.server.sendPromptListChanged;
        info.server.sendToolListChanged = (): void => { };
        info.server.sendPromptListChanged = (): void => { };
        try {
            this.applyHandlers();
            for (const handler of this._registeredHandlers.values()) {
                if (handler.kind === "prompt") {
                    if (!info.prompts.has(handler.name)) this.upsertPrompt(info, handler.name, handler);
                }
                else if (!info.tools.has(handler.name)) {
                    this.upsertTool(info, handler.name, handler);
                }
            }
        }
        finally {
            info.server.sendToolListChanged = sendToolListChanged;
            info.server.sendPromptListChanged = sendPromptListChanged;
        }
    }

    private scopedHandlers(): Array<{ handler: McpHandlerDefinition; scope: McpHandlerScope }> {
        const activeHandlers = new Map<string, { handler: McpHandlerDefinition; scope: McpHandlerScope }>();
        for (const scope of ["scene", "editor", "package"] as const) {
            for (const handler of this.handlers[scope]) {
                activeHandlers.set(this.registrationKey(handler), { handler, scope });
            }
        }
        return [...activeHandlers.values()];
    }

    private registrationKey(handler: Pick<McpHandlerDefinition, "kind" | "name">): string {
        return `${handler.kind}:${handler.name}`;
    }

    private upsertPrompt(info: IServerInfo, name: string, item: IRegisteredHandlerInfo): void {
        const callback = (args: Record<string, unknown>) => this.promptCallback(item, args);
        const prompt = info.prompts.get(name);
        if (prompt) {
            prompt.update({ description: item.description, argsSchema: item.params, callback });
            return;
        }
        info.prompts.set(name, info.server.registerPrompt(name, {
            description: item.description,
            argsSchema: item.params,
        }, callback));
    }

    private upsertTool(info: IServerInfo, name: string, item: IRegisteredHandlerInfo): void {
        const callback = (args: Record<string, unknown>) => this.toolCallback(item, args, info.agentGeneration);
        const tool = info.tools.get(name);
        if (tool) {
            tool.update({ description: item.description, paramsSchema: item.params, callback });
            return;
        }
        info.tools.set(name, info.server.registerTool(name, {
            description: item.description,
            inputSchema: item.params,
        }, callback));
    }

    private async promptCallback(curItem: IRegisteredHandlerInfo, args: Record<string, unknown>): Promise<GetPromptResult> {
        if (this.disposed) throw new Error("LayaAir MCP is unloading");
        const arrArgs: unknown[] = [];
        for (const k in curItem.params) {
            arrArgs.push(args[k]);
        }
        let ret: unknown;
        if (typeof (curItem.callback) === "string")
            ret = await this.options.invokeRemoteHandler(curItem.name, curItem.callback, arrArgs);
        else
            ret = await curItem.callback(...arrArgs);
        if (ret == null || typeof ret !== "object") {
            return {
                messages: [
                    {
                        role: "assistant",
                        content: {
                            type: "text",
                            text: '' + ret
                        }
                    }
                ]
            };
        }
        else
            return ret as GetPromptResult;
    }

    private async toolCallback(curItem: IRegisteredHandlerInfo, args: Record<string, unknown>, agentGeneration?: string): Promise<CallToolResult> {
        const route = this.route;
        if (!route?.active) throw new Error("MCP service stopped");
        const callback = curItem.callback;
        const action = typeof args.action === "string" ? args.action : undefined;
        await this.options.assertAllowed({
            toolName: action ? `${curItem.name}.${action}` : curItem.name,
            access: action && curItem.actionAccess && Object.hasOwn(curItem.actionAccess, action)
                ? curItem.actionAccess[action] : curItem.access,
            source: curItem.source,
        }, agentGeneration);
        if (!route.active || this.route !== route) throw new Error("MCP service stopped during approval");
        const arrArgs: unknown[] = [];
        for (const k in curItem.params) {
            arrArgs.push(args[k]);
        }
        let ret: unknown;
        if (typeof callback === "string")
            ret = await this.options.invokeRemoteHandler(curItem.name, callback, arrArgs);
        else
            ret = await callback(...arrArgs);
        return toCallToolResult(ret);
    }
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((entry, index) => entry === right[index]);
}
