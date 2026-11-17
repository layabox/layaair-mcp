import { getLightingBake, type BakeRequest, type BakeTask, type LightingBakeApi } from "../IdeCapabilities";
import type { IMcpParamSchema } from "../../shared/types";
import {
    asBoolean,
    asRecord,
    asString,
    errorMessage,
    normalizeAssetPath,
    toSerializable,
    toolError,
    toolSuccess,
    type ToolResult,
} from "./ToolSupport";

const BAKE_ACTION_ACCESS = {
    checkBake: "read",
    startBake: "execute",
    getBakeStatus: "read",
    cancelBake: "execute",
} as const;

const SCENE_ACTION_ACCESS = {
    getCurrent: "read",
    open: "execute",
    save: "write",
    saveAs: "write",
    close: "write",
    listComponents: "read",
    getComponentData: "read",
} as const;

const BAKE_PARAMS: Record<string, IMcpParamSchema> = {
    kind: { type: "string", desc: "Required for checkBake/startBake: gi | gi-preview | ibl | reflection-probe | volumetric-gi | all" },
    device: { type: "string", desc: "CPU (default) | CUDA; only gi, volumetric-gi and all" },
    target: { type: "string", desc: "scene3D (default) | bridge3D; only ibl" },
    nodeId: { type: "string", desc: "Required editor node ID for reflection-probe and volumetric-gi" },
    resume: { type: "boolean", desc: "Resume a matching checkpoint; only all, default false" },
    taskId: { type: "string", desc: "Required for cancelBake. For getBakeStatus, omit to query the active IDE task; null means idle." },
};

const OPEN_SCENE_TIMEOUT_MS = 30000;

type SceneNodeSummary = Pick<IEditor.IMyNode, "id" | "name" | "type">;

interface CurrentSceneState {
    sceneId: string;
    assetId: string | null;
    path: string | null;
    worldType: IEditor.WorldType;
    isModified: boolean;
    viewerMode: boolean;
    rootNode2D: SceneNodeSummary | null;
    rootNode3D: SceneNodeSummary | null;
    prefabRootNode: SceneNodeSummary | null;
    selectedNodes: SceneNodeSummary[];
}

export class SceneManagement {
    static register(): void {
        const canBake = getLightingBake() !== undefined;
        const actionAccess = canBake ? { ...SCENE_ACTION_ACCESS, ...BAKE_ACTION_ACCESS } : SCENE_ACTION_ACCESS;
        const description = canBake
            ? "Manage LayaAir scenes, lighting baking tasks and component metadata. Baking uses current scene settings, does not save the scene, and may leave partial output on cancellation or failure. Save explicitly after completion."
            : "Manage LayaAir scenes and inspect component metadata.";
        IEditor.mcp.tool("SceneManagement", description, {
            action: {
                type: "string",
                required: true,
                desc: `${Object.keys(actionAccess).join(" | ")}. For getCurrent, set params.includeState=true to inspect the live scene before editing.`,
            },
            params: {
                type: "object",
                desc: canBake
                    ? "Scene or baking parameters. Poll getBakeStatus with the taskId returned by startBake. cancelBake requests cancellation. The latest 20 completed tasks are retained."
                    : "Scene or component parameters",
                properties: {
                    path: { type: "string", desc: "Scene asset path or UUID" },
                    name: { type: "string", desc: "Component type name" },
                    includeState: {
                        type: "boolean",
                        desc: "For getCurrent, return the live scene ID, assets-relative path, roots and selected nodes. Otherwise getCurrent returns the scene path as a string.",
                    },
                    ...(canBake ? BAKE_PARAMS : {}),
                },
            },
        }, { access: "write", actionAccess })(this, "execute", { value: this.execute });
    }

    static async execute(action: string, input?: unknown): Promise<ToolResult<unknown>> {
        const params = asRecord(input);
        try {
            switch (action) {
                case "checkBake":
                    return toolSuccess(await lightingBake().check(parseBakeRequest(params)));
                case "startBake": {
                    const task = lightingBake().start(parseBakeRequest(params));
                    return toolSuccess(bakeSnapshot(trackBakeTask(task)));
                }
                case "getBakeStatus": {
                    const record = findBakeTask(params.taskId);
                    return toolSuccess(record ? bakeSnapshot(record) : null);
                }
                case "cancelBake": {
                    if (typeof params.taskId !== "string" || !params.taskId.trim()) {
                        return toolError("taskId is required to cancel a baking task");
                    }
                    const record = findBakeTask(params.taskId);
                    if (!record) return toolError("Baking task not found");
                    void record.task.cancel().catch((error: unknown) => {
                        record.cancelError = bakeDiagnostic(error);
                    });
                    return toolSuccess(bakeSnapshot(record));
                }
                case "getCurrent":
                    return this.getCurrent(asBoolean(params.includeState));
                case "open":
                    return await this.open(asString(params.path));
                case "save":
                    return await this.save(asString(params.path));
                case "saveAs":
                    return await this.saveAs(asString(params.path));
                case "close":
                    return await this.close();
                case "listComponents":
                    return toolSuccess(this.listComponents());
                case "getComponentData":
                    return this.getComponentData(asString(params.name));
                default:
                    return toolError(`Unknown SceneManagement action: ${action}`);
            }
        }
        catch (error) {
            return toolError(error);
        }
    }

