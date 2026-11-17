import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { validateLayaDocument } from "./DocumentValidation";

@IEditorEnv.regClass()
export class StandaloneMcpAssetScene {
    static async flushAssetDatabase(): Promise<true> {
        await EditorEnv.assetMgr.flushChanges();
        return true;
    }

    static async unpackModel(id: string): Promise<string> {
        try {
            const asset = EditorEnv.assetMgr.getAsset(id);
            if (!asset) return JSON.stringify({ success: false, error: `Asset not found: ${id}` });
            await EditorEnv.assetMgr.waitForAssetsReady([asset.file]);
            const extension = path.extname(asset.file);
            const relativeOutput = `${asset.file.slice(0, -extension.length)}-unpacked`;
            await IEditorEnv.CreateAssetUtil.unpackModel(asset, path.join(EditorEnv.assetsPath, relativeOutput));
            await EditorEnv.assetMgr.flushChanges();
            return JSON.stringify({ success: true, outputPath: `assets/${relativeOutput.replace(/\\/g, "/")}` });
        }
        catch (error) {
            return JSON.stringify({ success: false, error: errorMessage(error) });
        }
    }
}

@IEditorEnv.regClass()
export class StandaloneMcpAnimatorScene {
    static async addAnimatorComponent(resourceUUID: string, controllerUUID: string): Promise<string> {
        const prepared = await StandaloneMcpAnimatorScene.prepareAnimatorComponent(resourceUUID, controllerUUID);
        return prepared.success
            ? JSON.stringify({ success: true, file: prepared.file, result: prepared.updatedContent })
            : JSON.stringify({ success: false, error: prepared.error });
    }

    static async bindAnimators(bindingsJson: string): Promise<string> {
        return await enqueueAnimatorBinding(() => StandaloneMcpAnimatorScene.bindAnimatorsBatch(bindingsJson));
    }

    private static async bindAnimatorsBatch(bindingsJson: string): Promise<string> {
        try {
            const bindings: unknown = JSON.parse(bindingsJson);
            if (!Array.isArray(bindings) || bindings.length === 0) {
                return JSON.stringify({ success: false, error: "bindings must be a non-empty array" });
            }
            const prepared: AnimatorAssetWrite[] = [];
            const results: AnimatorBindingResult[] = [];
            const resourceIds = new Set<string>();
            for (const item of bindings) {
                const binding = isRecord(item) ? item : {};
                const resourceUUID = nonEmptyString(binding.resourceUUID);
                const controllerUUID = nonEmptyString(binding.controllerUUID);
                if (!resourceUUID || !controllerUUID) {
                    results.push({ resourceUUID, success: false, error: "resourceUUID and controllerUUID are required" });
                    continue;
                }
                if (resourceIds.has(resourceUUID)) {
                    results.push({ resourceUUID, success: false, error: `Duplicate resourceUUID: ${resourceUUID}` });
                    continue;
                }
                resourceIds.add(resourceUUID);
                const result = await StandaloneMcpAnimatorScene.prepareAnimatorComponent(resourceUUID, controllerUUID);
                if (!result.success || !result.file || !result.filePath
                    || result.originalContent === undefined || result.updatedContent === undefined) {
                    results.push({ resourceUUID, success: false, error: result.error ?? "Animator binding failed" });
                    continue;
                }
                prepared.push({
                    resourceUUID,
                    filePath: result.filePath,
                    originalContent: result.originalContent,
                    updatedContent: result.updatedContent,
                });
                results.push({ resourceUUID, file: result.file, success: true });
            }
            if (results.some((item) => !item.success)) {
                return JSON.stringify({
                    success: false,
                    error: "Animator bindings validation failed; no files were changed",
                    results: results.map((item) => item.success
                        ? { ...item, success: false, error: "Batch cancelled before writing" }
                        : item),
                });
            }
            return await commitAnimatorWrites(prepared, results);
        }
        catch (error) {
            return JSON.stringify({ success: false, error: errorMessage(error) });
        }
    }

