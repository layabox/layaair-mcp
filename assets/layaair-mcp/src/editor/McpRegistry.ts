import { randomUUID } from "crypto";
import { t } from "./i18n";
import type {
    McpEditorCallbackInvocation,
    McpEditorHandlerSnapshot,
    McpEditorHandlerSnapshotItem,
} from "../shared/contracts";
import type { IMcpParamSchema, IMcpPlugin, IMcpToolOptions } from "../shared/types";

type McpParams = Record<string, string | IMcpParamSchema>;
type McpHandlerCallback = (...args: unknown[]) => unknown;

export class EditorMcpRegistry {
    private readonly handlers = new Map<string, McpEditorHandlerSnapshotItem>();
    private readonly callbacks = new Map<string, McpHandlerCallback>();
    private changeListener: (() => void) | undefined;

    readonly api: IMcpPlugin = {
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

    getHandlerSnapshot(revision: number): McpEditorHandlerSnapshot {
        return { version: 2, revision, handlers: [...this.handlers.values()] };
    }

    registerContribution(register: (registrar: IMcpPlugin) => void): () => void {
        const contributed = new Map<string, string>();
        const own = (kind: "tool" | "prompt", name: string, apply: MethodDecorator): MethodDecorator =>
            (target, propertyKey, descriptor) => {
                const key = `${kind}:${name.trim()}`;
                if (this.handlers.has(key)) throw new Error(`MCP handler already registered: ${name}`);
                apply(target, propertyKey, descriptor);
                contributed.set(key, this.handlers.get(key)!.callbackId);
            };
        const unregister = () => {
            for (const [key, callbackId] of contributed) {
                if (this.handlers.get(key)?.callbackId !== callbackId) continue;
                this.handlers.delete(key);
                this.callbacks.delete(callbackId);
            }
            this.changeListener?.();
        };
        try {
            register({
                tool: ((name, ...args) => own("tool", name, Reflect.apply(this.api.tool, this.api, [name, ...args]))) as IMcpPlugin["tool"],
                prompt: ((name, ...args) => own("prompt", name, Reflect.apply(this.api.prompt, this.api, [name, ...args]))) as IMcpPlugin["prompt"],
            });
        } catch (error) {
            unregister();
            throw error;
        }
        return unregister;
    }

    invokeCallback(invocation: McpEditorCallbackInvocation): unknown {
        const callback = this.callbacks.get(invocation.callbackId);
        if (!callback) throw new Error(t("mcpEditor.callbackMissing", { id: invocation.callbackId }));
        return callback(...invocation.args);
    }

    setChangeListener(listener: (() => void) | undefined): void {
        this.changeListener = listener;
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
                throw new Error(t("mcpEditor.decoratorMethodRequired", {
                    kind: prompt ? "Prompt" : "Tool",
                    property: String(propertyKey),
                }));
            }

            // 名称同时作为稳定回调 ID。IDE 刷新后即使 Scene 侧短暂保留旧快照，
            // 回调仍能命中新 Editor 进程中的同名方法。
            const registrationKey = `${prompt ? "prompt" : "tool"}:${normalizedName}`;
            const previous = this.handlers.get(registrationKey);
            if (previous) this.callbacks.delete(previous.callbackId);
            const callbackId = `${registrationKey}:${randomUUID()}`;
            this.callbacks.set(callbackId, candidate.bind(target) as McpHandlerCallback);
            this.handlers.set(registrationKey, {
                kind: prompt ? "prompt" : "tool",
                name: normalizedName,
                description: desc,
                params: normalizedParams,
                callbackId,
                access: normalizedOptions.access ?? "write",
                ...(normalizedOptions.actionAccess
                    ? { actionAccess: { ...normalizedOptions.actionAccess } }
                    : {}),
            });
            this.changeListener?.();
        };
    }

    private normalizeName(name: string): string {
        const normalized = name.trim();
        if (!normalized) throw new Error(t("mcpEditor.nameRequired"));
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

export const editorMcpRegistry = new EditorMcpRegistry();
IEditor.mcp = editorMcpRegistry.api;
IEditor.standaloneMcp = editorMcpRegistry.api;

