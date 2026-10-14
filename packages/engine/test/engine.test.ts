import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "@duet/store";
import { describe, expect, it } from "vitest";
import { acquireLock, ask, CallTimeoutError, clean, LockHeldError, main, mergeFindings, run, type ClaudeRequest } from "../src/index.ts";
import { checkStatedQuotes } from "../src/stages/human.ts";
import { fakeClaude, fixtureRepo, git, happyHandlers, type Handler, noSleep, OUT, write } from "./kit.ts";

const userConfigDir = join(process.env.TMPDIR ?? "/tmp", "duet-no-user-config");

async function review(handlers: Record<string, Handler> = {}, repo = fixtureRepo(), extra: Partial<Parameters<typeof run>[0]> = {}) {
  const fake = fakeClaude({ ...happyHandlers(), ...handlers });
  const summary = await run({ repoRoot: repo.dir, change: { kind: "refs", base: "main", head: "feature" }, runner: fake.runner, sleep: noSleep, userConfigDir, ...extra });
  const reader = openStore({ repoRoot: repo.dir }).reader(summary.runId);
  return { ...fake, summary, reader, repo };
}

describe("running a review", () => {
  // @spec PIPE-CLI-001, PIPE-CLI-002
  it("creates a run for a change and completes every stage", async () => {
    const r = await review();
    expect(r.summary.stages).toEqual({ context: "complete", intent: "complete", briefing: "complete", cards: "complete", recommendations: "complete", findings: "complete" });
    for (const f of ["run", "context-pack", "intent", "briefing", "cards", "recommendations", "findings"] as const) expect(r.reader.read(f), f).not.toBeNull();
  });

  // @spec PIPE-CLI-002, PIPE-RES-004
  it("reuses complete stages and reruns ones left running", async () => {
    const first = await review();
    const store = openStore({ repoRoot: first.repo.dir });
    store.pipeline(first.summary.runId).setStage("recommendations", { status: "running" });
    const again = await review({}, first.repo);
    expect(again.count("intent")).toBe(0);
    expect(again.count("cards")).toBe(0);
    expect(again.count("specialist-bugs")).toBe(0);
    expect(again.count("recommendation")).toBeGreaterThan(0);
    expect(again.summary.stages.recommendations).toBe("complete");
  });

  // @spec PIPE-STG-001
  it("runs the human-layer stages in order, each after its predecessor", async () => {
    const r = await review();
    const order = r.calls.map((c) => c.name).filter((n) => ["intent", "briefing", "cards", "recommendation"].includes(n));
    expect(order.indexOf("intent")).toBeLessThan(order.indexOf("briefing"));
    expect(order.indexOf("briefing")).toBeLessThan(order.indexOf("cards"));
    expect(order.indexOf("cards")).toBeLessThan(order.indexOf("recommendation"));
  });

  // @spec PIPE-STG-002, PIPE-STG-003
  it("starts specialists alongside the human layer and the verifier only after them and the cards", async () => {
    let releaseIntent!: () => void;
    const gate = new Promise<void>((r) => (releaseIntent = r));
    const started: string[] = [];
    const r = review({
      intent: async () => {
        started.push("intent");
        await gate;
        return OUT.intent;
      },
      specialist: (req) => {
        started.push(req.name);
        if (req.name === "specialist-tests") releaseIntent();
        return happyHandlers().specialist(req, 1);
      },
    });
    const { calls } = await r;
    expect(started.filter((s) => s.startsWith("specialist-")).length).toBe(4);
    const names = calls.map((c) => c.name);
    expect(names.indexOf("verifier")).toBeGreaterThan(names.lastIndexOf("cards"));
    expect(names.indexOf("verifier")).toBeGreaterThan(Math.max(...["bugs", "security", "tests", "conventions"].map((s) => names.indexOf(`specialist-${s}`))));
  });

  // @spec PIPE-STG-006, PIPE-STG-007
  it("instructs the briefing to order steps by dependency and to list the change's choices with labelled reasons", async () => {
    const r = await review();
    const p = r.calls.find((c) => c.name === "briefing")!.prompt;
    expect(p).toMatch(/ordered so that what something depends on comes before it/);
    expect(p).toMatch(/starting with its overall approach/);
    expect(p).toMatch(/"stated"/);
    expect(p).toMatch(/"inferred"/);
    expect(p).toMatch(/"none"/);
  });

  // @spec PIPE-STG-008
  it("rejects a stated rationale whose quote is not verbatim in its cited item", async () => {
    const pack = { schema_version: "1.0", budget: 1, items: [{ id: "i1", kind: "commit-message" as const, source: "abc", size: 3, content: "we retry to protect jobs" }], excluded: [] };
    const choice = (quote: string) => ({ choices: [{ ...OUT.briefing.choices[0], rationale: { source: "stated" as const, text: "t", quote, item: "i1" } }] });
    expect(checkStatedQuotes(choice("retry to protect jobs") as never, pack)).toEqual([]);
    expect(checkStatedQuotes(choice("retry to protect customers") as never, pack)[0]).toMatch(/not appear verbatim/);
    const bad = await review({ briefing: () => ({ ...OUT.briefing, choices: [{ ...OUT.briefing.choices[0], rationale: { source: "stated", text: "t", quote: "made up words", item: "i5" } }] }) });
    expect(bad.summary.stages.briefing).toBe("failed");
    expect(bad.count("briefing")).toBe(2);
  });
});

