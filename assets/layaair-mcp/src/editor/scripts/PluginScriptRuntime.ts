import { randomUUID } from "crypto";
import type * as TypeScript from "typescript";
import {
    MCP_TOOL_SCENE_COMMANDS,
    type PluginScriptLog, type PluginScriptRequest, type PluginScriptResult,
    type PluginScriptSceneOperation, type PluginScriptSceneRequest, type PluginScriptSceneResult, type PluginScriptOperationStatus,
} from "../../shared/contracts";

const MAX_SOURCE = 256_000;
const MAX_RESULT = 1_000_000;

export function compilePluginScript(source: string, fileName: string): string {
    if (typeof source !== "string" || !source.trim() || source.length > MAX_SOURCE) {
        throw new Error(`${fileName}: source must contain 1-${MAX_SOURCE} characters`);
    }
    const ts = IEditor.require("typescript") as typeof TypeScript;
    const result = ts.transpileModule(source, {
        fileName, reportDiagnostics: true,
        compilerOptions: {
            target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
            experimentalDecorators: true, esModuleInterop: true,
        },
    });
    const errors = result.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error) ?? [];
    if (errors.length) throw new Error(`${fileName}: ${errors.map((item) =>
        ts.flattenDiagnosticMessageText(item.messageText, "\n")).join("\n")}`);
    // Parse emitted JavaScript before either process runs any top-level code.
    new Function(result.outputText);
    return `${result.outputText}\n//# sourceURL=plugin-task/${fileName.replace(/\.ts$/, ".js")}`;
}

