import { spawn, type ChildProcess } from "node:child_process";
import { clearTimeout, setTimeout } from "node:timers";
export type ApiKnowledgeResponse = Record<string, unknown>;

const QUERY_TIMEOUT_MS = 6 * 60_000;

interface PendingQuery {
    timer: ReturnType<typeof setTimeout>;
    resolve: (result: ApiKnowledgeResponse) => void;
    reject: (error: Error) => void;
}

export class ApiKnowledgeQueryProcess {
    private child?: ChildProcess;
    private nextId = 0;
    private readonly pending = new Map<number, PendingQuery>();

    constructor(
        private readonly cli: string,
        private readonly projectPath: string,
        private readonly env: NodeJS.ProcessEnv,
    ) {}

    query(args: string[]): Promise<ApiKnowledgeResponse> {
        const child = this.child ?? this.start();
        const id = ++this.nextId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.close(child, new Error("API knowledge query timed out"));
            }, QUERY_TIMEOUT_MS);
            this.pending.set(id, { timer, resolve, reject });
            child.send({ id, args }, (error) => {
                if (error) this.close(child, error);
            });
        });
    }

    stop(): void {
        if (this.child) this.close(this.child, new Error("API knowledge service is not active"));
    }

    private start(): ChildProcess {
        const child = spawn(process.execPath, [this.cli, "query-process", "--project", this.projectPath], {
            cwd: this.projectPath,
            env: this.env,
            stdio: ["ignore", "ignore", "ignore", "ipc"],
            windowsHide: true,
        });
        this.child = child;
        child.on("message", (reply: unknown) => this.receive(child, reply));
        child.on("error", (error) => this.close(child, error));
        child.once("disconnect", () => this.close(child, new Error("API knowledge query process disconnected")));
        child.once("exit", (code, signal) => {
            this.close(child, new Error(`API knowledge query process exited (${signal ?? code})`));
        });
        return child;
    }

    private receive(child: ChildProcess, reply: unknown): void {
        if (this.child !== child || !reply || typeof reply !== "object"
            || !("id" in reply) || typeof reply.id !== "number") return;
        const pending = this.pending.get(reply.id);
        if (!pending) return;
        this.pending.delete(reply.id);
        clearTimeout(pending.timer);
        try {
            if ("error" in reply && reply.error && typeof reply.error === "object"
                && "error" in reply.error && typeof reply.error.error === "string"
                && "message" in reply.error && typeof reply.error.message === "string") {
                throw new Error(`${reply.error.error}: ${reply.error.message}`);
            }
            if (!("json" in reply) || typeof reply.json !== "string") {
                throw new Error("Invalid API knowledge query response");
            }
            pending.resolve(JSON.parse(reply.json) as ApiKnowledgeResponse);
        } catch (error) {
            pending.reject(error instanceof Error ? error : new Error(String(error)));
        }
    }

    private close(child: ChildProcess, error: Error): void {
        if (this.child !== child) return;
        this.child = undefined;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
        if (child.exitCode === null && child.signalCode === null) child.kill();
    }
}
