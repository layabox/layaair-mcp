import "../McpRegistry";
import type { PluginScriptResult } from "../../shared/contracts";
import type { ToolResult } from "../tools/ToolSupport";
import { executePluginScript } from "./PluginScriptRuntime";

const PREVIEW_INSPECTION_EXAMPLE = `export async function main() {
    if (!Editor.sceneManager.playing) throw new Error("Start the IDE preview with RuntimeManagement.play first");
    const view = Editor.sceneManager.gameView;
    if (!view?.element) throw new Error("No IDE preview webview is available");
    return await view.element.executeJavaScript(\`(() => {
        if (typeof Laya === "undefined" || !Laya.stage) throw new Error("Laya runtime is not ready");
        return { width: Laya.stage.width, height: Laya.stage.height, children: Laya.stage.numChildren };
    })()\`);
}`;

export class PluginScriptTool {
    @IEditor.mcp.tool("ExecutePluginScript", [
        "Execute trusted temporary TypeScript using the public IDE plugin APIs. Provide editorCode and/or sceneCode.",
        "For live hierarchy edits, use Editor.sceneManager.activeScene (IEditor.IMyScene) in editorCode. If you need an example, call LayaAir_GetIdeGuide with topic=scene-editing. For creating assets from engine objects, use topic=create-asset-util. Reuse signatures already in context and look up only missing details.",
        "Each module exports async main(args, context); with both modules, Editor main orchestrates Scene exports through await context.scene.call(name, args). Editor has Editor and IEditor. In Scene, use IEditorEnv.CreateAssetUtil to create or serialize assets, EditorEnv.assetMgr to look up and synchronize assets, and Laya for engine objects.",
        "For built-in game preview inspection, first use RuntimeManagement for screenshots, mouse/keyboard input, and runtime logs. When you need runtime objects, model/resource loading state, or project-specific method calls, provide inline editorCode that awaits Editor.sceneManager.gameView.element.executeJavaScript(javaScriptSource).",
        "Only javaScriptSource runs in the Preview process and can access its Laya.stage and game objects; the outer editorCode runs in Editor. sceneCode and context.scene.call target the authoring Scene process, not the game Preview.",
        "Check that the IDE preview is running and its game objects are ready. The injected source must be plain JavaScript (no TypeScript syntax, Node.js, Editor, or EditorEnv APIs); await asynchronous checks and return a small JSON snapshot rather than engine objects.",
        "Send the inspection source inline in this MCP call; do not create temporary script files, use Shell/Python runners, process.mainModule, or scan Electron webContents to locate the preview. If this path is unavailable or fails, report the actual error before choosing a fallback.",
        "Use JSON arguments/results and IDs for assets/nodes. console.log/info/warn/error/debug are captured for Editor/Scene code; use RuntimeManagement.getConsoleLogs for Preview logs. context provides taskId, signal and onCleanup(callback).",
        "Both modules receive syntax checks before loading (not full type checking); injected Preview JavaScript is not compiled by this tool. Imports resolve IDE-provided modules only.",
        "This is full plugin execution, not a sandbox; timeout cannot stop synchronous code or roll back changes. Await operations and register cleanup for listeners/resources.",
    ].join(" "), {
        editorCode: {
            type: "string",
            desc: `Editor TypeScript module (max 256000 characters), exporting main(args, context). Preview inspection example:\n\`\`\`ts\n${PREVIEW_INSPECTION_EXAMPLE}\n\`\`\``,
        },
        sceneCode: {
            type: "string",
            desc: "Authoring Scene TypeScript module (max 256000 characters). Use IEditorEnv.CreateAssetUtil to create or serialize assets, and EditorEnv.assetMgr to look them up or flush changes. Use runtimeName exactly when an API lookup returns it. Export functions callable by Editor, or export main for a Scene-only task. To inspect the running game, use editorCode and gameView.element.executeJavaScript.",
        },
        args: { type: "object", additionalProperties: true, desc: "JSON input passed to main" },
        timeoutMs: { type: "int", desc: "Cooperative execution timeout, 100-120000 milliseconds; default 30000" },
    }, { access: "execute" })
    static async execute(editorCode?: string, sceneCode?: string, args?: unknown, timeoutMs?: number): Promise<ToolResult<PluginScriptResult>> {
        const data = await executePluginScript({ editorCode, sceneCode, args, timeoutMs });
        return { success: !data.error, data, ...(data.error ? { error: data.error } : {}) };
    }
}
