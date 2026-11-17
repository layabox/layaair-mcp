import "../McpRegistry";
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { MCP_TOOL_SCENE_COMMANDS } from "../../shared/contracts";
import {
    asNumber,
    asRecord,
    asString,
    asStringArray,
    errorMessage,
    toolError,
    toolSuccess,
    validateLayaDocument,
    type ToolResult,
} from "./ToolSupport";

interface JsonPatchOperation {
    op: "add" | "remove" | "replace" | "move" | "copy" | "test";
    path: string;
    value?: unknown;
    from?: string;
}

export class AssetTools {
    @IEditor.mcp.tool(
        "Laya_RefreshAssetDatabase",
        "Apply pending external file changes to the current project's asset database, even when the IDE is in the background. Use after copying files into the project outside the IDE. Waits for the IDE to finish processing the pending changes.",
        {},
        { access: "write" },
    )
    static async refreshAssetDatabase(): Promise<ToolResult<string>> {
        try {
            if (typeof Editor.assetDb.flushChanges === "function") {
                await Editor.assetDb.flushChanges();
            }
            else if (await Editor.scene?.runScript(MCP_TOOL_SCENE_COMMANDS.flushAssetDatabase) !== true) {
                return toolError("The IDE did not confirm the asset database refresh");
            }
            return toolSuccess("Asset database refreshed");
        }
        catch (error) {
            return toolError(error);
        }
    }

    @IEditor.mcp.tool("Laya_EditAsset", "Precisely edit a LayaAir JSON asset using RFC 6902 JSON Patch. For .ls/.lh, allocate new node _$id values as random 8-character strings from 0-9a-z; non-singleton component IDs use 4 characters. Put semantic labels in name. Preserve existing IDs and reference targets in _$ref, _$override, and _$parent, including nested paths", {
        file_path: { type: "string", required: true, desc: "Asset path within the project" },
        ops: {
            type: "array",
            required: true,
            desc: "Array of JSON Patch operations",
            items: {
                type: "object",
                required: ["op", "path"],
                properties: {
                    op: { type: "string", desc: "add | remove | replace | move | copy | test" },
                    path: { type: "string", desc: "JSON Pointer" },
                    value: { type: "string", desc: "Value; JSON supplied as a string is parsed automatically" },
                    from: { type: "string", desc: "Source JSON Pointer for move/copy" },
                },
            },
        },
    }, { access: "delete" })
    static async editAsset(filePath: string, operations: unknown): Promise<ToolResult<unknown>> {
        try {
            const absolutePath = await resolveProjectFile(filePath);
            return await enqueueAssetEdit(async () => {
                const originalContent = await fs.promises.readFile(absolutePath, "utf8");
                const document: unknown = JSON.parse(originalContent);
                const ops = parseOperations(operations);
                for (const operation of ops) applyOperation(document, operation);
                const validationErrors = await validateLayaDocument(document, path.extname(filePath).toLowerCase());
                if (validationErrors.length) return toolError(`Asset validation failed after editing: ${validationErrors.join("; ")}`);
                const content = `${JSON.stringify(document, null, 2)}\n`;
                await writeAssetAtomically(absolutePath, content);
                try {
                    await Editor.assetDb.flushChanges();
                }
                catch (error) {
                    try {
                        await writeAssetAtomically(absolutePath, originalContent);
                        await Editor.assetDb.flushChanges();
                    }
                    catch (rollbackError) {
                        throw new Error(`Asset refresh failed and rollback did not complete: ${errorMessage(error)}; ${errorMessage(rollbackError)}`);
                    }
                    throw new Error(`Asset refresh failed; the original file was restored: ${errorMessage(error)}`);
                }
                return toolSuccess({ message: `Applied ${ops.length} JSON Patch operations`, file_path: filePath });
            });
        }
        catch (error) {
            return toolError(error);
        }
    }

