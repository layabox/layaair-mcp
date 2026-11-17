import { MCP_SCENE_COMMANDS, type McpServerStatus } from "../shared/contracts";
import { uiText } from "./i18n";

interface StatusBarItem {
    update(options: { visible: boolean; tooltip?: string }): void;
    dispose(): void;
}

interface StatusBar {
    createItem(id: string, options: {
        icon: string;
        text: string;
        visible: boolean;
        onClick: () => void;
    }): StatusBarItem;
}

class McpStatusBar {
    private item?: StatusBarItem;
    private endpoint: string | null = null;
    private revision = 0;

    start(): void {
        this.stop();
        const { statusBar } = Editor as typeof Editor & { statusBar?: StatusBar };
        if (typeof statusBar?.createItem !== "function") return;
        this.item = statusBar.createItem("com.layaair.mcp.status", {
            icon: "editorResources/layaair-mcp/mcp.svg",
            text: "MCP",
            visible: false,
            onClick: () => {
                if (this.endpoint) Editor.clipboard.writeText(this.endpoint);
            },
        });
        void this.restoreEndpoint(this.revision);
    }

    stop(): void {
        this.revision += 1;
        this.endpoint = null;
        this.item?.dispose();
        this.item = undefined;
    }

    setEndpoint(endpoint: string | null): boolean {
        if (!this.item) return false;
        this.revision += 1;
        this.endpoint = endpoint;
        this.item.update({
            visible: Boolean(endpoint),
            tooltip: endpoint ? `${uiText("serviceStarted")}\n${endpoint}` : undefined,
        });
        return true;
    }

    private async restoreEndpoint(revision: number): Promise<void> {
        try {
            const status: McpServerStatus | undefined = await Editor.sceneManager.runSceneScript(MCP_SCENE_COMMANDS.getServerStatus);
            if (revision === this.revision && status?.state === "running" && status.endpoint) {
                this.setEndpoint(status.endpoint);
            }
        } catch {
            // The Scene can still be loading. It reports the endpoint when ready.
        }
    }
}

export const mcpStatusBar = new McpStatusBar();
