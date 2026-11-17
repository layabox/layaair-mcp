import "../McpRegistry";
import fs from "fs";
import path from "path";
import { MCP_TOOL_SCENE_COMMANDS } from "../../shared/contracts";
import {
    asBoolean,
    asNumber,
    asRecord,
    asString,
    asStringArray,
    normalizeAssetPath,
    toolError,
    toolSuccess,
    type ToolResult,
} from "./ToolSupport";

interface TemplateConfig {
    fileName: string;
    templateName: string | null;
    modernTemplateName?: string;
    args?: Record<string, string>;
}

const TEMPLATES: Record<string, TemplateConfig> = {
    Scene: { fileName: "Scene.ls", templateName: "Scene.json", modernTemplateName: "scene/Scene.ls" },
    Script: { fileName: "Script.ts", templateName: "LayaScript.ts", modernTemplateName: "script/LayaScript.ts" },
    AnimationScript2D: { fileName: "AnimationScript2D.ts", templateName: "LayaAniScript2D.ts", modernTemplateName: "script/LayaAniScript2D.ts" },
    AnimationScript3D: { fileName: "AnimationScript.ts", templateName: "LayaAniScript.ts", modernTemplateName: "script/LayaAniScript.ts" },
    BlankScript: { fileName: "Script.ts", templateName: null },
    ScriptBundleDefinition: { fileName: "MyModule.bundledef", templateName: "MyModule.bundledef", modernTemplateName: "script/MyModule.bundledef" },
    MaterialBlinnPhong: material("MaterialBlinnphong.json", "material/Blinnphong.lmat", "BLINNPHONG"),
    MaterialUnlit: material("MaterialUnlit.json", "material/Unlit.lmat", "Unlit"),
    MaterialPBR: material("MaterialPBR.json", "material/PBR.lmat", "PBR"),
    MaterialParticle: material("MaterialParticle.json", "material/Particle.lmat", "Particle"),
    MaterialTrail: material("MaterialTrail.json", "material/Trail.lmat", "Trail"),
    MaterialSkyBox: material("MaterialSkyBox.json", "material/SkyBox.lmat", "SkyBox"),
    MaterialSkyPanoramic: material("MaterialSkyPanoramic.json", "material/SkyPanoramic.lmat", "SkyPanoramic"),
    MaterialSkyProcedural: material("MaterialSkyProcedural.json", "material/SkyProcedural.lmat", "SkyProcedural"),
    MaterialTrail2D: material("MaterialTrail2D.json", "material/Trail2D.lmat", "Trail2D"),
    MaterialSprite2DTexture: material("MaterialSpriteTexture.json", "material/SpriteTexture.lmat", "Sprite2DTexture"),
    MaterialBaseRender2D: material("MaterialBaseRender2D.json", "material/BaseRender2D.lmat", "baseRender2D"),
    ShaderUnlit: shader("UnlitShader.shader", "Shader.json", "shader/Unlit.shader"),
    ShaderPBR: shader("PBRShader.shader", "PBRShader.json", "shader/PBR.shader"),
    ShaderBlinnPhong: shader("Blinnphong.shader", "Blinnphong.json", "shader/Blinnphong.shader"),
    ShaderParticle: shader("Particle.shader", "Particle.json", "shader/Particle.shader"),
    ShaderPostProcess: shader("PostProcess.shader", "PostProcess.json", "shader/PostProcess.shader"),
    ShaderTrail2D: shader("Trail2DShader.shader", "Trail2DShader.json", "shader/Trail2D.shader"),
    ShaderSprite2DTexture: shader("Sprite2DTextureShader.shader", "Sprite2DTextureShader.json", "shader/Sprite2DTexture.shader"),
    ShaderBaseRender2D: shader("baseRender2D.shader", "baseRender2D.json", "shader/BaseRender2D.shader"),
    TextureCube: { fileName: "TextureCube.cubemap", templateName: "TextureCube" },
    RenderTexture: { fileName: "RenderTexture.rendertexture", templateName: "RenderTexture" },
    Texture2DArray: { fileName: "Texture2DArray.tex2darray", templateName: "Texture2DArray" },
    ShaderBlueprint: { fileName: "ShaderBlueprint.bps", templateName: "ShaderBlueprint.json", modernTemplateName: "bp/ShaderBlueprint.bps" },
    ShaderBlueprintFunction: { fileName: "ShaderFunction.bpsf", templateName: "ShaderBlueprintFunction.json", modernTemplateName: "bp/ShaderBlueprintFunction.bpsf" },
    Blueprint: { fileName: "Blueprint.bp", templateName: "Blueprint.json", modernTemplateName: "bp/Blueprint.bp" },
    AnimationController2D: { fileName: "AnimationController.mcc", templateName: "AnimationController2D.mcc", modernTemplateName: "etc/AnimationController2D.mcc" },
    AnimationController3D: { fileName: "AnimationController.controller", templateName: "AnimationController3D.controller", modernTemplateName: "etc/AnimationController3D.controller" },
    AvatarMask: { fileName: "AvatarMask.lavm", templateName: "AvatarMask" },
    LensFlareData: { fileName: "LensFlareData.lensflare", templateName: "LensFlareData" },
    LightingSettings: { fileName: "LightmapBakeSettings.lighting", templateName: "LightingSettings" },
    AtlasConfig: { fileName: "AutoAtlas.atlascfg", templateName: "ImportSettings.AtlasConfig" },
    I18nSettings: { fileName: "i18nSettings.i18ns", templateName: "i18nSettings.i18ns" },
    BitmapFont: { fileName: "BitmapFont.fnt", templateName: "BitmapFont.fnt" },
};

