import { randomUUID } from "crypto";
import { MCP_EDITOR_COMMANDS, type PluginScriptEditorStart, type PluginScriptOperationStatus } from "../../shared/contracts";

/** Release the Editor RPC queue before waiting for any user code or API call. */
export async function invokePluginScript(callbackId: string, args: unknown[]): Promise<unknown> {
    const operationId = randomUUID();
    const request: PluginScriptEditorStart = { operationId, invocation: { callbackId, args } };
    let state: PluginScriptOperationStatus = await EditorEnv.runUIScript(MCP_EDITOR_COMMANDS.startPluginScript, request);
    const deadline = Date.now() + 130_000;
    while (true) {
        if (!state || state.operationId !== operationId) throw new Error("Invalid Editor script operation response");
        if (state.status === "completed") return state.result;
        if (state.status === "failed") throw new Error(state.error);
        if (state.status !== "pending") throw new Error("Invalid Editor script operation status");
        if (Date.now() >= deadline) throw new Error("Editor script operation timed out");
        await new Promise<void>(resolve => setTimeout(resolve, 20));
        state = await EditorEnv.runUIScript(MCP_EDITOR_COMMANDS.pollPluginScript, operationId);
    }
}
