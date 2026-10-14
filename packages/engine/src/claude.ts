import { spawn } from "node:child_process";

export type ToolSet = "none" | "read-only";

export interface ClaudeRequest {
  /** Prompt file name, for routing in tests and diagnostics. */
  name: string;
  prompt: string;
  cwd: string;
  model?: string;
  tools: ToolSet;
  maxTurns?: number;
  timeoutMs: number;
}

export interface ClaudeResponse {
  text: string;
  /** True when the call stopped at its turn limit or timeout; `text` holds what it produced. */
  truncated: boolean;
}

export type ClaudeRunner = (req: ClaudeRequest) => Promise<ClaudeResponse>;

export class RateLimitError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = "RateLimitError";
  }
}

export class CallTimeoutError extends Error {
  constructor(name: string, ms: number) {
    super(`${name} timed out after ${Math.round(ms / 1000)}s without output`);
    this.name = "CallTimeoutError";
  }
}

const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"];
const RATE_LIMIT = /rate.?limit|usage limit|too many requests|\b429\b|overloaded/i;

export function cliArgs(req: ClaudeRequest): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--strict-mcp-config"];
  if (req.model) args.push("--model", req.model);
  args.push("--tools", req.tools === "none" ? "" : READ_ONLY_TOOLS.join(","));
  if (req.maxTurns) args.push("--max-turns", String(req.maxTurns));
  return args;
}

/** Invokes the Claude CLI in headless mode, streaming JSON events so partial output survives a timeout. */
// @spec PIPE-CALL-001
export const cliRunner: ClaudeRunner = (req) =>
  new Promise((resolve, reject) => {
    const child = spawn("claude", cliArgs(req), { cwd: req.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    let lastText = "";
    let result: { subtype?: string; is_error?: boolean; result?: string } | null = null;
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, req.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === "assistant") {
            const text = (ev.message?.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("");
            if (text) lastText = text;
          } else if (ev.type === "result") result = ev;
        } catch {
          // Non-JSON noise on stdout is ignored.
        }
      }
    });
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`could not start the Claude CLI: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const errText = `${result?.result ?? ""} ${stderr}`;
      if (RATE_LIMIT.test(errText) && (result?.is_error || code !== 0)) return reject(new RateLimitError(errText.trim()));
      if (timedOut) {
        if (lastText) return resolve({ text: lastText, truncated: true });
        return reject(new CallTimeoutError(req.name, req.timeoutMs));
      }
      if (result?.subtype === "error_max_turns") return resolve({ text: lastText || result.result || "", truncated: true });
      if (result && !result.is_error) return resolve({ text: result.result ?? lastText, truncated: false });
      reject(new Error(`Claude CLI call ${req.name} failed: ${(result?.result ?? stderr).trim() || `exit ${code}`}`));
    });
    child.stdin.end(req.prompt);
  });

/** Pulls the first JSON object out of model text, tolerating code fences and surrounding prose. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  if (start < 0) throw new Error("no JSON object in output");
  let depth = 0;
  let inString = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return JSON.parse(candidate.slice(start, i + 1));
  }
  throw new Error("unterminated JSON object in output");
}
