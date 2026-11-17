import type { McpToolAccess } from "../../shared/types";

export type McpAuditOutcome = "allowed" | "denied" | "failed";

export interface McpAuditEvent {
    timestamp: string;
    toolName: string;
    access: McpToolAccess;
    source: "scene" | "editor" | "package";
    outcome: McpAuditOutcome;
    reason?: string;
}

export interface McpAuditSink {
    record(event: McpAuditEvent): void;
}

const AUDIT_REASON_DESCRIPTIONS: Readonly<Record<string, string>> = {
    "caller-managed": "The local MCP client manages approval.",
    "auto-authorized": "Automatically authorized.",
    "user-allowed": "The user allowed this operation.",
    "user-denied": "The user denied this operation.",
    "timeout": "The permission request timed out without a user decision.",
    "ui-unavailable": "The permission UI is unavailable or shutting down. Wait for the plugin to finish loading, then retry in the IDE.",
    "host-error": "The permission host could not process the request.",
    "missing-authorization": "No matching authorization was granted.",
};

export class ConsoleMcpAuditSink implements McpAuditSink {
    record(event: McpAuditEvent): void {
        const writer = event.outcome === "allowed" ? console.debug : console.warn;
        const description = event.reason && Object.hasOwn(AUDIT_REASON_DESCRIPTIONS, event.reason)
            ? AUDIT_REASON_DESCRIPTIONS[event.reason]
            : undefined;
        const reason = event.reason
            ? ` reason=${JSON.stringify(event.reason)}${description ? `: ${description}` : ""}`
            : "";
        writer(`[layaair-mcp-audit] ${event.outcome}: tool=${JSON.stringify(event.toolName)} access=${event.access} source=${event.source}${reason} timestamp=${event.timestamp}`);
    }
}