    @IEditor.mcp.tool("Laya_ReadLayaAsset", "Read saved LayaAir scene and prefab JSON. To find a node by name and verify its saved position, use mode=search with search.name and node_properties=[\"transform\"].", {
        file_path: {
            type: "string",
            required: true,
            desc: ".ls/.lh path relative to assets, such as Scene.ls from SceneManagement.getCurrent. Explicit project-relative paths, such as assets/Scene.ls or ./Scene.ls, also work.",
        },
        mode: { type: "string", desc: "auto | overview | node | path | search | children" },
        node_id: { type: "string", desc: "Serialized _$id from the saved .ls/.lh file. To locate a node known by its live IEditor.IMyNode.id, search by node name for its saved _$id." },
        json_path: { type: "string", desc: "JSON Pointer or dot/array path" },
        search: {
            type: "object",
            desc: "Search criteria",
            properties: {
                name: { type: "string" },
                type: { type: "string" },
                prefab: { type: "string" },
                component: { type: "string" },
            },
        },
        depth: { type: "number", desc: "Number of child levels to include in overview, node, or search results" },
        include_component_details: { type: "boolean", desc: "Whether to return component details" },
        skip_bones: { type: "boolean", desc: "Whether to filter out bone nodes" },
        precision: { type: "number", desc: "Number of decimal places for numeric values" },
        pagination: {
            type: "object",
            desc: "Pagination parameters",
            properties: {
                offset: { type: "number" },
                limit: { type: "number" },
            },
        },
        node_properties: {
            type: "array",
            items: { type: "string" },
            desc: "Extra top-level serialized node fields to include in overview, node, search, or children results, such as transform.",
        },
    }, { access: "read" })
    static async readAsset(
        filePath: string,
        mode = "auto",
        nodeId = "",
        jsonPath = "",
        search?: unknown,
        depth = 2,
        includeComponentDetails = false,
        skipBones = true,
        precision = 3,
        pagination?: unknown,
        nodeProperties?: unknown,
    ): Promise<ToolResult<unknown>> {
        try {
            const absolutePath = await resolveProjectFile(filePath, true);
            const document: unknown = JSON.parse(await fs.promises.readFile(absolutePath, "utf8"));
            const nodes = collectNodes(document);
            const effectiveMode = mode === "auto" ? (nodes.length < 50 ? "full" : "overview") : mode;
            const page = asRecord(pagination);
            const offset = Math.max(0, asNumber(page.offset));
            const defaultLimit = effectiveMode === "children" ? 10 : 20;
            const limit = Math.max(1, asNumber(page.limit, defaultLimit));
            const options = {
                depth: Math.max(0, depth), includeComponentDetails, skipBones, precision,
                nodeProperties: asStringArray(nodeProperties),
            };
            switch (effectiveMode) {
                case "full":
                    return toolSuccess(roundNumbers(document, precision));
                case "overview":
                    return toolSuccess({
                        file_info: { path: filePath, node_count: nodes.length },
                        root: summarizeNode(document, options, 0),
                    });
                case "node": {
                    const node = nodes.find((item) => nodeIdentifier(item) === nodeId);
                    return node ? toolSuccess(summarizeNode(node, options, 0)) : savedNodeNotFound(nodeId);
                }
                case "path": {
                    const value = getByFlexiblePath(document, jsonPath);
                    return value.found ? toolSuccess(roundNumbers(value.value, precision)) : toolError(`JSON path not found: ${jsonPath}`);
                }
                case "search": {
                    const criteria = asRecord(search);
                    const matches = nodes.filter((node) => matchesSearch(node, criteria));
                    return toolSuccess({ total: matches.length, offset, limit, items: matches.slice(offset, offset + limit).map((node) => summarizeNode(node, options, 0)) });
                }
                case "children": {
                    const parent = nodeId ? nodes.find((item) => nodeIdentifier(item) === nodeId) : document;
                    if (!parent) return savedNodeNotFound(nodeId);
                    const children = nodeChildren(parent).filter((node) => !skipBones || !isBoneNode(node));
                    return toolSuccess({ total: children.length, offset, limit, items: children.slice(offset, offset + limit).map((node) => summarizeNode(node, { ...options, depth: 0 }, 0)) });
                }
                default:
                    return toolError(`Unknown read mode: ${mode}`);
            }
        }
        catch (error) {
            return toolError(error);
        }
    }

