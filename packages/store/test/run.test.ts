import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveRunId, openStore, snapshotWorkingTree } from "../src/index.ts";
import { git, SHA_A, SHA_B, tempRepo } from "./fixtures.ts";

describe("run directory", () => {
  // @spec ART-RUN-001
  it("places a run's files under <root>/<run-id>, defaulting the root to .duet and allowing another", () => {
    const repo = tempRepo();
    expect(openStore({ repoRoot: repo }).runDir("r1")).toBe(join(repo, ".duet", "r1"));
    expect(openStore({ repoRoot: repo, root: "reviews" }).runDir("r1")).toBe(join(repo, "reviews", "r1"));
  });

  // @spec ART-RUN-002
  it("derives the run id deterministically from the base and head SHAs", () => {
    expect(deriveRunId(SHA_A, SHA_B)).toBe(deriveRunId(SHA_A, SHA_B));
    expect(deriveRunId(SHA_A, SHA_B)).not.toBe(deriveRunId(SHA_B, SHA_A));
    expect(deriveRunId(SHA_A, SHA_B)).toMatch(/^[0-9a-f]{16}$/);
  });

  // @spec ART-RUN-003
  it("snapshots tracked changes and non-ignored untracked files, excluding the run root, with HEAD as parent", () => {
    const repo = tempRepo();
    writeFileSync(join(repo, "a.txt"), "two\n");
    writeFileSync(join(repo, "new.txt"), "new\n");
    writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(repo, "ignored.txt"), "x\n");
    openStore({ repoRoot: repo }).ensureRoot();
    writeFileSync(join(repo, ".duet", "junk.json"), "{}");
    const sha = snapshotWorkingTree(repo, ".duet");
    expect(git(repo, "rev-parse", `${sha}^`)).toBe(git(repo, "rev-parse", "HEAD"));
    expect(git(repo, "show", `${sha}:a.txt`)).toBe("two");
    expect(git(repo, "show", `${sha}:new.txt`)).toBe("new");
    const files = git(repo, "ls-tree", "-r", "--name-only", sha).split("\n");
    expect(files).not.toContain("ignored.txt");
    expect(files.some((f) => f.startsWith(".duet"))).toBe(false);
  });

  // @spec ART-RUN-004
  it("leaves the working tree, index, and branches unchanged when snapshotting", () => {
    const repo = tempRepo();
    writeFileSync(join(repo, "a.txt"), "changed\n");
    writeFileSync(join(repo, "untracked.txt"), "u\n");
    const before = {
      status: git(repo, "status", "--porcelain"),
      head: git(repo, "rev-parse", "HEAD"),
      branches: git(repo, "for-each-ref", "refs/heads"),
    };
    snapshotWorkingTree(repo, ".duet");
    expect(git(repo, "status", "--porcelain")).toBe(before.status);
    expect(git(repo, "rev-parse", "HEAD")).toBe(before.head);
    expect(git(repo, "for-each-ref", "refs/heads")).toBe(before.branches);
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("changed\n");
  });

  // @spec ART-RUN-005
  it("keeps a snapshot reachable through refs/duet/<run-id> until the run is removed", () => {
    const repo = tempRepo();
    writeFileSync(join(repo, "a.txt"), "changed\n");
    const store = openStore({ repoRoot: repo });
    const sha = snapshotWorkingTree(repo, ".duet");
    store.keepSnapshot("r1", sha);
    expect(git(repo, "rev-parse", "refs/duet/r1")).toBe(sha);
    store.removeRun("r1");
    expect(() => git(repo, "rev-parse", "--verify", "-q", "refs/duet/r1")).toThrow();
  });

  // @spec ART-RUN-006
  it("writes a .gitignore inside a newly created root unless the root is configured as tracked", () => {
    const repo = tempRepo();
    openStore({ repoRoot: repo }).ensureRoot();
    expect(readFileSync(join(repo, ".duet", ".gitignore"), "utf8").trim()).toBe("*");
    const repo2 = tempRepo();
    openStore({ repoRoot: repo2, tracked: true }).ensureRoot();
    expect(existsSync(join(repo2, ".duet", ".gitignore"))).toBe(false);
  });

  // @spec ART-RUN-007
  it("produces the same snapshot SHA for the same base and working-tree contents", () => {
    const repo = tempRepo();
    writeFileSync(join(repo, "a.txt"), "changed\n");
    const first = snapshotWorkingTree(repo, ".duet");
    const second = snapshotWorkingTree(repo, ".duet");
    expect(second).toBe(first);
    writeFileSync(join(repo, "a.txt"), "changed again\n");
    expect(snapshotWorkingTree(repo, ".duet")).not.toBe(first);
  });
});
