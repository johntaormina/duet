import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssetResolver, DEFAULT_CONFIG } from "@duet/adapters";
import { describe, expect, it } from "vitest";
import { callJson, cliArgs, cliRunner, type ClaudeRequest, extractJson, InvalidOutputError, loadPrompt, RateLimitError, Scheduler } from "../src/index.ts";
import { CORE_ASSETS } from "../src/engine.ts";
import { fakeClaude, noSleep } from "./kit.ts";

function assets(prompt = "---\nmodel: sonnet\ntimeoutSec: 30\nmaxTurns: 4\ntools: read-only\n---\nSay {{thing}}.") {
  const dir = mkdtempSync(join(tmpdir(), "duet-assets-"));
  mkdirSync(join(dir, "prompts"));
  writeFileSync(join(dir, "prompts", "p.md"), prompt);
  return createAssetResolver(dir, null);
}

function env(runner: Parameters<typeof callJson>[0]["runner"], extra: Partial<Parameters<typeof callJson>[0]> = {}) {
  return { runner, assets: assets(), config: DEFAULT_CONFIG, scheduler: new Scheduler(3), cwd: "/tmp", sleep: noSleep, ...extra };
}

describe("calling the Claude CLI", () => {
  // @spec PIPE-CALL-001
  it("invokes the CLI in headless print mode with JSON output", () => {
    const args = cliArgs({ name: "p", prompt: "x", cwd: "/", tools: "none", timeoutMs: 1000 });
    expect(args).toContain("-p");
    expect(args.join(" ")).toMatch(/--output-format stream-json/);
    expect(args).not.toContain("--strict-mcp-config");
  });

  // @spec PIPE-CALL-009
  it("appends configured extra CLI arguments to every call", async () => {
    expect(cliArgs({ name: "p", prompt: "", cwd: "/", tools: "none", timeoutMs: 1, extraArgs: ["--permission-mode", "dontAsk"] }).slice(-2)).toEqual(["--permission-mode", "dontAsk"]);
    const { runner, calls } = fakeClaude({ p: () => ({ ok: true }) });
    await callJson(env(runner, { config: { ...DEFAULT_CONFIG, claudeArgs: ["--foo"] } }), { prompt: "p", vars: { thing: "x" }, branch: "human" });
    expect(calls[0].extraArgs).toEqual(["--foo"]);
  });

  // @spec PIPE-STG-004, PIPE-STG-005
  it("allows no tools for intent, briefing, and cards prompts, and only read-only tools for the rest", () => {
    const core = createAssetResolver(CORE_ASSETS, null);
    for (const name of ["intent", "briefing", "cards", "refute-cards", "fact-check"]) {
      expect(loadPrompt(core, name, DEFAULT_CONFIG).settings.tools, name).toBe("none");
    }
    for (const name of ["recommendation", "specialist-bugs", "specialist-security", "specialist-tests", "specialist-conventions", "verifier", "ask"]) {
      expect(loadPrompt(core, name, DEFAULT_CONFIG).settings.tools, name).toBe("read-only");
    }
    expect(cliArgs({ name: "p", prompt: "", cwd: "/", tools: "none", timeoutMs: 1 })).toEqual(expect.arrayContaining(["--tools", ""]));
    const ro = cliArgs({ name: "p", prompt: "", cwd: "/", tools: "read-only", timeoutMs: 1 });
    expect(ro[ro.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
  });

  // @spec PIPE-CALL-002
  it("takes model, turn limit, and timeout from frontmatter, overridden by configuration", async () => {
    const { runner, calls } = fakeClaude({ p: () => ({ ok: true }) });
    await callJson(env(runner), { prompt: "p", vars: { thing: "hi" }, branch: "human" });
    expect(calls[0]).toMatchObject({ model: "sonnet", maxTurns: 4, timeoutMs: 30_000, tools: "read-only", prompt: "Say hi." });
    const config = { ...DEFAULT_CONFIG, stages: { p: { model: "opus", timeoutSec: 99 } } };
    await callJson(env(runner, { config }), { prompt: "p", vars: { thing: "hi" }, branch: "human" });
    expect(calls[1]).toMatchObject({ model: "opus", maxTurns: 4, timeoutMs: 99_000 });
  });

  // @spec PIPE-CALL-003
  it("retries invalid output once with the problems listed", async () => {
    const { runner, calls } = fakeClaude({ p: (_r, n) => (n === 1 ? { bad: true } : { good: true }) });
    const res = await callJson<{ good?: boolean }>(env(runner), { prompt: "p", vars: {}, branch: "human", check: (o) => (o.good ? [] : ["needs good"]) });
    expect(res.value.good).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].prompt).toContain("needs good");
  });

  // @spec PIPE-CALL-004
  it("allows one retry in total and then fails", async () => {
    const { runner, calls } = fakeClaude({ p: () => "not json at all" });
    await expect(callJson(env(runner), { prompt: "p", vars: {}, branch: "human" })).rejects.toBeInstanceOf(InvalidOutputError);
    expect(calls).toHaveLength(2);
  });

  // @spec PIPE-CALL-005, PIPE-CALL-006
  it("waits out rate limits with exponential backoff, reporting the wait, without spending the retry", async () => {
    const waits: number[] = [];
    const details: (string | null)[] = [];
    const { runner, calls } = fakeClaude({
      p: (_r, n) => {
        if (n <= 3) throw new RateLimitError("429 rate limited");
        return { ok: true };
      },
    });
    await callJson(env(runner, { sleep: async (ms) => void waits.push(ms), onWait: (d) => details.push(d), config: { ...DEFAULT_CONFIG, rateLimitCeilingSec: 40 } }), { prompt: "p", vars: {}, branch: "human" });
    expect(calls).toHaveLength(4);
    expect(waits).toEqual([15_000, 30_000, 40_000]);
    expect(details.filter(Boolean)[0]).toMatch(/waiting on a rate limit until \d\d:\d\d:\d\d/);
    expect(details[details.length - 1]).toBeNull();
  });

  it("extracts JSON from fenced or chatty output", () => {
    expect(extractJson('Here:\n```json\n{"a": "}"}\n```')).toEqual({ a: "}" });
    expect(extractJson('Sure. {"a": {"b": 1}} done')).toEqual({ a: { b: 1 } });
  });
});

