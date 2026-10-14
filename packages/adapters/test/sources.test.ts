import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitSource, ghSource, type Exec } from "../src/index.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** main: c1 -> c3; feature (from c1): c2. */
function branchedRepo() {
  const dir = mkdtempSync(join(tmpdir(), "duet-src-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "T");
  writeFileSync(join(dir, "a.txt"), "1\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "c1");
  const c1 = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "-b", "feature");
  writeFileSync(join(dir, "b.txt"), "feature\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "c2");
  const c2 = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "main");
  writeFileSync(join(dir, "c.txt"), "main moved\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "c3");
  git(dir, "checkout", "-q", "feature");
  return { dir, c1, c2 };
}

const FIELDS = ["base", "head", "title", "description", "linkedIssues", "comments"];

describe("git source", () => {
  // @spec ADPT-SRC-001, ADPT-SRC-002, ADPT-SRC-009
  it("resolves a base and head ref to the merge-base and head commit, with every field present", async () => {
    const { dir, c1, c2 } = branchedRepo();
    const change = await gitSource().resolve({ kind: "refs", base: "main", head: "feature" }, { repoRoot: dir, runRoot: ".duet" });
    expect(Object.keys(change)).toEqual(expect.arrayContaining(FIELDS));
    expect(change.base).toBe(c1);
    expect(change.head).toBe(c2);
  });

  // @spec ADPT-SRC-002
  it("resolves the working tree against a base to a snapshot commit", async () => {
    const { dir, c2 } = branchedRepo();
    writeFileSync(join(dir, "b.txt"), "edited\n");
    const change = await gitSource().resolve({ kind: "worktree", base: "main" }, { repoRoot: dir, runRoot: ".duet" });
    expect(git(dir, "rev-parse", `${change.head}^`)).toBe(c2);
    expect(git(dir, "show", `${change.head}:b.txt`)).toBe("edited");
    expect(change.worktree).toBe(true);
  });

  // @spec ADPT-SRC-003
  it("returns empty intent sources without a reviewer-supplied description", async () => {
    const { dir } = branchedRepo();
    const change = await gitSource().resolve({ kind: "refs", base: "main", head: "feature" }, { repoRoot: dir, runRoot: ".duet" });
    expect(change.description).toBe("");
    expect(change.linkedIssues).toEqual([]);
    expect(change.comments).toEqual([]);
  });
});

describe("gh source", () => {
  function fakeGh(view: object) {
    const calls: string[][] = [];
    const exec: Exec = async (cmd, args, opts) => {
      calls.push([cmd, ...args]);
      if (cmd === "gh" && args[0] === "pr" && args[1] === "view") return JSON.stringify(view);
      if (cmd === "gh" && args[0] === "issue" && args[1] === "view") return JSON.stringify({ title: "Issue", body: "Issue body" });
      if (cmd === "git") return execFileSync("git", args, { cwd: opts?.cwd, encoding: "utf8" });
      throw new Error(`unexpected ${cmd} ${args.join(" ")}`);
    };
    return { calls, exec };
  }

  // @spec ADPT-SRC-004, ADPT-SRC-007
  it("reads a pull request with gh and returns the merge-base of its head and target branch", async () => {
    const { dir, c1, c2 } = branchedRepo();
    const { calls, exec } = fakeGh({
      number: 7,
      title: "Add b",
      body: "Adds b.txt",
      baseRefName: "main",
      headRefOid: c2,
      closingIssuesReferences: [{ number: 3 }],
      comments: [{ author: { login: "r" }, body: "Looks odd" }],
    });
    const change = await ghSource({ exec }).resolve({ kind: "pr", number: 7 }, { repoRoot: dir, runRoot: ".duet" });
    expect(calls[0].slice(0, 4)).toEqual(["gh", "pr", "view", "7"]);
    expect(change).toMatchObject({ base: c1, head: c2, title: "Add b", description: "Adds b.txt" });
    expect(change.linkedIssues[0]).toContain("Issue body");
    expect(change.comments[0]).toEqual({ author: "r", body: "Looks odd" });
  });

  // @spec ADPT-SRC-005
  it("fetches a missing head commit without changing the checked-out branch", async () => {
    const { dir, c2 } = branchedRepo();
    const fetched: string[][] = [];
    const exec: Exec = async (cmd, args, opts) => {
      if (cmd === "gh") return JSON.stringify({ number: 7, title: "t", body: "", baseRefName: "main", headRefOid: "f".repeat(40), closingIssuesReferences: [], comments: [] });
      if (args[0] === "fetch") {
        fetched.push(args);
        return "";
      }
      if (args[0] === "cat-file") throw new Error("missing");
      if (args[0] === "merge-base") return c2;
      return execFileSync(cmd, args, { cwd: opts?.cwd, encoding: "utf8" });
    };
    await ghSource({ exec }).resolve({ kind: "pr", number: 7 }, { repoRoot: dir, runRoot: ".duet" });
    expect(fetched).toHaveLength(1);
    expect(fetched[0].join(" ")).toContain("refs/pull/7/head:refs/duet/pr/7/head");
    expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature");
  });

  // @spec ADPT-SRC-006
  it("never runs a command that writes to the code host", async () => {
    const { dir, c2 } = branchedRepo();
    const { calls, exec } = fakeGh({ number: 7, title: "t", body: "", baseRefName: "main", headRefOid: c2, closingIssuesReferences: [], comments: [] });
    await ghSource({ exec }).resolve({ kind: "pr", number: 7 }, { repoRoot: dir, runRoot: ".duet" });
    const ghCalls = calls.filter((c) => c[0] === "gh").map((c) => `${c[1]} ${c[2]}`);
    expect(ghCalls.every((c) => c === "pr view" || c === "issue view")).toBe(true);
    expect(calls.some((c) => c[0] === "git" && c[1] === "push")).toBe(false);
  });
});
