#!/usr/bin/env node
// Structural LID coherence check: every @spec annotation names a real spec, and every spec in
// the given prefixes is cited by at least one test. Usage: node scripts/coherence-check.mjs [PREFIX...]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const prefixes = process.argv.slice(2);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "package.json" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const specs = new Map();
for (const f of walk(join(root, "docs/intent")).filter((f) => f.endsWith("-specs.md"))) {
  for (const m of readFileSync(f, "utf8").matchAll(/^- \[(.)\] \*\*([A-Z]+(?:-[A-Z]+)*-\d{3})\*\*/gm)) {
    specs.set(m[2], { marker: m[1], file: relative(root, f) });
  }
}

const cited = { test: new Set(), code: new Set() };
const dangling = [];
for (const f of walk(join(root, "packages")).filter((f) => /\.(ts|js|mjs|json|md)$/.test(f))) {
  const kind = /[\\/]test[\\/]/.test(f) ? "test" : "code";
  for (const m of readFileSync(f, "utf8").matchAll(/@spec ([A-Z0-9, -]+)/g)) {
    for (const id of m[1].split(",").map((s) => s.trim().replace(/\s*-+$/, "")).filter((s) => /^[A-Z]+(?:-[A-Z]+)*-\d{3}$/.test(s))) {
      if (!specs.has(id)) dangling.push(`${relative(root, f)}: ${id}`);
      cited[kind].add(id);
    }
  }
}

const inScope = [...specs.keys()].filter((id) => prefixes.length === 0 || prefixes.some((p) => id.startsWith(p + "-")));
const active = inScope.filter((id) => specs.get(id).marker !== "D");
const untested = active.filter((id) => !cited.test.has(id));
const unimplemented = active.filter((id) => !cited.code.has(id));

console.log(`specs in scope: ${inScope.length} (${active.length} active)`);
console.log(`dangling @spec annotations: ${dangling.length}`);
dangling.forEach((d) => console.log(`  ${d}`));
console.log(`active specs with no test: ${untested.length}`);
untested.forEach((id) => console.log(`  ${id}`));
console.log(`active specs with no code annotation: ${unimplemented.length}`);
unimplemented.forEach((id) => console.log(`  ${id}`));
process.exit(dangling.length || untested.length ? 1 : 0);
