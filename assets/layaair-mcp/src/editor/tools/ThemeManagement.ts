import { getThemeManager, type ThemeInstallation, type ThemeManager, type ThemeMode } from "../IdeCapabilities";
import {
    asBoolean,
    asRecord,
    asString,
    toSerializable,
    toolError,
    toolSuccess,
    type ToolResult,
} from "./ToolSupport";

const THEME_ACTION_ACCESS = {
    getState: "read",
    getSchema: "read",
    listThemes: "read",
    applyExisting: "write",
    installAndApply: "write",
} as const;

export class ThemeManagement {
    static register(): void {
        if (!getThemeManager()) return;
        IEditor.mcp.tool("ThemeManagement", "Use this tool whenever the user asks to inspect, switch, create, generate, modify, install, or apply the current LayaAir IDE theme, color scheme, or appearance, including requests such as 'give the IDE a Genshin Impact theme'. Operate the IDE directly with this tool; do not create or edit project plugin files. For a described visual style, choose a concise name and ID when the user does not provide them, then call installAndApply with one single-mode ThemeDefinition JSON object. Reuse the same custom mode and ID to modify it. Use getSchema when exact schema or override-token details are needed.", {
            action: {
                type: "string",
                required: true,
                desc: "getState | getSchema | listThemes | applyExisting | installAndApply",
            },
            params: {
                type: "object",
                desc: "Theme action parameters",
                properties: {
                    mode: { type: "string", desc: "dark | light; required by applyExisting and optional for listThemes" },
                    id: { type: "string", desc: "Registered theme ID required by applyExisting" },
                    definition: {
                        type: "object",
                        required: ["schemaVersion", "id", "name", "mode", "recipe"],
                        additionalProperties: false,
                        desc: "A ThemeDefinition JSON object returned according to getSchema; required by installAndApply",
                        properties: {
                            $schema: { type: "string", desc: "Optional JSON Schema URI" },
                            schemaVersion: { type: "int", desc: "Must be 1" },
                            id: { type: "string", desc: "Lowercase identifier using letters, digits, dots, underscores, or hyphens; do not use a built-in ID" },
                            name: { type: "string", desc: "User-facing theme name" },
                            description: { type: "string", desc: "Optional short theme description" },
                            author: { type: "string", desc: "Optional author name" },
                            mode: { type: "string", desc: "dark | light" },
                            recipe: {
                                type: "object",
                                required: ["accent"],
                                additionalProperties: false,
                                desc: "Deterministic palette generation inputs",
                                properties: {
                                    accent: { type: "string", desc: "Six-digit hexadecimal accent color such as #4f8cff" },
                                    contrast: { type: "number", desc: "0..100; defaults to 50" },
                                    surfaceOffset: { type: "number", desc: "-0.15..0.15; defaults to 0" },
                                    borderOffset: { type: "number", desc: "-0.15..0.15; defaults to surfaceOffset * 0.72" },
                                    bodyOffset: { type: "number", desc: "-0.15..0.15; defaults to surfaceOffset" },
                                    surfaceTint: { type: "number", desc: "0..1.25; defaults to 1" },
                                },
                            },
                            overrides: {
                                type: "object",
                                additionalProperties: true,
                                desc: "Optional registered semantic color-token overrides; prefer recipe unless exact tokens are known",
                            },
                        },
                    },
                    replace: {
                        type: "boolean",
                        desc: "Whether installAndApply may replace an existing custom theme with the same mode/id; defaults to true",
                    },
                },
            },
        }, { access: "write", actionAccess: THEME_ACTION_ACCESS })(this, "execute", { value: this.execute });
    }

    static async execute(action: string, input?: unknown): Promise<ToolResult<unknown>> {
        const params = asRecord(input);
        try {
            const manager = getThemeManager();
            if (!manager) return toolError("THEME_UNAVAILABLE: The IDE theme API is unavailable");
            switch (action) {
                case "getState":
                    return toolSuccess(this.getState(manager));
                case "getSchema":
                    return toolSuccess({
                        schemaVersion: manager.schemaVersion,
                        schema: toSerializable(manager.jsonSchema),
                    });
                case "listThemes":
                    return this.listThemes(manager, asString(params.mode));
                case "applyExisting":
                    return this.applyExisting(manager, asString(params.mode), asString(params.id));
                case "installAndApply":
                    if (!("definition" in params)) return toolError("definition is required by installAndApply");
                    return this.installAndApply(manager, params.definition, asBoolean(params.replace, true));
                default:
                    return toolError(`Unknown ThemeManagement action: ${action}`);
            }
        }
        catch (error) {
            return toolError(error);
        }
    }

    private static listThemes(manager: ThemeManager, modeValue: string): ToolResult<unknown> {
        const mode = parseThemeMode(modeValue);
        if (modeValue && !mode) return toolError(`Invalid theme mode: ${modeValue}`);
        return toolSuccess(toSerializable(manager.getThemeDefinitions(mode)));
    }

    private static applyExisting(manager: ThemeManager, modeValue: string, id: string): ToolResult<unknown> {
        const mode = parseThemeMode(modeValue);
        if (!mode) return toolError("mode must be dark or light");
        if (!id) return toolError("id is required by applyExisting");

        const definition = manager.getThemeDefinition(mode, id);
        if (definition.id !== id) return toolError(`Theme not found: ${mode}:${id}`);
        return toolSuccess(this.activate(manager, mode, id));
    }

    private static installAndApply(manager: ThemeManager, definition: unknown, replace: boolean): ToolResult<unknown> {
        const result = manager.installTheme(definition, replace);
        if (!result.ok || !result.definition) return toolError(formatThemeOperationError(result));

        const state = this.activate(manager, result.definition.mode, result.definition.id);
        return toolSuccess({
            installedTheme: toSerializable(result.definition),
            diagnostics: toSerializable(result.diagnostics),
            state,
        });
    }

    private static activate(manager: ThemeManager, mode: ThemeMode, id: string): Record<string, unknown> {
        manager.setThemePreference(mode);
        manager.setAccentPreset(id);
        return this.getState(manager);
    }

    private static getState(manager: ThemeManager): Record<string, unknown> {
        const resolvedMode = manager.getTheme();
        return {
            preference: manager.getThemePreference(),
            resolvedMode,
            activeTheme: toSerializable(manager.getThemeDefinition(resolvedMode, manager.getAccentPreset())),
        };
    }

}

function parseThemeMode(value: string): ThemeMode | undefined {
    return value === "dark" || value === "light" ? value : undefined;
}

function formatThemeOperationError(result: ThemeInstallation): string {
    const details = result.diagnostics.map((diagnostic) => (
        diagnostic.path ? `${diagnostic.path}: ${diagnostic.message}` : diagnostic.message
    ));
    return details.join("\n") || "Theme operation failed";
}
