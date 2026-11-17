# LayaAir MCP

让 AI 助手连接当前打开的 LayaAir IDE 项目。你可以用自然语言让助手查找资源引用、创建预制体，或启动游戏预览、截图并读取运行日志，在同一次对话里完成修改和验证。

## 主要功能

- **场景与预制体**：打开和保存场景，查询组件信息，创建 2D、3D 或 UI 预制体，也可以将现有节点保存为预制体。
- **项目资源与构建**：新建和整理项目资源，查询资源依赖和引用关系，查看可用构建目标并启动构建。
- **预览与调试**：运行游戏预览，模拟鼠标和键盘操作，截取画面并查看控制台日志，帮助复现和定位问题。
- **API 知识库**：按版本查找 LayaAir 引擎和 IDE 的 API，查看类型声明、组件属性及不同版本之间的变化。

## 开始使用

安装插件后，打开项目时默认启动 MCP 服务。搭配 LayaAir Agent 时，Agent 会自动接入当前项目。有状态栏的 IDE 可在 Agent 的 MCP 图标上查看连接地址，缺少状态栏接口的 IDE 会在控制台打印地址。

Codex CLI 和其他支持 Streamable HTTP 的本机客户端可连接 `http://127.0.0.1:<预览端口>/ai/mcp`。MCP 服务复用当前项目的 HTTP 预览端口，IDE 默认设置为 `18090`。

要更换端口，在 IDE 的「项目设置 → 预览服务 → 端口」填入新端口，按提示重启 IDE，再更新客户端的连接地址。如果设置的端口已被占用，IDE 会尝试后续端口，请以控制台、状态栏或浏览器预览地址显示的实际端口为准。

连接后，可以试试对助手说「找出这张贴图被哪些资源引用」或「运行游戏，在预览里点击开始按钮，截张图并检查控制台报错」。来自独立客户端的写入、删除、构建和预览控制等操作会在 IDE 中逐次请求批准。通过 LayaAir Agent 发起的操作遵循 Agent 的权限设置。

支持 LayaAir IDE 3.0 及以上版本。帧调试、性能分析和灯光烘焙等功能取决于当前 IDE 提供的能力。

## 扩展 MCP 工具

你可以把自己的项目检查、资源处理流程或团队操作指引接入同一个 MCP 服务，让已连接的 AI 助手发现并使用它们。

1. 在自己的 IDE 插件 `package.json` 的 `pluginDependencies` 中声明 `com.layaair.mcp` 依赖。类型声明位于 `~/packages/com.layaair.mcp/types`。
2. 在 Editor 脚本中，用 `@IEditor.mcp.tool(...)` 注册工具，用 `@IEditor.mcp.prompt(...)` 注册可复用的提示模板。Scene 脚本对应使用 `@IEditorEnv.mcp.tool(...)` 和 `@IEditorEnv.mcp.prompt(...)`。已有扩展可以继续使用这些装饰器。
3. 为工具填写名称、说明和参数，并按实际行为声明 `access`。可选值为 `read`（读取）、`write`（写入）、`delete`（删除）和 `execute`（执行），权限检查沿用插件的授权流程。

下面是一个在 Editor 脚本中注册的只读工具，供助手查询当前项目名称。

```typescript
class ProjectTools {
    @IEditor.mcp.tool(
        "Example_GetProjectName",
        "Get the name of the current LayaAir project",
        {},
        { access: "read" },
    )
    static getProjectName(): string {
        return Editor.projectName;
    }
}
```
