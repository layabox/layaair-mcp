import type { ZodType } from "zod";
import { z } from "./McpSdk";
import type { IMcpParamSchema } from "./contracts";

export function toZodType(schema: IMcpParamSchema, requiredOverride?: boolean): ZodType {
    let type: ZodType;
    if (schema.type === "array") {
        type = z.array(schema.items ? toZodType(schema.items, true) : z.string());
    }
    else if (schema.type === "object") {
        const shape: Record<string, ZodType> = {};
        const requiredNames = Array.isArray(schema.required) ? schema.required : undefined;
        for (const [name, property] of Object.entries(schema.properties ?? {})) {
            const propertyRequired = requiredNames?.includes(name)
                ?? (typeof property === "object" && property.required === true);
            shape[name] = typeof property === "object"
                ? toZodType(property, propertyRequired)
                : optionalUnlessRequired(z.string().describe(property), propertyRequired);
        }
        const objectType = z.object(shape);
        type = schema.additionalProperties ? objectType.passthrough() : objectType;
    }
    else {
        switch (schema.type) {
            case "number": type = z.number(); break;
            case "int": type = z.number().int(); break;
            case "boolean": type = z.boolean(); break;
            default: type = z.string(); break;
        }
    }

    type = optionalUnlessRequired(type, requiredOverride ?? schema.required === true);
    const description = schema.desc || schema.description;
    if (description) type = type.describe(description);
    return type;
}

function optionalUnlessRequired(type: ZodType, required: boolean): ZodType {
    return required ? type : type.optional();
}
