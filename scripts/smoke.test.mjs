import assert from "node:assert/strict";
import { builtinModules, createRequire } from "node:module";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build as defaultBuild } from "esbuild";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const plugin = path.join(root, "assets/layaair-mcp");
const ide = process.env.LAYA_IDE_SOURCE || process.env.LAYA_33_SOURCE;
const require = createRequire(import.meta.url);
const ideVersion = ide ? require(path.join(ide, "package.json")).version : "3.3.13";
const optionalApisLoaded = process.env.LAYA_TEST_OPTIONAL_APIS === "1";
const temp = await mkdtemp(path.join(os.tmpdir(), "layaair-mcp-test-"));
const external = [...builtinModules, "node:*"];
const build = ide ? require(path.join(ide, "node_modules/esbuild")).build : defaultBuild;

async function decoratorTools() {
    if (!ide) {
        return {
            getScriptType: (source) => /^\s*@IEditor\./m.test(source) ? 4 : /^\s*@IEditorEnv\./m.test(source) ? 2 : 0,
            getDecoratorHandler: () => (source, uuid) =>
                source.replace(/@(IEditor(?:Env)?).regClass\(\)/g, (_, host) => `@${host}.regClass("${uuid}")`),
        };
    }
    const out = path.join(temp, "ide-decorators.cjs");
    await defaultBuild({
        entryPoints: [path.join(ide, "src/game/compiler/DecoratorUtils.ts")],
        bundle: true, platform: "node", format: "cjs", outfile: out,
    });
    return require(out);
}

async function filesUnder(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    return (await Promise.all(entries.map((entry) => {
        const file = path.join(directory, entry.name);
        return entry.isDirectory() ? filesUnder(file) : file;
    }))).flat().sort();
}

function fakeIDE(liveServer) {
    const classes = new Map();
    const editorLoads = [];
    const editorUnloads = [];
    const sceneLoads = [];
    const sceneUnloads = [];
    const userLoads = [];
    const menus = new Set();
    const panels = new Set();
    let permissionDialogs = 0;
    let changed = 0;
    let assetRefreshes = 0;
    let currentPanel;
    const editorSyncRequests = [];
    const push = (list) => (target, name) => { list.push(target[name].bind(target)); };
    const regClass = (uuid) => (cls) => {
        assert.match(uuid, /^[0-9a-f-]{36}/);
        classes.set(cls.name, cls);
    };
    const context = { id: "active-scene" };
    const execute = async (command, ...args) => {
        const [name, method] = command.split(".");
        return classes.get(name)?.[method]?.call(context, ...args);
    };
    const flushAssetChanges = async () => {
        await readFile(path.join(temp, "assets", "Copied.txt"));
        assetRefreshes += 1;
    };
    const previousMcp = {
        tool: () => assert.fail("Tool registration reached the previous MCP registry"),
        prompt: () => assert.fail("Prompt registration reached the previous MCP registry"),
    };
    globalThis.IEditor = {
        mcp: previousMcp,
        regClass, onLoad: push(editorLoads), onUnload: push(editorUnloads),
        EditorPanel: class {}, panel: (id) => () => { panels.add(id); },
        require: (id) => ide && id === "typescript" ? require(path.join(ide, "node_modules/typescript")) : require(id),
        menu: (menu) => () => { menus.add(menu); },
    };
    globalThis.Laya = {};
    globalThis.IEditorEnv = {
        mcp: previousMcp,
        regClass, onLoad: push(sceneLoads), onUnload: push(sceneUnloads),
        onUserScriptsLoad: push(userLoads), onUserScriptsUnload() {},
        HierarchyValidator: class { validate() { return []; } },
    };
    globalThis.gui = {
        Translations: { create() {
            const messages = {};
            return {
                setContent(lang, values) { if (lang === "en") Object.assign(messages, values); return this; },
                t: (key, values = {}) => messages[key]?.replace(/\{\{(\w+)\}\}/g, (_, name) => values[name]),
            };
        } },
    };
    globalThis.Editor = {
        scene: { runScript: execute },
        sceneManager: { runSceneScript: execute },
        projectName: "MCP smoke test",
        ipc: { invoke: async (method) => method === "GetVersion" ? ideVersion : { name: "layaair-ide" } },
        onConsoleMessage: { add() {}, remove() {} },
        showMessageBox: async () => {
            permissionDialogs += 1;
            return { response: 0 };
        },
        panelManager: {
            panelIds: ["TestPanel"],
            showPanel(id) {
                if (id === "TestPanel") { changed += 1; currentPanel = id; }
            },
            isPanelShowing(id) { return currentPanel === id; },
        },
        projectPath: temp,
        assetsPath: path.join(temp, "assets"),
        cliMode: true,
        assetDb: {
            flushChanges: flushAssetChanges,
            getAsset: async (file) => {
                if (file === "Test.ls") return { file, root: temp };
                if (file === "Copied.txt" && assetRefreshes > 0) return { id: "copied-asset-id" };
                if (file === "editorResources/layaair-mcp/plugin-root-marker.txt") return { file, root: plugin };
                return null;
            },
            getFullPath: (asset) => path.join(asset.root, asset.file),
        },
    };
    globalThis.EditorEnv = {
        assetMgr: { flushChanges: flushAssetChanges },
        projectPath: temp,
        runUIScript: (command, ...args) => {
            if (command === "StandaloneMcpEditor.requestHandlerSync") editorSyncRequests.push(args[0].requestId);
            return execute(command, ...args);
        },
        extensionManager: { loadingPackages: false },
        ipc: Editor.ipc, liveServer,
    };
    return {
        editorLoads, editorUnloads, sceneLoads, sceneUnloads, userLoads, execute, menus, panels, editorSyncRequests,
        get permissionDialogs() { return permissionDialogs; },
        get changed() { return changed; },
        get assetRefreshes() { return assetRefreshes; },
    };
}

