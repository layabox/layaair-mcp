# LayaAir MCP

用 LayaAir IDE 打开 `layaair-mcp.laya`。安装说明和插件目录见 [插件 README](assets/layaair-mcp/README.md)。

在工程根目录运行 `npm ci` 安装插件开发和测试依赖。

MCP Server 核心是独立的 Node.js 20+ 项目。在 `assets/layaair-mcp/server-src~/` 运行以下命令。

```sh
npm ci
npm run typecheck
npm run build
```

在插件内构建会更新 `server-dist/mcp-server.mjs` 和第三方许可文件。将 `server-src~/` 单独复制到其他位置时，同样的命令会把产物写入子项目的 `dist/`。工程根目录的 `npm run build:runtime` 调用同一个构建脚本。

在工程根目录运行 `npm run build`，用 LayaAir CLI 将现有插件文件导出为 `dist/layaair-mcp.layapkg`。

安装包同时包含 MCP Server 核心源码和预编译产物。安装时无需运行 npm。

`npm run typecheck` 检查类型，可用 `LAYA_IDE_TYPES` 指定 IDE 的 `engine/types`。运行 `npm test` 可测试插件，可用 `LAYA_IDE_SOURCE` 指定 IDE 源码目录，用 `LAYA_TEST_OPTIONAL_APIS=1` 验证可选 API 已加载时的工具行为。