    private static getCurrent(includeState: boolean): ToolResult<string | CurrentSceneState> {
        const scene = Editor.sceneManager.activeScene;
        if (!scene) return toolError("No scene is currently open");
        if (scene.loading) return toolError("The current scene is still loading");

        const { asset, sceneId } = scene;
        const path = asset?.file ? toProjectPath(asset.file) : null;
        if (!includeState) return toolSuccess(path ?? `Untitled (unsaved scene; no asset path yet). sceneId: ${sceneId}`);

        const { rootNode2D, rootNode3D, prefabRootNode } = scene;
        const selectedNodes: ReadonlyArray<IEditor.IMyNode> = scene.getSelection("node");
        return toolSuccess({
            sceneId,
            assetId: asset?.id ?? null,
            path,
            worldType: scene.worldType ?? null,
            isModified: scene.isModified,
            viewerMode: scene.viewerMode,
            rootNode2D: rootNode2D ? summarizeNode(rootNode2D) : null,
            rootNode3D: rootNode3D ? summarizeNode(rootNode3D) : null,
            prefabRootNode: prefabRootNode ? summarizeNode(prefabRootNode) : null,
            selectedNodes: selectedNodes.map(summarizeNode),
        });
    }

    private static async open(path: string): Promise<ToolResult<boolean>> {
        if (!path) return toolError("Scene path is required");
        const idOrPath = isUuid(path) ? path : normalizeAssetPath(path);
        const asset = await Editor.assetDb.getAsset(idOrPath);
        if (!asset) return toolError(`Scene asset not found: ${path}`);
        if (!isSceneEditorAsset(asset)) return toolError(`Asset is not a scene or prefab: ${path}`);
        if (Editor.scene.asset?.id === asset.id) return toolSuccess(true);

        const activated = await waitForSceneActivation(asset.id, () => Editor.openFile(normalizeAssetPath(asset.file)));
        return activated
            ? toolSuccess(true)
            : toolError(`Timed out opening scene: ${path}`);
    }

    private static async save(idOrPath: string): Promise<ToolResult<boolean>> {
        let scene = idOrPath
            ? Object.values(Editor.sceneManager.getScenes()).find((item) => item.sceneId === idOrPath)
            : Editor.scene;
        if (!scene && idOrPath) {
            const asset = await Editor.assetDb.getAsset(isUuid(idOrPath) ? idOrPath : normalizeAssetPath(idOrPath));
            if (asset) scene = Object.values(Editor.sceneManager.getScenes()).find((item) => item.asset?.id === asset.id);
        }
        if (!scene?.asset) return toolError(`No open scene was found to save: ${idOrPath || "<current>"}`);
        await Editor.sceneManager.saveScene(scene.sceneId);
        return toolSuccess(true);
    }

    private static async saveAs(path: string): Promise<ToolResult<boolean>> {
        if (!Editor.scene.asset) return toolError("No scene is currently open");
        if (!path) return toolError("Save-as path is required");
        await Editor.sceneManager.saveScene(Editor.scene.sceneId, normalizeAssetPath(path));
        return toolSuccess(true);
    }

    private static async close(): Promise<ToolResult<boolean>> {
        if (!Editor.scene.asset) return toolError("No scene is currently open");
        const sceneId = Editor.scene.sceneId;
        if (Editor.scene.isModified) await Editor.sceneManager.saveScene(sceneId);
        await Editor.sceneManager.closeScene(sceneId);
        return toolSuccess(true);
    }

    private static listComponents(): Array<{ name: string; worldType: IEditor.WorldType }> {
        const registry = Editor.typeRegistry;
        const base = registry.types[registry.componentTypeName];
        return base ? registry.getDerivedTypes(base).map((type) => ({ name: type.name, worldType: type.worldType })) : [];
    }

    private static getComponentData(name: string): ToolResult<unknown> {
        const component = Editor.typeRegistry.types[name];
        return component && Editor.typeRegistry.isDerivedOf(name, Editor.typeRegistry.componentTypeName)
            ? toolSuccess(toSerializable(component))
            : toolError(`Component not found: ${name}`);
    }
}

function isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isSceneEditorAsset(asset: IEditor.IAssetInfo): boolean {
    return asset.type === IEditor.AssetType.Scene
        || asset.type === IEditor.AssetType.Prefab
        || asset.type === IEditor.AssetType.GUIPrefab;
}

