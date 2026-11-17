# LayaAir MCP

LayaAir IDE 的 MCP 插件。同一份插件支持 **IDE 3.3.13 和 3.4.3**，运行时使用项目自己的本机 MCP 服务。

## 安装和连接

- **IDE 3.3**：在「开发者 → 包管理器」从磁盘添加，解压 `layaair-mcp.layapkg`，选择含 `package.json` 的解压目录。
- **IDE 3.4**：在「开发者 → 包管理器」选择「安装本地 Laya Package」，打开 `layaair-mcp.layapkg`。也支持从磁盘添加已解压的目录。

打开项目时默认启动 MCP 服务。IDE 3.3 在控制台打印连接地址。IDE 3.4 支持状态栏 API 时，服务就绪后显示 MCP 图标。悬停可查看连接地址，点击可复制地址。

MCP 服务复用当前项目的 LiveServer HTTP 预览端口，IDE 默认设置为 `18090`。将 `http://127.0.0.1:<预览端口>/ai/mcp` 填入支持 Streamable HTTP 的本机 MCP 客户端。

要更换端口，在 IDE 的「项目设置 → 预览服务 → 端口」修改 HTTP 端口（`liveServerPort`），按提示重启 IDE，再更新客户端的连接地址。如果设置的端口已被占用，IDE 会尝试后续端口，请以控制台、状态栏或浏览器预览地址显示的实际端口为准。

写入、删除、构建、预览控制和脚本执行等操作需在 IDE 里逐次批准。

主题管理、帧调试、性能分析和灯光烘焙分别按 IDE 提供的 API 启用。3.4 加载相应功能后会公布这些工具，灯光烘焙操作位于 `SceneManagement`。3.3 自动跳过缺少 API 的工具和操作。

## 与 LayaAir Agent 一起使用

Agent 启动 ACPCore 后，使用 IDE 预览端口登记 `/ai/mcp`。持有 Agent 调用凭据的连接沿用 Agent 权限设置，其他客户端使用 IDE 原生确认。

## 插件目录

- `src/` 保存 Editor、Scene 和 MCP 工具的 TypeScript 源码及 `.meta`，由 IDE 编译。
- `server-src~/` 是 MCP Server 核心的独立 Node.js 20+ 项目，包含源码、依赖清单和构建配置。进入该目录后可运行 `npm ci`、`npm run typecheck` 和 `npm run build`。服务启动时由 Scene 加载构建生成的 `server-dist/mcp-server.mjs`。

插件通过 `types/index.d.ts` 提供注册接口，依赖方可从 `~/packages/com.layaair.mcp/types` 导入类型。

扩展工具和提示模板沿用 `IEditor.mcp.tool`、`IEditor.mcp.prompt` 和 Scene 侧的 `IEditorEnv.mcp.tool`、`IEditorEnv.mcp.prompt`。IDE 插件通过 `pluginDependencies` 声明 `com.layaair.mcp` 依赖。