describe("machine layer", () => {
  // @spec PIPE-MACH-001, PIPE-MACH-002
  it("runs four specialists as separate calls with turn limits and timeouts", async () => {
    const r = await review();
    const specs = r.calls.filter((c) => c.name.startsWith("specialist-"));
    expect(specs.map((c) => c.name).sort()).toEqual(["specialist-bugs", "specialist-conventions", "specialist-security", "specialist-tests"]);
    for (const c of specs) {
      expect(c.maxTurns).toBeGreaterThan(0);
      expect(c.timeoutMs).toBeGreaterThan(0);
    }
  });

  // @spec PIPE-MACH-003
  it("keeps truncated specialist output and records what was not examined", async () => {
    const r = await review({ specialist: (req) => (req.name === "specialist-security" ? { __response: { text: JSON.stringify({ findings: [], not_examined: ["auth module"] }), truncated: true } } : { findings: [] }) });
    const ex = r.reader.read("findings")!.exploration.not_examined;
    expect(ex).toContain("security: auth module");
    expect(ex).toContain("security: stopped at its exploration budget before finishing");
  });

  // @spec PIPE-MACH-004
  it("fails the findings stage when a specialist times out without output", async () => {
    const r = await review({ specialist: (req) => { if (req.name === "specialist-tests") throw new CallTimeoutError(req.name, 1000); return { findings: [] }; } });
    expect(r.summary.stages.findings).toBe("failed");
    expect(r.summary.stages.cards).toBe("complete");
  });

  // @spec PIPE-MACH-005
  it("merges duplicate findings from different specialists", () => {
    const f = { category: "bug", severity: "high" as const, title: "t", anchors: [{ file: "a.ts", start_line: 1, end_line: 1, pattern: "x" }], evidence: "e" };
    const merged = mergeFindings([{ name: "bugs", findings: [f] }, { name: "tests", findings: [f] }], "/nonexistent", "b".repeat(40));
    expect(merged).toHaveLength(1);
    expect(merged[0].found_by).toEqual(["bugs", "tests"]);
  });

  // @spec PIPE-MACH-006, PIPE-MACH-007, PIPE-MACH-009
  it("verifies in a fresh call with claims, cards, and context but no specialist reasoning, and links cards", async () => {
    const r = await review({ specialist: (req) => (req.name === "specialist-bugs" ? `My chain of thought: SECRET-REASONING.\n${JSON.stringify(happyHandlers().specialist(req, 1))}` : { findings: [] }) });
    const v = r.calls.find((c) => c.name === "verifier")!;
    expect(v.prompt).toContain("Unbounded retry");
    expect(v.prompt).toContain("Should a failed upload retry forever");
    expect(v.prompt).toMatch(/Try to refute each one/);
    expect(v.prompt).not.toContain("SECRET-REASONING");
    const finding = r.reader.read("findings")!.findings[0];
    expect(finding.verification).toMatchObject({ status: "confirmed", by: "verifier" });
    expect(finding.related_cards).toEqual(["D1"]);
  });

  // @spec PIPE-MACH-008
  it("never writes findings without running the verifier", async () => {
    const r = await review({ verifier: () => { throw new Error("verifier down"); } });
    expect(r.summary.stages.findings).toBe("failed");
    expect(r.reader.read("findings")).toBeNull();
  });

  // @spec PIPE-MACH-010
  it("writes findings with no card links when the cards stage failed", async () => {
    const r = await review({ cards: () => "garbage" });
    expect(r.summary.stages.cards).toBe("failed");
    expect(r.summary.stages.findings).toBe("complete");
    expect(r.reader.read("findings")!.findings.every((f) => f.related_cards.length === 0)).toBe(true);
  });
});

