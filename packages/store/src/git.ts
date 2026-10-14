import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } }).trim();
}

const FIXED_IDENTITY = {
  GIT_AUTHOR_NAME: "duet",
  GIT_AUTHOR_EMAIL: "duet@localhost",
  GIT_AUTHOR_DATE: "1970-01-01T00:00:00+0000",
  GIT_COMMITTER_NAME: "duet",
  GIT_COMMITTER_EMAIL: "duet@localhost",
  GIT_COMMITTER_DATE: "1970-01-01T00:00:00+0000",
};

/**
 * Captures the working tree as a commit whose parent is HEAD, using a private index so the
 * reviewer's working tree, index, and branches are untouched. Fixed metadata makes the SHA a
 * function of content alone.
 */
// @spec ART-RUN-003, ART-RUN-004, ART-RUN-007
export function snapshotWorkingTree(repoRoot: string, runRoot: string): string {
  const tmp = mkdtempSync(join(tmpdir(), "duet-index-"));
  const env = { GIT_INDEX_FILE: join(tmp, "index") };
  try {
    git(repoRoot, ["read-tree", "HEAD"], env);
    git(repoRoot, ["add", "-A", "--", ".", `:(top,exclude)${runRoot}`], env);
    const tree = git(repoRoot, ["write-tree"], env);
    return git(repoRoot, ["commit-tree", "--no-gpg-sign", tree, "-p", "HEAD", "-m", "duet snapshot"], {
      ...env,
      ...FIXED_IDENTITY,
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function updateRef(repoRoot: string, ref: string, sha: string): void {
  git(repoRoot, ["update-ref", ref, sha]);
}

export function deleteRef(repoRoot: string, ref: string): void {
  try {
    git(repoRoot, ["update-ref", "-d", ref]);
  } catch {
    // Already absent.
  }
}
