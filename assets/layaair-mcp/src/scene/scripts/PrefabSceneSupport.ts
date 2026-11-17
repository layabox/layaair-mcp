import fs from "fs";

@IEditorEnv.regClass()
export class StandaloneMcpPrefabScene {
    static async waitAssetMgrBusy(timeoutMs = 30000): Promise<boolean> {
        const startedAt = Date.now();
        while (EditorEnv.assetMgr.busy) {
            if (Date.now() - startedAt > timeoutMs) return false;
            await EditorEnv.assetMgr.flushChanges();
            await IEditorEnv.utils.sleep(250);
        }
        return true;
    }

    static async applyChangesToPrefab(id: string, timeoutMs = 30000): Promise<boolean> {
        const target = getPrefabRoot(id);
        if (!target) return false;
        const asset = EditorEnv.assetMgr.getAsset(target.prefabId);
        if (!isPrefabAsset(asset)) return false;
        if (!await isReadablePrefabSource(asset)) return false;
        await EditorEnv.scene.runScript("applyPrefabAllOverrides", id);
        if (!await waitForNodeReload(id, target.node, timeoutMs)) return false;
        await EditorEnv.assetMgr.flushChanges();
        if (!await isReadableJsonFile(EditorEnv.assetMgr.getFullPath(asset))) return false;
        EditorEnv.scene.validateScene();
        return true;
    }

    static async restorePrefab(id: string, timeoutMs = 30000): Promise<boolean> {
        const target = getPrefabRoot(id);
        if (!target) return false;
        const asset = EditorEnv.assetMgr.getAsset(target.prefabId);
        if (!isPrefabAsset(asset)) return false;
        await EditorEnv.scene.runScript("revertPrefabAllOverrides", id);
        if (!await waitForNodeReload(id, target.node, timeoutMs)) return false;
        EditorEnv.scene.validateScene();
        return true;
    }
}

function getPrefabRoot(id: string): { node: IEditorEnv.IMyNode; prefabId: string } | null {
    const node = EditorEnv.scene.getNodeById(id);
    if (!node) return null;
    const extra: unknown = node._extra;
    if (extra === null || typeof extra !== "object") return null;
    const metadata = extra as Record<string, unknown>;
    return metadata.isTopPrefab === true
        && metadata.prefabMissing !== true
        && typeof metadata.prefabId === "string"
        && metadata.prefabId.length > 0
        ? { node, prefabId: metadata.prefabId }
        : null;
}

function isPrefabAsset(asset: IEditorEnv.IAssetInfo | null): asset is IEditorEnv.IAssetInfo {
    return Boolean(asset && (asset.type === IEditorEnv.AssetType.Prefab || asset.type === IEditorEnv.AssetType.GUIPrefab));
}

function isReadablePrefabSource(asset: IEditorEnv.IAssetInfo): Promise<boolean> {
    const sourcePath = asset.type === IEditorEnv.AssetType.Prefab
        ? EditorEnv.assetMgr.getPrefabSourcePath(asset)
        : EditorEnv.assetMgr.getFullPath(asset);
    return isReadableJsonFile(sourcePath);
}

async function isReadableJsonFile(filePath: string): Promise<boolean> {
    try {
        const value: unknown = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }
    catch {
        return false;
    }
}

async function waitForNodeReload(id: string, previousNode: IEditorEnv.IMyNode, timeoutMs: number): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
        const currentNode = EditorEnv.scene.getNodeById(id);
        if (previousNode.destroyed && currentNode !== null && currentNode !== previousNode) return true;
        const remaining = timeoutMs - (Date.now() - startedAt);
        if (remaining <= 0) break;
        await IEditorEnv.utils.sleep(Math.min(50, remaining));
    }
    return false;
}
