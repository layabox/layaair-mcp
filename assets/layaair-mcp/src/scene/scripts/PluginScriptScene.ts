import type {
    PluginScriptLog, PluginScriptSceneRequest, PluginScriptSceneResult,
    PluginScriptSceneOperation, PluginScriptOperationStatus,
} from "../../shared/contracts";

interface ScriptTask {
    exports: Record<string, unknown>;
    logs: PluginScriptLog[];
    controller: AbortController;
    cleanup: Array<() => unknown>;
    deadline: number;
    cleanupError?: string;
    disposal?: Promise<void>;
    timer?: ReturnType<typeof setTimeout>;
    context: {
        taskId: string;
        signal: AbortSignal;
        onCleanup(callback: () => unknown): void;
    };
}

const tasks = new Map<string, ScriptTask>();
// Retain bounded diagnostics for tasks expired before the Editor dispose RPC arrives.
const finished = new Map<string, ScriptTask>();

@IEditorEnv.regClass()
export class StandaloneMcpPluginScriptScene {
    static dispatch(request: PluginScriptSceneRequest): PluginScriptOperationStatus<PluginScriptSceneResult> {
        if (request.action === "poll") {
            const entry = operations.get(request.operationId);
            if (!entry || entry.taskId !== request.taskId) return { operationId: request.operationId, status: "failed", error: "Scene operation is missing or expired" };
            if (entry.state.status !== "pending") {
                clearTimeout(entry.timer);
                operations.delete(request.operationId);
            }
            return entry.state;
        }
        if (operations.has(request.operationId) || operations.size >= 256) {
            return { operationId: request.operationId, status: "failed", error: "Duplicate or excessive Scene operations" };
        }
        const operationId = request.operationId;
        const entry: SceneOperation = {
            taskId: request.operation.taskId,
            state: { operationId, status: "pending" },
            timer: setTimeout(() => operations.delete(operationId), 135_000),
        };
        operations.set(operationId, entry);
        setTimeout(() => {
            if (operations.get(operationId) !== entry) return;
            void executeOperation(request.operation, operationId).then(
                result => { entry.state = { operationId, status: "completed", result }; },
                error => { entry.state = { operationId, status: "failed", error: printError(error) }; },
            );
        }, 0);
        return entry.state;
    }

    @IEditorEnv.onUnload
    static async onUnload(): Promise<void> {
        await Promise.all([...tasks].map(([id, task]) => disposeTask(id, task)));
        finished.clear();
        for (const entry of operations.values()) clearTimeout(entry.timer);
        operations.clear();
    }
}

interface SceneOperation {
    taskId: string;
    state: PluginScriptOperationStatus<PluginScriptSceneResult>;
    timer: ReturnType<typeof setTimeout>;
}
const operations = new Map<string, SceneOperation>();

async function executeOperation(request: PluginScriptSceneOperation, operationId: string): Promise<PluginScriptSceneResult> {
    const response: PluginScriptSceneResult = { taskId: request.taskId, success: true, logs: [] };
    let task = tasks.get(request.taskId);
    if (request.action === "dispose") task ??= finished.get(request.taskId);
    try {
        if (request.action === "install") {
            if (task || finished.has(request.taskId)) throw new Error("Scene script task already exists");
            if (!Number.isFinite(request.deadline) || request.deadline <= Date.now()
                || request.deadline > Date.now() + 120_000) throw new Error("Scene script task deadline is invalid or expired");
            if (typeof request.code !== "string" || request.code.length > 1_000_000) throw new Error("Invalid Scene script code");
            task = createTask(request.taskId, request.deadline);
            tasks.set(request.taskId, task);
            loadScript(task, request.code);
        }
        else if (request.action === "call") {
            if (!task || task.controller.signal.aborted || task.deadline <= Date.now()) throw new Error("Scene script task is closed");
            const callback = Object.hasOwn(task.exports, request.name) && task.exports[request.name];
            if (typeof callback !== "function") throw new Error(`Scene script does not export a function named ${request.name}`);
            response.value = transferResult(await invokeCancellable(task, () => callback(transferResult(request.args), task.context)));
        }
        else if (request.action === "dispose") {
            if (task) {
                await disposeTask(request.taskId, task);
                finished.delete(request.taskId);
                for (const [id, entry] of operations) {
                    if (id !== operationId && entry.taskId === request.taskId) {
                        clearTimeout(entry.timer);
                        operations.delete(id);
                    }
                }
                if (task.cleanupError) throw new Error(task.cleanupError);
            }
        }
        else throw new Error("Unknown Scene script action");
    }
    catch (error) {
        response.success = false;
        response.error = printError(error);
        if (request.action === "install" && task) await disposeTask(request.taskId, task);
    }
    if (task) response.logs = [...task.logs];
    return response;
}


