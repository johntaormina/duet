import { execFileSync } from "node:child_process";

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

export function gitBuffer(cwd: string, args: string[]): Buffer {
  return execFileSync("git", args, { cwd, maxBuffer: 256 * 1024 * 1024 });
}

export interface ChangedFile {
  status: string;
  path: string;
  oldPath?: string;
  binary: boolean;
}

/** Changed files between base and head, with rename and copy detection. */
// @spec PIPE-CTX-007
export function changedFiles(repo: string, base: string, head: string): ChangedFile[] {
  const nameStatus = git(repo, ["diff", "--name-status", "-M", "-C", base, head]).trim();
  const numstat = git(repo, ["diff", "--numstat", "-M", "-C", base, head]).trim();
  const binary = new Set<string>();
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [add, del, ...rest] = line.split("\t");
    if (add === "-" && del === "-") binary.add(rest[rest.length - 1].replace(/.*=> /, "").replace(/[{}]/g, ""));
  }
  return nameStatus
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      const status = parts[0];
      const path = parts[parts.length - 1];
      return { status, path, oldPath: parts.length > 2 ? parts[1] : undefined, binary: binary.has(path) };
    });
}

/** The unified diff of one file, with rename and copy detection. */
export function filePatch(repo: string, base: string, head: string, f: ChangedFile, context = 3): string {
  const paths = f.oldPath ? [f.oldPath, f.path] : [f.path];
  return git(repo, ["diff", `-U${context}`, "-M", "-C", base, head, "--", ...paths]);
}

export function showFile(repo: string, rev: string, path: string): string | null {
  try {
    return git(repo, ["show", `${rev}:${path}`]);
  } catch {
    return null;
  }
}