function waitForSceneActivation(assetId: string, open: () => void): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
        let completed = false;
        const finish = (result: boolean): void => {
            if (completed) return;
            completed = true;
            clearTimeout(timeout);
            Editor.sceneManager.off("scene-activate", onSceneActive);
            resolve(result);
        };
        const onSceneActive = (event: gui.Event): void => {
            const scene = event.data as IEditor.IMyScene | undefined;
            if (scene?.asset?.id === assetId) finish(true);
        };
        const timeout = setTimeout(() => finish(false), OPEN_SCENE_TIMEOUT_MS);
        Editor.sceneManager.on("scene-activate", onSceneActive);
        try {
            open();
        }
        catch (error) {
            clearTimeout(timeout);
            Editor.sceneManager.off("scene-activate", onSceneActive);
            reject(error);
        }
    });
}

function summarizeNode({ id, name, type }: IEditor.IMyNode): SceneNodeSummary {
    return { id, name, type };
}

function toProjectPath(file: string): string {
    const normalized = file.replace(/\\/g, "/");
    const project = Editor.projectPath.replace(/\\/g, "/").replace(/\/$/, "");
    return normalized.startsWith(`${project}/`) ? normalized.slice(project.length + 1) : normalized;
}

interface BakeDiagnostic {
    code: string;
    message: string;
}

interface TrackedBakeTask {
    task: BakeTask;
    result?: unknown;
    error?: BakeDiagnostic;
    cancelError?: BakeDiagnostic;
    settled: boolean;
}

const bakeTasks = new Map<string, TrackedBakeTask>();

function lightingBake(): LightingBakeApi {
    const api = getLightingBake();
    if (!api) throw new Error("BAKE_UNAVAILABLE: Lighting baking API is unavailable in this IDE");
    return api;
}

function parseBakeRequest(params: Record<string, unknown>): BakeRequest {
    const { kind, device, target, nodeId, resume } = params;
    if (device !== undefined && device !== "CPU" && device !== "CUDA") throw new Error("Invalid bake device: expected CPU or CUDA");
    if (target !== undefined && target !== "scene3D" && target !== "bridge3D") throw new Error("Invalid bake target: expected scene3D or bridge3D");
    if (resume !== undefined && typeof resume !== "boolean") throw new Error("resume must be a boolean");
    if (device !== undefined && kind !== "gi" && kind !== "volumetric-gi" && kind !== "all") throw new Error("device is only supported for gi, volumetric-gi and all");
    if (target !== undefined && kind !== "ibl") throw new Error("target is only supported for ibl");
    if (resume !== undefined && kind !== "all") throw new Error("resume is only supported for all");
    if (nodeId !== undefined && kind !== "reflection-probe" && kind !== "volumetric-gi") throw new Error("nodeId is only supported for reflection-probe and volumetric-gi");
    const bakeDevice = device === "CPU" || device === "CUDA" ? device : undefined;
    const bakeTarget = target === "scene3D" || target === "bridge3D" ? target : undefined;
    const bakeResume = typeof resume === "boolean" ? resume : undefined;
    switch (kind) {
        case "gi": return { kind, device: bakeDevice };
        case "gi-preview": return { kind };
        case "ibl": return { kind, target: bakeTarget };
        case "all": return { kind, device: bakeDevice, resume: bakeResume };
        case "reflection-probe":
        case "volumetric-gi":
            if (typeof nodeId !== "string" || !nodeId.trim()) throw new Error("nodeId is required for probe or volume baking");
            return kind === "reflection-probe" ? { kind, nodeId } : { kind, nodeId, device: bakeDevice };
        default: throw new Error("Invalid bake kind: expected gi, gi-preview, ibl, reflection-probe, volumetric-gi or all");
    }
}

function trackBakeTask(task: BakeTask): TrackedBakeTask {
    const existing = bakeTasks.get(task.id);
    if (existing) return existing;
    const record: TrackedBakeTask = { task, settled: false };
    bakeTasks.set(task.id, record);
    void task.result.then(
        (result) => { record.result = result; },
        (error: unknown) => { record.error = bakeDiagnostic(error); },
    ).then(() => {
        record.settled = true;
        const completed = [...bakeTasks.values()].filter((entry) => entry.settled);
        for (const entry of completed.slice(0, Math.max(0, completed.length - 20))) bakeTasks.delete(entry.task.id);
    });
    return record;
}

function findBakeTask(taskId: unknown): TrackedBakeTask | null {
    const api = lightingBake();
    if (taskId !== undefined && (typeof taskId !== "string" || !taskId.trim())) throw new Error("taskId must be a non-empty string");
    if (typeof taskId === "string") {
        const record = bakeTasks.get(taskId);
        if (record) return record;
    }
    const active = api.activeTask;
    if (active && (taskId === undefined || active.id === taskId)) return trackBakeTask(active);
    if (taskId !== undefined) throw new Error(`Baking task not found or expired: ${taskId}`);
    return null;
}

function bakeDiagnostic(error: unknown): BakeDiagnostic {
    const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
    return { code: typeof code === "string" ? code : "BAKE_FAILED", message: errorMessage(error) };
}

function bakeSnapshot(record: TrackedBakeTask): unknown {
    return toSerializable({
        taskId: record.task.id,
        sceneId: record.task.sceneId,
        state: record.task.state,
        progress: record.task.progress,
        settled: record.settled,
        result: record.result,
        error: record.error,
        cancelError: record.cancelError,
    });
}
