import { execFile } from "node:child_process";

export interface ExecOptions {
  cwd?: string;
  input?: string;
}

/** Runs a command and resolves with its stdout; rejects on a non-zero exit. */
export type Exec = (cmd: string, args: string[], opts?: ExecOptions) => Promise<string>;

export const defaultExec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { cwd: opts.cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(" ")} failed: ${stderr || err.message}`));
      else resolve(stdout);
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
