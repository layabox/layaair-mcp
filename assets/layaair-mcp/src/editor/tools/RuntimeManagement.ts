import "../McpRegistry";
import fs from "fs";
import os from "os";
import path from "path";
import { DebugManagement } from "./DebugManagement";
import {
    asBoolean,
    asNumber,
    asRecord,
    asString,
    asStringArray,
    toolError,
    toolSuccess,
    type ToolResult,
} from "./ToolSupport";

const RUNTIME_ACTION_ACCESS = {
    play: "execute",
    stop: "execute",
    pause: "execute",
    resume: "execute",
    isPlaying: "read",
    screenshot: "write",
    sendMouseEvent: "execute",
    sendKeyEvent: "execute",
    getConsoleLogs: "read",
    getViewportInfo: "read",
} as const;

interface ScreenshotPathRequest {
    requestedPath: string;
    allowedRoot: string;
    projectRoot: string;
}

type RuntimePlayer = "editor" | "browser" | "emulator";

export class RuntimeManagement {
    @IEditor.mcp.tool("RuntimeManagement", [
        "Control game preview, capture screenshots, simulate input, and read runtime logs. Prefer this tool with player=editor and playCurrentScene=false to test the full LayaAir project through its configured startup scene. Use playCurrentScene=true only to test the current scene in isolation.",
        "Use screenshots and mouse/keyboard events to verify visible behavior, and getConsoleLogs to inspect runtime errors. For runtime object inspection, model/resource loading state, or project-specific method calls that these actions cannot provide, use ExecutePluginScript with inline editorCode that awaits Editor.sceneManager.gameView.element.executeJavaScript(javaScriptSource). The source runs in the Preview process; sceneCode targets the authoring Scene process instead. See ExecutePluginScript's editorCode example for readiness checks and JSON results; no temporary script file or Shell/Python runner is needed.",
        "Use an external browser only when explicitly requested, for browser-specific testing, or when IDE preview is unavailable; explain the reason before falling back.",
    ].join(" "), {
        action: {
            type: "string",
            required: true,
            desc: "play | stop | pause | resume | isPlaying | screenshot | sendMouseEvent | sendKeyEvent | getConsoleLogs | getViewportInfo",
        },
        params: {
            type: "object",
            desc: "Preview, screenshot, mouse, keyboard, or log parameters",
            properties: {
                playCurrentScene: { type: "boolean", desc: "Defaults to false: run the full project through its configured startup scene. Explicitly pass false for full-project testing. Set true only to run the current scene in isolation, bypassing the configured startup scene and its initialization" },
                player: { type: "string", desc: "editor | browser | emulator. Defaults to editor; prefer the IDE preview for game testing, screenshots, input simulation, and runtime logs. Use browser only when explicitly requested, for browser-specific testing, or when IDE preview is unavailable. Browser/emulator can only be launched and cannot subsequently be paused or stopped by the IDE" },
                timeout: { type: "number", desc: "Timeout while waiting for preview to start, in milliseconds" },
                outputPath: { type: "string", desc: "Optional absolute output path. Defaults to local/laya-ai/screenshots/ in the current project; project screenshots return a project-relative path for links." },
                mouseType: { type: "string", desc: "mouseDown | mouseUp | mouseMove | click" },
                x: { type: "number", desc: "Mouse X coordinate" },
                y: { type: "number", desc: "Mouse Y coordinate" },
                button: { type: "string", desc: "left | right | middle" },
                clickCount: { type: "number", desc: "Mouse click count" },
                keyType: { type: "string", desc: "keyDown | keyUp | char" },
                keyCode: { type: "string", desc: "Keyboard key identifier" },
                modifiers: { type: "array", items: { type: "string" }, desc: "shift/control/alt/meta modifier keys" },
                group: { type: "string", desc: "Console log group" },
                filter: {
                    type: "object",
                    desc: "Console log filters",
                    properties: {
                        level: { type: "number", desc: "Log level" },
                        group: { type: "string", desc: "Log group" },
                    },
                },
                limit: { type: "number", desc: "Maximum number of recent log entries to return" },
            },
        },
    }, { access: "execute", actionAccess: RUNTIME_ACTION_ACCESS })
    static async execute(action: string, input?: unknown): Promise<ToolResult<unknown>> {
        const params = asRecord(input);
        try {
            switch (action) {
                case "play":
                    return await this.play(
                        asBoolean(params.playCurrentScene, false),
                        asString(params.player, "editor"),
                        asNumber(params.timeout, 10000),
                    );
                case "stop":
                    return await this.stop();
                case "pause":
                    if (!Editor.sceneManager.playing) return toolError("No scene is currently running; call play first");
                    SceneEditor.playControls.pause();
                    return toolSuccess(true);
                case "resume":
                    if (!Editor.sceneManager.playing) return toolError("No scene is currently running; call play first");
                    SceneEditor.playControls.resume();
                    return toolSuccess(true);
                case "isPlaying":
                    return toolSuccess(Editor.sceneManager.playing);
                case "screenshot":
                    return await this.screenshot(asString(params.outputPath));
                case "sendMouseEvent":
                    return await this.sendMouseEvent(params);
                case "sendKeyEvent":
                    return this.sendKeyEvent(params);
                case "getConsoleLogs": {
                    const filter = asRecord(params.filter);
                    return DebugManagement.execute("getConsoleLog", {
                        group: asString(filter.group, asString(params.group, "Play")),
                        level: filter.level,
                        limit: params.limit,
                    });
                }
                case "getViewportInfo": {
                    const gameView = Editor.sceneManager.gameView;
                    return toolSuccess({
                        viewport: { width: gameView?.width ?? 0, height: gameView?.height ?? 0 },
                        playing: Editor.sceneManager.playing,
                    });
                }
                default:
                    return toolError(`Unknown RuntimeManagement action: ${action}`);
            }
        }
        catch (error) {
            return toolError(error);
        }
    }

