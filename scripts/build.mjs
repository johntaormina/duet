#!/usr/bin/env node
// Bundles the engine command and the VS Code extension.
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const esmRequire = "import { createRequire as __duetCreateRequire } from 'node:module'; const require = __duetCreateRequire(import.meta.url);";

// The engine CLI: one ESM file; prompt files stay beside it in ../assets.
await build({
  entryPoints: [join(root, "packages/engine/src/cli.ts")],
  outfile: join(root, "packages/engine/dist/cli.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: esmRequire },
  logLevel: "warning",
});

// The VS Code extension, when present: CommonJS with `vscode` external, plus a private copy of the engine.
const ext = join(root, "packages/vscode");
if (existsSync(join(ext, "src/extension.ts"))) {
  await build({
    entryPoints: [join(ext, "src/extension.ts")],
    outfile: join(ext, "dist/extension.js"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
    logLevel: "warning",
  });
  rmSync(join(ext, "dist/engine"), { recursive: true, force: true });
  mkdirSync(join(ext, "dist/engine"), { recursive: true });
  cpSync(join(root, "packages/engine/dist/cli.mjs"), join(ext, "dist/engine/cli.mjs"));
  writeFileSync(join(ext, "dist/engine/duet.mjs"), "import { main } from \"./cli.mjs\";\nprocess.exit(await main(process.argv.slice(2)));\n");
  rmSync(join(ext, "dist/assets"), { recursive: true, force: true });
  cpSync(join(root, "packages/engine/assets"), join(ext, "dist/assets"), { recursive: true });
}
console.log("built");
