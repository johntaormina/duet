import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Change } from "@duet/adapters";
import { openStore } from "@duet/store";
import { describe, expect, it } from "vitest";
import { buildContextPack, ChangeTooLargeError, collapseMechanical, ensureHeadWorktree, stripNotebook, summarizeLockfile } from "../src/index.ts";
import { fixtureRepo, git, write } from "./kit.ts";

function change(base: string, head: string, extra: Partial<Change> = {}): Change {
  return { base, head, title: "Retry uploads", description: "", linkedIssues: [], comments: [], ...extra };
}

async function pack(dir: string, base: string, head: string, extra: Partial<Parameters<typeof buildContextPack>[0]> = {}) {
  const worktree = ensureHeadWorktree(dir, join(dir, ".duet", "r"), head);
  return buildContextPack({ repo: dir, worktree, change: change(base, head), budget: 100_000, perFileLimit: 20_000, historyCount: 5, generatedPaths: [], resolvers: [], toolOutput: [], ...extra });
}

function commit(dir: string, files: Record<string, string>, message = "change") {
  for (const [p, c] of Object.entries(files)) write(dir, p, c);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

describe("head worktree", () => {
  // @spec PIPE-WT-001, PIPE-WT-002, PIPE-WT-003
  it("creates one detached worktree of the head without touching the reviewer's checkout", () => {
    const { dir, base } = fixtureRepo();
    git(dir, "checkout", "-q", "main");
    write(dir, "local.txt", "uncommitted");
    openStore({ repoRoot: dir }).ensureRoot();
    const before = git(dir, "status", "--porcelain");
    const head = git(dir, "rev-parse", "feature");
    const wt = ensureHeadWorktree(dir, join(dir, ".duet", "r1"), head);
    expect(git(wt, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(wt, "src/upload.ts"), "utf8")).toContain("while (true)");
    expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(dir, "status", "--porcelain")).toBe(before);
    expect(ensureHeadWorktree(dir, join(dir, ".duet", "r1"), head)).toBe(wt);
    void base;
  });
});

