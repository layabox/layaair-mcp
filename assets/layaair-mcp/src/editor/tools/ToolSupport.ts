import path from "path";
import { MCP_TOOL_SCENE_COMMANDS, type McpHierarchyValidationRequest } from "../../shared/contracts";

export interface ToolResult<T> {
    success: boolean;
    data?: T;
    error?: string;
}

export function toolSuccess<T>(data: T): ToolResult<T> {
    return { success: true, data };
}

export function toolError(error: unknown): ToolResult<never> {
    return { success: false, error: errorMessage(error) };
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function asRecord(value: unknown): Record<string, unknown> {
    return isRecord(value) ? value : {};
}

export function asString(value: unknown, fallback = ""): string {
    return typeof value === "string" ? value : fallback;
}

export function asBoolean(value: unknown, fallback = false): boolean {
    return typeof value === "boolean" ? value : fallback;
}

export function asNumber(value: unknown, fallback = 0): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function asStringArray(value: unknown): string[] {
    if (typeof value === "string") return [value];
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string");
}

export function toSerializable(value: unknown, seen = new WeakSet<object>()): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value !== "object") return null;
    if (seen.has(value)) return "[Circular]";
    seen.add(value);

    if (Array.isArray(value)) return value.map((item) => toSerializable(item, seen));

    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
        if (typeof item !== "function") result[key] = toSerializable(item, seen);
    }
    return result;
}

export function normalizeAssetPath(input: string): string {
    let value = input.replace(/\\/g, "/");
    if (path.isAbsolute(value)) value = Editor.assetDb.toRelativePath(value).replace(/\\/g, "/");
    if (value.startsWith("assets/")) value = value.slice(7);
    else if (value === "assets") value = "";
    else if (value === "src" || value.startsWith("src/")) value = `../${value}`;
    return value;
}

export async function validateLayaDocument(document: unknown, extension: string): Promise<string[]> {
    if (extension !== ".ls" && extension !== ".lh") return [];
    const request: McpHierarchyValidationRequest = { document, extension };
    const result: unknown = await Editor.sceneManager.runSceneScript(
        MCP_TOOL_SCENE_COMMANDS.validateHierarchy, request,
    );
    if (!isRecord(result) || !Array.isArray(result.errors)
        || !result.errors.every((error): error is string => typeof error === "string")) {
        throw new Error("Scene hierarchy validation returned an invalid response");
    }
    return result.errors;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