describe("recommendations", () => {
  // @spec PIPE-LEAN-001
  it("makes one fresh call per card with the pack, briefing, and that card", async () => {
    const r = await review();
    const recs = r.calls.filter((c) => c.name === "recommendation");
    const cards = r.reader.read("cards")!.cards;
    expect(recs).toHaveLength(cards.length);
    for (const c of cards) expect(recs.filter((x) => x.prompt.includes(c.question))).toHaveLength(1);
    expect(recs[0].prompt).toContain("# Briefing");
    expect(recs[0].prompt).toContain("# Context");
  });

  // @spec PIPE-LEAN-002
  it("writes each recommendation as it arrives and completes the stage when all exist", async () => {
    const seen: number[] = [];
    let repoDir = "";
    const r = await review({
      recommendation: (req: ClaudeRequest, n) => {
        if (n > 1) {
          const store = openStore({ repoRoot: repoDir });
          const runs = require_runs(repoDir);
          seen.push(store.reader(runs[0]).read("recommendations")?.entries.length ?? 0);
        }
        void req;
        return { option: 1, confidence: 70, reasoning: "r", what_would_change_my_mind: "w" };
      },
    }, (() => { const f = fixtureRepo(); repoDir = f.dir; return f; })(), { flags: { concurrency: 1 } });
    expect(seen.some((n) => n > 0)).toBe(true);
    expect(r.reader.read("recommendations")!.entries).toHaveLength(r.reader.read("cards")!.cards.length);
    expect(r.summary.stages.recommendations).toBe("complete");
  });
});

function require_runs(repo: string): string[] {
  return readdirSyncImpl(join(repo, ".duet")).filter((n) => !n.startsWith("."));
}
import { readdirSync as readdirSyncImpl } from "node:fs";

describe("failure", () => {
  // @spec PIPE-FAIL-001, PIPE-FAIL-002
  it("records a stage's error and fails the stages downstream of it in its branch", async () => {
    const r = await review({ briefing: () => "not json" });
    const run = r.reader.read("run")!;
    expect(run.stages.briefing.status).toBe("failed");
    expect(run.stages.briefing.error).toMatch(/invalid output/);
    expect(run.stages.cards).toMatchObject({ status: "failed", error: "upstream stage briefing failed" });
    expect(run.stages.recommendations).toMatchObject({ status: "failed", error: "upstream stage briefing failed" });
  });

  // @spec PIPE-FAIL-003, PIPE-FAIL-004
  it("keeps each branch running when the other fails, and never fails across branches", async () => {
    const human = await review({ intent: () => "nope" });
    expect(human.summary.stages.intent).toBe("failed");
    expect(human.summary.stages.findings).toBe("complete");
    const machine = await review({ verifier: () => { throw new Error("down"); } });
    expect(machine.summary.stages.findings).toBe("failed");
    expect(machine.summary.stages.recommendations).toBe("complete");
  });
});

describe("locking", () => {
  // @spec PIPE-RES-001, PIPE-RES-002
  it("takes a lock and refuses a second live holder", () => {
    const dir = fixtureRepo().dir;
    const release = acquireLock(dir);
    expect(readFileSync(join(dir, "lock"), "utf8")).toBe(String(process.pid));
    writeFileSync(join(dir, "lock"), String(process.ppid));
    expect(() => acquireLock(dir)).toThrow(LockHeldError);
    expect(() => acquireLock(dir)).toThrow(new RegExp(`pid ${process.ppid}`));
    release();
  });

  // @spec PIPE-RES-003
  it("takes over a lock whose process is gone", () => {
    const dir = fixtureRepo().dir;
    writeFileSync(join(dir, "lock"), "999999");
    const release = acquireLock(dir);
    expect(readFileSync(join(dir, "lock"), "utf8")).toBe(String(process.pid));
    release();
    expect(existsSync(join(dir, "lock"))).toBe(false);
  });
});

