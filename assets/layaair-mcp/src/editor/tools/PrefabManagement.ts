import "../McpRegistry";
import fs from "fs";
import path from "path";
import { MCP_TOOL_SCENE_COMMANDS } from "../../shared/contracts";
import {
    asBoolean,
    asRecord,
    asString,
    normalizeAssetPath,
    toolError,
    toolSuccess,
    type ToolResult,
} from "./ToolSupport";

const PREFAB_ACTION_ACCESS = {
    create: "write",
    createPrefab2D: "write",
    createPrefab3D: "write",
    createPrefabUI: "write",
    getPrefabList: "read",
    createFromNode: "write",
    breakPrefabLink: "write",
    applyChanges: "write",
    restorePrefab: "write",
    close: "write",
} as const;

interface PrefabTemplate {
    fileName: string;
    modern: string;
    legacy: string;
    args?: Record<string, string>;
}

const PREFAB_TEMPLATES: Record<string, PrefabTemplate> = {
    Prefab2D: { fileName: "Prefab2D.lh", modern: "scene/Prefab2d.lh", legacy: "Prefab2d.json" },
    Prefab3D: { fileName: "Prefab.lh", modern: "scene/Prefab3d.lh", legacy: "Prefab3d.json" },
    PrefabUI: { fileName: "PrefabUI.lh", modern: "scene/PrefabUI.lh", legacy: "PrefabUI.json", args: { Type: "Box" } },
};

export class PrefabManagement {
    @IEditor.mcp.tool("PrefabManagement", "Create and manage LayaAir prefabs and their instance links. Let the IDE allocate new random IDs; preserve existing serialized IDs when editing. Semantic labels belong in name, not _$id", {
        action: {
            type: "string",
            required: true,
            desc: "create | createPrefab2D | createPrefab3D | createPrefabUI | getPrefabList | createFromNode | breakPrefabLink | applyChanges | restorePrefab | close",
        },
        params: {
            type: "object",
            desc: "Parameters for the selected prefab action",
            properties: {
                name: { type: "string", desc: "Prefab name for create/createPrefab2D/createPrefab3D/createPrefabUI" },
                path: { type: "string", desc: "Save directory, or prefab UUID/path for close" },
                template: { type: "string", desc: "PrefabUI | Prefab2D | Prefab3D" },
                args: { type: "object", additionalProperties: true, desc: "Open-ended arguments for the create template" },
                nodeType: { type: "string", desc: "Root node type for createPrefabUI" },
                keyword: { type: "string", desc: "Search keyword for getPrefabList" },
                nodeId: { type: "string", desc: "Node ID" },
                prefabName: { type: "string", desc: "Prefab file name for createFromNode" },
                deep: { type: "boolean", desc: "Whether breakPrefabLink recursively unpacks nested prefabs" },
            },
        },
    }, { access: "write", actionAccess: PREFAB_ACTION_ACCESS })
    static async execute(action: string, input?: unknown): Promise<ToolResult<unknown>> {
        const params = asRecord(input);
        const targetPath = asString(params.path);
        try {
            switch (action) {
                case "create":
                    return await this.create(asString(params.name), targetPath, asString(params.template), asRecord(params.args));
                case "createPrefab2D":
                    return await this.create(asString(params.name), targetPath, "Prefab2D", {});
                case "createPrefab3D":
                    return await this.create(asString(params.name), targetPath, "Prefab3D", {});
                case "createPrefabUI":
                    return await this.create(asString(params.name), targetPath, "PrefabUI", {
                        Type: asString(params.nodeType, "Box"),
                    });
                case "getPrefabList":
                    return await this.getPrefabList(asString(params.keyword));
                case "createFromNode":
                    return await this.createFromNode(asString(params.nodeId), targetPath, asString(params.prefabName));
                case "breakPrefabLink": {
                    const nodeId = asString(params.nodeId);
                    if (!nodeId) return toolError("nodeId is required");
                    const node = await Editor.scene.getNodeAsync(nodeId);
                    if (!node || (node.features & IEditor.NodeFeatures.IsTopPrefab) === 0) {
                        return toolError(`Node is not a valid prefab root: ${nodeId}`);
                    }
                    await Editor.scene.runScript(
                        asBoolean(params.deep)
                            ? MCP_TOOL_SCENE_COMMANDS.unpackPrefabCompletely
                            : MCP_TOOL_SCENE_COMMANDS.unpackPrefab,
                        nodeId,
                    );
                    const updatedNode = await Editor.scene.getNodeAsync(nodeId);
                    if (!updatedNode || await Editor.scene.getPrefabId(updatedNode)) {
                        return toolError(`Prefab link was not removed: ${nodeId}`);
                    }
                    return toolSuccess(true);
                }
                case "applyChanges":
                    return this.sceneBooleanResult(
                        await Editor.scene.runScript(MCP_TOOL_SCENE_COMMANDS.applyPrefabChanges, asString(params.nodeId)),
                        "Failed to apply prefab changes",
                    );
                case "restorePrefab":
                    return this.sceneBooleanResult(
                        await Editor.scene.runScript(MCP_TOOL_SCENE_COMMANDS.restorePrefab, asString(params.nodeId)),
                        "Failed to restore prefab",
                    );
                case "close":
                    return await this.close(targetPath);
                default:
                    return toolError(`Unknown PrefabManagement action: ${action}`);
            }
        }
        catch (error) {
            return toolError(error);
        }
    }

