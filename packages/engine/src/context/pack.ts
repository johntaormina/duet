import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CallerResolver, Change, ToolOutputProvider } from "@duet/adapters";
import type { ContextItem, ContextKind, ContextPack } from "@duet/store";
import { changedFiles, filePatch, git, type ChangedFile } from "./git.ts";
import { classify, collapseMechanical, type Classified } from "./normalize.ts";
import { globToRegex } from "./glob.ts";

export class ChangeTooLargeError extends Error {
  constructor(size: number, budget: number) {
    super(
      `The change is too large to review as one: its normalized diff and author reasoning take ${size} characters against a context budget of ${budget}. Consider splitting it.`,
    );
    this.name = "ChangeTooLargeError";
  }
}

export interface PackInput {
  repo: string;
  /** Head worktree, where files at head are read and searched. */
  worktree: string;
  change: Change;
  authorStatement?: string;
  agentPlan?: string;
  budget: number;
  perFileLimit: number;
  historyCount: number;
  generatedPaths: string[];
  resolvers: CallerResolver[];
  toolOutput: ToolOutputProvider[];
}

interface Candidate {
  kind: ContextKind;
  source: string;
  content: string;
  /** Items that are never excluded: the normalized diff and the author's reasoning. */
  required?: boolean;
}

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "README.md", "README"];
const DESIGN_DIRS = ["docs/adr", "docs/adrs", "docs/decisions", "doc/adr", "adr", "architecture/decisions", "docs/architecture/decisions"];
const CODEOWNERS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];
const STOP_NAMES = new Set(["get", "set", "id", "name", "type", "value", "data", "config", "init", "main", "run", "start", "stop", "index", "default", "props", "state", "result", "error", "handler", "test", "update", "create", "delete", "list", "item", "key", "options", "params", "args", "options", "util", "utils", "helper", "new", "load", "save", "read", "write", "open", "close", "parse", "format", "render", "build", "make"]);
const CALLER_CAP = 5;

/**
 * Assembles the context pack deterministically: no Claude calls, priority order, a character budget,
 * and every exclusion recorded with its reason.
 */
// @spec PIPE-CTX-001, PIPE-CTX-002, PIPE-CTX-003, PIPE-CTX-004
export async function buildContextPack(input: PackInput): Promise<ContextPack> {
  const { change } = input;
  const files = changedFiles(input.repo, change.base, change.head);
  const classified = classify({ repo: input.repo, base: change.base, head: change.head, generatedPaths: input.generatedPaths }, files);
  const candidates: Candidate[] = [];

  // 1. The normalized diff.
  const mechanical: string[] = [];
  for (const c of classified) {
    if (c.kind === "lockfile" || c.kind === "generated" || c.kind === "binary") {
      candidates.push({ kind: "summarized-file", source: c.file.path, content: c.summary, required: true });
    } else if (c.kind === "notebook") {
      candidates.push({ kind: "diff", source: c.file.path, content: c.patch, required: true });
    } else {
      const { patch, collapsed } = collapseMechanical(c.patch);
      if (c.file.status.startsWith("R") && !/^@@ /m.test(c.patch)) mechanical.push(`renamed ${c.file.oldPath} -> ${c.file.path}`);
      else if (collapsed.length) mechanical.push(`${c.file.path}: ${[...new Set(collapsed)].join(", ")}`);
      if (patch) candidates.push({ kind: "diff", source: c.file.path, content: patch, required: true });
    }
  }
  if (mechanical.length) {
    candidates.push({ kind: "summarized-file", source: "mechanical changes", content: `Mechanical changes collapsed:\n${mechanical.join("\n")}`, required: true });
  }

  // 2. Author reasoning.
  if (input.authorStatement?.trim()) candidates.push({ kind: "author-statement", source: "author statement", content: input.authorStatement.trim(), required: true });
  if (input.agentPlan?.trim()) candidates.push({ kind: "author-statement", source: "agent plan", content: input.agentPlan.trim(), required: true });
  if (change.title || change.description) {
    candidates.push({ kind: "intent-source", source: change.pr ? `pull request #${change.pr}` : "change description", content: `${change.title}\n\n${change.description}`.trim(), required: true });
  }
  for (const issue of change.linkedIssues) candidates.push({ kind: "intent-source", source: issue.split("\n")[0], content: issue, required: true });
  if (!change.worktree) {
    const log = git(input.repo, ["log", "--format=%H%x00%B%x01", `${change.base}..${change.head}`]);
    for (const entry of log.split("\x01").map((e) => e.trim()).filter(Boolean)) {
      const [sha, message] = entry.split("\0");
      candidates.push({ kind: "commit-message", source: sha.slice(0, 12), content: message.trim(), required: true });
    }
  }

  // 3. Changed files at head, outlined when too large.
  const sourceFiles = classified.filter((c): c is Extract<Classified, { kind: "source" }> => c.kind === "source" && !c.file.status.startsWith("D"));
  for (const c of sourceFiles) candidates.push(changedFileItem(input, c.file));

  // 4. Linked documents.
  candidates.push(...linkedDocs(input, files));

  // 5. Project documents and code owners.
  candidates.push(...projectDocs(input, files));

  // 6. History of the changed lines.
  candidates.push(...history(input, sourceFiles.map((c) => c.file)));

  // 7. Tool output.
  // @spec PIPE-CTX-017
  for (const p of input.toolOutput) {
    const out = await p.produce({ worktree: input.worktree, base: change.base, head: change.head, files: files.map((f) => f.path) });
    if (out) candidates.push({ kind: "tool-output", source: p.name, content: out });
  }

  // 8. Direct callers.
  candidates.push(...(await callers(input, sourceFiles.map((c) => c.file.path))));

  return fit(candidates, input.budget);
}