describe("context pack", () => {
  // @spec PIPE-CTX-001
  it("is deterministic for the same change and configuration", async () => {
    const { dir, base, head } = fixtureRepo();
    expect(await pack(dir, base, head)).toEqual(await pack(dir, base, head));
  });

  // @spec PIPE-CTX-002
  it("orders items: diff, author reasoning, changed files, project docs, then callers", async () => {
    const { dir, base, head } = fixtureRepo();
    const p = await pack(dir, base, head, { authorStatement: "I want retries" });
    const kinds = p.items.map((i) => i.kind);
    const first = (k: string) => kinds.indexOf(k as never);
    expect(first("diff")).toBe(0);
    expect(first("diff")).toBeLessThan(first("author-statement"));
    expect(first("author-statement")).toBeLessThan(first("intent-source"));
    expect(first("intent-source")).toBeLessThan(first("commit-message"));
    expect(first("commit-message")).toBeLessThan(first("changed-file"));
    expect(first("changed-file")).toBeLessThan(first("project-doc"));
    expect(first("project-doc")).toBeLessThan(first("caller"));
    expect(p.items.map((i) => i.id)).toEqual(p.items.map((_, i) => `i${i + 1}`));
  });

  // @spec PIPE-CLI-005
  it("includes an author statement and an agent plan as author reasoning", async () => {
    const { dir, base, head } = fixtureRepo();
    const p = await pack(dir, base, head, { authorStatement: "Make imports resilient", agentPlan: "Plan: add retries" });
    expect(p.items.filter((i) => i.kind === "author-statement").map((i) => i.content)).toEqual(["Make imports resilient", "Plan: add retries"]);
  });

  // @spec PIPE-CTX-003
  it("skips an item that does not fit and keeps considering smaller later ones", async () => {
    const { dir, base, head } = fixtureRepo();
    const full = await pack(dir, base, head);
    const required = full.items.filter((i) => ["diff", "intent-source", "commit-message", "summarized-file", "author-statement"].includes(i.kind)).reduce((n, i) => n + i.size, 0);
    const big = full.items.find((i) => i.kind === "changed-file")!;
    const p = await pack(dir, base, head, { budget: required + big.size - 1 });
    expect(p.excluded.some((e) => e.source === big.source && /budget/.test(e.reason))).toBe(true);
    expect(p.items.some((i) => i.kind === "project-doc")).toBe(true);
  });

  // @spec PIPE-CTX-004
  it("fails when the diff and author reasoning alone exceed the budget", async () => {
    const { dir, base, head } = fixtureRepo();
    await expect(pack(dir, base, head, { budget: 50 })).rejects.toBeInstanceOf(ChangeTooLargeError);
    await expect(pack(dir, base, head, { budget: 50 })).rejects.toThrow(/too large to review as one/);
  });

  // @spec PIPE-CTX-005
  it("finds callers with a configured resolver for the file's ecosystem", async () => {
    const { dir, base, head } = fixtureRepo();
    const p = await pack(dir, base, head, { resolvers: [{ ecosystem: "ts", matches: (f) => f.endsWith(".ts"), callers: async () => ["README.md"] }] });
    expect(p.items.filter((i) => i.kind === "caller").map((i) => i.source)).toEqual(["README.md"]);
  });

  // @spec PIPE-CTX-006
  it("falls back to text search, skipping stop-listed names and noting the limitation", async () => {
    const { dir, base, head } = fixtureRepo();
    const p = await pack(dir, base, head);
    const callers = p.items.filter((i) => i.kind === "caller");
    expect(callers.map((c) => c.source)).toContain("src/caller.ts");
    expect(callers.some((c) => /text search only/.test(c.content))).toBe(true);
  });

  // @spec PIPE-CTX-007
  it("detects renames", async () => {
    const { dir, head } = fixtureRepo();
    git(dir, "mv", "src/caller.ts", "src/invoke.ts");
    git(dir, "commit", "-q", "-m", "rename");
    const p = await pack(dir, head, git(dir, "rev-parse", "HEAD"));
    expect(p.items.find((i) => i.source === "mechanical changes")?.content).toContain("renamed src/caller.ts -> src/invoke.ts");
  });

  // @spec PIPE-CTX-008
  it("summarizes lockfiles as packages added, removed, and changed", async () => {
    const lock = (deps: Record<string, string>) => JSON.stringify({ packages: Object.fromEntries(Object.entries(deps).map(([k, v]) => [`node_modules/${k}`, { version: v }])) });
    const s = summarizeLockfile("package-lock.json", lock({ a: "1.0.0", b: "1.0.0" }), lock({ a: "2.0.0", c: "1.0.0" }));
    expect(s).toMatch(/added \(1\): c@1\.0\.0/);
    expect(s).toMatch(/removed \(1\): b@1\.0\.0/);
    expect(s).toMatch(/changed \(1\): a 1\.0\.0 -> 2\.0\.0/);
    const { dir, head } = fixtureRepo();
    const next = commit(dir, { "package-lock.json": lock({ a: "1.0.0" }) });
    const p = await pack(dir, head, next);
    expect(p.items.find((i) => i.source === "package-lock.json")?.kind).toBe("summarized-file");
  });

  // @spec PIPE-CTX-009
  it("replaces generated and vendored files with a one-line note", async () => {
    const { dir, head } = fixtureRepo();
    const next = commit(dir, { "gen/api.ts": "// Code generated by tool. DO NOT EDIT.\nexport const x = 1;\n", "vendor/lib.js": "x", "custom/out.txt": "y" });
    const p = await pack(dir, head, next, { generatedPaths: ["custom/**"] });
    for (const f of ["gen/api.ts", "vendor/lib.js", "custom/out.txt"]) {
      const item = p.items.find((i) => i.source === f);
      expect(item?.kind, f).toBe("summarized-file");
      expect(item?.content).toMatch(/Generated or vendored/);
    }
  });

  // @spec PIPE-CTX-010
  it("includes notebooks with outputs removed", async () => {
    const nb = JSON.stringify({ cells: [{ cell_type: "code", source: ["x = 1\n"], outputs: [{ data: { "image/png": "AAAA".repeat(500) } }] }] });
    expect(stripNotebook(nb)).not.toContain("AAAA");
    const { dir, head } = fixtureRepo();
    const next = commit(dir, { "nb.ipynb": nb });
    const p = await pack(dir, head, next);
    const item = p.items.find((i) => i.source === "nb.ipynb")!;
    expect(item.content).toContain("x = 1");
    expect(item.content).not.toContain("AAAA");
  });

  // @spec PIPE-CTX-011
  it("replaces binary and large-file-storage files with path, size, and hash", async () => {
    const { dir, head } = fixtureRepo();
    write(dir, "img.png", "");
    const next = (() => {
      require_binary(dir);
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "bin");
      return git(dir, "rev-parse", "HEAD");
    })();
    const p = await pack(dir, head, next);
    expect(p.items.find((i) => i.source === "img.png")?.content).toMatch(/Binary file img\.png: A, \d+ bytes, sha256 [0-9a-f]{16}/);
  });

  // @spec PIPE-CTX-012
  it("collapses whitespace-only and import-reordering hunks", () => {
    const patch = `diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-import a from "a";\n-import b from "b";\n+import b from "b";\n+import a from "a";\n@@ -10,1 +10,1 @@\n-const x=1;\n+const x = 1;\n@@ -20,1 +20,1 @@\n-return 1;\n+return 2;\n`;
    const out = collapseMechanical(patch);
    expect(out.collapsed.sort()).toEqual(["import reordering", "reformatting"]);
    expect(out.patch).toContain("return 2");
    expect(out.patch).not.toContain("import b");
  });

  // @spec PIPE-CTX-013
  it("outlines a changed file over the per-file limit with its changed hunks", async () => {
    const { dir, base, head } = fixtureRepo();
    const p = await pack(dir, base, head, { perFileLimit: 50 });
    const item = p.items.find((i) => i.source === "src/upload.ts" && i.kind === "file-outline")!;
    expect(item.content).toMatch(/Outline of src\/upload\.ts/);
    expect(item.content).toMatch(/export async function upload/);
    expect(item.content).toMatch(/Changed hunks/);
  });

  // @spec PIPE-CTX-014
  it("includes documents linked from the description and matching design records", async () => {
    const { dir, head } = fixtureRepo();
    const next = commit(dir, { "docs/retry-plan.md": "Plan", "docs/adr/0003-src-retries.md": "We retry in src/upload.ts", "src/upload.ts": "export const changed = 1;\n" });
    const worktree = ensureHeadWorktree(dir, join(dir, ".duet", "r2"), next);
    const p = await buildContextPack({ repo: dir, worktree, change: change(head, next, { description: "See [plan](docs/retry-plan.md)" }), budget: 100_000, perFileLimit: 20_000, historyCount: 0, generatedPaths: [], resolvers: [], toolOutput: [] });
    const docs = p.items.filter((i) => i.kind === "linked-doc").map((i) => i.source);
    expect(docs).toContain("docs/retry-plan.md");
    expect(docs).toContain("docs/adr/0003-src-retries.md");
  });

  // @spec PIPE-CTX-015
  it("includes the nearest instruction files, the root's, and matching code owners", async () => {
    const { dir, head } = fixtureRepo();
    const next = commit(dir, { "src/AGENTS.md": "src rules", ".github/CODEOWNERS": "/src/ @upload-team\n/docs/ @docs-team\n", "src/upload.ts": "export const v = 2;\n" });
    const p = await pack(dir, head, next);
    const docs = p.items.filter((i) => i.kind === "project-doc").map((i) => i.source);
    expect(docs.indexOf("src/AGENTS.md")).toBeLessThan(docs.indexOf("README.md"));
    const owners = p.items.find((i) => i.kind === "codeowners")!;
    expect(owners.content).toContain("@upload-team");
    expect(owners.content).not.toContain("@docs-team");
  });

  // @spec PIPE-CTX-016
  it("includes recent earlier commits that touched the changed lines", async () => {
    const { dir, base, head } = fixtureRepo();
    const p = await pack(dir, base, head);
    const hist = p.items.filter((i) => i.kind === "history");
    expect(hist.some((h) => h.content.includes("initial upload client"))).toBe(true);
    const none = await pack(dir, base, head, { historyCount: 0 });
    expect(none.items.some((i) => i.kind === "history")).toBe(false);
  });

  // @spec PIPE-CTX-017
  it("includes configured tool output", async () => {
    const { dir, base, head } = fixtureRepo();
    const p = await pack(dir, base, head, { toolOutput: [{ name: "plan", produce: async () => "1 to replace" }] });
    expect(p.items.find((i) => i.kind === "tool-output")).toMatchObject({ source: "plan", content: "1 to replace" });
  });
});

function require_binary(dir: string) {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01, 0xff, 0x00]);
  write(dir, "img.png", bytes as unknown as string);
}