    private static async prepareAnimatorComponent(
        resourceUUID: string,
        controllerUUID: string,
    ): Promise<AnimatorPreparationResult> {
        try {
            if (!resourceUUID || !controllerUUID) {
                return { success: false, error: "resourceUUID and controllerUUID are required" };
            }
            const asset = EditorEnv.assetMgr.getAsset(resourceUUID);
            if (!asset) return { success: false, error: `Asset not found: ${resourceUUID}` };
            if (asset.type !== IEditorEnv.AssetType.Scene && asset.type !== IEditorEnv.AssetType.Prefab) {
                return { success: false, error: "Asset is not a Scene or Prefab" };
            }
            const controller = EditorEnv.assetMgr.getAsset(controllerUUID);
            if (!controller) return { success: false, error: `AnimationController not found: ${controllerUUID}` };
            if (controller.type !== IEditorEnv.AssetType.AnimationController
                && controller.type !== IEditorEnv.AssetType.AnimationController2D) {
                return { success: false, error: `Asset is not an AnimationController: ${controllerUUID}` };
            }
            const filePath = EditorEnv.assetMgr.getFullPath(asset);
            const originalContent = await fs.promises.readFile(filePath, "utf8");
            const document: unknown = JSON.parse(originalContent);
            const extension = path.extname(asset.file).toLowerCase();
            const initialErrors = validateLayaDocument(document, extension);
            if (initialErrors.length) {
                return { success: false, error: `Scene or Prefab structure is invalid: ${initialErrors.join("; ")}` };
            }
            const is2D = controller.type === IEditorEnv.AssetType.AnimationController2D;
            const serialized = await serializeAnimatorAsset(asset, is2D);
            if (!injectAnimatorController(serialized.document, serialized.targetId, controllerUUID, is2D)) {
                return { success: false, error: "Serialized Animator component is missing or duplicated on the target node" };
            }
            const updatedErrors = validateLayaDocument(serialized.document, extension);
            if (updatedErrors.length) {
                return { success: false, error: `Updated Scene or Prefab structure is invalid: ${updatedErrors.join("; ")}` };
            }
            return {
                success: true,
                file: asset.file,
                filePath,
                originalContent,
                updatedContent: JSON.stringify(serialized.document, null, 2),
            };
        }
        catch (error) {
            return { success: false, error: errorMessage(error) };
        }
    }
}

interface AnimatorPreparationResult {
    success: boolean;
    error?: string;
    file?: string;
    filePath?: string;
    originalContent?: string;
    updatedContent?: string;
}

interface AnimatorAssetWrite {
    resourceUUID: string;
    filePath: string;
    originalContent: string;
    updatedContent: string;
}

interface AnimatorBindingResult {
    resourceUUID: string;
    file?: string;
    success: boolean;
    error?: string;
}

async function commitAnimatorWrites(
    writes: AnimatorAssetWrite[],
    results: AnimatorBindingResult[],
): Promise<string> {
    const changed: AnimatorAssetWrite[] = [];
    try {
        for (const write of writes) {
            await replaceFileIfUnchanged(write.filePath, write.originalContent, write.updatedContent);
            changed.push(write);
        }
        await EditorEnv.assetMgr.flushChanges();
        return JSON.stringify({ success: true, results });
    }
    catch (error) {
        const rollbackErrors: string[] = [];
        for (const write of changed.reverse()) {
            try {
                await replaceFileIfUnchanged(write.filePath, write.updatedContent, write.originalContent);
            }
            catch (rollbackError) {
                rollbackErrors.push(`${write.resourceUUID}: ${errorMessage(rollbackError)}`);
            }
        }
        try {
            await EditorEnv.assetMgr.flushChanges();
        }
        catch (rollbackError) {
            rollbackErrors.push(`flush: ${errorMessage(rollbackError)}`);
        }
        const rollbackSuffix = rollbackErrors.length
            ? `; rollback incomplete: ${rollbackErrors.join("; ")}`
            : "; all changed files were restored";
        return JSON.stringify({
            success: false,
            error: `Animator bindings write failed: ${errorMessage(error)}${rollbackSuffix}`,
            results: results.map((item) => ({ ...item, success: false, error: "Batch rolled back" })),
        });
    }
}