    @IEditor.mcp.tool("Laya_ValidateLayaAsset", "Validate a project .ls scene or .lh prefab with the IDE hierarchy validator. Validation does not verify how IDs were generated; use random 8-character node IDs and 4-character component IDs from 0-9a-z for new elements", {
        file_path: { type: "string", required: true, desc: ".ls/.lh asset path within the project" },
    }, { access: "read" })
    static async validateAsset(filePath: string): Promise<ToolResult<unknown>> {
        try {
            const extension = path.extname(filePath).toLowerCase();
            if (extension !== ".ls" && extension !== ".lh") return toolError("Only .ls scenes and .lh prefabs are supported");
            const absolutePath = await resolveProjectFile(filePath);
            const document: unknown = JSON.parse(await fs.promises.readFile(absolutePath, "utf8"));
            const errors = await validateLayaDocument(document, extension);
            if (errors.length) return toolError(`Invalid asset structure: ${errors.join("; ")}`);
            const nodes = collectNodes(document);
            return toolSuccess({ valid: true, file_path: filePath, node_count: nodes.length });
        }
        catch (error) {
            return toolError(`Asset validation failed: ${errorMessage(error)}`);
        }
    }
}

let assetEditChain: Promise<void> = Promise.resolve();

function enqueueAssetEdit<T>(operation: () => Promise<T>): Promise<T> {
    const result = assetEditChain.then(operation, operation);
    assetEditChain = result.then(
        (): void => { },
        (): void => { },
    );
    return result;
}

async function writeAssetAtomically(filePath: string, content: string): Promise<void> {
    const temporaryPath = path.join(
        path.dirname(filePath),
        `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
        await fs.promises.writeFile(temporaryPath, content, "utf8");
        await fs.promises.rename(temporaryPath, filePath);
    }
    finally {
        await fs.promises.rm(temporaryPath, { force: true }).catch((): void => { });
    }
}

async function resolveProjectFile(filePath: string, preferAssets = false): Promise<string> {
    if (!filePath) throw new Error("file_path is required");
    const projectRoot = await fs.promises.realpath(path.resolve(Editor.projectPath));
    const input = preferAssets ? filePath.replaceAll("\\", "/") : filePath;
    const assetsRelative = preferAssets && !path.isAbsolute(input) && !/^(?:assets|\.{1,2})(?:\/|$)/.test(input);
    const assetsFile = assetsRelative
        ? await fs.promises.realpath(path.resolve(Editor.assetsPath, input)).catch((error: NodeJS.ErrnoException): undefined => {
            if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined;
            throw error;
        })
        : undefined;
    const absolutePath = assetsFile ?? await fs.promises.realpath(path.resolve(projectRoot, input));
    const relative = path.relative(projectRoot, absolutePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Path is outside the project directory: ${filePath}`);
    return absolutePath;
}

function parseOperations(value: unknown): JsonPatchOperation[] {
    if (!Array.isArray(value)) throw new Error("ops must be an array");
    if (value.length === 0) throw new Error("ops must not be empty");
    return value.map((item, index) => {
        const operation = asRecord(item);
        const op = asString(operation.op) as JsonPatchOperation["op"];
        const pointer = asString(operation.path);
        if (!["add", "remove", "replace", "move", "copy", "test"].includes(op) || !pointer.startsWith("/")) {
            throw new Error(`ops[${index}] is not a valid JSON Patch operation`);
        }
        pointerSegments(pointer);
        const requiresValue = op === "add" || op === "replace" || op === "test";
        if (requiresValue && (!hasOwn(operation, "value") || operation.value === undefined)) {
            throw new Error(`ops[${index}].value is required`);
        }
        const from = asString(operation.from);
        if (op === "move" || op === "copy") {
            if (!hasOwn(operation, "from") || !from.startsWith("/")) {
                throw new Error(`ops[${index}].from must be a JSON Pointer`);
            }
            pointerSegments(from);
        }
        return {
            op,
            path: pointer,
            from: from || undefined,
            ...(hasOwn(operation, "value") ? { value: parseJsonLiteral(operation.value) } : {}),
        };
    });
}

