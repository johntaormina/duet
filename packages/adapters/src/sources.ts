import { snapshotWorkingTree } from "@duet/store";
import { defaultExec, type Exec } from "./exec.ts";

export type ChangeRef =
  | { kind: "pr"; number: number }
  | { kind: "refs"; base: string; head: string }
  | { kind: "worktree"; base: string };

export interface Change {
  base: string;
  head: string;
  title: string;
  description: string;
  linkedIssues: string[];
  comments: { author: string; body: string }[];
  /** True when the head is a snapshot of the working tree. */
  worktree?: boolean;
  /** The pull request number, when the change is one. */
  pr?: number;
}

export interface SourceContext {
  repoRoot: string;
  /** The run root directory name, excluded from working-tree snapshots. */
  runRoot: string;
}

export interface Source {
  name: string;
  resolve(ref: ChangeRef, ctx: SourceContext): Promise<Change>;
}

const trim = (s: string) => s.trim();

// @spec ADPT-SRC-001, ADPT-SRC-002, ADPT-SRC-003, ADPT-SRC-009
export function gitSource(opts: { exec?: Exec } = {}): Source {
  const exec = opts.exec ?? defaultExec;
  const git = async (cwd: string, ...args: string[]) => trim(await exec("git", args, { cwd }));
  return {
    name: "git",
    async resolve(ref, ctx) {
      if (ref.kind === "pr") throw new Error("the git source cannot resolve pull requests; use the gh source");
      if (ref.kind === "worktree") {
        const base = await git(ctx.repoRoot, "merge-base", ref.base, "HEAD");
        const head = snapshotWorkingTree(ctx.repoRoot, ctx.runRoot);
        return { base, head, title: "Working tree changes", description: "", linkedIssues: [], comments: [], worktree: true };
      }
      const head = await git(ctx.repoRoot, "rev-parse", `${ref.head}^{commit}`);
      const base = await git(ctx.repoRoot, "merge-base", ref.base, head);
      return { base, head, title: `${ref.head} against ${ref.base}`, description: "", linkedIssues: [], comments: [] };
    },
  };
}

interface PrView {
  number: number;
  title: string;
  body: string;
  baseRefName: string;
  headRefOid: string;
  closingIssuesReferences?: { number: number }[];
  comments?: { author?: { login?: string }; body: string }[];
}

// @spec ADPT-SRC-004, ADPT-SRC-005, ADPT-SRC-006, ADPT-SRC-007
export function ghSource(opts: { exec?: Exec } = {}): Source {
  const exec = opts.exec ?? defaultExec;
  return {
    name: "gh",
    async resolve(ref, ctx) {
      if (ref.kind !== "pr") throw new Error("the gh source resolves pull requests only");
      const cwd = ctx.repoRoot;
      const n = ref.number;
      const view = JSON.parse(
        await exec("gh", ["pr", "view", String(n), "--json", "number,title,body,baseRefName,headRefOid,closingIssuesReferences,comments"], { cwd }),
      ) as PrView;
      let baseRef = view.baseRefName;
      let fetched = false;
      try {
        await exec("git", ["cat-file", "-e", `${view.headRefOid}^{commit}`], { cwd });
      } catch {
        await exec("git", ["fetch", "--no-tags", "origin", `+refs/pull/${n}/head:refs/duet/pr/${n}/head`, `+refs/heads/${view.baseRefName}:refs/duet/pr/${n}/base`], { cwd });
        fetched = true;
      }
      if (fetched) baseRef = `refs/duet/pr/${n}/base`;
      else {
        try {
          await exec("git", ["rev-parse", "--verify", "-q", `origin/${view.baseRefName}`], { cwd });
          baseRef = `origin/${view.baseRefName}`;
        } catch {
          // No remote-tracking branch; use the local branch of that name.
        }
      }
      const base = trim(await exec("git", ["merge-base", baseRef, view.headRefOid], { cwd }));
      const linkedIssues: string[] = [];
      for (const issue of (view.closingIssuesReferences ?? []).slice(0, 3)) {
        const i = JSON.parse(await exec("gh", ["issue", "view", String(issue.number), "--json", "title,body"], { cwd })) as { title: string; body: string };
        linkedIssues.push(`#${issue.number} ${i.title}\n${i.body}`);
      }
      return {
        base,
        head: view.headRefOid,
        title: view.title,
        description: view.body ?? "",
        linkedIssues,
        comments: (view.comments ?? []).map((c) => ({ author: c.author?.login ?? "unknown", body: c.body })),
        pr: n,
      };
    },
  };
}