test(`IDE ${ideVersion} serves tools with ${optionalApisLoaded ? "available" : "missing"} optional APIs`, async (t) => {
    const startupPrefix = "[LayaAir MCP] MCP service started at ";
    const consoleInfo = t.mock.method(console, "info");
    const startupMessages = () => consoleInfo.mock.calls
        .map(({ arguments: [message] }) => message)
        .filter((message) => typeof message === "string" && message.startsWith(startupPrefix));
    const express = require("express");
    const app = express();
    if (optionalApisLoaded) app.use(express.json());
    app.get("/test-preview", (_req, res) => res.send("Preview"));
    let routeCount = 0;
    const expressApp = Object.fromEntries(["get", "post", "delete"].map((method) => [
        method, (path, handler) => { routeCount++; app[method](path, handler); },
    ]));
    const httpServer = app.listen(0, "127.0.0.1");
    const queryChildren = [];
    function requireMcp(id) {
        const dependency = require(id);
        if (id !== "node:child_process") return dependency;
        return {
            ...dependency,
            spawn(executable, args, options) {
                const child = dependency.spawn(executable, args, options);
                if (args[1] === "query-process") queryChildren.push(child);
                return child;
            },
        };
    }
    try {
        await new Promise((resolve, reject) => {
            httpServer.once("listening", resolve);
            httpServer.once("error", reject);
        });
        const liveUrl = `http://127.0.0.1:${httpServer.address().port}`;
        const settingsFile = path.join(temp, "local/layaair-mcp/settings.json");
        await mkdir(path.dirname(settingsFile), { recursive: true });
        await writeFile(settingsFile, JSON.stringify({ port: 6800, autoStart: true }));
        const { getScriptType, getDecoratorHandler } = await decoratorTools();
        const transform = getDecoratorHandler();
        const source = path.join(plugin, "src");
        const files = (await filesUnder(source)).filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"));
        const entries = { editor: [], scene: [] };
        for (const file of files) {
            const contents = await readFile(file, "utf8");
            const kind = getScriptType(contents);
            if (!kind) continue;
            const process = path.relative(source, file).split(path.sep)[0];
            assert.equal(kind, process === "editor" ? 4 : 2, `Wrong IDE process for ${file}`);
            entries[process].push(file);
        }
        const platform = fakeIDE({ expressApp, url: liveUrl });
        await writeFile(path.join(temp, "Test.ls"), JSON.stringify({ "_$ver": 1 }));
        for (const [process, sources] of Object.entries(entries)) {
            assert.ok(sources.some((file) => path.basename(file) === "Main.ts"), `${process} entry not discovered`);
            const result = await build({
                stdin: {
                    contents: sources.map((file) => `export * from ${JSON.stringify(file)};`).join("\n"),
                    resolveDir: plugin,
                },
                bundle: true, format: "iife", target: "es2022", keepNames: true, external,
                tsconfig: path.join(plugin, "tsconfig.json"), write: false, metafile: true,
                plugins: [{
                    name: "layaair-ide-decorators",
                    setup(builder) {
                        builder.onLoad({ filter: /\.ts$/ }, async ({ path: file }) => {
                            const contents = await readFile(file, "utf8");
                            if (!getScriptType(contents)) return undefined;
                            const { uuid } = JSON.parse(await readFile(`${file}.meta`, "utf8"));
                            return { contents: transform(contents, uuid, file), loader: "ts" };
                        });
                    },
                }],
            });
            assert.equal(Object.keys(result.metafile.inputs).some((file) => file.includes("node_modules")), false,
                "installation package must bundle its own runtime dependencies");
            const hasCore = Object.keys(result.metafile.inputs).some((file) => file.endsWith("server-dist/mcp-server.mjs"));
            assert.equal(hasCore, process === "scene");
            new Function("require", result.outputFiles[0].text)(requireMcp);
        }
        const extensionRegistrars = { editor: IEditor.mcp, scene: IEditorEnv.mcp };
        for (const [process, registrar] of Object.entries(extensionRegistrars)) {
            const extension = { describe: (name) => `${process}: ${name}` };
            registrar.tool(`${process}-extension-tool`, { name: "Name" }, { access: "read" })(extension, "describe");
            registrar.prompt(`${process}-extension-prompt`, { name: "Name" })(extension, "describe");
        }
        for (const hook of platform.sceneLoads) await hook();
        for (const hook of platform.userLoads) await hook();
        await waitFor(async () => (await platform.execute("StandaloneMcpScene.getServerStatus")).state === "starting");
        assert.deepEqual(startupMessages(), []);
        assert.equal(platform.editorSyncRequests.length, 0, "Scene must allow Editor to publish the first snapshot");
        // In the IDE, feature packs mount their APIs after script evaluation and before plugin onLoad.
        if (optionalApisLoaded) {
            Editor.statusBar = { createItem() { assert.fail("The Agent plugin owns the status bar item"); } };
            mountOptionalApis();
        }
        for (const hook of platform.editorLoads) await hook();
        Editor.cliMode = false;
        const status = await waitFor(async () => {
            const status = await platform.execute("StandaloneMcpScene.getServerStatus");
            return status?.state === "running" ? status : null;
        });
        assert.equal(status.endpoint, liveUrl + "/ai/mcp");
        const expectedStartupMessages = optionalApisLoaded ? [] : [`${startupPrefix}${status.endpoint}`];
        assert.deepEqual(startupMessages(), expectedStartupMessages);
        const configure = (command) => platform.execute("StandaloneMcpScene.serviceSettings", command);
        assert.equal((await configure({ action: "start" })).status.state, "running");
        assert.deepEqual(startupMessages(), expectedStartupMessages);
        assert.equal((await fetch(liveUrl + "/ai/layaair-mcp")).status, 404);
        assert.equal(routeCount, 3);
        assert.equal(platform.menus.has("App/developer/LayaAir MCP"), false);
        assert.equal(platform.panels.has("LayaAirStandaloneMcpSettings"), false);
        assert.equal((await fetch(status.endpoint, { headers: { Origin: "http://localhost:12345" } })).status, 403);

        const client = new Client({ name: "layaair-mcp-smoke", version: "1" });
        const transport = new StreamableHTTPClientTransport(new URL(status.endpoint));
        try {
            await client.connect(transport);
            const { tools } = await client.listTools();
            const { prompts } = await client.listPrompts();
            for (const process of Object.keys(extensionRegistrars)) {
                const toolName = `${process}-extension-tool`;
                const promptName = `${process}-extension-prompt`;
                const args = { name: "project" };
                assert.ok(tools.some(({ name }) => name === toolName));
                assert.ok(prompts.some(({ name }) => name === promptName));
                const tool = await client.callTool({ name: toolName, arguments: args });
                assert.equal(tool.content[0].text, `${process}: project`);
                const prompt = await client.getPrompt({ name: promptName, arguments: args });
                assert.equal(prompt.messages[0].content.text, `${process}: project`);
            }
            for (const name of ["get-product-version", "ProjectManagement", "AssetManagement", "Laya_ValidateLayaAsset",
                "Laya_RefreshAssetDatabase", "SceneManagement", "PrefabManagement", "RuntimeManagement", "ExecutePluginScript",
                "LayaAir_GetIdeGuide", "DebugManagement"]) {
                assert.ok(tools.some((tool) => tool.name === name), `Missing ${name}`);
            }
            assert.match(tools.find(({ name }) => name === "ExecutePluginScript").description, /LayaAir_GetIdeGuide/);
            const guide = await client.callTool({ name: "LayaAir_GetIdeGuide", arguments: { topic: "plugin-communication" } });
            assert.equal(guide.isError, undefined, JSON.stringify(guide));
            assert.match(JSON.parse(guide.content[0].text).data, /^## 17\. Cross-Process Communication\n/);
            assert.doesNotMatch(JSON.parse(guide.content[0].text).data, /^## 18\./m);
            const overview = await client.callTool({ name: "LayaAir_GetIdeGuide", arguments: { topic: "overview" } });
            assert.equal(JSON.parse(overview.content[0].text).data,
                await readFile(path.join(plugin, "bundled_skills~/layaair-ide-plugin/SKILL.md"), "utf8"));
            const patterns = await client.callTool({ name: "LayaAir_GetIdeGuide", arguments: { topic: "api-patterns" } });
            assert.match(JSON.parse(patterns.content[0].text).data, /^- 16\. Asset Database API$/m);
            const pattern = await client.callTool({
                name: "LayaAir_GetIdeGuide",
                arguments: { topic: "api-patterns", section: "16. Asset Database API" },
            });
            assert.match(JSON.parse(pattern.content[0].text).data, /^## 16\. Asset Database API\n/);
            assert.doesNotMatch(JSON.parse(pattern.content[0].text).data, /^## 17\./m);
            const deepPattern = await client.callTool({
                name: "LayaAir_GetIdeGuide",
                arguments: { topic: "react-ui", section: "TextInput" },
            });
            assert.match(JSON.parse(deepPattern.content[0].text).data, /^#### TextInput\n/);
            assert.doesNotMatch(JSON.parse(deepPattern.content[0].text).data, /^#### NumericInput$/m);
            const invalidGuide = await client.callTool({ name: "LayaAir_GetIdeGuide", arguments: { topic: "../package.json" } });
            assert.equal(invalidGuide.isError, true);
            const knowledgeTools = tools.filter(({ name }) => /^LayaAir_.*(?:Api|Schema)/.test(name));
            assert.equal(knowledgeTools.length, 10);
            for (const hook of platform.userLoads) await hook();
            await waitFor(() => platform.editorSyncRequests.length === 1);
            assert.equal((await client.listTools()).tools.filter(({ name }) => /^LayaAir_.*(?:Api|Schema)/.test(name)).length, 10);
            const querySchema = async () => {
                const schema = await client.callTool({
                    name: "LayaAir_GetComponentSchema", arguments: { name: "Sprite3D" },
                });
                assert.equal(schema.isError, undefined);
                assert.equal(JSON.parse(schema.content[0].text).data.result.name, "Sprite3D");
            };
            assert.equal(queryChildren.length, 0);
            await Promise.all([querySchema(), querySchema()]);
            assert.equal(queryChildren.length, 1);
            const exited = once(queryChildren[0], "exit", { signal: AbortSignal.timeout(3000) });
            queryChildren[0].kill();
            await exited;
            await querySchema();
            assert.equal(queryChildren.length, 2);
            for (const name of ["ThemeManagement", "FrameDebugger", "Profiler"]) {
                assert.equal(tools.some((tool) => tool.name === name), optionalApisLoaded, name);
            }
            const scene = tools.find(({ name }) => name === "SceneManagement");
            const { action, params } = scene.inputSchema.properties;
            for (const name of ["checkBake", "startBake", "getBakeStatus", "cancelBake"]) {
                assert.equal(action.description.includes(name), optionalApisLoaded, name);
            }
            assert.equal(Object.hasOwn(params.properties, "taskId"), optionalApisLoaded);
            const currentSceneRequest = { name: "SceneManagement", arguments: { action: "getCurrent" } };
            const liveSceneRequest = {
                name: currentSceneRequest.name,
                arguments: { ...currentSceneRequest.arguments, params: { includeState: true } },
            };
            assert.equal((await client.callTool(liveSceneRequest)).isError, true);
            await mkdir(Editor.assetsPath);
            await writeFile(path.join(Editor.assetsPath, "Stage.ls"), JSON.stringify({ "_$type": "Scene", name: "Saved2D" }));
            await writeFile(path.join(temp, "Stage.ls"), JSON.stringify({ "_$type": "Scene", name: "ProjectRoot" }));
            const rootNode2D = { id: "root-2d", name: "Scene2D", type: "Scene" };
            const rootNode3D = { id: "root-3d", name: "Scene3D", type: "Scene3D" };
            const selected = { id: "selected", name: "Selected3D", type: "Sprite3D" };
            const activeScene = {
                sceneId: "live-scene",
                asset: { file: "Stage.ls", id: "scene-asset" },
                loading: false,
                isModified: true,
                viewerMode: false,
                worldType: null,
                rootNode2D,
                rootNode3D,
                getSelection(type) { return type === "node" ? [selected] : []; },
            };
            Editor.sceneManager.activeScene = activeScene;
            const current = await client.callTool(currentSceneRequest);
            assert.equal(JSON.parse(current.content[0].text).data, "Stage.ls");
            const liveScene = await client.callTool(liveSceneRequest);
            const state = JSON.parse(liveScene.content[0].text).data;
            assert.deepEqual(state, {
                sceneId: "live-scene",
                assetId: "scene-asset",
                path: "Stage.ls",
                worldType: null,
                isModified: true,
                viewerMode: false,
                rootNode2D,
                rootNode3D,
                prefabRootNode: null,
                selectedNodes: [selected],
            });
            const readScene = async (filePath) => {
                const result = await client.callTool({ name: "Laya_ReadLayaAsset", arguments: { file_path: filePath } });
                assert.equal(result.isError, undefined, JSON.stringify(result));
                return JSON.parse(result.content[0].text).data.name;
            };
            assert.equal(await readScene(state.path), "Saved2D");
            assert.equal(await readScene("assets/Stage.ls"), "Saved2D");
            assert.equal(await readScene("./Stage.ls"), "ProjectRoot");

            activeScene.rootNode3D = null;
            activeScene.asset = null;
            activeScene.getSelection = () => [];
            const unsaved = JSON.parse((await client.callTool(liveSceneRequest)).content[0].text).data;
            assert.equal(unsaved.sceneId, "live-scene");
            assert.equal(unsaved.assetId, null);
            assert.equal(unsaved.path, null);
            assert.equal(unsaved.rootNode3D, null);
            assert.deepEqual(unsaved.selectedNodes, []);
            activeScene.loading = true;
            assert.equal((await client.callTool(liveSceneRequest)).isError, true);
            delete Editor.sceneManager.activeScene;
            const version = await client.callTool({ name: "get-product-version" });
            assert.ok(version.content[0].text.includes(ideVersion));
            const version2 = await client.callTool({
                name: "ProjectManagement", arguments: { action: "getEditorVersion" },
            });
            assert.equal(version2.isError, undefined);
            assert.ok(JSON.stringify(version2.content).includes(ideVersion));

            const validation = await client.callTool({
                name: "Laya_ValidateLayaAsset", arguments: { file_path: "Test.ls" },
            });
            assert.notEqual(validation.isError, true);
            assert.match(validation.content[0].text, /"valid":\s*true/);

            const request = {
                name: "ProjectManagement",
                arguments: { action: "showPanel", params: { panelId: "TestPanel" } },
            };
            const scriptRequest = {
                name: "ExecutePluginScript",
                arguments: { sceneCode: 'export function main() { return "scene-ok"; }' },
            };
            const credential = "a".repeat(64);
            let agentApprovals = 0;
            let agentAllowsOperation = false;
            const registration = IEditor.standaloneMcp.registerAgent(
                credential,
                (registrar) => registrar.tool("agent-knowledge-test", {}, { access: "read" })({ run() { return "ok"; } }, "run"),
                async (query) => {
                    agentApprovals += 1;
                    return agentAllowsOperation
                        ? { ...query, decision: "allow", reason: "auto-authorized" }
                        : { ...query, decision: "deny", reason: "user-denied" };
                },
            );
            await waitFor(async () => {
                const state = await platform.execute("StandaloneMcpScene.getServerStatus");
                return state?.agentGeneration === registration.generation;
            });
            const standaloneScript = await client.callTool(scriptRequest);
            assert.equal(standaloneScript.isError, undefined, JSON.stringify(standaloneScript));
            assert.match(standaloneScript.content[0].text, /scene-ok/);
            assert.equal(agentApprovals, 0);
            assert.equal(platform.permissionDialogs, 0);
            const protectedTransport = new StreamableHTTPClientTransport(new URL(status.endpoint), {
                requestInit: { headers: { "x-layaair-agent-mcp": credential } },
            });
            const protectedClient = new Client({ name: "agent-bridge-smoke", version: "1" });
            try {
                await protectedClient.connect(protectedTransport);
                const { tools } = await protectedClient.listTools();
                assert.ok(tools.some(({ name }) => name === "agent-knowledge-test"));
                assert.equal((await protectedClient.callTool(request)).isError, true);
                assert.equal(platform.changed, 0);
                agentAllowsOperation = true;
                assert.equal((await protectedClient.callTool(request)).isError, undefined);
                assert.equal(platform.changed, 1);
                assert.equal(agentApprovals, 2);

                const refresh = { name: "Laya_RefreshAssetDatabase", arguments: {} };
                const lookupCopiedAsset = {
                    name: "AssetManagement", arguments: { action: "pathToUuid", params: { source: "assets/Copied.txt" } },
                };
                await writeFile(path.join(temp, "assets", "Copied.txt"), "Copied outside the IDE");
                assert.equal(platform.assetRefreshes, 0);
                assert.equal((await client.callTool(lookupCopiedAsset)).isError, true);
                const refreshed = await protectedClient.callTool(refresh);
                assert.equal(refreshed.isError, undefined, JSON.stringify(refreshed));
                assert.equal(platform.assetRefreshes, 1);
                const copiedAsset = await client.callTool(lookupCopiedAsset);
                assert.equal(JSON.parse(copiedAsset.content[0].text).data, "copied-asset-id");
                delete Editor.assetDb.flushChanges;
                assert.equal((await protectedClient.callTool(refresh)).isError, undefined);
                assert.equal(platform.assetRefreshes, 2);
                if (optionalApisLoaded) await checkOptionalTools(protectedClient);
                const script = await protectedClient.callTool(scriptRequest);
                assert.notEqual(script.isError, true, JSON.stringify(script));
                assert.match(script.content[0].text, /scene-ok/);
                assert.equal((await fetch(status.endpoint, {
                    headers: { "mcp-session-id": protectedTransport.sessionId },
                })).status, 404);
                assert.equal(platform.permissionDialogs, 0);
            } finally {
                await protectedTransport.terminateSession().catch(() => {});
                await protectedClient.close();
                registration.dispose();
            }
            await waitFor(async () => !(await platform.execute("StandaloneMcpScene.getServerStatus")).agentGeneration);
            assert.equal((await fetch(status.endpoint, { headers: { "x-layaair-agent-mcp": credential } })).status, 403);
            assert.equal((await client.callTool(request)).isError, undefined);
            assert.equal(platform.changed, 2);
            assert.equal(platform.permissionDialogs, 0);
        }
        finally {
            await transport.terminateSession().catch(() => {});
            await client.close();
            const stopped = await configure({ action: "stop" });
            assert.equal(stopped.status.state, "stopped");
            assert.equal((await fetch(status.endpoint)).status, 503);
            const saved = await configure({ action: "save", settings: { autoStart: false } });
            assert.equal(saved.error, undefined);
            assert.deepEqual(JSON.parse(await readFile(settingsFile, "utf8")), { autoStart: false });
            assert.equal((await configure({ action: "start" })).status.endpoint, status.endpoint);
            assert.deepEqual(startupMessages(), [...expectedStartupMessages, ...expectedStartupMessages]);
            assert.equal(routeCount, 3);
            const queryExit = once(queryChildren.at(-1), "exit", { signal: AbortSignal.timeout(3000) });
            for (const hook of platform.editorUnloads) await hook();
            await queryExit;
            for (const hook of platform.sceneUnloads) await hook();
        }
        assert.equal((await platform.execute("StandaloneMcpScene.getServerStatus")).state, "stopped");
        assert.equal((await fetch(status.endpoint)).status, 503);
        assert.equal(await (await fetch(liveUrl + "/test-preview")).text(), "Preview");
    }
    finally {
        const runningChildren = queryChildren.filter((child) => child.exitCode === null && child.signalCode === null);
        await Promise.all(runningChildren.map(async (child) => {
            const exited = once(child, "exit", { signal: AbortSignal.timeout(3000) });
            child.kill();
            await exited;
        }));
        httpServer.closeAllConnections();
        await new Promise((resolve) => httpServer.close(resolve));
        await rm(temp, { recursive: true, force: true });
    }
});

function mountOptionalApis() {
    let themeMode = "light";
    let themeId = "default";
    let recording = false;
    let activeTask = null;
    Object.assign(IEditor, {
        React: { themeManager: {
            schemaVersion: 1,
            jsonSchema: {},
            getTheme: () => themeMode,
            getThemePreference: () => themeMode,
            setThemePreference: (mode) => { themeMode = mode; },
            getAccentPreset: () => themeId,
            setAccentPreset: (id) => { themeId = id; },
            getThemeDefinition: (mode, id) => ({ mode, id }),
            getThemeDefinitions: () => [],
            installTheme: (definition) => ({ ok: true, definition, diagnostics: [] }),
        } },
        FrameDebugger: { captureFrame: async (options) => options },
        Profiler: {
            get state() { return { recording }; },
            async connect() {},
            async start() { recording = true; },
            async stop() { recording = false; },
            async exportReport(options) { return options; },
            async dispose() { recording = false; },
        },
        LightingBake: {
            get activeTask() { return activeTask; },
            async check(request) { return { ready: true, request }; },
            start(request) {
                assert.equal(request.kind, "gi");
                let settle;
                activeTask = {
                    id: "bake-task", sceneId: "active-scene", state: "running",
                    result: new Promise((resolve) => { settle = resolve; }),
                    async cancel() {
                        this.state = "cancelled";
                        activeTask = null;
                        settle({ status: "cancelled" });
                    },
                };
                return activeTask;
            },
        },
    });
}

async function checkOptionalTools(client) {
    async function call(name, action, params, pattern) {
        const result = await client.callTool({ name, arguments: { action, params } });
        assert.notEqual(result.isError, true, JSON.stringify(result));
        assert.match(result.content[0].text, pattern);
    }
    await call("ThemeManagement", "applyExisting", { mode: "dark", id: "default" }, /"resolvedMode":\s*"dark"/);
    await call("FrameDebugger", "captureFrame", { resolution: "low" }, /"resolution":\s*"low"/);
    await call("Profiler", "start", undefined, /"recording":\s*true/);
    await call("SceneManagement", "checkBake", { kind: "gi" }, /"ready":\s*true/);
    await call("SceneManagement", "startBake", { kind: "gi" }, /"taskId":\s*"bake-task"/);
    await call("SceneManagement", "cancelBake", { taskId: "bake-task" }, /"state":\s*"cancelled"/);
    await call("SceneManagement", "getBakeStatus", { taskId: "bake-task" }, /"settled":\s*true/);
}

async function waitFor(read) {
    const end = Date.now() + 5000;
    while (Date.now() < end) {
        const value = await read();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Timed out waiting for MCP to start");
}
