import fs from "fs";
import type { McpResourceContent, McpResourceReader, McpResourceResult, McpResourceVariables } from "../../../server-src~/src/types";

export class AssetResourceProvider implements McpResourceReader {
    async read(uri: URL, variables: McpResourceVariables): Promise<McpResourceResult> {
        const asset = EditorEnv.assetMgr.getAsset(String(variables.uuid));
        if (!asset) throw new Error(`asset not found ${variables.uuid}`);

        const path = EditorEnv.assetMgr.getFullPath(asset);
        let content: McpResourceContent;
        if (this.isBinaryAsset(asset.type)) {
            content = {
                uri: uri.href,
                blob: (await fs.promises.readFile(path)).toString("base64"),
                mimeType: this.getMimeType(asset.ext),
            };
        }
        else {
            content = {
                uri: uri.href,
                text: await fs.promises.readFile(path, "utf-8"),
                mimeType: "text/plain",
            };
        }
        return { contents: [content] };
    }

    private isBinaryAsset(type: IEditorEnv.AssetType): boolean {
        return type === IEditorEnv.AssetType.Image
            || type === IEditorEnv.AssetType.SVGImage
            || type === IEditorEnv.AssetType.Video
            || type === IEditorEnv.AssetType.Audio
            || type === IEditorEnv.AssetType.TTFFont
            || type === IEditorEnv.AssetType.Skeleton
            || type === IEditorEnv.AssetType.Mesh
            || type === IEditorEnv.AssetType.WebAssembly
            || type === IEditorEnv.AssetType.Binary
            || type === IEditorEnv.AssetType.Model;
    }

    private getMimeType(extension: string): string {
        switch (extension) {
            case "png": return "image/png";
            case "jpg":
            case "jpeg": return "image/jpeg";
            case "svg": return "image/svg+xml";
            case "mp4": return "video/mp4";
            case "ogg": return "audio/ogg";
            case "mp3": return "audio/mpeg";
            case "ttf": return "font/ttf";
            case "wasm": return "application/wasm";
            default: return "application/octet-stream";
        }
    }
}
