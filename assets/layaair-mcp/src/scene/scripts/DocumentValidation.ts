import type { McpHierarchyValidationRequest, McpHierarchyValidationResult } from "../../shared/contracts";

@IEditorEnv.regClass()
export class StandaloneMcpDocumentValidation {
    static validate(request: McpHierarchyValidationRequest): McpHierarchyValidationResult {
        if (request.extension !== ".ls" && request.extension !== ".lh") {
            throw new Error("Only .ls scenes and .lh prefabs are supported");
        }
        return { errors: validateLayaDocument(request.document, request.extension) };
    }
}

export function validateLayaDocument(document: unknown, extension: string): string[] {
    if (extension !== ".ls" && extension !== ".lh") return [];
    if (document === null || typeof document !== "object" || Array.isArray(document)) {
        return ["Asset root must be a JSON object"];
    }
    return new IEditorEnv.HierarchyValidator().validate(document)
        .map((error) => `${error.path}: [${error.errorType}] ${error.errorMessage}`);
}
