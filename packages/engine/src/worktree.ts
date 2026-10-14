import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/**
 * Returns the run's read-only view of the head commit, creating it once as a detached worktree
 * inside the run directory. The reviewer's branch, index, and files are not touched.
 */
// @spec PIPE-WT-001, PIPE-WT-002, PIPE-WT-003
export function ensureHeadWorktree(repo: string, runDir: string, head: string): string {
  const path = join(runDir, "head");
  if (existsSync(join(path, ".git"))) {
    if (git(path, ["rev-parse", "HEAD"]) === head) return path;
    removeHeadWorktree(repo, runDir);
  }
  git(repo, ["worktree", "add", "--detach", "--quiet", path, head]);
  return path;
}

export function removeHeadWorktree(repo: string, runDir: string): void {
  const path = join(runDir, "head");
  try {
    git(repo, ["worktree", "remove", "--force", path]);
  } catch {
    // Not a registered worktree; the directory is removed with the run.
  }
  try {
    git(repo, ["worktree", "prune"]);
  } catch {
    // Nothing to prune.
  }
}