function applyOperation(document: unknown, operation: JsonPatchOperation): void {
    if (operation.op === "move" || operation.op === "copy") {
        if (!operation.from) throw new Error(`${operation.op} operation requires from`);
        const source = getPointer(document, operation.from);
        if (!source.found) throw new Error(`Source path not found: ${operation.from}`);
        const value = operation.op === "copy" ? structuredClone(source.value) : source.value;
        if (operation.op === "move") removePointer(document, operation.from);
        setPointer(document, operation.path, value, true);
        return;
    }
    if (operation.op === "remove") {
        removePointer(document, operation.path);
        return;
    }
    if (operation.op === "test") {
        const current = getPointer(document, operation.path);
        if (!current.found || !jsonValuesEqual(current.value, operation.value)) throw new Error(`test failed: ${operation.path}`);
        return;
    }
    setPointer(document, operation.path, operation.value, operation.op === "add");
}

function getPointer(document: unknown, pointer: string): { found: boolean; value?: unknown } {
    let current = document;
    for (const segment of pointerSegments(pointer)) {
        if (Array.isArray(current)) {
            const index = Number(segment);
            if (!Number.isInteger(index) || index < 0 || index >= current.length) return { found: false };
            current = current[index];
        }
        else if (isRecord(current) && hasOwn(current, segment)) current = current[segment];
        else return { found: false };
    }
    return { found: true, value: current };
}

function setPointer(document: unknown, pointer: string, value: unknown, add: boolean): void {
    const { parent, key } = pointerParent(document, pointer);
    if (Array.isArray(parent)) {
        if (key === "-" && add) parent.push(value);
        else {
            const index = Number(key);
            if (!Number.isInteger(index) || index < 0 || index > parent.length) throw new Error(`Invalid array path: ${pointer}`);
            if (add) parent.splice(index, 0, value);
            else if (index < parent.length) parent[index] = value;
            else throw new Error(`Replace path not found: ${pointer}`);
        }
    }
    else if (isRecord(parent)) {
        if (!add && !hasOwn(parent, key)) throw new Error(`Replace path not found: ${pointer}`);
        parent[key] = value;
    }
    else throw new Error(`Target parent path is not a container: ${pointer}`);
}

function removePointer(document: unknown, pointer: string): void {
    const { parent, key } = pointerParent(document, pointer);
    if (Array.isArray(parent)) {
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= parent.length) throw new Error(`Remove path not found: ${pointer}`);
        parent.splice(index, 1);
    }
    else if (isRecord(parent) && hasOwn(parent, key)) delete parent[key];
    else throw new Error(`Remove path not found: ${pointer}`);
}

function pointerParent(document: unknown, pointer: string): { parent: unknown; key: string } {
    const segments = pointerSegments(pointer);
    const key = segments.pop();
    if (key === undefined) throw new Error("The JSON root cannot be modified directly");
    const parentPointer = segments.length ? `/${segments.map(escapePointer).join("/")}` : "";
    const parent = parentPointer ? getPointer(document, parentPointer) : { found: true, value: document };
    if (!parent.found) throw new Error(`Parent path not found: ${pointer}`);
    return { parent: parent.value, key };
}

function pointerSegments(pointer: string): string[] {
    if (pointer === "") return [];
    const encodedSegments = pointer.slice(1).split("/");
    if (encodedSegments.some((segment) => /~(?:[^01]|$)/.test(segment))) {
        throw new Error(`Invalid JSON Pointer escape sequence: ${pointer}`);
    }
    const segments = encodedSegments.map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
    if (segments.some(isUnsafeProperty)) throw new Error(`JSON Pointer contains an unsafe property: ${pointer}`);
    return segments;
}

