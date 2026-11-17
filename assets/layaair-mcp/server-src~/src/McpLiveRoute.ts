import type { ServerResponse } from "node:http";
import type { McpLiveServer, McpRouteHandler, McpRouteRequest } from "./types";

const MCP_PATH = "/ai/mcp";
const ROUTE_STATE = Symbol.for("com.layaair.agent.mcp-http-route");
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

interface RouteState {
    handle?: McpRouteHandler;
}

export interface McpLiveRoute {
    readonly endpoint: string;
    readonly active: boolean;
    release(): void;
}

export function attachMcpRoute(
    liveServer: McpLiveServer,
    handle: (route: McpLiveRoute, req: McpRouteRequest, res: ServerResponse) => Promise<void>,
): McpLiveRoute {
    const url = new URL(liveServer.url);
    url.hostname = "127.0.0.1";
    const app = liveServer.expressApp;
    const slot = mountRoute(app, MCP_PATH, ROUTE_STATE);
    const route: McpLiveRoute = {
        endpoint: url.origin + MCP_PATH,
        get active() { return slot.handle === dispatch; },
        release() {
            if (route.active) slot.handle = undefined;
        },
    };
    const dispatch: McpRouteHandler = (req, res) => {
        // LiveServer also serves LAN previews. MCP requests stay on the local machine.
        const address = req.socket.remoteAddress;
        if ((address !== "127.0.0.1" && address !== "::ffff:127.0.0.1")
            || req.headers.host !== url.host || req.headers.origin !== undefined) {
            res.writeHead(403).end();
            return;
        }
        if (req.method !== "GET" && req.method !== "POST" && req.method !== "DELETE") {
            res.writeHead(405, { Allow: "GET, POST, DELETE" }).end();
            return;
        }
        void handle(route, req, res);
    };
    slot.handle = dispatch;
    return route;
}

function mountRoute(app: McpLiveServer["expressApp"], path: string, key: symbol): RouteState {
    const slots = app as McpLiveServer["expressApp"] & Record<symbol, RouteState | undefined>;
    if (slots[key]) return slots[key];
    const slot: RouteState = {};
    const dispatch: McpRouteHandler = (req, res) => {
        if (slot.handle) slot.handle(req, res);
        else res.writeHead(503).end();
    };
    app.get(path, dispatch);
    app.post(path, dispatch);
    app.delete(path, dispatch);
    slots[key] = slot;
    return slot;
}

export async function readMcpJson(req: McpRouteRequest): Promise<unknown> {
    if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] ?? "")) return undefined;
    const length = req.headers["content-length"];
    if (length !== undefined && Number(length) > MAX_REQUEST_BYTES) return undefined;

    // IDE 3.4 parses requests on the Express app. IDE 3.3 exposes the raw stream.
    if (req.body !== undefined) return req.body;

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_REQUEST_BYTES) {
            req.resume();
            return undefined;
        }
        chunks.push(bytes);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