const ASSET_ACTION_ACCESS = {
    waitAssetBusy: "read",
    create: "write",
    createFolder: "write",
    moveAssets: "delete",
    copyAssets: "write",
    deleteAssets: "delete",
    renameAsset: "write",
    createScene: "write",
    createScript: "write",
    createMaterial: "write",
    createShader: "write",
    createAnimCtrl: "write",
    getAssetInfo: "read",
    pathToUuid: "read",
    uuidToPath: "read",
    queryDeps: "read",
    queryRefs: "read",
    unpackModel: "write",
    bindAnimators: "write",
    addAnimatorComponent: "write",
} as const;

export class AssetManagement {
    @IEditor.mcp.tool("AssetManagement", "Create, move, copy, delete, and query LayaAir project assets", {
        action: {
            type: "string",
            required: true,
            desc: "waitAssetBusy | create | createFolder | moveAssets | copyAssets | deleteAssets | renameAsset | createScene | createScript | createMaterial | createShader | createAnimCtrl | getAssetInfo | pathToUuid | uuidToPath | queryDeps | queryRefs | unpackModel | bindAnimators | addAnimatorComponent",
        },
        params: {
            type: "object",
            desc: "Parameters for the selected asset action",
            properties: {
                source: { type: "string", desc: "Asset UUID, asset path, or target directory for a create action" },
                name: { type: "string", desc: "Asset name for create/createScene/createScript/createMaterial/createShader/createAnimCtrl" },
                template: { type: "string", desc: "Asset template type used by create" },
                args: { type: "object", additionalProperties: true, desc: "Open-ended arguments for the create template" },
                folderName: { type: "string", desc: "Folder name for createFolder" },
                sources: { type: "array", items: { type: "string" }, desc: "Asset UUIDs or paths for move/copy/delete" },
                targetFolder: { type: "string", desc: "Target folder UUID or path for move/copy" },
                conflictResolution: { type: "string", desc: "replace | keepBoth" },
                newName: { type: "string", desc: "New name for renameAsset" },
                materialType: { type: "string", desc: "Material type for createMaterial" },
                shaderType: { type: "string", desc: "Shader type for createShader" },
                is2D: { type: "boolean", desc: "Whether createAnimCtrl creates a 2D controller" },
                includeIndirect: { type: "boolean", desc: "Whether queryDeps includes indirect dependencies" },
                timeoutMs: { type: "number", desc: "Timeout for waitAssetBusy, in milliseconds" },
                bindings: {
                    type: "array",
                    desc: "Resource and controller bindings for bindAnimators",
                    items: {
                        type: "object",
                        properties: {
                            resourceUUID: { type: "string", required: true, desc: "Scene/Prefab UUID" },
                            controllerUUID: { type: "string", required: true, desc: "AnimationController UUID" },
                        },
                    },
                },
                controllerUUID: { type: "string", desc: "AnimationController UUID for addAnimatorComponent" },
            },
        },
    }, { access: "write", actionAccess: ASSET_ACTION_ACCESS })
    static async execute(action: string, input?: unknown): Promise<ToolResult<unknown>> {
        const params = asRecord(input);
        const source = asString(params.source);
        try {
            switch (action) {
                case "waitAssetBusy":
                    return toolSuccess(await this.waitAssetBusy(asNumber(params.timeoutMs, 30000)));
                case "create":
                    return await this.create(asString(params.name), source, asString(params.template), asRecord(params.args));
                case "createFolder":
                    return this.wrapAsset(await Editor.assetDb.createFolder(joinAssetPath(source, asString(params.folderName))));
                case "moveAssets":
                    return await this.transfer("move", params.sources, asString(params.targetFolder), asString(params.conflictResolution, "replace"));
                case "copyAssets":
                    return await this.transfer("copy", params.sources, asString(params.targetFolder), asString(params.conflictResolution, "keepBoth"));
                case "deleteAssets":
                    return await this.deleteAssets(params.sources);
                case "renameAsset":
                    return await this.renameAsset(source, asString(params.newName));
                case "createScene":
                    return await this.create(asString(params.name), source, "Scene", {});
                case "createScript":
                    return await this.create(asString(params.name), source, "Script", {});
                case "createMaterial":
                    return await this.create(asString(params.name), source, `Material${asString(params.materialType, "PBR")}`, {});
                case "createShader":
                    return await this.create(asString(params.name), source, `Shader${asString(params.shaderType, "Unlit")}`, {});
                case "createAnimCtrl":
                    return await this.create(asString(params.name), source, asBoolean(params.is2D) ? "AnimationController2D" : "AnimationController3D", {});
                case "getAssetInfo":
                    return await this.assetInfo(source);
                case "pathToUuid":
                    return await this.pathToUuid(source);
                case "uuidToPath":
                    return await this.uuidToPath(source);
                case "queryDeps":
                    return await this.queryDependencies(source, asBoolean(params.includeIndirect, true));
                case "queryRefs":
                    return await this.queryReferences(source);
                case "unpackModel":
                    return await this.sceneJsonOperation(MCP_TOOL_SCENE_COMMANDS.unpackModel, await this.resolveUuid(source));
                case "bindAnimators": {
                    const bindings = await this.resolveAnimatorBindings(params.bindings);
                    return await this.sceneJsonOperation(MCP_TOOL_SCENE_COMMANDS.bindAnimators, JSON.stringify(bindings));
                }
                case "addAnimatorComponent":
                    return await this.sceneJsonOperation(
                        MCP_TOOL_SCENE_COMMANDS.addAnimatorComponent,
                        await this.resolveUuid(source),
                        await this.resolveUuid(asString(params.controllerUUID)),
                    );
                default:
                    return toolError(`Unknown AssetManagement action: ${action}`);
            }
        }
        catch (error) {
            return toolError(error);
        }
    }

