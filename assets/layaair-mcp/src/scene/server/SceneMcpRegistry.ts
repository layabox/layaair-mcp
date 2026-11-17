import type {
    IMcpParamSchema,
    IMcpPlugin,
    IMcpServer,
    IMcpToolOptions,
} from "../../shared/types";
import type {
    McpHandlerCallback,
    McpHandlerScope,
    McpHandlerStore,
} from "../../../server-src~/src/types";
import { t } from "../i18n";

type McpParams = Record<string, string | IMcpParamSchema>;

export class SceneMcpRegistry {
    readonly api: IMcpPlugin & { server: IMcpServer };

    constructor(private readonly server: McpHandlerStore) {
        this.api = {
            server,
            tool: ((
                name: string,
                descOrParams?: string | McpParams,
                paramsOrOptions?: McpParams | IMcpToolOptions,
                options?: IMcpToolOptions,
            ) => (
                this.createDecorator(name, descOrParams, paramsOrOptions, options, false)
            )) as IMcpPlugin["tool"],
            prompt: ((name: string, descOrParams?: string | McpParams, params?: McpParams) => (
                this.createDecorator(name, descOrParams, params, undefined, true)
            )) as IMcpPlugin["prompt"],
        };
    }

    async clearScope(scope: McpHandlerScope): Promise<void> {
        this.server.clearHandlers(scope);
        await this.server.reload();
    }

    private createDecorator(
        name: string,
        descOrParams: string | McpParams | undefined,
        paramsOrOptions: McpParams | IMcpToolOptions | undefined,
        options: IMcpToolOptions | undefined,
        prompt: boolean,
    ): MethodDecorator {
        const normalizedName = this.normalizeName(name);
        const { desc, normalizedParams, normalizedOptions } = this.normalizeDefinition(
            descOrParams,
            paramsOrOptions,
            options,
            prompt,
        );
        return (target, propertyKey, descriptor): void => {
            const candidate = descriptor?.value
                ?? (target as Record<PropertyKey, unknown>)[propertyKey];
            if (typeof candidate !== "function") {
                throw new Error(t("registry.methodRequired", {
                    kind: prompt ? "Prompt" : "Tool",
                    propertyKey: String(propertyKey),
                }));
            }

            const scope: McpHandlerScope = EditorEnv.extensionManager.loadingPackages ? "package" : "scene";
            this.server.upsertHandler(scope, {
                kind: prompt ? "prompt" : "tool",
                name: normalizedName,
                description: desc,
                params: normalizedParams,
                callback: candidate.bind(target) as McpHandlerCallback,
                access: normalizedOptions.access ?? "write",
                ...(normalizedOptions.actionAccess
                    ? { actionAccess: { ...normalizedOptions.actionAccess } }
                    : {}),
            });
        };
    }

    private normalizeName(name: string): string {
        const normalized = name.trim();
        if (!normalized) throw new Error(t("registry.nameRequired"));
        return normalized;
    }

    private normalizeDefinition(
        descOrParams: string | McpParams | undefined,
        paramsOrOptions: McpParams | IMcpToolOptions | undefined,
        options: IMcpToolOptions | undefined,
        prompt: boolean,
    ): { desc: string; normalizedParams: McpParams; normalizedOptions: IMcpToolOptions } {
        if (typeof descOrParams === "object") {
            return {
                desc: "",
                normalizedParams: descOrParams,
                normalizedOptions: prompt ? { access: "read" } : this.asToolOptions(paramsOrOptions),
            };
        }
        return {
            desc: descOrParams ?? "",
            normalizedParams: this.asParams(paramsOrOptions),
            normalizedOptions: prompt ? { access: "read" } : (options ?? {}),
        };
    }

    private asParams(value: McpParams | IMcpToolOptions | undefined): McpParams {
        if (!value || isToolOptions(value)) return {};
        return value as McpParams;
    }

    private asToolOptions(value: McpParams | IMcpToolOptions | undefined): IMcpToolOptions {
        if (value && isToolOptions(value)) return value;
        return {};
    }
}

function isToolOptions(value: McpParams | IMcpToolOptions): value is IMcpToolOptions {
    const keys = Object.keys(value);
    if (keys.some((key) => key !== "access" && key !== "actionAccess")) return false;
    const access = (value as IMcpToolOptions).access;
    const actionAccess = (value as IMcpToolOptions).actionAccess;
    return (access === undefined || isMcpToolAccess(access))
        && (actionAccess === undefined
            || (actionAccess !== null
                && !Array.isArray(actionAccess)
                && typeof actionAccess === "object"
                && Object.values(actionAccess).every(isMcpToolAccess)));
}

function isMcpToolAccess(value: unknown): value is Exclude<McpToolOptionsAccess, undefined> {
    return value === "read"
        || value === "write"
        || value === "delete"
        || value === "execute";
}

type McpToolOptionsAccess = IMcpToolOptions["access"];
