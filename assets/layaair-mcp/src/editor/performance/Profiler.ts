import { getProfiler, type ProfilerOptions } from "../IdeCapabilities";
import { asRecord, toolError, toolSuccess, type ToolResult } from "../tools/ToolSupport";

export class Profiler {
    static register(): void {
        if (!getProfiler()) return;
        IEditor.mcp.tool("Profiler", "Collect CPU-zone and frame timing statistics with Tracy. Requires an open scene and the IDE preview server. Shares the Profiler panel session. Workflow: start, exercise the workload, stop, exportReport, dispose. Reports exclude GPU, memory, locks and call stacks.", {
            action: { type: "string", required: true, desc: "getState | connect | start | stop | exportReport | dispose" },
            params: {
                type: "object",
                properties: {
                    target: { type: "string", desc: "editor | browser | emulator | remote. connect defaults to editor; start without options retains the prepared target. For browser, connect before opening the browser preview, then start without options." },
                    remoteAddress: { type: "string", desc: "Required for target remote: host, host:port, or tcp://host:port; default port 8086" },
                    maxZones: { type: "int", desc: "exportReport: maximum CPU source-location groups sorted by total self time, 1-10000; default 100. Stop first for a stable snapshot." },
                },
            },
        }, {
            access: "execute",
            actionAccess: {
                getState: "read", connect: "execute", start: "execute", stop: "execute",
                exportReport: "read", dispose: "execute",
            },
        })(this, "execute", { value: this.execute });
    }

    static async execute(action: string, input?: unknown): Promise<ToolResult<unknown>> {
        try {
            const profiler = getProfiler();
            if (!profiler) return toolError("PROFILER_UNAVAILABLE: The IDE profiler feature-pack is not loaded");
            const params = asRecord(input);
            switch (action) {
                case "getState": return toolSuccess(profiler.state);
                case "connect": await profiler.connect(this.targetOptions(params)); break;
                case "start": await profiler.start(this.targetOptions(params)); break;
                case "stop": await profiler.stop(); break;
                case "exportReport": {
                    const maxZones = params.maxZones ?? 100;
                    if (typeof maxZones !== "number" || !Number.isSafeInteger(maxZones) || maxZones < 1 || maxZones > 10000) {
                        return toolError("maxZones must be an integer from 1 to 10000");
                    }
                    return toolSuccess(await profiler.exportReport({ maxZones }));
                }
                case "dispose": await profiler.dispose(); break;
                default: return toolError(`Unknown Profiler action: ${action}`);
            }
            return toolSuccess(profiler.state);
        }
        catch (error) {
            return toolError(error);
        }
    }

    private static targetOptions(params: Record<string, unknown>): ProfilerOptions | undefined {
        if (params.target === undefined && params.remoteAddress === undefined) return undefined;
        const target = params.target ?? "editor";
        if (target !== "editor" && target !== "browser" && target !== "emulator" && target !== "remote") {
            throw new Error("target must be editor, browser, emulator, or remote");
        }
        if (params.remoteAddress !== undefined && typeof params.remoteAddress !== "string") {
            throw new Error("remoteAddress must be a string");
        }
        const remoteAddress = typeof params.remoteAddress === "string" ? params.remoteAddress : undefined;
        if (target === "remote" && !remoteAddress?.trim()) {
            throw new Error("remoteAddress is required for target remote");
        }
        if (target !== "remote" && remoteAddress !== undefined) {
            throw new Error("remoteAddress requires target remote");
        }
        return { target, remoteAddress };
    }
}
