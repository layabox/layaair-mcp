export interface IMcpParamSchema {
    /**
     * The type of the parameter, which can be one of the predefined property types.
     */
    type?: "string" | "int" | "number" | "boolean" | "array" | "object";

    /**
     * Indicates whether the parameter is required or optional. Default is false.
     * 
     * If it is an array, the elements of the array are the names of the parameters that are required.
     */
    required?: boolean | string[];

    /**
     * A description of the parameter. Short form for description.
     */
    desc?: string;
    /**
     * A description of the parameter.
     */
    description?: string;

    /**
     * If type is "array", this property defines the type of the elements in the array.
     */
    items?: IMcpParamSchema;

    /**
     * If type is "object", this property defines the properties of the object.
     */
    properties?: Record<string, string | IMcpParamSchema>;

    /**
     * Preserve object keys that are not explicitly declared in `properties`.
     * Use this only for intentionally open-ended option bags.
     */
    additionalProperties?: boolean;
}

export type McpToolAccess = "read" | "write" | "delete" | "execute";

export interface McpToolPermissionQuery {
    toolName: string;
    access: McpToolAccess;
    source: "scene" | "editor" | "package";
}

/** Read-only status of the MCP service. */
export interface McpServerStatus {
    state: "starting" | "running" | "stopped";
    endpoint: string;
    agentGeneration?: string;
    toolCount: number;
    promptCount: number;
}