function fit(candidates: Candidate[], budget: number): ContextPack {
  const requiredSize = candidates.filter((c) => c.required).reduce((n, c) => n + c.content.length, 0);
  if (requiredSize > budget) throw new ChangeTooLargeError(requiredSize, budget);
  const items: ContextItem[] = [];
  const excluded: ContextPack["excluded"] = [];
  let used = 0;
  for (const c of candidates) {
    if (c.required || used + c.content.length <= budget) {
      items.push({ id: `i${items.length + 1}`, kind: c.kind, source: c.source, size: c.content.length, content: c.content });
      used += c.content.length;
    } else {
      excluded.push({ kind: c.kind, source: c.source, reason: `did not fit in the remaining context budget (${c.content.length} characters, ${budget - used} left)` });
    }
  }
  return { schema_version: "1.0", budget, items, excluded };
}

const DECLARATION = /^\s*(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|enum|const|let|var|def|func|fn|struct|trait|impl|module|resource|data|variable|output|model|public|private|protected|package)\b.*$/;

// @spec PIPE-CTX-013
function changedFileItem(input: PackInput, f: ChangedFile): Candidate {
  const path = join(input.worktree, f.path);
  const content = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (content.length <= input.perFileLimit) return { kind: "changed-file", source: f.path, content };
  const outline = content
    .split("\n")
    .map((l, i) => [i + 1, l] as const)
    .filter(([, l]) => DECLARATION.test(l))
    .map(([n, l]) => `${n}: ${l.trim()}`)
    .join("\n");
  const hunks = filePatch(input.repo, input.change.base, input.change.head, f, 5);
  return { kind: "file-outline", source: f.path, content: `Outline of ${f.path} (${content.length} characters, too large to include whole):\n${outline}\n\nChanged hunks with surrounding lines:\n${hunks}` };
}

// @spec PIPE-CTX-014
function linkedDocs(input: PackInput, files: ChangedFile[]): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const text = `${input.change.description}\n${input.change.linkedIssues.join("\n")}`;
  for (const m of text.matchAll(/(?:\]\(|\s|^)((?:\.\/)?[\w./-]+\.(?:md|markdown|rst|txt|adoc))\b/gm)) {
    const p = m[1].replace(/^\.\//, "");
    const abs = join(input.worktree, p);
    if (!seen.has(p) && existsSync(abs) && statSync(abs).isFile()) {
      seen.add(p);
      out.push({ kind: "linked-doc", source: p, content: readFileSync(abs, "utf8") });
    }
  }
  const changedDirs = new Set(files.flatMap((f) => f.path.split("/").slice(0, -1)).filter((s) => s.length > 2));
  for (const dir of DESIGN_DIRS) {
    const abs = join(input.worktree, dir);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) continue;
    for (const name of readdirSync(abs).sort()) {
      const p = `${dir}/${name}`;
      if (seen.has(p) || !/\.(md|markdown|rst|txt)$/.test(name)) continue;
      const content = readFileSync(join(abs, name), "utf8");
      const matches = files.some((f) => content.includes(f.path)) || [...changedDirs].some((d) => name.toLowerCase().includes(d.toLowerCase()));
      if (matches) {
        seen.add(p);
        out.push({ kind: "linked-doc", source: p, content });
      }
    }
  }
  return out;
}

function globMatch(pattern: string, path: string): boolean {
  let p = pattern.startsWith("/") ? pattern.slice(1) : `**/${pattern}`;
  if (p.endsWith("/")) p += "**";
  return globToRegex(p).test(path) || globToRegex(`${p}/**`).test(path);
}

