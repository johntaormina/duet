#!/usr/bin/env node
// Runs the bundled CLI when built, otherwise the TypeScript source through Node's type transform.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundled = join(here, "..", "dist", "cli.mjs");
const { main } = await import(existsSync(bundled) ? bundled : join(here, "..", "src", "cli.ts"));
process.exit(await main(process.argv.slice(2)));
