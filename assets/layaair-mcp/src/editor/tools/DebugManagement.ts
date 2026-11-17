import "../McpRegistry";
import { asNumber, asRecord, asString, toolError, toolSuccess, type ToolResult } from "./ToolSupport";

interface ConsoleLogItem {
    rawMessage: string;
    message: string;
    level: number;
    group: string;
    timestamp: number;
    sourceId?: string;
    line?: number;
}

export class DebugManagement {
    private static readonly maxLogs = 1000;
    private static readonly logs: ConsoleLogItem[] = [];
    private static listening = false;

    @IEditor.onLoad
    static onLoad(): void {
        this.installConsoleListener();
    }

    @IEditor.onUnload
    static onUnload(): void {
        this.uninstallConsoleListener();
    }

    @IEditor.mcp.tool("DebugManagement", "Read LayaAir IDE console logs", {
        action: { type: "string", required: true, desc: "getConsoleLog" },
        params: {
            type: "object",
            desc: "Log filters: group, level, keyword, and limit",
            properties: {
                group: { type: "string", desc: "Log group" },
                level: { type: "number", desc: "Log level" },
                keyword: { type: "string", desc: "Message keyword" },
                limit: { type: "number", desc: "Maximum number of recent entries to return" },
            },
        },
    }, { access: "read", actionAccess: { getConsoleLog: "read" } })
    static async execute(action: string, input?: unknown): Promise<ToolResult<unknown>> {
        this.installConsoleListener();
        if (action !== "getConsoleLog") return toolError(`Unknown DebugManagement action: ${action}`);
        const params = asRecord(input);
        const group = typeof params.group === "string" ? params.group : undefined;
        const level = typeof params.level === "number" ? params.level : undefined;
        const keyword = asString(params.keyword);
        const limit = asNumber(params.limit);
        let result = this.logs.filter((item) => (
            (group === undefined || item.group === group)
            && (level === undefined || item.level === level)
            && (!keyword || `${item.message}\n${item.sourceId ?? ""}`.includes(keyword))
        ));
        if (limit > 0 && result.length > limit) result = result.slice(-limit);
        return toolSuccess(result);
    }

    static installConsoleListener(): void {
        if (this.listening) return;
        Editor.onConsoleMessage.add(this.onConsoleMessage, this);
        this.listening = true;
    }

    static uninstallConsoleListener(): void {
        if (!this.listening) return;
        Editor.onConsoleMessage.remove(this.onConsoleMessage, this);
        this.listening = false;
    }

    private static onConsoleMessage(
        message: string,
        level: number,
        group?: string,
        line?: number,
        sourceId?: string,
    ): void {
        if (level === -1) {
            if (group) {
                for (let index = this.logs.length - 1; index >= 0; index -= 1) {
                    if (this.logs[index].group === group) this.logs.splice(index, 1);
                }
            }
            else this.logs.length = 0;
            return;
        }
        this.logs.push({
            rawMessage: message ?? "",
            message: message ?? "",
            level,
            group: group ?? "",
            timestamp: Date.now(),
            sourceId,
            line,
        });
        if (this.logs.length > this.maxLogs) this.logs.splice(0, this.logs.length - this.maxLogs);
    }
}
