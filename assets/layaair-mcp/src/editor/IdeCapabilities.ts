// Local types describe only the APIs consumed by these tools. IDE 3.3 does not declare them.
export type ThemeMode = "dark" | "light";

interface ThemeDefinition {
    id: string;
    mode: ThemeMode;
}

export interface ThemeInstallation {
    ok: boolean;
    definition?: ThemeDefinition;
    diagnostics: ReadonlyArray<{ path?: string; message: string }>;
}

export interface ThemeManager {
    readonly schemaVersion: number;
    readonly jsonSchema: Readonly<Record<string, unknown>>;
    getTheme(): ThemeMode;
    getThemePreference(): ThemeMode | "system";
    setThemePreference(mode: ThemeMode): void;
    getAccentPreset(): string;
    setAccentPreset(id: string): void;
    getThemeDefinition(mode: ThemeMode, id: string): ThemeDefinition;
    getThemeDefinitions(mode?: ThemeMode): readonly ThemeDefinition[];
    installTheme(definition: unknown, replace: boolean): ThemeInstallation;
}

interface FrameCaptureApi {
    captureFrame(options: { targetSceneView: boolean; resolution: "none" | "low" | "high" }): Promise<unknown>;
}

export interface ProfilerOptions {
    target: "editor" | "browser" | "emulator" | "remote";
    remoteAddress?: string;
}

interface ProfilerApi {
    readonly state: unknown;
    connect(options?: ProfilerOptions): Promise<void>;
    start(options?: ProfilerOptions): Promise<void>;
    stop(): Promise<void>;
    exportReport(options: { maxZones: number }): Promise<unknown>;
    dispose(): Promise<void>;
}

type BakeDevice = "CPU" | "CUDA";

export type BakeRequest =
    | { kind: "gi"; device?: BakeDevice }
    | { kind: "gi-preview" }
    | { kind: "ibl"; target?: "scene3D" | "bridge3D" }
    | { kind: "reflection-probe"; nodeId: string }
    | { kind: "volumetric-gi"; nodeId: string; device?: BakeDevice }
    | { kind: "all"; device?: BakeDevice; resume?: boolean };

export interface BakeTask {
    readonly id: string;
    readonly sceneId: string;
    readonly state: string;
    readonly progress: unknown;
    readonly result: Promise<unknown>;
    cancel(): Promise<void>;
}

export interface LightingBakeApi {
    readonly activeTask: BakeTask | null;
    check(request: BakeRequest): Promise<unknown>;
    start(request: BakeRequest): BakeTask;
}

interface OptionalEditorApi {
    React?: { themeManager?: ThemeManager };
    FrameDebugger?: FrameCaptureApi;
    Profiler?: ProfilerApi;
    LightingBake?: LightingBakeApi;
}

function optionalApi(): OptionalEditorApi {
    return IEditor as typeof IEditor & OptionalEditorApi;
}

export function getThemeManager(): ThemeManager | undefined {
    const manager = optionalApi().React?.themeManager;
    if (manager && manager.schemaVersion === 1 && manager.jsonSchema
        && typeof manager.getTheme === "function" && typeof manager.getThemePreference === "function"
        && typeof manager.setThemePreference === "function" && typeof manager.getAccentPreset === "function"
        && typeof manager.setAccentPreset === "function" && typeof manager.getThemeDefinition === "function"
        && typeof manager.getThemeDefinitions === "function" && typeof manager.installTheme === "function") {
        return manager;
    }
}

export function getFrameDebugger(): FrameCaptureApi | undefined {
    const debuggerApi = optionalApi().FrameDebugger;
    if (typeof debuggerApi?.captureFrame === "function") return debuggerApi;
}

export function getProfiler(): ProfilerApi | undefined {
    const profiler = optionalApi().Profiler;
    if (profiler && typeof profiler.connect === "function" && typeof profiler.start === "function"
        && typeof profiler.stop === "function" && typeof profiler.exportReport === "function"
        && typeof profiler.dispose === "function" && "state" in profiler) {
        return profiler;
    }
}

export function getLightingBake(): LightingBakeApi | undefined {
    const bake = optionalApi().LightingBake;
    if (bake && typeof bake.check === "function" && typeof bake.start === "function" && "activeTask" in bake) {
        return bake;
    }
}