describe("scheduler", () => {
  // @spec PIPE-CALL-007
  it("never runs more calls at once than the cap", async () => {
    const s = new Scheduler(3);
    let active = 0;
    let peak = 0;
    const task = () => s.run("machine", async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    await Promise.all(Array.from({ length: 10 }, task));
    expect(peak).toBe(3);
  });

  // @spec PIPE-CALL-008
  it("starts queued human-layer calls before machine-layer ones", async () => {
    const s = new Scheduler(1);
    const order: string[] = [];
    let release!: () => void;
    const blocker = s.run("machine", () => new Promise<void>((r) => (release = r)));
    const queued = [s.run("machine", async () => void order.push("m1")), s.run("machine", async () => void order.push("m2")), s.run("human", async () => void order.push("h1"))];
    await new Promise((r) => setTimeout(r, 0));
    release();
    await Promise.all([blocker, ...queued]);
    expect(order[0]).toBe("h1");
  });
});

describe("progress", () => {
  // @spec PIPE-PROG-001, PIPE-PROG-002
  it("reports when each call starts, with its model, and when it ends, with its duration", async () => {
    const lines: string[] = [];
    const { runner } = fakeClaude({ p: () => ({ ok: true }) });
    await callJson(env(runner, { stage: "briefing", progress: (l: string) => lines.push(l) }), { prompt: "p", vars: { thing: "x" }, branch: "human" });
    expect(lines).toEqual(["briefing: p: claude started (model sonnet)", expect.stringMatching(/^briefing: p: claude done in \d+s$/)]);
    const same: string[] = [];
    await callJson(env(runner, { stage: "p", progress: (l: string) => same.push(l) }), { prompt: "p", vars: { thing: "x" }, branch: "human" });
    expect(same[0]).toBe("p: claude started (model sonnet)");
  });

  // @spec PIPE-PROG-002
  it("reports a failed call with its duration and the CLI's error", async () => {
    const lines: string[] = [];
    const { runner } = fakeClaude({ p: () => { throw new Error("Claude CLI call p failed: boom"); } });
    await expect(callJson(env(runner, { stage: "intent", progress: (l: string) => lines.push(l) }), { prompt: "p", vars: { thing: "x" }, branch: "human" })).rejects.toThrow(/boom/);
    expect(lines[1]).toMatch(/^intent: p: claude failed after \d+s: Claude CLI call p failed: boom$/);
  });

  // @spec PIPE-PROG-003
  it("reports a rate-limit wait and when it will retry", async () => {
    const lines: string[] = [];
    const { runner } = fakeClaude({ p: (_r, n) => { if (n === 1) throw new RateLimitError("rate limit"); return { ok: true }; } });
    await callJson(env(runner, { stage: "cards", progress: (l: string) => lines.push(l), now: () => new Date("2026-01-01T12:00:00Z") }), { prompt: "p", vars: { thing: "x" }, branch: "human" });
    expect(lines).toContain("cards: p: rate limited; retrying at 12:00:15 UTC");
  });
});


/** Puts a fake `claude` on PATH that prints the given stream-json lines, sleeping where a line is a number of ms. */
async function withFakeCli<T>(script: (string | number)[], fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "duet-fakecli-"));
  const body = script.map((l) => (typeof l === "number" ? `await new Promise((r) => setTimeout(r, ${l}));` : `process.stdout.write(${JSON.stringify(l + "\n")});`)).join("\n");
  writeFileSync(join(dir, "claude"), `#!/usr/bin/env node\nprocess.stdin.resume();\n${body}\n`);
  chmodSync(join(dir, "claude"), 0o755);
  const old = process.env.PATH;
  process.env.PATH = `${dir}:${old}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = old;
  }
}

describe("rate limits inside a CLI call", () => {
  const retry = (status: number, delay: number) => JSON.stringify({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: delay, error_status: status, error: status === 429 ? "rate_limit" : "overloaded" });
  const result = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: '{"ok":true}' });

  // @spec PIPE-CALL-010
  it("does not count the CLI's rate-limit retry delays toward the call's timeout", async () => {
    const res = await withFakeCli([retry(429, 1500), 1700, result], () => cliRunner({ name: "p", prompt: "x", cwd: "/tmp", tools: "none", timeoutMs: 1000 }));
    expect(res).toEqual({ text: '{"ok":true}', truncated: false });
  });

  // @spec PIPE-CALL-010
  it("still times out a call that is slow for reasons other than rate limits", async () => {
    const slow = withFakeCli([JSON.stringify({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 1500, error_status: 500, error: "server_error" }), 1700, result], () => cliRunner({ name: "p", prompt: "x", cwd: "/tmp", tools: "none", timeoutMs: 1000 }));
    await expect(slow).rejects.toThrow(/timed out/);
  });

  // @spec PIPE-CALL-011
  it("reports the stage as waiting on a rate limit while the CLI retries", async () => {
    const waits: (string | null)[] = [];
    const lines: string[] = [];
    await withFakeCli([retry(529, 300), 350, result], () =>
      callJson(env(cliRunner, { onWait: (d) => waits.push(d), progress: (l) => lines.push(l), stage: "briefing", now: () => new Date("2026-10-15T12:00:00Z") }), { prompt: "p", vars: { thing: "x" }, branch: "human" }),
    );
    expect(waits[0]).toBe("waiting on a rate limit until 12:00:00 UTC");
    expect(waits.at(-1)).toBeNull();
    expect(lines.some((l) => /rate limited; claude retries at 12:00:00 UTC/.test(l))).toBe(true);
  });
});

describe("after a rate limit", () => {
  // @spec PIPE-CALL-012
  it("recognizes Bedrock's and other providers' rate-limit wording", async () => {
    for (const msg of ["ThrottlingException: Too many tokens, please wait before trying again.", "Too many requests", "API Error: 529 Overloaded", "Rate limit reached", "usage limit"]) {
      const out = JSON.stringify({ type: "result", subtype: "success", is_error: true, result: msg });
      await expect(withFakeCli([out], () => cliRunner({ name: "p", prompt: "x", cwd: "/tmp", tools: "none", timeoutMs: 5000 })), msg).rejects.toBeInstanceOf(RateLimitError);
    }
    const other = JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Invalid model id" });
    await expect(withFakeCli([other], () => cliRunner({ name: "p", prompt: "x", cwd: "/tmp", tools: "none", timeoutMs: 5000 }))).rejects.not.toBeInstanceOf(RateLimitError);
    const throttled = JSON.stringify({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 1500, error: "ThrottlingException" });
    const ok = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: '{"ok":true}' });
    await expect(withFakeCli([throttled, 1700, ok], () => cliRunner({ name: "p", prompt: "x", cwd: "/tmp", tools: "none", timeoutMs: 1000 }))).resolves.toMatchObject({ truncated: false });
  });

  // @spec PIPE-CALL-013
  it("runs one call at a time once a call meets a rate limit, letting running calls finish", async () => {
    const s = new Scheduler(3);
    let active = 0;
    let peak = 0;
    const task = (ms: number) => s.run("machine", async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, ms));
      active--;
    });
    const first = [task(30), task(30), task(30)];
    await new Promise((r) => setTimeout(r, 5));
    s.throttle();
    peak = active;
    const later = Array.from({ length: 4 }, () => task(5));
    await Promise.all([...first, ...later]);
    expect(s.cap).toBe(1);
    expect(peak).toBe(3); // the three already running finished
    let after = 0;
    let afterPeak = 0;
    await Promise.all(Array.from({ length: 4 }, () => s.run("machine", async () => { after++; afterPeak = Math.max(afterPeak, after); await new Promise((r) => setTimeout(r, 5)); after--; })));
    expect(afterPeak).toBe(1);
  });

  // @spec PIPE-CALL-013
  it("throttles the run's scheduler when a call is rate limited, by the CLI or by its result", async () => {
    for (const runner of [
      (() => { let n = 0; return async (req: ClaudeRequest) => { if (n++ === 0) throw new RateLimitError("429"); void req; return { text: '{"ok":true}', truncated: false }; }; })(),
      async (req: ClaudeRequest) => { req.onRateLimitRetry?.(10); return { text: '{"ok":true}', truncated: false }; },
    ]) {
      const scheduler = new Scheduler(3);
      await callJson(env(runner, { scheduler }), { prompt: "p", vars: { thing: "x" }, branch: "human" });
      expect(scheduler.cap).toBe(1);
    }
  });
});