// @spec PIPE-CTX-015
function projectDocs(input: PackInput, files: ChangedFile[]): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (rel: string) => {
    const abs = join(input.worktree, rel);
    if (seen.has(rel) || !existsSync(abs) || !statSync(abs).isFile()) return false;
    seen.add(rel);
    out.push({ kind: "project-doc", source: rel, content: readFileSync(abs, "utf8") });
    return true;
  };
  for (const f of files) {
    for (let dir = dirname(f.path); dir !== "." && dir !== "/"; dir = dirname(dir)) {
      if (INSTRUCTION_FILES.map((n) => add(`${dir}/${n}`)).some(Boolean)) break;
    }
  }
  for (const n of INSTRUCTION_FILES) add(n);
  for (const rel of CODEOWNERS) {
    const abs = join(input.worktree, rel);
    if (!existsSync(abs)) continue;
    const lines = readFileSync(abs, "utf8")
      .split("\n")
      .filter((l) => l.trim() && !l.trim().startsWith("#"))
      .filter((l) => files.some((f) => globMatch(l.trim().split(/\s+/)[0], f.path)));
    if (lines.length) out.push({ kind: "codeowners", source: rel, content: lines.join("\n") });
    break;
  }
  return out;
}

// @spec PIPE-CTX-016
function history(input: PackInput, files: ChangedFile[]): Candidate[] {
  if (input.historyCount <= 0) return [];
  const commits = new Map<string, number>();
  for (const f of files) {
    const patch = filePatch(input.repo, input.change.base, input.change.head, f, 0);
    for (const m of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? /gm)) {
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      if (count === 0 || start === 0) continue;
      try {
        const blame = git(input.repo, ["blame", "--porcelain", "-L", `${start},${start + count - 1}`, input.change.base, "--", f.oldPath ?? f.path]);
        for (const b of blame.matchAll(/^([0-9a-f]{40}) \d+ \d+/gm)) {
          const time = Number(/committer-time (\d+)/.exec(blame.slice(b.index))?.[1] ?? 0);
          commits.set(b[1], Math.max(commits.get(b[1]) ?? 0, time));
        }
      } catch {
        // New file or path absent at base.
      }
    }
  }
  return [...commits.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, input.historyCount)
    .map(([sha]) => ({ kind: "history" as const, source: sha.slice(0, 12), content: git(input.repo, ["log", "-1", "--format=%h %an %ad%n%B", "--date=short", sha]).trim() }));
}

const NAME_PATTERNS = [
  /export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm,
  /^\s*class\s+([A-Za-z_]\w*)/gm,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm,
  /^\s*pub\s+(?:fn|struct|enum|trait)\s+([A-Za-z_]\w*)/gm,
  /^\s*public\s+(?:static\s+)?[\w<>[\],\s]+\s+([A-Za-z_]\w*)\s*\(/gm,
];

function pathDistance(a: string, b: string): number {
  const x = a.split("/");
  const y = b.split("/");
  let i = 0;
  while (i < x.length - 1 && i < y.length - 1 && x[i] === y[i]) i++;
  return x.length - 1 - i + (y.length - 1 - i);
}

// @spec PIPE-CTX-005, PIPE-CTX-006
async function callers(input: PackInput, changed: string[]): Promise<Candidate[]> {
  const found = new Map<string, { from: string; via: string }>();
  const textSearched: string[] = [];
  for (const file of changed) {
    const resolver = input.resolvers.find((r) => r.matches(file));
    if (resolver) {
      for (const c of await resolver.callers(file, input.worktree)) if (!changed.includes(c) && !found.has(c)) found.set(c, { from: file, via: resolver.ecosystem });
      continue;
    }
    const path = join(input.worktree, file);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    const names = new Set<string>();
    for (const re of NAME_PATTERNS) for (const m of text.matchAll(re)) if (m[1].length > 2 && !STOP_NAMES.has(m[1].toLowerCase())) names.add(m[1]);
    if (names.size) textSearched.push(file);
    for (const name of [...names].sort()) {
      let hits: string[] = [];
      try {
        hits = git(input.worktree, ["grep", "-l", "-w", "-F", name]).split("\n").filter(Boolean);
      } catch {
        hits = [];
      }
      hits
        .filter((h) => h !== file && !changed.includes(h))
        .sort((a, b) => pathDistance(file, a) - pathDistance(file, b) || a.localeCompare(b))
        .slice(0, CALLER_CAP)
        .forEach((h) => !found.has(h) && found.set(h, { from: file, via: `text search for ${name}` }));
    }
  }
  const items: Candidate[] = [...found.entries()]
    .sort((a, b) => pathDistance(a[1].from, a[0]) - pathDistance(b[1].from, b[0]) || a[0].localeCompare(b[0]))
    .map(([p, info]) => ({ kind: "caller" as const, source: p, content: `Refers to ${info.from} (${info.via}):\n${readFileSync(join(input.worktree, p), "utf8")}` }));
  if (textSearched.length) {
    items.unshift({ kind: "caller", source: "caller discovery note", content: `Callers of ${textSearched.join(", ")} were found by text search only; references by reflection, configuration, or other languages were not examined.` });
  }
  return items;
}
