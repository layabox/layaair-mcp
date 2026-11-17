import type { IMcpParamSchema, IMcpPlugin } from "../../shared/types";
import { apiKnowledge, type ApiKnowledgeRequest, type ApiKnowledgeResponse } from "../ApiKnowledge";
import { asRecord, asString, toolError, toolSuccess, type ToolResult } from "./ToolSupport";

type ApiSourceDomain = NonNullable<ApiKnowledgeRequest["sourceDomain"]>;
type ApiDiffType = NonNullable<ApiKnowledgeRequest["diffType"]>;

const HIERARCHY_ID_GUIDANCE =
    "In .ls/.lh hierarchies, new node _$id values are random 8-character strings from 0-9a-z; non-singleton component IDs use 4 characters. Put semantic labels in name and preserve existing IDs and reference targets";

const registrations: Array<(registrar: IMcpPlugin) => void> = [];

function knowledgeTool(name: string, description: string, parameters: Record<string, string | IMcpParamSchema>, options: { access: "read" }): MethodDecorator {
    return (target, key, descriptor) => {
        registrations.push((registrar) => registrar.tool(name, description, parameters, options)(target, key, descriptor));
    };
}

export function registerApiKnowledgeTools(registrar: IMcpPlugin): void {
    for (const register of registrations) register(registrar);
}

export class ApiKnowledgeTools {
    @knowledgeTool("LayaAir_ListApiVersions", "List the LayaAir API declaration versions available in the local knowledge base", {}, { access: "read" })
    static listVersions(): Promise<ToolResult<ApiKnowledgeResponse>> {
        return this.query({ command: "versions" });
    }

    @knowledgeTool("LayaAir_SearchApi", "Search a specified LayaAir/LayaAirIDE API version by name or keyword", {
        query: { type: "string", required: true, desc: "API name, fully qualified name, or keyword" },
        api_version: { type: "string", desc: "LayaAir version; defaults to the current IDE version" },
        domain: { type: "string", desc: "engine-runtime | ide | support" },
        kind: { type: "string", desc: "Symbol kind, such as class, interface, method, or property" },
        owner: { type: "string", desc: "Search only direct members of the specified class or interface" },
        limit: { type: "int", desc: "Maximum number of results, from 1 to 100" },
    }, { access: "read" })
    static searchApi(
        query: string,
        apiVersion?: string,
        domain?: string,
        kind?: string,
        owner?: string,
        limit?: number,
    ): Promise<ToolResult<ApiKnowledgeResponse>> {
        return this.query({
            command: "search", value: query, apiVersion,
            sourceDomain: sourceDomain(domain), kind, owner, limit,
        });
    }

    @knowledgeTool("LayaAir_GetApi", "Get the signature, documentation, parameters, relationships, and declaration evidence for a known exact LayaAir API symbol. Use exact spelling for qualified names. When the result includes runtimeName, use that exact name in code. fullyQualifiedName identifies the declaration. For an unknown name or NOT_FOUND, use LayaAir_SearchApi with a short member name and owner or domain when known.", {
        symbol: { type: "string", required: true, desc: "Symbol ID, fully qualified name, or exact name" },
        api_version: { type: "string", desc: "LayaAir version; defaults to the current IDE version" },
    }, { access: "read" })
    static getApi(symbol: string, apiVersion?: string): Promise<ToolResult<ApiKnowledgeResponse>> {
        return this.query({ command: "get", value: symbol, apiVersion });
    }

