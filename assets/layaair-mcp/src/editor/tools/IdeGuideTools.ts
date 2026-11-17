import "../McpRegistry";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getPluginRoot } from "../PluginRoot";
import { toolError, toolSuccess, type ToolResult } from "./ToolSupport";

const API_PATTERNS_REFERENCE = "references/api-patterns.md";
const GUIDE_HEADINGS = new Map([
    ["panel-plugin", "1. Panel Plugin"],
    ["react-ui", "2. React UI Guide"],
    ["react-components", "Built-in React Components (`IEditor.React`)"],
    ["graph-editors", "Graph Editors: `IEditor.Flow` and `IEditor.StateGraph`"],
    ["timeline-editor", "Timeline Editor (`IEditor.Timeline`)"],
    ["themes", "Built-in Theme Reference"],
    ["menu-plugin", "3. Menu Plugin"],
    ["dialog", "4. Dialog"],
    ["inspector-field", "5. Custom Inspector Field"],
    ["inspector-layout", "6. Inspector Layout"],
    ["settings", "7. Settings & Preferences"],
    ["build-plugin", "8. Build Plugin"],
    ["build-target", "9. Custom Build Target"],
    ["asset-type", "10. Custom Asset Type"],
    ["asset-import-export", "11. Asset Import/Export"],
    ["asset-preview", "12. Asset Thumbnail & Preview"],
    ["asset-processor", "13. Asset Processor"],
    ["scene-hook", "14. Scene Hook"],
    ["gizmos", "15. Custom Editor (Gizmos)"],
    ["asset-database", "16. Asset Database API"],
    ["create-asset-util", "CreateAssetUtil"],
    ["plugin-communication", "17. Cross-Process Communication"],
    ["scene-editing", "Editing the Active Scene"],
    ["i18n", "18. I18n Support"],
    ["scriptable-object", "19. ScriptableObject (`.sco`) Data Assets"],
    ["package-precompilation", "20. Package Precompilation"],
    ["frame-debugger-profiler", "21. Frame Debugger & Profiler"],
    ["status-bar", "22. Plugin Status-Bar Entry"],
    ["decorators", "Decorator Quick Reference"],
    ["property-decorators", "Property Decorator Options"],
    ["panel-options", "Panel Options Reference"],
]);
const TOPIC_NAMES = ["overview", "api-patterns", ...GUIDE_HEADINGS.keys()].join(" | ");

export class IdeGuideTools {
    @IEditor.mcp.tool("LayaAir_GetIdeGuide",
        "Read a topic from the bundled layaair-ide-plugin Skill. Choose an IDE plugin capability from topic, or use api-patterns to list all reference section titles. Use LayaAir_GetApi for exact API signatures.", {
            topic: { type: "string", required: true, desc: TOPIC_NAMES },
            section: {
                type: "string",
                desc: "Exact section or subsection title within the selected topic. For api-patterns, omit to list all available titles.",
            },
        }, { access: "read" })
    static async readGuide(topic = "", section = ""): Promise<ToolResult<string>> {
        const name = topic.trim();
        const heading = GUIDE_HEADINGS.get(name);
        if (!heading && name !== "overview" && name !== "api-patterns")
            return toolError(`Unknown IDE guide topic. Choose ${TOPIC_NAMES}.`);

        try {
            const root = await getPluginRoot();
            const file = name === "overview" ? "SKILL.md" : API_PATTERNS_REFERENCE;
            const guide = await readFile(join(root, "bundled_skills~", "layaair-ide-plugin", file), "utf8");
            const requestedSection = section.trim();
            if (name === "overview" && !requestedSection) return toolSuccess(guide);

            const selection = readSection(guide.replace(/\r\n/g, "\n"), heading ?? requestedSection);
            if (!heading || !requestedSection || selection.data === undefined) return selection;
            return readSection(selection.data, requestedSection);
        } catch (error) {
            return toolError(error);
        }
    }
}

function readSection(guide: string, heading: string): ToolResult<string> {
    const headings = [...guide.matchAll(/^(#{2,6}) (.+)$/gm)];
    if (!heading) {
        return toolSuccess(headings.map(([, marker, title]) => `${"  ".repeat(marker.length - 2)}- ${title}`).join("\n"));
    }

    const index = headings.findIndex(([, , title]) => title === heading);
    const start = headings[index];
    if (!start) return toolError(`Unknown IDE guide section "${heading}". Call api-patterns without section to list the titles.`);
    const next = headings.slice(index + 1).find(([, marker]) => marker.length <= start[1].length);
    return toolSuccess(guide.slice(start.index, next?.index).trimEnd());
}