    private static async create(
        name: string,
        targetPath: string,
        templateName: string,
        args: Record<string, unknown>,
    ): Promise<ToolResult<unknown>> {
        const template = PREFAB_TEMPLATES[templateName];
        if (!template) return toolError(`Unknown prefab template: ${templateName}`);
        if (!name) return toolError("Prefab name is required");
        const fileName = name.endsWith(".lh") ? name : `${name}.lh`;
        const info = await Editor.assetDb.createFileFromTemplate(
            joinAssetPath(targetPath, fileName),
            chooseTemplate(template),
            { ...template.args, ...toStringRecord(args) },
            false,
        );
        return info
            ? toolSuccess({ ...info, file: toProjectPath(info.file) })
            : toolError(`Failed to create prefab: ${name}`);
    }

    private static async getPrefabList(keyword: string): Promise<ToolResult<unknown>> {
        const assets = await Editor.assetDb.search(keyword, [IEditor.AssetType.Prefab, IEditor.AssetType.GUIPrefab]);
        return toolSuccess(assets.map((asset) => ({
            id: asset.id,
            name: asset.name,
            file: toProjectPath(asset.file),
            type: asset.type,
        })));
    }

    private static async createFromNode(
        nodeId: string,
        targetPath: string,
        prefabName: string,
    ): Promise<ToolResult<unknown>> {
        if (!nodeId) return toolError("nodeId is required");
        const result = await Editor.scene.createPrefab(nodeId, normalizeAssetPath(targetPath), prefabName || undefined);
        if (!result) return toolError(`Failed to create a prefab from the node: ${nodeId}`);
        return toolSuccess({
            asset: {
                id: result.asset.id,
                name: result.asset.name,
                file: toProjectPath(result.asset.file),
            },
            newNodeId: result.newNode.id,
        });
    }

    private static async close(idOrPath: string): Promise<ToolResult<boolean>> {
        const asset = idOrPath ? await Editor.assetDb.getAsset(normalizeIdOrPath(idOrPath)) : Editor.scene.asset;
        if (!asset) return toolError("No prefab was found to close");
        if (!isPrefabAsset(asset)) return toolError("The target is not a prefab; use SceneManagement.close to close a scene");

        const scene = Object.values(Editor.sceneManager.getScenes()).find((item) => item.asset?.id === asset.id);
        if (!scene) return toolError(`Prefab is not currently open: ${idOrPath || asset.file}`);
        if (scene.isModified) await Editor.sceneManager.saveScene(scene.sceneId);
        await Editor.sceneManager.closeScene(scene.sceneId);
        return toolSuccess(true);
    }

    private static sceneBooleanResult(value: unknown, message: string): ToolResult<boolean> {
        return value === true ? toolSuccess(true) : toolError(message);
    }

}

function chooseTemplate(template: PrefabTemplate): string {
    return templateExists(template.modern) ? template.modern : template.legacy;
}

function templateExists(templateName: string): boolean {
    return [
        path.join(Editor.projectPath, "asset-templates", templateName),
        path.join(Editor.unpackedWebRootPath, "template", "asset", templateName),
        templateName,
    ].some((candidate) => fs.existsSync(candidate));
}

function joinAssetPath(parent: string, name: string): string {
    const normalized = normalizeAssetPath(parent);
    return normalized ? path.posix.join(normalized, name) : name;
}

function normalizeIdOrPath(value: string): string {
    return /^[0-9a-f-]{36}$/i.test(value) ? value : normalizeAssetPath(value);
}

function toStringRecord(value: Record<string, unknown>): Record<string, string> {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
}

function toProjectPath(file: string): string {
    const normalized = file.replace(/\\/g, "/");
    const project = Editor.projectPath.replace(/\\/g, "/").replace(/\/$/, "");
    return normalized.startsWith(`${project}/`) ? normalized.slice(project.length + 1) : normalized;
}

function isPrefabAsset(asset: IEditor.IAssetInfo): boolean {
    return asset.type === IEditor.AssetType.Prefab || asset.type === IEditor.AssetType.GUIPrefab;
}
