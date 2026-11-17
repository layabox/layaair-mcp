import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = path.join(root, "src");
const parent = path.dirname(path.resolve(root));
const parentManifest = await readFile(path.join(parent, "package.json"), "utf8").catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return "{}";
});
const inPlugin = JSON.parse(parentManifest).name === "com.layaair.mcp";
const outputDirectory = inPlugin ? path.join(parent, "server-dist") : path.join(root, "dist");
const output = path.join(outputDirectory, "mcp-server.mjs");
const noticeFile = path.join(inPlugin ? parent : outputDirectory, "THIRD-PARTY-NOTICES.txt");
const result = await build({
    absWorkingDir: root,
    tsconfig: path.join(root, "tsconfig.json"),
    entryPoints: [path.join(source, "McpServer.ts")],
    outfile: output,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    keepNames: true,
    minifyWhitespace: true,
    legalComments: "none",
    metafile: true,
    write: false,
    plugins: [{
        name: "validate-mcp-server-source",
        setup(builder) {
            builder.onLoad({ filter: /\.ts$/ }, async ({ path: file }) => {
                if (!file.startsWith(source + path.sep)) return;
                const contents = await readFile(file, "utf8");
                const ast = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true);
                function check(node) {
                    if (ts.isDecorator(node)) {
                        throw new Error(`LayaAir IDE must compile decorated scripts: ${file}`);
                    }
                    if (ts.isIdentifier(node) && ["Editor", "EditorEnv", "IEditor", "IEditorEnv", "gui"].includes(node.text)) {
                        throw new Error(`MCP Server core cannot use IDE globals: ${file}`);
                    }
                    ts.forEachChild(node, check);
                }
                check(ast);
                return { contents, loader: "ts" };
            });
        },
    }],
});

for (const input of Object.keys(result.metafile.inputs)) {
    const file = path.resolve(root, input);
    if (!file.startsWith(source + path.sep) && !file.split(path.sep).includes("node_modules")) {
        throw new Error(`MCP Server core cannot bundle IDE files: ${file}`);
    }
}

const notices = await dependencyNotices(result.metafile);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, result.outputFiles[0].contents);
await writeFile(noticeFile, notices);
console.log(`Built the MCP Server core at ${output}.`);

async function dependencyNotices(metafile) {
    const packages = new Set();
    for (const input of Object.keys(metafile.inputs)) {
        const parts = path.resolve(root, input).split(path.sep);
        const index = parts.lastIndexOf("node_modules");
        if (index < 0) continue;
        packages.add(parts.slice(0, index + (parts[index + 1].startsWith("@") ? 3 : 2)).join(path.sep));
    }
    const results = [];
    for (const directory of [...packages].sort()) {
        const { name, version } = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
        const files = (await readdir(directory)).filter((file) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(file));
        if (files.length === 0) throw new Error(`Missing license text for ${name}@${version}`);
        const texts = await Promise.all(files.sort().map((file) => readFile(path.join(directory, file), "utf8")));
        results.push(`${name}@${version}\n\n${texts.join("\n\n").trim()}`);
    }
    return results.join("\n\n-------------------------------------------------------------------------------\n\n") + "\n";
}
