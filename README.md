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


## API knowledge

The IDE plugin ships the complete `layaair-api-knowledge` and `layaair-ide-plugin` Skills. The knowledge Skill includes the query script, SQLite WASM engine, and component schemas. LayaAir Agent imports both Skills from its installed MCP dependency using the versions in `bundled_skills~/version.json`. Queries use a child process started on first use. It reuses an open SQLite snapshot, checks the shared database file before each query, and exits when the plugin unloads. A separate command checks for database updates at startup and every six hours. The query runtime shares an IDE-independent per-user cache with LayaAir Agent and the `layaair-api-knowledge` Skill. Its root is `~/Library/Application Support/LayaAir` on macOS, `%LOCALAPPDATA%\LayaAir` on Windows, and `${XDG_DATA_HOME:-~/.local/share}/LayaAir` on Linux. Only verified releases are published, ordered by the remote manifest's `publishedAt`.

The knowledge build tools live in the separate `layaair-api-knowledge` project. Run `npm ci` in that project to install its dependencies.

| Command | Output |
| --- | --- |
| `npm run build` | The complete Skill in `dist/skills/layaair-api-knowledge/` |
| `npm run build:db` | The SQLite database, Brotli archive, and release manifest in the knowledge project's `dist/cache/` |

To update the bundled knowledge Skill, manually copy the generated `layaair-api-knowledge/` directory into `assets/layaair-mcp/bundled_skills~/`. The Editor locates the plugin root through `editorResources/layaair-mcp/plugin-root-marker.txt` and keeps both Skill directories outside asset scanning.
