import "../McpRegistry";
import {
    asRecord,
    asString,
    toSerializable,
    toolError,
    toolSuccess,
    type ToolResult,
} from "./ToolSupport";
import { MCP_TOOL_SCENE_COMMANDS } from "../../shared/contracts";

const PROJECT_ACTION_ACCESS = {
    build: "execute",
    getBuildTargets: "read",
    getProjectInfo: "read",
    getEditorVersion: "read",
    getFullInfo: "read",
    getSettings: "read",
    openBuildPanel: "execute",
    showPanel: "execute",
    hidePanel: "execute",
    isPanelShowing: "read",
    getAllPanelIds: "read",
} as const;

const PUBLIC_PROJECT_SETTINGS = new Set([
    "PlayerSettings",
    "EditorSettings",
    "CompilerSettings",
    "BuildSettings",
    "SceneViewSettings",
    "Preferences",
    "DimensionsSettings",
]);

export class ProjectManagement {
    @IEditor.mcp.tool("ProjectManagement", "Query project and IDE information, list registered build targets, build the project, and control IDE panels. Call getProjectInfo before UI coding to read current PlayerSettings modules and addons. Call getBuildTargets before build; registered targets may still require dependency installation.", {
        action: {
            type: "string",
            required: true,
            desc: "build | getBuildTargets | getProjectInfo | getEditorVersion | getFullInfo | getSettings | openBuildPanel | showPanel | hidePanel | isPanelShowing | getAllPanelIds",
        },
        params: {
            type: "object",
            desc: "Action parameters: platform, options, settingsName, and panelId",
            properties: {
                platform: { type: "string", desc: "Exact platform ID returned by getBuildTargets. Query the registered targets before building." },
                options: {
                    type: "object",
                    desc: "Build options",
                    additionalProperties: true,
                    properties: {
                        destPath: { type: "string" },
                        name: { type: "string" },
                        displayName: { type: "string" },
                        version: { type: "string" },
                        useCompressedEngine: { type: "boolean" },
                        minifyJS: { type: "boolean" },
                        sourcemap: { type: "boolean" },
                        sourcesContent: { type: "boolean" },
                        enableVersion: { type: "boolean" },
                        enableSubpackages: { type: "boolean" },
                        copyBinFiles: { type: "boolean" },
                        useSafeFileExtensions: { type: "boolean" },
                        allowTextureCompressedFormat: { type: "boolean" },
                        keepTextureSourceFile: { type: "boolean" },
                        renderDevice: { type: "string" },
                    },
                },
                settingsName: { type: "string", desc: "PlayerSettings | EditorSettings | CompilerSettings | BuildSettings | SceneViewSettings | Preferences | DimensionsSettings" },
                panelId: { type: "string", desc: "IDE panel ID" },
            },
        },
    }, { access: "execute", actionAccess: PROJECT_ACTION_ACCESS })
    static async execute(action: string, input?: unknown): Promise<ToolResult<unknown>> {
        const params = asRecord(input);
        try {
            switch (action) {
                case "getBuildTargets":
                    return this.getBuildTargets();
                case "build":
                    return this.buildResult(await Editor.sceneManager.runSceneScript(
                        MCP_TOOL_SCENE_COMMANDS.buildProject,
                        asString(params.platform),
                        asRecord(params.options),
                    ));
                case "getProjectInfo":
                    return toolSuccess(await this.projectInfo());
                case "getEditorVersion":
                    return toolSuccess(await this.editorVersion());
                case "getFullInfo":
                    return toolSuccess({ project: await this.projectInfo(), editor: await this.editorVersion() });
                case "getSettings": {
                    const settingsName = asString(params.settingsName);
                    if (!PUBLIC_PROJECT_SETTINGS.has(settingsName)) {
                        return toolError(`Reading this settings group is not allowed: ${settingsName || "<empty>"}`);
                    }
                    const settings = Editor.getSettings(settingsName);
                    await settings.sync();
                    return toolSuccess(toSerializable(settings.data));
                }
                case "openBuildPanel":
                    return this.showPanel("BuildSettingsPanel");
                case "showPanel":
                    return this.showPanel(asString(params.panelId));
                case "hidePanel":
                    return this.hidePanel(asString(params.panelId));
                case "isPanelShowing":
                    return toolSuccess(Editor.panelManager?.isPanelShowing(asString(params.panelId)) ?? false);
                case "getAllPanelIds":
                    return toolSuccess(Editor.panelManager?.panelIds ?? []);
                default:
                    return toolError(`Unknown ProjectManagement action: ${action}`);
            }
        }
        catch (error) {
            return toolError(error);
        }
    }

    private static getBuildTargets(): ToolResult<unknown> {
        const panel = Editor.panelManager?.getPanel<IEditor.IBuildSettingsPanel>("BuildSettingsPanel");
        if (!panel || typeof panel.getBuildTargets !== "function") {
            return toolError("The IDE build target registry is unavailable");
        }
        return toolSuccess(Object.entries(panel.getBuildTargets()).map(([platform, target]) => ({
            platform,
            caption: target.caption ?? platform,
            isMiniGame: target.isMiniGame ?? false,
            runningPlatforms: target.runningPlatforms ?? [],
            requireModules: target.requireModules ?? [],
            settingsName: target.settingsName,
        })));
    }

    private static async projectInfo(): Promise<Record<string, unknown>> {
        const settings = Editor.getSettings("PlayerSettings");
        await settings.sync();
        return {
            name: Editor.projectName,
            path: Editor.projectPath,
            type: Editor.projectType,
            assetsPath: Editor.assetsPath,
            appPath: Editor.appPath,
            execPath: process.execPath,
            userDataPath: Editor.userDataPath,
            serverURL: Editor.serverURL,
            isPackaged: Editor.isPackaged,
            cliMode: Editor.cliMode,
            moduleName: Editor.moduleName,
            modules: toSerializable(asRecord(settings.data.modules)),
            addons: toSerializable(asRecord(settings.data.addons)),
        };
    }

    private static async editorVersion(): Promise<Record<string, unknown>> {
        return {
            ideVersion: await Editor.ipc.invoke("GetVersion"),
            packageJson: await Editor.ipc.invoke("GetPackageJson"),
            electronVersion: process.versions.electron ?? "unknown",
            chromeVersion: process.versions.chrome ?? "unknown",
            nodeVersion: process.versions.node ?? "unknown",
            v8Version: process.versions.v8 ?? "unknown",
            platform: process.platform,
            arch: process.arch,
        };
    }

    private static buildResult(value: unknown): ToolResult<unknown> {
        return value === "success" ? toolSuccess(value) : toolError(`Project build did not succeed: ${String(value)}`);
    }

    private static showPanel(panelId: string): ToolResult<boolean> {
        if (!panelId) return toolError("panelId is required");
        if (!Editor.panelManager?.panelIds.includes(panelId)) return toolError(`IDE panel not found: ${panelId}`);
        Editor.panelManager.showPanel(panelId);
        return Editor.panelManager.isPanelShowing(panelId)
            ? toolSuccess(true)
            : toolError(`IDE panel could not be shown: ${panelId}`);
    }

    private static hidePanel(panelId: string): ToolResult<boolean> {
        if (!panelId) return toolError("panelId is required");
        if (!Editor.panelManager?.panelIds.includes(panelId)) return toolError(`IDE panel not found: ${panelId}`);
        Editor.panelManager.hidePanel(panelId);
        return Editor.panelManager.isPanelShowing(panelId)
            ? toolError(`IDE panel could not be hidden: ${panelId}`)
            : toolSuccess(true);
    }
}