    private static async play(
        playCurrentScene: boolean,
        player: string,
        timeout: number,
    ): Promise<ToolResult<boolean>> {
        if (!isRuntimePlayer(player)) return toolError(`Unsupported player: ${player}`);
        if (Editor.sceneManager.playing) return toolSuccess(true);
        if (!SceneEditor.playControls.play(playCurrentScene, player)) return toolError("Failed to start playback");
        if (player !== "editor") return toolSuccess(true);
        return await this.waitForPlaying(true, timeout);
    }

    private static async stop(): Promise<ToolResult<boolean>> {
        if (!Editor.sceneManager.playing) return toolError("No IDE-managed scene is currently running");
        SceneEditor.playControls.stop();
        return await this.waitForPlaying(false, 5000);
    }

    private static async waitForPlaying(expected: boolean, timeout: number): Promise<ToolResult<boolean>> {
        const startedAt = Date.now();
        while (Editor.sceneManager.playing !== expected) {
            if (Date.now() - startedAt > timeout) return toolError("Timed out waiting for the preview state to change");
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
        return toolSuccess(true);
    }

    private static async screenshot(outputPath: string): Promise<ToolResult<unknown>> {
        if (!Editor.sceneManager.playing) return toolError("No scene is currently running; call play first");
        const element = this.gameViewElement();
        if (!element) return toolError("No game view is available for capture");
        const request = await validateScreenshotPath(outputPath);
        const image = await element.capturePage();
        if (image.isEmpty()) return toolError("Screenshot result is empty");
        const file = await prepareScreenshotPath(request);
        await fs.promises.writeFile(file, image.toPNG(), { flag: "wx" });
        const relativePath = path.relative(request.projectRoot, file);
        return toolSuccess({
            path: !relativePath.startsWith("..") && !path.isAbsolute(relativePath)
                ? relativePath.replace(/\\/g, "/") : file,
            ...image.getSize(),
        });
    }

    private static async sendMouseEvent(params: Record<string, unknown>): Promise<ToolResult<boolean>> {
        if (!Editor.sceneManager.playing) return toolError("No scene is currently running; call play first");
        const element = this.gameViewElement();
        if (!element) return toolError("No running game view is available");
        const type = asString(params.mouseType, "click");
        const event = {
            x: asNumber(params.x),
            y: asNumber(params.y),
            button: asString(params.button, "left"),
            clickCount: asNumber(params.clickCount, 1),
        };
        if (type === "click") {
            element.sendInputEvent({ ...event, type: "mouseDown" });
            await new Promise<void>((resolve) => setTimeout(resolve, 50));
            element.sendInputEvent({ ...event, type: "mouseUp" });
        }
        else element.sendInputEvent({ ...event, type });
        return toolSuccess(true);
    }

    private static sendKeyEvent(params: Record<string, unknown>): ToolResult<boolean> {
        if (!Editor.sceneManager.playing) return toolError("No scene is currently running; call play first");
        const element = this.gameViewElement();
        if (!element) return toolError("No running game view is available");
        const keyCode = asString(params.keyCode);
        if (!keyCode) return toolError("keyCode is required");
        element.sendInputEvent({
            type: asString(params.keyType, "keyDown"),
            keyCode,
            modifiers: asStringArray(params.modifiers),
        });
        return toolSuccess(true);
    }

    private static gameViewElement(): IEditor.IWebview["element"] | undefined {
        return Editor.sceneManager.gameView?.element;
    }
}

function isRuntimePlayer(value: string): value is RuntimePlayer {
    return value === "editor" || value === "browser" || value === "emulator";
}

async function validateScreenshotPath(outputPath: string): Promise<ScreenshotPathRequest> {
    const projectRoot = await fs.promises.realpath(path.resolve(Editor.projectPath));
    const temporaryRoot = await fs.promises.realpath(path.resolve(os.tmpdir()));
    const requestedPath = path.resolve(
        outputPath || path.join(projectRoot, "local", "laya-ai", "screenshots", `screenshot-${Date.now()}-${Math.random().toString(36).slice(2)}.png`),
    );
    if (path.extname(requestedPath).toLowerCase() !== ".png") {
        throw new Error("Screenshot output file must use the .png extension");
    }

    const requestedRoot = [
        { resolved: path.resolve(Editor.projectPath), canonical: projectRoot },
        { resolved: path.resolve(os.tmpdir()), canonical: temporaryRoot },
    ].find((root) => (
        isPathInside(root.resolved, requestedPath)
        || isPathInside(root.canonical, requestedPath)
    ));
    if (!requestedRoot) throw new Error("Screenshots can only be saved in the current project or the system temporary directory");

    const parent = path.dirname(requestedPath);
    const existingAncestor = await nearestExistingDirectory(parent);
    const realAncestor = await fs.promises.realpath(existingAncestor);
    const canonicalPath = path.resolve(
        realAncestor,
        path.relative(existingAncestor, requestedPath),
    );
    if (!isPathInside(requestedRoot.canonical, canonicalPath)) {
        throw new Error("Screenshot output directory escapes the allowed root through a symbolic link");
    }

    if (samePath(existingAncestor, parent)) {
        const existingFile = path.join(realAncestor, path.basename(requestedPath));
        if (await pathExists(existingFile)) throw new Error(`Screenshot file already exists; refusing to overwrite it: ${existingFile}`);
    }

    return { requestedPath, allowedRoot: requestedRoot.canonical, projectRoot };
}

async function prepareScreenshotPath(request: ScreenshotPathRequest): Promise<string> {
    const { requestedPath, allowedRoot } = request;
    const parent = path.dirname(requestedPath);
    await fs.promises.mkdir(parent, { recursive: true });
    const realParent = await fs.promises.realpath(parent);
    if (!isPathInside(allowedRoot, realParent)) {
        throw new Error("Screenshot output directory escapes the allowed root through a symbolic link");
    }
    const file = path.join(realParent, path.basename(requestedPath));
    if (await pathExists(file)) throw new Error(`Screenshot file already exists; refusing to overwrite it: ${file}`);
    return file;
}

async function nearestExistingDirectory(start: string): Promise<string> {
    let candidate = start;
    while (!await pathExists(candidate)) {
        const parent = path.dirname(candidate);
        if (parent === candidate) throw new Error(`Screenshot output directory is unavailable: ${start}`);
        candidate = parent;
    }
    const stats = await fs.promises.stat(candidate);
    if (!stats.isDirectory()) throw new Error(`Screenshot output directory is unavailable: ${candidate}`);
    return candidate;
}

async function pathExists(candidate: string): Promise<boolean> {
    try {
        await fs.promises.lstat(candidate);
        return true;
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

function isPathInside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
    return path.relative(left, right) === "";
}
