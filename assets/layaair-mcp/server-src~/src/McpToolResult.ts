import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function toCallToolResult(value: unknown): CallToolResult {
    if (isCallToolResult(value)) return value;

    return {
        content: [{ type: "text", text: stringifyToolValue(value) }],
        isError: isFailedBusinessResult(value) || undefined,
    };
}

function stringifyToolValue(value: unknown): string {
    if (typeof value === "string") return value;
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    if (typeof value !== "object") return String(value);

    try {
        return JSON.stringify(value, null, 2);
    }
    catch {
        return String(value);
    }
}

function isFailedBusinessResult(value: unknown): boolean {
    return isRecord(value) && value.success === false;
}

function isCallToolResult(value: unknown): value is CallToolResult {
    if (!isRecord(value) || !Array.isArray(value.content)) return false;
    return value.content.every((item) => isRecord(item) && typeof item.type === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