    private static async create(
        name: string,
        targetPath: string,
        template: string,
        args: Record<string, unknown>,
    ): Promise<ToolResult<unknown>> {
        const config = TEMPLATES[template];
        if (!config) return toolError(`Unknown asset template: ${template}`);
        if (!name) return toolError("Asset name is required");
        const extension = path.extname(config.fileName);
        const fileName = name.endsWith(extension) ? name : `${name}${extension}`;
        const assetPath = joinAssetPath(targetPath, fileName);
        const info = await Editor.assetDb.createFileFromTemplate(
            assetPath,
            chooseTemplate(config),
            { ...config.args, ...toStringRecord(args) },
            false,
        );
        return this.wrapAsset(info);
    }

    private static async transfer(
        operation: "move" | "copy",
        sources: unknown,
        targetFolder: string,
        conflictResolution: string,
    ): Promise<ToolResult<unknown>> {
        if (conflictResolution !== "replace" && conflictResolution !== "keepBoth") {
            return toolError(`Unknown conflict resolution strategy: ${conflictResolution}`);
        }
        const resolved = await this.resolveAssets(asStringArray(sources));
        if (resolved.missing.length) return toolError(`Assets not found: ${resolved.missing.join(", ")}`);
        const sourceIds = uniqueAssetIds(resolved.assets);
        if (sourceIds.length === 0) return toolError("No assets are available for this operation");
        const target = await Editor.assetDb.getAsset(normalizeIdOrPath(targetFolder));
        if (!target) return toolError(`Target folder not found: ${targetFolder}`);
        if (target.type !== IEditor.AssetType.Folder) return toolError(`Target is not a folder: ${targetFolder}`);
        if (operation === "move") await Editor.assetDb.move(sourceIds, target.id, conflictResolution);
        else await Editor.assetDb.copy(sourceIds, target.id, conflictResolution);
        await this.waitAssetBusy(30000);
        return toolSuccess(operation === "move" ? { movedCount: sourceIds.length } : { copiedCount: sourceIds.length });
    }

