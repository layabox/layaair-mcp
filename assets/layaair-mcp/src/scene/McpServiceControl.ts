import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { MCP_EDITOR_COMMANDS, type McpServiceCommand, type McpServiceSettings, type McpServiceState } from "../shared/contracts";
import type { McpServerInstance } from "../../server-src~/src/types";

const DEFAULT_SETTINGS: McpServiceSettings = { autoStart: true };

export class McpServiceControl {
    private settings = DEFAULT_SETTINGS;
    private error?: string;
    private pending = Promise.resolve();
    private disposing = false;
    private startupReported = false;

    constructor(private readonly server: McpServerInstance) {}

    load(): void {
        void this.enqueue(async () => {
            try {
                this.settings = await readSettings(settingsPath());
                if (this.settings.autoStart && !this.disposing) this.start();
            } catch (error) {
                this.error = errorMessage(error);
                console.error("[LayaAir MCP]", this.error);
            }
        });
    }

    command(command: McpServiceCommand): Promise<McpServiceState> {
        return this.enqueue(async () => {
            if (this.disposing) throw new Error("MCP service is unloading");
            if (command?.action !== "read") {
                try {
                    this.error = undefined;
                    switch (command?.action) {
                        case "start": this.start(); break;
                        case "stop":
                            await this.server.stop();
                            this.startupReported = false;
                            break;
                        case "save": {
                            const next = validateSettings(command.settings);
                            await saveSettings(settingsPath(), next);
                            this.settings = next;
                            break;
                        }
                        default: throw new Error("Unknown MCP settings command");
                    }
                } catch (error) {
                    this.error = errorMessage(error);
                }
            }
            return { status: this.server.getStatus(), settings: this.settings, error: this.error };
        });
    }

    dispose(): Promise<void> {
        this.disposing = true;
        return this.enqueue(() => this.server.dispose());
    }

    reportReady(): void {
        if (this.disposing || this.startupReported) return;
        const { state, endpoint } = this.server.getStatus();
        if (state !== "running" || !endpoint) return;
        this.startupReported = true;
        void EditorEnv.runUIScript(MCP_EDITOR_COMMANDS.reportServiceStarted, endpoint).catch((error: unknown) => {
            console.debug("[LayaAir MCP] Could not report startup to the Editor", error);
        });
    }

    private start(): void {
        this.server.start(EditorEnv.liveServer);
        this.reportReady();
    }

    private enqueue<T>(work: () => Promise<T>): Promise<T> {
        const next = this.pending.then(work);
        this.pending = next.then(() => {}, () => {});
        return next;
    }
}

function settingsPath(): string {
    return path.join(EditorEnv.projectPath, "local", "layaair-mcp", "settings.json");
}

function validateSettings(value: McpServiceSettings): McpServiceSettings {
    if (typeof value?.autoStart !== "boolean") {
        throw new Error("MCP settings require an auto-start toggle");
    }
    return { autoStart: value.autoStart };
}

async function readSettings(file: string): Promise<McpServiceSettings> {
    try {
        return validateSettings(JSON.parse(await readFile(file, "utf8")));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_SETTINGS;
        throw error;
    }
}

async function saveSettings(file: string, settings: McpServiceSettings): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, JSON.stringify(settings, null, 2) + "\n", { flag: "wx" });
        await rename(temporary, file);
    } finally {
        await rm(temporary, { force: true });
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
