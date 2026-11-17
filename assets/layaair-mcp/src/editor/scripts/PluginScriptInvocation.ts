import type { PluginScriptOperationStatus } from "../../shared/contracts";

interface Invocation {
    state: PluginScriptOperationStatus;
    timer: ReturnType<typeof setTimeout>;
}
const invocations = new Map<string, Invocation>();

/** Submit only. The actual callback runs after the incoming RPC has returned. */
export function startPluginScriptInvocation(operationId: string, callback: () => unknown): PluginScriptOperationStatus {
    if (invocations.has(operationId)) throw new Error("Plugin script operation already exists");
    if (!operationId || invocations.size >= 128) throw new Error("Invalid or excessive plugin script operations");
    const entry: Invocation = {
        state: { operationId, status: "pending" },
        timer: setTimeout(() => invocations.delete(operationId), 135_000),
    };
    invocations.set(operationId, entry);
    setTimeout(() => {
        if (invocations.get(operationId) !== entry) return;
        void Promise.resolve().then(callback).then(
            result => { entry.state = { operationId, status: "completed", result }; },
            error => { entry.state = { operationId, status: "failed", error: error instanceof Error ? error.message : String(error) }; },
        );
    }, 0);
    return entry.state;
}

export function pollPluginScriptInvocation(operationId: string): PluginScriptOperationStatus {
    const entry = invocations.get(operationId);
    if (!entry) return { operationId, status: "failed", error: "Plugin script operation is missing or expired" };
    if (entry.state.status !== "pending") {
        clearTimeout(entry.timer);
        invocations.delete(operationId);
    }
    return entry.state;
}

export function clearPluginScriptInvocations(): void {
    for (const entry of invocations.values()) clearTimeout(entry.timer);
    invocations.clear();
}