    private static async deleteAssets(sources: unknown): Promise<ToolResult<unknown>> {
        const resolved = await this.resolveAssets(asStringArray(sources));
        if (resolved.missing.length) return toolError(`Assets not found: ${resolved.missing.join(", ")}`);
        const assets = uniqueAssets(resolved.assets);
        if (assets.length === 0) return toolError("No assets are available to delete");
        await Editor.assetDb.delete(assets);
        await this.waitAssetBusy(30000);
        return toolSuccess({ deletedCount: assets.length });
    }

    private static async renameAsset(source: string, newName: string): Promise<ToolResult<unknown>> {
        const asset = await Editor.assetDb.getAsset(normalizeIdOrPath(source));
        if (!asset) return toolError(`Asset not found: ${source}`);
        const code = await Editor.assetDb.rename(asset.id, newName);
        await this.waitAssetBusy(30000);
        return code === 0 ? toolSuccess({ newName }) : toolError(`Rename failed with error code: ${code}`);
    }

    private static async assetInfo(source: string): Promise<ToolResult<unknown>> {
        const asset = await Editor.assetDb.getAsset(normalizeIdOrPath(source));
        return asset ? this.wrapAsset(asset) : toolError(`Asset not found: ${source}`);
    }

    private static async pathToUuid(source: string): Promise<ToolResult<string>> {
        if (isUuid(source)) return toolSuccess(source);
        const asset = await Editor.assetDb.getAsset(normalizeAssetPath(source));
        return asset ? toolSuccess(asset.id) : toolError(`Asset not found: ${source}`);
    }

    private static async uuidToPath(source: string): Promise<ToolResult<string>> {
        if (!isUuid(source)) return toolSuccess(source);
        const asset = await Editor.assetDb.getAsset(source);
        return asset ? toolSuccess(toProjectPath(asset.file)) : toolError(`Asset not found: ${source}`);
    }

    private static async queryDependencies(source: string, indirect: boolean): Promise<ToolResult<unknown>> {
        const asset = await Editor.assetDb.getAsset(normalizeIdOrPath(source));
        if (!asset) return toolError(`Asset not found: ${source}`);
        const [dependencies, notFound] = await IEditor.AssetDependencyTool.queryDependency([asset.id], indirect);
        return toolSuccess({ dependencies: dependencies.map(assetSummary), notFound });
    }

    private static async queryReferences(source: string): Promise<ToolResult<unknown>> {
        const asset = await Editor.assetDb.getAsset(normalizeIdOrPath(source));
        if (!asset) return toolError(`Asset not found: ${source}`);
        const references = await IEditor.AssetDependencyTool.queryReference([asset.id]);
        return toolSuccess(references.map(assetSummary));
    }

    private static async sceneJsonOperation(name: string, ...args: unknown[]): Promise<ToolResult<unknown>> {
        if (args.some((value) => value === null)) return toolError("An asset was not found or an argument is invalid");
        const raw: unknown = await Editor.sceneManager.runSceneScript(name, ...args);
        if (typeof raw !== "string") return toolError(`${name} did not return a valid operation result`);
        const parsed: unknown = JSON.parse(raw);
        const result = asRecord(parsed);
        if (result.success !== true) return toolError(asString(result.error, `${name} did not confirm success`));
        return toolSuccess(result);
    }