export async function executePluginScript(request: PluginScriptRequest): Promise<PluginScriptResult> {
    const taskId = randomUUID();
    const logs: PluginScriptLog[] = [];
    const result: PluginScriptResult = { taskId, logs };
    const controller = new AbortController();
    const cleanup: Array<() => unknown> = [];
    const pending: Promise<unknown>[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sceneStarted = false;
    let closed = false;
    const append = (entries: PluginScriptLog[]) => {
        for (const entry of entries) if (logs.length < 200) logs.push(entry);
    };
    const log = (level: PluginScriptLog["level"], values: unknown[]) => append([{
        taskId, process: "editor", level, timestamp: Date.now(),
        message: values.map(printValue).join(" ").slice(0, 2000),
    }]);
    let sceneLogCount = 0;
    const scene = async (command: PluginScriptSceneOperation): Promise<unknown> => {
        const operationId = randomUUID();
        const send = (message: PluginScriptSceneRequest): Promise<PluginScriptOperationStatus<PluginScriptSceneResult>> =>
            Editor.sceneManager.runSceneScript(MCP_TOOL_SCENE_COMMANDS.pluginScript, message);
        let state = await send({ action: "start", operationId, operation: command });
        const deadline = Date.now() + (command.action === "dispose" ? 2500 : 125_000);
        while (true) {
            if (!state || state.operationId !== operationId) throw new Error("Invalid Scene script operation response");
            if (state.status === "failed") throw new Error(state.error);
            if (state.status === "completed") break;
            if (state.status !== "pending") throw new Error("Invalid Scene script operation status");
            if ((closed && command.action !== "dispose") || Date.now() >= deadline) throw new Error("Scene script operation cancelled or timed out");
            await new Promise<void>(resolve => setTimeout(resolve, 20));
            state = await send({ action: "poll", operationId, taskId });
        }
        const response = state.result;
        if (!response || response.taskId !== taskId || typeof response.success !== "boolean"
            || !Array.isArray(response.logs)) throw new Error("Invalid Scene script response");
        // Scene snapshots are cumulative so timed-out calls cannot consume cleanup logs.
        append(response.logs.slice(sceneLogCount));
        sceneLogCount = Math.max(sceneLogCount, response.logs.length);
        if (!response.success) throw new Error(response.error || "Scene script failed");
        return response.value;
    };
    try {
        if (!request.editorCode && !request.sceneCode) throw new Error("editorCode or sceneCode is required");
        const timeout = request.timeoutMs ?? 30_000;
        if (!Number.isInteger(timeout) || timeout < 100 || timeout > 120_000) {
            throw new Error("timeoutMs must be an integer between 100 and 120000");
        }
        const editorCode = request.editorCode ? compilePluginScript(request.editorCode, "editor.ts") : undefined;
        const sceneCode = request.sceneCode ? compilePluginScript(request.sceneCode, "scene.ts") : undefined;
        const args = transferValue(request.args);
        const deadline = Date.now() + timeout;
        const expired = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                closed = true;
                controller.abort();
                reject(new Error("Plugin script timed out; running code and prior changes may continue"));
            }, timeout);
        });
        const context = {
            taskId, signal: controller.signal,
            onCleanup(callback: () => unknown) {
                if (closed) throw new Error("Plugin script task is closed");
                if (typeof callback !== "function") throw new Error("Cleanup must be a function");
                cleanup.push(callback);
            },
            scene: {
                call(name: string, input?: unknown): Promise<unknown> {
                    if (closed || Date.now() >= deadline) return Promise.reject(new Error("Plugin script task is closed"));
                    if (!sceneCode) return Promise.reject(new Error("sceneCode was not provided"));
                    const call = scene({ action: "call", taskId, name, args: transferValue(input) });
                    pending.push(call);
                    // Track forgotten awaits without producing unhandled rejections.
                    void call.catch((): void => { });
                    return call;
                },
            },
        };
        const run = async () => {
            if (sceneCode) {
                sceneStarted = true;
                await scene({ action: "install", taskId, code: sceneCode, deadline });
            }
            if (closed) throw new Error("Plugin script task is closed");
            let value: unknown;
            if (editorCode) {
                const module = { exports: {} as Record<string, unknown> };
                const localConsole = Object.fromEntries(["log", "info", "warn", "error", "debug"].map((level) =>
                    [level, (...values: unknown[]) => log(level as PluginScriptLog["level"], values)]));
                new Function("exports", "module", "require", "console", "context", "Editor", "IEditor", editorCode)(
                    module.exports, module, requireModule, localConsole, context, Editor, IEditor,
                );
                const main = Object.hasOwn(module.exports, "main") && module.exports.main;
                if (typeof main !== "function") throw new Error("editor.ts must export a main(args, context) function");
                value = await main(args, context);
            }
            else value = await context.scene.call("main", args);
            // Include calls started by main even when the script forgot to await them.
            let completed = 0;
            while (completed < pending.length) {
                const batch = pending.slice(completed);
                completed = pending.length;
                await Promise.allSettled(batch);
            }
            return transferValue(value);
        };
        result.value = await Promise.race([run(), expired]);
    }
    catch (error) { result.error = printError(error); }
    finally {
        closed = true;
        controller.abort();
        if (timer) clearTimeout(timer);
        try {
            await boundedCleanup((async () => {
                for (const callback of cleanup.reverse()) {
                    try { await callback(); }
                    catch (error) { log("error", ["Editor cleanup failed:", printError(error)]); result.error ??= "Plugin script cleanup failed"; }
                }
            })());
        }
        catch (error) { log("error", [printError(error)]); result.error ??= "Plugin script cleanup failed"; }
        if (sceneStarted) {
            try { await boundedCleanup(scene({ action: "dispose", taskId }), 3000); }
            catch (error) { log("error", ["Scene cleanup failed:", printError(error)]); result.error ??= "Plugin script cleanup failed"; }
        }
        logs.sort((a, b) => a.timestamp - b.timestamp);
    }
    return { ...result, logs: [...logs] };
}

function requireModule(id: string): unknown {
    if (typeof id !== "string" || id.startsWith(".") || id.startsWith("/")) {
        throw new Error("Transient scripts support IDE-provided modules, not relative or absolute imports");
    }
    return IEditor.require(id);
}

function transferValue(value: unknown): unknown {
    if (value === undefined) return null;
    const text = JSON.stringify(value, (_, item: unknown) => {
        if (typeof item === "function" || typeof item === "symbol" || typeof item === "bigint") {
            throw new Error("Script arguments and results must be JSON-serializable");
        }
        return item;
    });
    if (text === undefined || text.length > MAX_RESULT) throw new Error("Script value exceeds the JSON result limit");
    return JSON.parse(text) as unknown;
}

function printValue(value: unknown): string {
    try { return typeof value === "string" ? value : value instanceof Error ? printError(value) : JSON.stringify(value) ?? String(value); }
    catch { return String(value); }
}

function printError(error: unknown): string {
    return (error instanceof Error ? error.stack || error.message : String(error)).slice(0, 8000);
}

async function boundedCleanup(work: Promise<unknown>, timeoutMs = 1000): Promise<void> {
    let timer: ReturnType<typeof setTimeout>;
    try {
        await Promise.race([work, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Cleanup timed out")), timeoutMs);
        })]);
    }
    finally { clearTimeout(timer!); }
}
