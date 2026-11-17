import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { promisify } from "node:util";
import { ApiKnowledgeQueryProcess, type ApiKnowledgeResponse } from "./ApiKnowledgeQueryProcess";
import { getPluginRoot } from "./PluginRoot";
export type { ApiKnowledgeResponse } from "./ApiKnowledgeQueryProcess";

export type ApiKnowledgeCommand =
  | "versions"
  | "search"
  | "get"
  | "members"
  | "inheritance"
  | "compare-versions"
  | "resolve-location"
  | "schema-search"
  | "schema-get"
  | "schema-descendants";

export interface ApiKnowledgeRequest {
  command: ApiKnowledgeCommand;
  value?: string;
  apiVersion?: string;
  sourceDomain?: "engine-runtime" | "ide" | "support";
  kind?: string;
  owner?: string;
  limit?: number;
  inherited?: boolean;
  direction?: "ancestors" | "descendants";
  maxDepth?: number;
  fromVersion?: string;
  toVersion?: string;
  diffType?: "all" | "class" | "method" | "property";
  worldType?: "2d" | "3d";
  includeProperties?: boolean;
}

const execFileAsync = promisify(execFile);
const CACHE_CHECK_INTERVAL_MS = 6 * 60 * 60_000;
const COMMAND_TIMEOUT_MS = 6 * 60_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const VERSIONED_COMMANDS = new Set<ApiKnowledgeCommand>(["search", "get", "members", "inheritance", "resolve-location"]);

class ApiKnowledge {
    private lifetime?: AbortController;
    private timer?: ReturnType<typeof setInterval>;
    private update?: Promise<void>;
    private queryProcess?: ApiKnowledgeQueryProcess;

    start(): void {
        if (this.lifetime) return;
        this.lifetime = new AbortController();
        if (Editor.cliMode) return;
        void this.checkForUpdate();
        this.timer = setInterval(() => void this.checkForUpdate(), CACHE_CHECK_INTERVAL_MS);
        this.timer.unref?.();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        this.lifetime?.abort();
        this.lifetime = undefined;
        this.queryProcess?.stop();
        this.queryProcess = undefined;
        this.update = undefined;
    }

    async query(request: ApiKnowledgeRequest): Promise<ApiKnowledgeResponse> {
        const signal = this.getSignal();
        const args = buildQueryArgs(request);
        if (!request.apiVersion && VERSIONED_COMMANDS.has(request.command)) {
            const version: unknown = await Editor.ipc.invoke("GetVersion");
            if (typeof version === "string" && version) args.push("--api-version", version);
        }
        signal.throwIfAborted();
        if (!this.queryProcess) {
            const cli = await this.findRuntime(signal);
            signal.throwIfAborted();
            this.queryProcess ??= new ApiKnowledgeQueryProcess(cli, Editor.projectPath, runtimeEnv(cli));
        }
        return this.queryProcess.query(args);
    }

    private checkForUpdate(): Promise<void> {
        if (this.update) return this.update;
        const lifetime = this.lifetime;
        const update = this.runCacheUpdate().then((result) => {
            console.debug(`[LayaAir MCP] API knowledge cache check: ${result.action ?? "unknown"}`);
            if (result.action === "installed") {
                console.debug("[LayaAir MCP] API knowledge cache updated", result.artifactVersion);
            } else if (result.action === "failed") {
                const log = result.usableCache === true ? console.debug : console.warn;
                log("[LayaAir MCP] Unable to download API knowledge cache", result.message);
            }
        }).catch((error: unknown) => {
            if (lifetime && !lifetime.signal.aborted) {
                console.debug("[LayaAir MCP] API knowledge cache check failed", error);
            }
        }).finally(() => {
            if (this.update === update) this.update = undefined;
        });
        this.update = update;
        return update;
    }

    private getSignal(): AbortSignal {
        const signal = this.lifetime?.signal;
        if (!signal) throw new Error("API knowledge service is not active");
        return signal;
    }

    private async findRuntime(signal: AbortSignal): Promise<string> {
        const pluginRoot = await getPluginRoot(signal);
        const cli = join(pluginRoot, "bundled_skills~", "layaair-api-knowledge", "scripts", "layaair-api.cjs");
        await access(cli);
        signal.throwIfAborted();
        return cli;
    }

    private async runCacheUpdate(): Promise<ApiKnowledgeResponse> {
        const signal = this.getSignal();
        const cli = await this.findRuntime(signal);
        try {
            const { stdout } = await execFileAsync(process.execPath, [
                cli, "cache-update", "--project", Editor.projectPath,
            ], {
                cwd: Editor.projectPath,
                env: runtimeEnv(cli),
                encoding: "utf8",
                timeout: COMMAND_TIMEOUT_MS,
                maxBuffer: MAX_OUTPUT_BYTES,
                windowsHide: true,
                signal,
            });
            return JSON.parse(stdout) as ApiKnowledgeResponse;
        } catch (error) {
            if (error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string") {
                const payload = parseFailure(error.stderr);
                if (payload) throw new Error(payload);
            }
            throw error;
        }
    }
}

function runtimeEnv(cli: string): NodeJS.ProcessEnv {
    return {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        LAYA_API_SKILL_ROOT: join(dirname(cli), ".."),
    };
}

function parseFailure(text: string): string | undefined {
    try {
        const response = JSON.parse(text) as ApiKnowledgeResponse;
        if (typeof response.message === "string") {
            return typeof response.error === "string" ? `${response.error}: ${response.message}` : response.message;
        }
    } catch {
        // Preserve the original process error when stderr is not a structured response.
    }
    return undefined;
}

function buildQueryArgs(request: ApiKnowledgeRequest): string[] {
    const args: string[] = [request.command];
    addArgument(args, "", request.value);
    addArgument(args, "--api-version", request.apiVersion);
    addArgument(args, "--domain", request.sourceDomain);
    addArgument(args, "--kind", request.kind);
    addArgument(args, "--owner", request.owner);
    addArgument(args, "--limit", request.limit);
    addArgument(args, "--direction", request.direction);
    addArgument(args, "--max-depth", request.maxDepth);
    addArgument(args, "--from-version", request.fromVersion);
    addArgument(args, "--to-version", request.toVersion);
    addArgument(args, "--diff-type", request.diffType);
    addArgument(args, "--world-type", request.worldType);
    if (request.inherited) args.push("--inherited");
    if (request.includeProperties) args.push("--include-properties");
    return args;
}

function addArgument(args: string[], flag: string, value: string | number | undefined): void {
    if (value === undefined) return;
    const argument = String(value).trim();
    if (!argument || argument.startsWith("--")) {
        throw new Error(`Invalid value for ${flag || "query"}`);
    }
    if (flag) args.push(flag);
    args.push(argument);
}

export const apiKnowledge = new ApiKnowledge();
