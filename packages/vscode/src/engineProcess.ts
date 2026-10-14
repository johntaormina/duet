import { spawn } from "node:child_process";
import type { RunManifest } from "@duet/store";

export type StartChoice =
  | { kind: "branch"; base: string; head?: string }
  | { kind: "worktree"; base: string }
  | { kind: "pr"; number: number };

export interface StartAnswers {
  change: StartChoice;
  statement?: string;
  planFile?: string;
}

/** The questions Start review asks, in order. A working-tree review asks for the statement first. */
// @spec EXT-CMD-001, EXT-CMD-009
export function startQuestions(kind: StartChoice["kind"]): ("base" | "pr" | "statement" | "plan")[] {
  if (kind === "pr") return ["pr", "statement", "plan"];
  if (kind === "worktree") return ["statement", "base", "plan"];
  return ["base", "statement", "plan"];
}

/** Arguments for the engine's `run`. */
// @spec EXT-CMD-008
export function runArgs(a: StartAnswers): string[] {
  const args = ["run"];
  if (a.change.kind === "pr") args.push("--pr", String(a.change.number));
  else if (a.change.kind === "worktree") args.push("--worktree", "--base", a.change.base);
  else args.push("--base", a.change.base, ...(a.change.head ? ["--head", a.change.head] : []));
  if (a.statement?.trim()) args.push("--statement", a.statement.trim());
  if (a.planFile) args.push("--plan", a.planFile);
  return args;
}

export interface EngineHandle {
  pid: number | undefined;
  done: Promise<{ code: number; stderr: string; stdout: string }>;
}

/** Starts the engine as a background child process. */
// @spec EXT-CMD-002
export function startEngine(nodePath: string, cliPath: string, args: string[], cwd: string, onRun?: (runId: string, runDir: string) => void): EngineHandle {
  const child = spawn(nodePath, [cliPath, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => {
    stderr += c;
    const m = /^duet-run (\S+) (.+)$/m.exec(String(c));
    if (m) onRun?.(m[1], m[2].trim());
  });
  const done = new Promise<{ code: number; stderr: string; stdout: string }>((resolve) => {
    child.on("close", (code) => resolve({ code: code ?? 1, stderr, stdout }));
    child.on("error", (e) => resolve({ code: 1, stderr: e.message, stdout }));
  });
  return { pid: child.pid, done };
}

/** What to tell the reviewer when the engine exits with an error. */
// @spec EXT-CMD-005
export function engineExitMessage(code: number, stderr: string, run: RunManifest | null): string | null {
  if (code === 0) return null;
  const stages = run ? Object.entries(run.stages).map(([k, v]) => `${k}: ${v.status}${v.error ? ` (${v.error})` : ""}`).join("; ") : "no run was created";
  const err = stderr.trim().split("\n").filter(Boolean).pop() ?? `exit code ${code}`;
  return `Duet's engine stopped with an error: ${err}. Stages: ${stages}`;
}