    @knowledgeTool("LayaAir_GetApiMembers", "List members of a class or interface. Use detail=summary when exploring available members and reuse the returned signatures. For details of a known member, use LayaAir_GetApi.", {
        symbol: { type: "string", required: true, desc: "Symbol ID, fully qualified name, or exact name of a class or interface" },
        api_version: { type: "string", desc: "LayaAir version; defaults to the current IDE version" },
        domain: { type: "string", desc: "engine-runtime | ide | support" },
        kind: { type: "string", desc: "Optional member kind, such as method or property" },
        inherited: { type: "boolean", desc: "Whether to include inherited members" },
        limit: { type: "int", desc: "Maximum number of results, from 1 to 100" },
        detail: { type: "string", desc: "summary for qualified names, signatures, and brief documentation; full for all member fields (default)" },
    }, { access: "read" })
    static async getMembers(
        symbol: string,
        apiVersion?: string,
        domain?: string,
        kind?: string,
        inherited?: boolean,
        limit?: number,
        detail?: string,
    ): Promise<ToolResult<ApiKnowledgeResponse>> {
        if (detail !== undefined && detail !== "summary" && detail !== "full") {
            return toolError("detail must be summary or full");
        }
        const result = await this.query({
            command: "members", value: symbol, apiVersion,
            sourceDomain: sourceDomain(domain), kind, inherited, limit,
        });
        const data = result.data;
        if (detail !== "summary" || !data || !Array.isArray(data.members)) return result;
        return toolSuccess({ ...data, members: data.members.map(summarizeMember) });
    }

    @knowledgeTool("LayaAir_GetApiInheritance", "Get ancestors or derived types for a LayaAir class or interface", {
        symbol: { type: "string", required: true, desc: "Symbol ID, fully qualified name, or exact name of a class or interface" },
        api_version: { type: "string", desc: "LayaAir version; defaults to the current IDE version" },
        domain: { type: "string", desc: "engine-runtime | ide | support" },
        direction: { type: "string", desc: "ancestors | descendants; defaults to ancestors" },
        max_depth: { type: "int", desc: "Maximum inheritance depth, from 1 to 20" },
        limit: { type: "int", desc: "Maximum number of results, from 1 to 100" },
    }, { access: "read" })
    static getInheritance(
        symbol: string,
        apiVersion?: string,
        domain?: string,
        direction?: string,
        maxDepth?: number,
        limit?: number,
    ): Promise<ToolResult<ApiKnowledgeResponse>> {
        return this.query({
            command: "inheritance", value: symbol, apiVersion,
            sourceDomain: sourceDomain(domain), direction: inheritanceDirection(direction), maxDepth, limit,
        });
    }

    @knowledgeTool("LayaAir_CompareApiVersions", "Compare additions, removals, signature changes, and other differences between two local LayaAir API versions", {
        from_version: { type: "string", required: true, desc: "Older source version" },
        to_version: { type: "string", required: true, desc: "Newer target version" },
        name: { type: "string", desc: "Optional class, interface, or API name; limits comparison to that scope" },
        diff_type: { type: "string", desc: "all | class | method | property" },
        domain: { type: "string", desc: "engine-runtime | ide | support" },
        limit: { type: "int", desc: "Maximum number of changes returned, from 1 to 100" },
    }, { access: "read" })
    static compareVersions(
        fromVersion: string,
        toVersion: string,
        name?: string,
        diffType?: string,
        domain?: string,
        limit?: number,
    ): Promise<ToolResult<ApiKnowledgeResponse>> {
        return this.query({
            command: "compare-versions", value: name,
            fromVersion, toVersion, diffType: apiDiffType(diffType),
            sourceDomain: sourceDomain(domain), limit,
        });
    }

    @knowledgeTool("LayaAir_ResolveApiLocation", "Resolve the versioned evidence location of an API symbol in local declaration data", {
        symbol: { type: "string", required: true, desc: "Symbol ID, fully qualified name, or exact name" },
        api_version: { type: "string", desc: "LayaAir version; defaults to the current IDE version" },
    }, { access: "read" })
    static resolveLocation(symbol: string, apiVersion?: string): Promise<ToolResult<ApiKnowledgeResponse>> {
        return this.query({ command: "resolve-location", value: symbol, apiVersion });
    }

