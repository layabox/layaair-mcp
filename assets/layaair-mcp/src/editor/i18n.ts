const diagnostics = {
    "mcpEditor.callbackMissing": "MCP Editor callback not found: {{id}}",
    "mcpEditor.decoratorMethodRequired": "MCP {{kind}} must decorate a method: {{property}}",
    "mcpEditor.nameRequired": "MCP Tool/Prompt name is required",
    "mcpEditor.syncRequestIdRequired": "The Scene MCP synchronization request is missing requestId",
    "mcpEditor.snapshotNotReady": "The Editor MCP registration snapshot is not ready",
    "mcpEditor.confirmationPending": "MCP Editor tool synchronization confirmation has not yet reached Scene",
    "mcpEditor.syncFailed": "MCP Editor tool synchronization failed because the Scene service is not ready",
    "mcpEditor.lifecycleReplaced": "Editor MCP synchronization was superseded by a newer plugin lifecycle",
    "mcpEditor.syncTimeout": "Timed out waiting for the Scene MCP synchronization response",
    "mcpEditor.snapshotNotConfirmed": "Scene MCP has not confirmed the Editor snapshot"
} as const;

const en = {
    "serviceStarted": "MCP service started at"
};
const zhCN: Record<keyof typeof en, string> = {
    "serviceStarted": "MCP 服务已启动，连接地址"
};

let translate: (key: keyof typeof en) => string = (key) => en[key];

export function initializeEditorI18n(): void {
    const translations = gui.Translations.create("LayaAirStandaloneMcp", "en");
    translations.setContent("en", en).setContent("zh-CN", zhCN);
    translate = translations.t.bind(translations);
}

export function uiText(key: keyof typeof en): string {
    return translate(key);
}

export function t(key: keyof typeof diagnostics, values: Record<string, string> = {}): string {
    return diagnostics[key].replace(/\{\{(\w+)\}\}/g, (_, name: string) => values[name] ?? "");
}