    private static async waitAssetBusy(timeoutMs: number): Promise<boolean> {
        const result: unknown = await Editor.sceneManager.runSceneScript(MCP_TOOL_SCENE_COMMANDS.waitAssetManager, timeoutMs);
        if (result !== true) {
            throw new Error(result === false
                ? "Timed out waiting for the asset manager to become idle"
                : "The Scene process asset-management support is unavailable");
        }
        return true;
    }

    private static async resolveAssets(values: string[]): Promise<{ assets: IEditor.IAssetInfo[]; missing: string[] }> {
        const assets: IEditor.IAssetInfo[] = [];
        const missing: string[] = [];
        for (const value of values) {
            const asset = await Editor.assetDb.getAsset(normalizeIdOrPath(value));
            if (asset) assets.push(asset);
            else missing.push(value);
        }
        return { assets, missing };
    }

    private static async resolveUuid(value: string): Promise<string | null> {
        if (!value) return null;
        const asset = await Editor.assetDb.getAsset(normalizeIdOrPath(value));
        return asset?.id ?? null;
    }

    private static async resolveAnimatorBindings(
        value: unknown,
    ): Promise<Array<{ resourceUUID: string; controllerUUID: string }>> {
        if (!Array.isArray(value) || value.length === 0) throw new Error("bindings must be a non-empty array");
        const result: Array<{ resourceUUID: string; controllerUUID: string }> = [];
        for (let index = 0; index < value.length; index += 1) {
            const binding = asRecord(value[index]);
            const resourceInput = asString(binding.resourceUUID);
            const controllerInput = asString(binding.controllerUUID);
            if (!resourceInput || !controllerInput) {
                throw new Error(`bindings[${index}] requires resourceUUID and controllerUUID`);
            }
            const resourceUUID = await this.resolveUuid(resourceInput);
            if (!resourceUUID) throw new Error(`Asset not found: ${resourceInput}`);
            const controllerUUID = await this.resolveUuid(controllerInput);
            if (!controllerUUID) throw new Error(`Asset not found: ${controllerInput}`);
            result.push({ resourceUUID, controllerUUID });
        }
        return result;
    }

    private static wrapAsset(asset: IEditor.IAssetInfo | null | undefined): ToolResult<unknown> {
        return asset ? toolSuccess({ ...asset, file: toProjectPath(asset.file) }) : toolError("Failed to create asset");
    }
}

function material(templateName: string, modernTemplateName: string, type: string): TemplateConfig {
    return { fileName: "Material.lmat", templateName, modernTemplateName, args: { type } };
}

function toStringRecord(value: Record<string, unknown>): Record<string, string> {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
}

function shader(fileName: string, templateName: string, modernTemplateName: string): TemplateConfig {
    return { fileName, templateName, modernTemplateName };
}

function chooseTemplate(config: TemplateConfig): string | null {
    if (!config.modernTemplateName) return config.templateName;
    return templateExists(config.modernTemplateName) ? config.modernTemplateName : config.templateName;
}

function templateExists(templateName: string): boolean {
    return [
        path.join(Editor.projectPath, "asset-templates", templateName),
        path.join(Editor.unpackedWebRootPath, "template", "asset", templateName),
        templateName,
    ].some((candidate) => fs.existsSync(candidate));
}

function assetSummary(asset: IEditor.IAssetInfo): Record<string, unknown> {
    return { id: asset.id, name: asset.name, file: toProjectPath(asset.file), type: asset.type };
}

function uniqueAssets(assets: IEditor.IAssetInfo[]): IEditor.IAssetInfo[] {
    return [...new Map(assets.map((asset) => [asset.id, asset])).values()];
}

function uniqueAssetIds(assets: IEditor.IAssetInfo[]): string[] {
    return uniqueAssets(assets).map((asset) => asset.id);
}

function joinAssetPath(parent: string, name: string): string {
    const normalized = normalizeAssetPath(parent);
    return (normalized ? path.posix.join(normalized, name) : name).replace(/\\/g, "/");
}

function normalizeIdOrPath(value: string): string {
    return isUuid(value) ? value : normalizeAssetPath(value);
}

function isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function toProjectPath(file: string): string {
    const normalized = file.replace(/\\/g, "/");
    const project = Editor.projectPath.replace(/\\/g, "/").replace(/\/$/, "");
    return normalized.startsWith(`${project}/`) ? normalized.slice(project.length + 1) : normalized;
}