    @knowledgeTool("LayaAir_SearchComponentSchema", "Search local serialization schemas for scene nodes and components", {
        query: { type: "string", desc: "Node or component name, or a description keyword; omit to list candidates" },
        world_type: { type: "string", desc: "2d | 3d" },
        limit: { type: "int", desc: "Maximum number of results, from 1 to 100" },
    }, { access: "read" })
    static searchSchema(
        query?: string,
        worldType?: string,
        limit?: number,
    ): Promise<ToolResult<ApiKnowledgeResponse>> {
        return this.query({
            command: "schema-search", value: query,
            worldType: schemaWorldType(worldType), limit,
        });
    }

    @knowledgeTool("LayaAir_GetComponentSchema", `Get an exact node or component schema, optionally expanding inherited properties. ${HIERARCHY_ID_GUIDANCE}`, {
        name: { type: "string", required: true, desc: "Node or component type name" },
        inherited: { type: "boolean", desc: "Whether to return the inheritance chain and all effective properties" },
    }, { access: "read" })
    static getSchema(
        name: string,
        inherited?: boolean,
    ): Promise<ToolResult<ApiKnowledgeResponse>> {
        return this.query({ command: "schema-get", value: name, inherited });
    }

    @knowledgeTool("LayaAir_GetComponentSchemaDescendants", "Get derived types for a specified node or component schema", {
        name: { type: "string", required: true, desc: "Base node or component name" },
        max_depth: { type: "int", desc: "Maximum descendant depth, from 1 to 20" },
        limit: { type: "int", desc: "Maximum number of results, from 1 to 100" },
        include_properties: { type: "boolean", desc: "Whether to include all properties for each derived type" },
    }, { access: "read" })
    static getSchemaDescendants(
        name: string,
        maxDepth?: number,
        limit?: number,
        includeProperties?: boolean,
    ): Promise<ToolResult<ApiKnowledgeResponse>> {
        return this.query({
            command: "schema-descendants", value: name,
            maxDepth, limit, includeProperties,
        });
    }

    private static async query(
        request: ApiKnowledgeRequest,
    ): Promise<ToolResult<ApiKnowledgeResponse>> {
        try {
            validateRequestBounds(request);
            return toolSuccess(await apiKnowledge.query(request));
        }
        catch (error) {
            return toolError(error);
        }
    }
}

function summarizeMember(value: unknown): Record<string, string> {
    const member = asRecord(value);
    const [paragraph] = asString(member.documentation).split(/(?:^|\r?\n)\s*@|\r?\n\s*\r?\n/, 1);
    const brief = paragraph.trim().replace(/\s+/g, " ");
    return {
        fullyQualifiedName: asString(member.fullyQualifiedName),
        signature: asString(member.signature),
        documentation: brief.length > 240 ? `${brief.slice(0, 239)}…` : brief,
    };
}

function validateRequestBounds(request: ApiKnowledgeRequest): void {
    validateBoundedInteger(request.limit, "limit", 100);
    validateBoundedInteger(request.maxDepth, "max_depth", 20);
}

function validateBoundedInteger(value: number | undefined, name: string, maximum: number): void {
    if (value === undefined) return;
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
        throw new Error(`${name} must be an integer from 1 to ${maximum}`);
    }
}

function sourceDomain(value?: string): ApiSourceDomain | undefined {
    if (value === undefined || value === "") return undefined;
    if (value === "engine-runtime" || value === "ide" || value === "support") return value;
    throw new Error("domain must be engine-runtime, ide, or support");
}

function inheritanceDirection(value?: string): "ancestors" | "descendants" | undefined {
    if (value === undefined || value === "") return undefined;
    if (value === "ancestors" || value === "descendants") return value;
    throw new Error("direction must be ancestors or descendants");
}

function apiDiffType(value?: string): ApiDiffType | undefined {
    if (value === undefined || value === "") return undefined;
    if (value === "all" || value === "class" || value === "method" || value === "property") return value;
    throw new Error("diff_type must be all, class, method, or property");
}

function schemaWorldType(value?: string): "2d" | "3d" | undefined {
    if (value === undefined || value === "") return undefined;
    const normalized = value.toLowerCase();
    if (normalized === "2d" || normalized === "3d") return normalized;
    throw new Error("world_type must be 2d or 3d");
}
