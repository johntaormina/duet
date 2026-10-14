import { createHash } from "node:crypto";
import { type ChangedFile, filePatch, git, gitBuffer, showFile } from "./git.ts";
import { globToRegex } from "./glob.ts";

const LOCKFILES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "poetry.lock", "Pipfile.lock", "uv.lock",
  "Cargo.lock", "Gemfile.lock", "go.sum", "composer.lock", "Podfile.lock", "gradle.lockfile", "mix.lock", "pubspec.lock",
]);
const GENERATED_PATHS = [/(^|\/)vendor\//, /(^|\/)node_modules\//, /(^|\/)dist\//, /\.min\.(js|css)$/, /\.pb\.go$/, /_pb2(_grpc)?\.py$/, /\.generated\./, /(^|\/)__generated__\//];
const GENERATED_HEADER = /@generated|DO NOT EDIT|Code generated .* DO NOT EDIT|auto-?generated/i;
const LFS_POINTER = /^version https:\/\/git-lfs\.github\.com\/spec/;

export type Classified =
  | { kind: "lockfile"; file: ChangedFile; summary: string }
  | { kind: "generated"; file: ChangedFile; summary: string }
  | { kind: "binary"; file: ChangedFile; summary: string }
  | { kind: "notebook"; file: ChangedFile; content: string; patch: string }
  | { kind: "source"; file: ChangedFile; patch: string };

export interface NormalizeOptions {
  repo: string;
  base: string;
  head: string;
  generatedPaths: string[];
}


function attrs(repo: string, rev: string, paths: string[]): Set<string> {
  if (paths.length === 0) return new Set();
  const marked = new Set<string>();
  try {
    const out = git(repo, ["-c", "core.quotepath=off", "check-attr", `--source=${rev}`, "linguist-generated", "linguist-vendored", "--", ...paths]);
    for (const line of out.split("\n")) {
      const m = /^(.*): linguist-(?:generated|vendored): (set|true)$/.exec(line);
      if (m) marked.add(m[1]);
    }
  } catch {
    // Older git without --source: no attribute-based classification.
  }
  return marked;
}

/** Packages and versions mentioned in a lockfile, as `name@version` strings. */
export function lockEntries(name: string, text: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!text) return out;
  if (name.endsWith(".json")) {
    try {
      const json = JSON.parse(text);
      for (const [k, v] of Object.entries<{ version?: string }>(json.packages ?? json.dependencies ?? {})) {
        const pkg = k.replace(/^.*node_modules\//, "");
        if (pkg && v?.version) out.set(pkg, v.version);
      }
      return out;
    } catch {
      return out;
    }
  }
  for (const m of text.matchAll(/^"?(@?[\w./-]+)@[^\n]*\n\s+version:? "?([\w.+-]+)"?/gm)) out.set(m[1], m[2]);
  for (const m of text.matchAll(/name = "([^"]+)"\s*\nversion = "([^"]+)"/g)) out.set(m[1], m[2]);
  for (const m of text.matchAll(/^([\w./-]+) v?([\d][\w.+-]*)(?:\/go\.mod)? h1:/gm)) out.set(m[1], m[2]);
  return out;
}

// @spec PIPE-CTX-008
export function summarizeLockfile(path: string, before: string | null, after: string | null): string {
  const name = path.split("/").pop()!;
  const a = lockEntries(name, before);
  const b = lockEntries(name, after);
  const added = [...b.keys()].filter((k) => !a.has(k)).map((k) => `${k}@${b.get(k)}`);
  const removed = [...a.keys()].filter((k) => !b.has(k)).map((k) => `${k}@${a.get(k)}`);
  const changed = [...b.keys()].filter((k) => a.has(k) && a.get(k) !== b.get(k)).map((k) => `${k} ${a.get(k)} -> ${b.get(k)}`);
  const list = (label: string, xs: string[]) => (xs.length ? `${label} (${xs.length}): ${xs.slice(0, 40).join(", ")}${xs.length > 40 ? ", ..." : ""}` : "");
  return [`Lockfile ${path} changed.`, list("added", added), list("removed", removed), list("changed", changed)].filter(Boolean).join("\n");
}

/** A notebook's cells with outputs and execution counts removed. */
// @spec PIPE-CTX-010
export function stripNotebook(text: string | null): string {
  if (!text) return "";
  try {
    const nb = JSON.parse(text);
    return (nb.cells ?? [])
      .map((c: { cell_type: string; source: string | string[] }, i: number) => `# cell ${i + 1} (${c.cell_type})\n${Array.isArray(c.source) ? c.source.join("") : c.source}`)
      .join("\n\n");
  } catch {
    return text;
  }
}

/** Classifies each changed file and replaces noise with compact summaries. */
// @spec PIPE-CTX-009, PIPE-CTX-011
export function classify(opts: NormalizeOptions, files: ChangedFile[]): Classified[] {
  const generatedGlobs = opts.generatedPaths.map(globToRegex);
  const marked = attrs(opts.repo, opts.head, files.map((f) => f.path));
  return files.map((file): Classified => {
    const name = file.path.split("/").pop()!;
    if (LOCKFILES.has(name)) {
      return {
        kind: "lockfile",
        file,
        summary: summarizeLockfile(file.path, showFile(opts.repo, opts.base, file.oldPath ?? file.path), showFile(opts.repo, opts.head, file.path)),
      };
    }
    const after = file.status.startsWith("D") ? null : showFile(opts.repo, opts.head, file.path);
    if (file.binary || (after !== null && LFS_POINTER.test(after))) {
      const buf = file.status.startsWith("D") ? Buffer.alloc(0) : gitBuffer(opts.repo, ["show", `${opts.head}:${file.path}`]);
      const hash = createHash("sha256").update(buf).digest("hex").slice(0, 16);
      const lfs = after !== null && LFS_POINTER.test(after) ? " (large-file-storage pointer)" : "";
      return { kind: "binary", file, summary: `Binary file ${file.path}${lfs}: ${file.status}, ${buf.length} bytes, sha256 ${hash}` };
    }
    const generated =
      marked.has(file.path) ||
      GENERATED_PATHS.some((r) => r.test(file.path)) ||
      generatedGlobs.some((r) => r.test(file.path)) ||
      (after !== null && GENERATED_HEADER.test(after.split("\n").slice(0, 5).join("\n")));
    if (generated) return { kind: "generated", file, summary: `Generated or vendored file ${file.path} ${file.status === "A" ? "added" : file.status.startsWith("D") ? "deleted" : "changed"}; contents not reviewed.` };
    if (name.endsWith(".ipynb")) {
      const before = stripNotebook(showFile(opts.repo, opts.base, file.oldPath ?? file.path));
      const content = stripNotebook(after);
      return { kind: "notebook", file, content, patch: `--- ${file.path} (outputs removed)\n${simpleDiff(before, content)}` };
    }
    return { kind: "source", file, patch: filePatch(opts.repo, opts.base, opts.head, file) };
  });
}

function simpleDiff(a: string, b: string): string {
  const al = new Set(a.split("\n"));
  const bl = new Set(b.split("\n"));
  return [...a.split("\n").filter((l) => !bl.has(l)).map((l) => `-${l}`), ...b.split("\n").filter((l) => !al.has(l)).map((l) => `+${l}`)].join("\n");
}

const IMPORT = /^\s*(import\b|from\s+\S+\s+import\b|use\s|using\s|#include\b|require\(|const .* = require\()/;

/**
 * Splits a patch into substantive hunks and mechanical ones (whitespace-only or import reordering).
 * Returns the patch without mechanical hunks and a description of what was collapsed.
 */
// @spec PIPE-CTX-012
export function collapseMechanical(patch: string): { patch: string; collapsed: string[] } {
  const [header, ...hunks] = patch.split(/^(?=@@ )/m);
  const kept: string[] = [];
  const collapsed: string[] = [];
  for (const h of hunks) {
    const lines = h.split("\n").slice(1);
    const removed = lines.filter((l) => l.startsWith("-")).map((l) => l.slice(1));
    const added = lines.filter((l) => l.startsWith("+")).map((l) => l.slice(1));
    const squash = (xs: string[]) => xs.join("").replace(/\s+/g, "");
    const whitespaceOnly = removed.length + added.length > 0 && squash(removed) === squash(added);
    const sorted = (xs: string[]) => [...xs].map((x) => x.trim()).sort().join("\n");
    const importReorder =
      removed.length > 0 && removed.every((l) => IMPORT.test(l)) && added.every((l) => IMPORT.test(l)) && sorted(removed) === sorted(added);
    if (whitespaceOnly) collapsed.push("reformatting");
    else if (importReorder) collapsed.push("import reordering");
    else kept.push(h);
  }
  return { patch: kept.length ? header + kept.join("") : "", collapsed };
}