async function replaceFileIfUnchanged(
    filePath: string,
    expectedContent: string,
    updatedContent: string,
): Promise<void> {
    const temporaryPath = path.join(
        path.dirname(filePath),
        `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
        await fs.promises.writeFile(temporaryPath, updatedContent, "utf8");
        // Scene 进程没有公开的 AssetManager 写锁或文件修订令牌。同步执行最终比较和
        // 重命名，避免同一进程事件循环中的保存操作插入两步之间。
        const currentContent = fs.readFileSync(filePath, "utf8");
        if (currentContent !== expectedContent) {
            throw new Error(`Asset changed while preparing Animator binding: ${filePath}`);
        }
        fs.renameSync(temporaryPath, filePath);
    }
    finally {
        await fs.promises.rm(temporaryPath, { force: true }).catch((): void => { });
    }
}

let animatorBindingChain: Promise<void> = Promise.resolve();

function enqueueAnimatorBinding(operation: () => Promise<string>): Promise<string> {
    const result = animatorBindingChain.then(operation, operation);
    animatorBindingChain = result.then(
        (): void => { },
        (): void => { },
    );
    return result;
}

interface SerializedAnimatorAsset {
    document: unknown;
    targetId: string;
}

async function serializeAnimatorAsset(
    asset: IEditorEnv.IAssetInfo,
    is2D: boolean,
): Promise<SerializedAnimatorAsset> {
    const prefab = await Laya.loader.load(`res://${asset.id}`, { cache: false }) as Laya.PrefabImpl | null;
    if (!prefab) throw new Error(`Unable to load asset through LayaAir: ${asset.id}`);
    const root = prefab.create({ editMode: true });
    if (!root) throw new Error(`Unable to instantiate asset through LayaAir: ${asset.id}`);
    try {
        const animatorClassName = is2D ? "Animator2D" : "Animator";
        const animatorClass = Laya.ClassUtils.getClass(animatorClassName) as (new () => Laya.Component) | null;
        if (!animatorClass) throw new Error(`${animatorClassName} class not found in engine`);

        if (asset.type === IEditorEnv.AssetType.Scene) {
            const scene = root as Laya.Scene;
            const target: Laya.Node | null = is2D ? scene : scene.scene3D;
            if (!target) throw new Error(`Scene has no ${is2D ? "2D" : "3D"} root node`);
            assertAnimatorOwner(target, is2D);
            const targetId = nodeStoreId(target);
            if (!target.getComponent(animatorClass)) target.addComponent(animatorClass);
            return {
                document: IEditorEnv.HierarchyWriter.writeScene(scene, scene.scene3D),
                targetId,
            };
        }

        assertAnimatorOwner(root, is2D);
        const targetId = nodeStoreId(root);
        if (!root.getComponent(animatorClass)) root.addComponent(animatorClass);
        return { document: IEditorEnv.HierarchyWriter.write(root), targetId };
    }
    finally {
        root.destroy();
        prefab.destroy();
    }
}

function assertAnimatorOwner(node: Laya.Node, is2D: boolean): void {
    const is3DNode = node instanceof Laya.Sprite3D;
    if (is2D === is3DNode) {
        throw new Error(`${is2D ? "Animator2D" : "Animator"} cannot be attached to this node type`);
    }
}

function nodeStoreId(node: Laya.Node): string {
    const metadata = (node as unknown as { _extra?: { storeId?: unknown } })._extra;
    if (typeof metadata?.storeId !== "string" || !metadata.storeId) {
        throw new Error("Animator target node has no storeId");
    }
    return metadata.storeId;
}

function injectAnimatorController(
    document: unknown,
    targetId: string,
    controllerUUID: string,
    is2D: boolean,
): boolean {
    const node = findSerializedNode(document, targetId);
    if (!node || !Array.isArray(node._$comp)) return false;
    const animatorType = is2D ? "Animator2D" : "Animator";
    const animators = node._$comp.filter((item) => (
        isRecord(item) && (item._$type === animatorType || item._$override === animatorType)
    ));
    if (animators.length !== 1) return false;
    const controller = {
        _$uuid: controllerUUID,
        _$type: is2D ? "AnimationController2D" : "AnimationController",
    };
    animators[0].controller = controller;
    return true;
}

function findSerializedNode(value: unknown, targetId: string): Record<string, unknown> | null {
    if (!isRecord(value)) return null;
    if (value._$id === targetId) return value;
    if (isRecord(value._$hierarchy)) {
        const hierarchyMatch = findSerializedNode(value._$hierarchy, targetId);
        if (hierarchyMatch) return hierarchyMatch;
    }
    if (!Array.isArray(value._$child)) return null;
    for (const child of value._$child) {
        const match = findSerializedNode(child, targetId);
        if (match) return match;
    }
    return null;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function nonEmptyString(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