describe("ask", () => {
  async function asked(may: boolean, extraQa = false) {
    const r = await review();
    if (extraQa) openStore({ repoRoot: r.repo.dir }).session(r.summary.runId, "rev").appendQa({ card_id: "D1", asked_at: "t", question: "Earlier question?", answer: "Earlier answer.", committed: false });
    const fake = fakeClaude(happyHandlers());
    writeFileSync(join(r.summary.runDir, "lock"), String(process.ppid));
    const answer = await ask({ repoRoot: r.repo.dir, runId: r.summary.runId, cardId: "D1", question: "What happens on 429?", mayRevealRecommendation: may, reviewer: "rev", runner: fake.runner, userConfigDir });
    return { r, fake, answer };
  }

  // @spec PIPE-CLI-003, PIPE-ASK-001, PIPE-RES-005
  it("answers in a fresh context with the card, pack, briefing, and earlier questions, without the lock", async () => {
    const { fake, answer } = await asked(false, true);
    expect(answer).toBe("The loop retries on every 429.");
    const p = fake.calls[0].prompt;
    expect(p).toContain("Should a failed upload retry forever");
    expect(p).toContain("# Briefing");
    expect(p).toContain("# Context");
    expect(p).toContain("Earlier question?");
  });

  // @spec PIPE-ASK-002, PIPE-ASK-003
  it("withholds the recommendation and the lean until the reviewer may see it", async () => {
    const hidden = await asked(false);
    expect(hidden.fake.calls[0].prompt).toContain("(withheld)");
    expect(hidden.fake.calls[0].prompt).not.toContain("Bounded retries are safer");
    expect(hidden.fake.calls[0].prompt).toMatch(/Do not say, hint, or rank which option you would choose/);
    const shown = await asked(true);
    expect(shown.fake.calls[0].prompt).toContain("Bounded retries are safer");
  });

  // @spec PIPE-ASK-004
  it("writes nothing to the run directory", async () => {
    const r = await review();
    const before = readdirSyncImpl(r.summary.runDir).sort();
    await ask({ repoRoot: r.repo.dir, runId: r.summary.runId, cardId: "D1", question: "q?", mayRevealRecommendation: false, reviewer: "rev", runner: fakeClaude(happyHandlers()).runner, userConfigDir });
    expect(readdirSyncImpl(r.summary.runDir).sort()).toEqual(before);
  });
});

describe("command line and clean", () => {
  // @spec PIPE-CLI-001, PIPE-CLI-005
  it("accepts a pull request, refs, or the working tree, with an author statement", async () => {
    const out: string[] = [];
    const sink = { write: (s: string) => void out.push(s) } as never;
    expect(await main(["run"], sink, sink)).toBe(2);
    expect(out.join("")).toMatch(/--pr <number> \| --base <ref> \[--head <ref>\] \| --worktree/);
    const repo = fixtureRepo();
    write(repo.dir, "src/upload.ts", "export const wip = 1;\n");
    const fake = fakeClaude(happyHandlers());
    const s = await run({ repoRoot: repo.dir, change: { kind: "worktree", base: "main" }, authorStatement: "I meant to simplify upload", runner: fake.runner, sleep: noSleep, userConfigDir });
    const pack = openStore({ repoRoot: repo.dir }).reader(s.runId).read("context-pack")!;
    expect(pack.items.find((i) => i.kind === "author-statement")?.content).toBe("I meant to simplify upload");
    expect(git(repo.dir, "rev-parse", `refs/duet/${s.runId}`)).toBe(openStore({ repoRoot: repo.dir }).reader(s.runId).read("run")!.head);
  });

  // @spec PIPE-CLI-004
  it("removes named or old runs with their worktrees and snapshot refs", async () => {
    const r = await review();
    const old = join(r.summary.runDir, "run.json");
    utimesSync(old, new Date(0), new Date(0));
    expect(await clean({ repoRoot: r.repo.dir, olderThanDays: 1, userConfigDir })).toEqual([r.summary.runId]);
    expect(existsSync(r.summary.runDir)).toBe(false);
    expect(git(r.repo.dir, "worktree", "list")).not.toContain(r.summary.runId);
  });
});
