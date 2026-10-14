import { readFileSync } from "node:fs";
import type { ChangeRef } from "@duet/adapters";
import { ask, clean, LockHeldError, run } from "./engine.ts";

const USAGE = `Usage:
  duet run --pr <number> | --base <ref> [--head <ref>] | --worktree [--base <ref>]
           [--statement <text> | --statement-file <path>] [--plan <path>]
  duet ask --run <id> --card <id> --question <text> --reviewer <id> [--may-see-recommendation]
  duet clean [<run-id>...] [--older-than <days>]`;

function parseArgs(argv: string[]) {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[a.slice(2)] = next;
        i++;
      } else flags[a.slice(2)] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

const str = (v: string | true | undefined) => (typeof v === "string" ? v : undefined);

export async function main(argv: string[], out = process.stdout, err = process.stderr): Promise<number> {
  const [command, ...rest] = argv;
  const { flags, positional } = parseArgs(rest);
  const repoRoot = str(flags.repo) ?? process.cwd();
  try {
    if (command === "run") {
      let change: ChangeRef;
      if (flags.pr) change = { kind: "pr", number: Number(flags.pr) };
      else if (flags.worktree) change = { kind: "worktree", base: str(flags.base) ?? "main" };
      else if (flags.base) change = { kind: "refs", base: str(flags.base)!, head: str(flags.head) ?? "HEAD" };
      else {
        err.write(`${USAGE}\n`);
        return 2;
      }
      const statement = str(flags.statement) ?? (flags["statement-file"] ? readFileSync(str(flags["statement-file"])!, "utf8") : undefined);
      const summary = await run({ repoRoot, change, authorStatement: statement, agentPlanFile: str(flags.plan), onRun: (id, dir) => err.write(`duet-run ${id} ${dir}\n`) });
      out.write(`${JSON.stringify(summary)}\n`);
      return Object.values(summary.stages).every((s) => s === "complete") ? 0 : 1;
    }
    if (command === "ask") {
      const answer = await ask({
        repoRoot,
        runId: str(flags.run)!,
        cardId: str(flags.card)!,
        question: str(flags.question)!,
        reviewer: str(flags.reviewer) ?? "reviewer",
        mayRevealRecommendation: flags["may-see-recommendation"] === true,
      });
      out.write(`${answer}\n`);
      return 0;
    }
    if (command === "clean") {
      const removed = await clean({ repoRoot, runIds: positional, olderThanDays: flags["older-than"] ? Number(flags["older-than"]) : undefined });
      out.write(`${removed.length ? `removed ${removed.join(", ")}` : "nothing to remove"}\n`);
      return 0;
    }
    err.write(`${USAGE}\n`);
    return 2;
  } catch (e) {
    err.write(`duet: ${(e as Error).message}\n`);
    return e instanceof LockHeldError ? 3 : 1;
  }
}
