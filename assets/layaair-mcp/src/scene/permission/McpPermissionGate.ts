import type { McpToolAccess } from "../../shared/types";
import type { McpToolPermissionResult } from "../../shared/contracts";
import { t } from "../i18n";
import {
    ConsoleMcpAuditSink,
    type McpAuditOutcome,
    type McpAuditSink,
} from "./McpAuditTrail";

export interface McpPermissionRequest {
    toolName: string;
    access: McpToolAccess;
    source: "scene" | "editor" | "package";
}

export interface McpPermissionAuthorizer {
    authorize(request: McpPermissionRequest, agentGeneration: string): boolean | McpToolPermissionResult | Promise<boolean | McpToolPermissionResult>;
}

class DenyMutationAuthorizer implements McpPermissionAuthorizer {
    authorize(): boolean {
        return false;
    }
}

export class McpPermissionDeniedError extends Error {
    constructor(readonly request: McpPermissionRequest) {
        super(t("permission.denied", {
            toolName: request.toolName,
            access: request.access,
        }));
        this.name = "McpPermissionDeniedError";
    }
}

export class McpPermissionGate {
    constructor(
        private readonly authorizer: McpPermissionAuthorizer = new DenyMutationAuthorizer(),
        private readonly audit: McpAuditSink = new ConsoleMcpAuditSink(),
    ) { }

    async assertAllowed(request: McpPermissionRequest, agentGeneration?: string): Promise<void> {
        if (request.access === "read") {
            this.record(request, "allowed");
            return;
        }

        // The MCP route admits only loopback connections. External clients handle their own approval.
        if (!agentGeneration) {
            this.record(request, "allowed", "caller-managed");
            return;
        }

        try {
            const authorization = await this.authorizer.authorize(request, agentGeneration);
            if (this.isAllowed(request, authorization)) {
                this.record(request, "allowed", typeof authorization === "boolean"
                    ? undefined
                    : authorization.reason);
                return;
            }
            const reason = typeof authorization === "boolean"
                ? "missing-authorization"
                : authorization.reason ?? "missing-authorization";
            this.record(request, "denied", reason);
            throw new McpPermissionDeniedError(request);
        }
        catch (error) {
            if (error instanceof McpPermissionDeniedError) throw error;
            this.record(request, "failed", error instanceof Error ? error.message : String(error));
            throw error;
        }
    }

    private isAllowed(
        request: McpPermissionRequest,
        authorization: boolean | McpToolPermissionResult,
    ): boolean {
        if (typeof authorization === "boolean") return authorization;
        return authorization.decision === "allow"
            && authorization.toolName === request.toolName
            && authorization.access === request.access
            && authorization.source === request.source;
    }

    private record(request: McpPermissionRequest, outcome: McpAuditOutcome, reason?: string): void {
        this.audit.record({
            timestamp: new Date().toISOString(),
            toolName: request.toolName,
            access: request.access,
            source: request.source,
            outcome,
            reason,
        });
    }
}