function escapePointer(value: string): string {
    return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function parseJsonLiteral(value: unknown): unknown {
    if (typeof value !== "string") return value;
    try { return JSON.parse(value); }
    catch { return value; }
}

function collectNodes(document: unknown): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = [];
    const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
            value.forEach(visit);
            return;
        }
        if (!isRecord(value)) return;
        if ("_$type" in value || "_$id" in value || "_$child" in value) result.push(value);
        Object.values(value).forEach(visit);
    };
    visit(document);
    return result;
}

function nodeChildren(node: unknown): Array<Record<string, unknown>> {
    const children = isRecord(node) ? node._$child : undefined;
    return Array.isArray(children) ? children.filter(isRecord) : [];
}

function nodeIdentifier(node: Record<string, unknown>): string {
    return asString(node._$id, asString(node.id));
}

function savedNodeNotFound(nodeId: string): ToolResult<never> {
    return toolError(`Node not found: ${nodeId}. Use the saved _$id or search by node name.`);
}

function summarizeNode(
    node: unknown,
    options: {
        depth: number;
        includeComponentDetails: boolean;
        skipBones: boolean;
        precision: number;
        nodeProperties: string[];
    },
    currentDepth: number,
): unknown {
    if (!isRecord(node)) return roundNumbers(node, options.precision);
    const result: Record<string, unknown> = Object.fromEntries(options.nodeProperties
        .filter((key) => key !== "_$child" && key !== "_$comp" && hasOwn(node, key))
        .map((key) => [key, roundNumbers(node[key], options.precision)]));
    for (const key of ["_$id", "_$type", "name", "_$prefab", "prefab"]) {
        if (key in node) result[key] = node[key];
    }
    const components = Array.isArray(node._$comp) ? node._$comp : [];
    if (components.length) {
        result._$comp = options.includeComponentDetails
            ? roundNumbers(components, options.precision)
            : components.map((component) => isRecord(component) ? component._$type ?? component.type : component);
    }
    if (currentDepth < options.depth) {
        const children = nodeChildren(node).filter((child) => !options.skipBones || !isBoneNode(child));
        if (children.length) result._$child = children.map((child) => summarizeNode(child, options, currentDepth + 1));
    }
    return result;
}

function matchesSearch(node: Record<string, unknown>, criteria: Record<string, unknown>): boolean {
    const name = asString(criteria.name).toLowerCase();
    const type = asString(criteria.type);
    const prefab = asString(criteria.prefab);
    const component = asString(criteria.component);
    if (name && !asString(node.name).toLowerCase().includes(name)) return false;
    if (type && asString(node._$type) !== type) return false;
    if (prefab && asString(node._$prefab, asString(node.prefab)) !== prefab) return false;
    if (component) {
        const components = Array.isArray(node._$comp) ? node._$comp : [];
        if (!components.some((item) => isRecord(item) && asString(item._$type, asString(item.type)).includes(component))) return false;
    }
    return true;
}

function isBoneNode(node: Record<string, unknown>): boolean {
    return /^(mixamorig:|bip|bone)/i.test(asString(node.name));
}

function roundNumbers(value: unknown, precision: number): unknown {
    if (typeof value === "number") return Number(value.toFixed(Math.max(0, precision)));
    if (Array.isArray(value)) return value.map((item) => roundNumbers(item, precision));
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, roundNumbers(item, precision)]));
}

function getByFlexiblePath(document: unknown, expression: string): { found: boolean; value?: unknown } {
    if (expression.startsWith("/")) return getPointer(document, expression);
    const segments = expression.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
    return getPointer(document, segments.length ? `/${segments.map(escapePointer).join("/")}` : "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function isUnsafeProperty(value: string): boolean {
    return value === "__proto__" || value === "prototype" || value === "constructor";
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
    if (left === right) return true;
    if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left)
            && Array.isArray(right)
            && left.length === right.length
            && left.every((item, index) => jsonValuesEqual(item, right[index]));
    }
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
        && leftKeys.every((key) => hasOwn(right, key) && jsonValuesEqual(left[key], right[key]));
}
