import { getFrameDebugger } from "../IdeCapabilities";
import { asRecord, toolError, toolSuccess, type ToolResult } from "../tools/ToolSupport";

export class FrameDebugger {
    static register(): void {
        if (!getFrameDebugger()) return;
        IEditor.mcp.tool("FrameDebugger", "Capture the next WebGL frame as Spector.js JSON, including commands and initial/final render state. Requires a Laya WebGL scene. Only one capture can run at a time; requests are not queued.", {
            action: { type: "string", required: true, desc: "captureFrame" },
            params: {
                type: "object",
                properties: {
                    targetSceneView: { type: "boolean", desc: "true captures the editor scene view without play mode; false (default) requires a running scene" },
                    resolution: { type: "string", desc: "none | low | high. Defaults to none to omit screenshot payloads while retaining frame data." },
                },
            },
        }, { access: "execute", actionAccess: { captureFrame: "execute" } })(this, "execute", { value: this.execute });
    }

    static async execute(action: string, input?: unknown): Promise<ToolResult<unknown>> {
        try {
            if (action !== "captureFrame") return toolError(`Unknown FrameDebugger action: ${action}`);
            const debuggerApi = getFrameDebugger();
            if (!debuggerApi) return toolError("FRAME_DEBUGGER_UNAVAILABLE: The IDE framedebugger feature-pack is not loaded");
            const params = asRecord(input);
            const targetSceneView = params.targetSceneView ?? false;
            const resolution = params.resolution ?? "none";
            if (typeof targetSceneView !== "boolean") return toolError("targetSceneView must be a boolean");
            if (resolution !== "none" && resolution !== "low" && resolution !== "high") {
                return toolError("resolution must be none, low, or high");
            }
            return toolSuccess(await debuggerApi.captureFrame({ targetSceneView, resolution }));
        }
        catch (error) {
            // The official API supplies a separate code for capture failures.
            if (error instanceof Error && "code" in error && typeof error.code === "string") {
                return toolError(`${error.code}: ${error.message}`);
            }
            return toolError(error);
        }
    }
}
