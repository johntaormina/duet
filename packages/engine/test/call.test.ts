import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssetResolver, DEFAULT_CONFIG } from "@duet/adapters";
import { describe, expect, it } from "vitest";
import { callJson, cliArgs, extractJson, InvalidOutputError, loadPrompt, RateLimitError, Scheduler } from "../src/index.ts";
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