function createTask(taskId: string, deadline: number): ScriptTask {
    const controller = new AbortController();
    const cleanup: Array<() => unknown> = [];
    const task: ScriptTask = {
        exports: {}, logs: [], controller, cleanup, deadline,
        context: {
            taskId, signal: controller.signal,
            onCleanup(callback: () => unknown) {
                if (controller.signal.aborted) throw new Error("Scene script task is closed");
                if (typeof callback !== "function") throw new Error("Cleanup must be a function");
                cleanup.push(callback);
            },
        },
    };
    task.timer = setTimeout(() => { void disposeTask(taskId, task); }, deadline - Date.now());
    return task;
}

function loadScript(task: ScriptTask, code: string): void {
    const module = { exports: task.exports };
    const localConsole = Object.fromEntries(["log", "info", "warn", "error", "debug"].map((level) =>
        [level, (...values: unknown[]) => appendLog(task, level as PluginScriptLog["level"], values)]));
    new Function("exports", "module", "require", "console", "context", "EditorEnv", "IEditorEnv", "Laya", code)(
        module.exports, module, (id: string) => {
            if (typeof id !== "string" || id.startsWith(".") || id.startsWith("/")) {
                throw new Error("Transient scripts support IDE-provided modules, not relative or absolute imports");
            }
            return IEditorEnv.require(id);
        }, localConsole, task.context, EditorEnv, IEditorEnv, Laya,
    );
    task.exports = module.exports;
}

function disposeTask(id: string, task: ScriptTask): Promise<void> {
    if (task.disposal) return task.disposal;
    if (tasks.get(id) !== task) return Promise.resolve();
    if (task.timer) clearTimeout(task.timer);
    task.controller.abort();
    task.disposal = cleanTask(task).finally(() => {
        tasks.delete(id);
        task.exports = {};
        task.cleanup.length = 0;
        finished.set(id, task);
        if (finished.size > 32) finished.delete(finished.keys().next().value!);
    });
    return task.disposal;
}

async function cleanTask(task: ScriptTask): Promise<void> {
    let timer: ReturnType<typeof setTimeout>;
    try {
        await Promise.race([
            (async () => {
                for (const callback of task.cleanup.reverse()) {
                    try { await callback(); }
                    catch (error) { task.cleanupError = printError(error); appendLog(task, "error", ["Scene cleanup failed:", task.cleanupError]); }
                }
            })(),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("Scene cleanup timed out")), 750);
            }),
        ]);
    }
    catch (error) { task.cleanupError = printError(error); appendLog(task, "error", [task.cleanupError]); }
    finally { clearTimeout(timer!); }
}

function appendLog(task: ScriptTask, level: PluginScriptLog["level"], values: unknown[]): void {
    if (task.logs.length >= 200) return;
    task.logs.push({
        taskId: task.context.taskId, process: "scene", level, timestamp: Date.now(),
        message: values.map((value) => {
            try { return typeof value === "string" ? value : value instanceof Error ? printError(value) : JSON.stringify(value) ?? String(value); }
            catch { return String(value); }
        }).join(" ").slice(0, 2000),
    });
}

function transferResult(value: unknown): unknown {
    if (value === undefined) return null;
    const text = JSON.stringify(value, (_, item: unknown) => {
        if (typeof item === "function" || typeof item === "symbol" || typeof item === "bigint") {
            throw new Error("Script arguments and results must be JSON-serializable");
        }
        return item;
    });
    if (text === undefined || text.length > 1_000_000) throw new Error("Script value exceeds the JSON result limit");
    return JSON.parse(text) as unknown;
}

function printError(error: unknown): string {
    return (error instanceof Error ? error.stack || error.message : String(error)).slice(0, 8000);
}

async function invokeCancellable(task: ScriptTask, callback: () => unknown): Promise<unknown> {
    let onAbort: () => void;
    const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error("Scene script task was cancelled or timed out"));
        task.controller.signal.addEventListener("abort", onAbort, { once: true });
        if (task.controller.signal.aborted) onAbort();
    });
    try { return await Promise.race([Promise.resolve().then(callback), cancelled]); }
    finally { task.controller.signal.removeEventListener("abort", onAbort!); }
}
