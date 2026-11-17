interface BuildOptions {
    destPath?: string;
    name?: string;
    displayName?: string;
    version?: string;
    useCompressedEngine?: boolean;
    minifyJS?: boolean;
    sourcemap?: boolean;
    sourcesContent?: boolean;
    enableVersion?: boolean;
    enableSubpackages?: boolean;
    copyBinFiles?: boolean;
    useSafeFileExtensions?: boolean;
    allowTextureCompressedFormat?: boolean;
    keepTextureSourceFile?: boolean;
    disableWebAssembly?: boolean | "alternative";
    renderDevice?: "webgl" | "webgpu" | "opengl" | "metal" | "vulkan";
}

@IEditorEnv.regClass()
export class StandaloneMcpBuildHelper {
    static async buildAndWait(
        platform: string,
        options?: BuildOptions,
    ): Promise<"success" | "failed" | "running"> {
        const plugin: IEditorEnv.IBuildPlugin = {
            onSetup(task): void {
                if (!options) return;
                const config = task.config;
                if (options.name !== undefined) config.name = options.name;
                if (options.displayName !== undefined) config.displayName = options.displayName;
                if (options.version !== undefined) config.version = options.version;
                if (options.useCompressedEngine !== undefined) config.useCompressedEngine = options.useCompressedEngine;
                if (options.minifyJS !== undefined) config.minifyJS = options.minifyJS;
                if (options.sourcemap !== undefined) config.sourcemap = options.sourcemap;
                if (options.sourcesContent !== undefined) config.sourcesContent = options.sourcesContent;
                if (options.enableVersion !== undefined) config.enableVersion = options.enableVersion;
                if (options.enableSubpackages !== undefined) config.enableSubpackages = options.enableSubpackages;
                if (options.copyBinFiles !== undefined) config.copyBinFiles = options.copyBinFiles;
                if (options.useSafeFileExtensions !== undefined) config.useSafeFileExtensions = options.useSafeFileExtensions;
                if (options.allowTextureCompressedFormat !== undefined) config.allowTextureCompressedFormat = options.allowTextureCompressedFormat;
                if (options.keepTextureSourceFile !== undefined) config.keepTextureSourceFile = options.keepTextureSourceFile;
                if (options.disableWebAssembly !== undefined) config.disableWebAssembly = options.disableWebAssembly;
                if (options.renderDevice !== undefined) config.renderDevice = options.renderDevice;
            },
        };
        const task = options?.destPath
            ? IEditorEnv.BuildTask.start(platform, options.destPath, plugin)
            : IEditorEnv.BuildTask.start(platform, plugin);
        const status = await task.waitForCompletion();
        if (status === IEditorEnv.BuildTaskStatus.Success) return "success";
        if (status === IEditorEnv.BuildTaskStatus.Running) return "running";
        return "failed";
    }
}
