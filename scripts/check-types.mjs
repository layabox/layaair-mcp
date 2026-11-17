import { accessSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const types = path.resolve(process.env.LAYA_IDE_TYPES || process.env.LAYA_33_TYPES || path.join(root, "engine/types"));
try {
    accessSync(path.join(types, "editor.d.ts"));
    accessSync(path.join(types, "editor-env.d.ts"));
}
catch {
    throw new Error("Set LAYA_IDE_TYPES to the engine/types directory from LayaAir IDE.");
}
const config = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent({
    ...config.config,
    include: [...config.config.include.filter((item) => !item.startsWith("engine/")), path.join(types, "*.d.ts")],
}, ts.sys, root);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
if (diagnostics.length > 0) {
    console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCurrentDirectory: () => root,
        getCanonicalFileName: (name) => name,
        getNewLine: () => "\n",
    }));
    process.exitCode = 1;
}
else {
    console.log(`Type check passed with ${types}`);
}
