import { dirname, join } from "node:path";

const PLUGIN_ROOT_MARKER = "editorResources/layaair-mcp/plugin-root-marker.txt";

export async function getPluginRoot(signal?: AbortSignal): Promise<string> {
    const marker = await Editor.assetDb.getAsset(PLUGIN_ROOT_MARKER, true);
    signal?.throwIfAborted();
    if (!marker) throw new Error("The LayaAir MCP plugin root marker is missing");
    return join(dirname(Editor.assetDb.getFullPath(marker)), "..", "..");
}
