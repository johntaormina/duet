import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardHash, openStore, type Card } from "@duet/store";
import { describe, expect, it } from "vitest";
import { reviewerIdentity, ReviewSession, SessionError } from "../src/index.ts";

const HEAD = "b".repeat(40);
const anchor = (file: string) => ({ file, commit: HEAD, start_line: 1, end_line: 2 });

function card(id: string, stakes: "high" | "low", over: Partial<Card> = {}): Card {
  return {
    id,
    order: Number(id.slice(1)),
    fingerprint: `fp-${id}`,
    source: "trigger",
    categories: ["error-semantics"],
    stakes,
    stakes_basis: "default",
    question: `Question ${id}?`,
    why_it_matters: "Jobs hang.",
    plain_technical: "Loop has no limit.",
    options: [
      { summary: "Keep", pros: [], cons: [], reversibility: "easy", is_current: true },
      { summary: "Cap", pros: [], cons: [], reversibility: "easy", is_current: false },
    ],
    anchors: [anchor("src/upload.ts")],
    step_ref: "S1",
    basis: [],
    not_examined: [],
    flags: [],
    ...over,
  };
}

const briefing = {
  schema_version: "1.0",
  effort: { score: 2, minutes: 10, drivers: [] },
  coverage: { reviewed: [], skipped: [] },
  cohorts: [{ id: "C1", title: "Upload", summary: "s", files: ["src/upload.ts"], depends_on: [] }],
  steps: [{ id: "S1", title: "t", explanation: "e", anchors: [] }],
  choices: [{ id: "H1", kind: "approach", choice: "c", alternative: "a", tradeoff: "t", rationale: { source: "inferred", text: "x" }, anchors: [], step_ref: "S1" }],
};

function setup(opts: { recs?: boolean; recStage?: "complete" | "running" | "failed" } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "duet-sess-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "Pat.Reviewer+x@Example.com"], { cwd: repo });
  const store = openStore({ repoRoot: repo });
  const p = store.pipeline("r1");
  p.initRun({ base: "a".repeat(40), head: HEAD, title: "t" });
  p.write("briefing", briefing);
  const cards = [card("D1", "high"), card("D2", "low")];
  p.write("cards", { schema_version: "1.0", cards, no_decisions_summary: "rest mechanical", settled: [], fact_check: "complete", proposed_status: { status: "complete" } });
  if (opts.recs !== false) {
    p.write("recommendations", { schema_version: "1.0", entries: cards.map((c) => ({ card_id: c.id, option: 1, confidence: 70, reasoning: "Cap is safer.", what_would_change_my_mind: "Retry-After", card_hash: cardHash(c) })) });
  }
  p.setStage("recommendations", { status: opts.recStage ?? "complete", ...(opts.recStage === "failed" ? { error: "x" } : {}) });
  p.setStage("findings", { status: "running" });
  const asks: { cardId: string; question: string; mayReveal: boolean }[] = [];
  let t = 0;
  const session = new ReviewSession({
    store,
    runId: "r1",
    reviewer: "rev",
    ask: async (a) => {
      asks.push(a);
      return `answer to ${a.question}`;
    },
    now: () => new Date(Date.UTC(2026, 9, 14, 0, 0, t++)),
  });
  return { repo, store, p, session, asks, cards };
}

describe("reviewer identity", () => {
  // @spec SESS-ID-001, SESS-ID-002
  it("uses the repository's git email unless overridden, made filename-safe", () => {
    const { repo } = setup();
    expect(reviewerIdentity(repo)).toBe("pat-reviewer-x-example-com");
    expect(reviewerIdentity(repo, "Someone Else")).toBe("someone-else");
  });
});

describe("card states and blind-first", () => {
  // @spec SESS-STATE-001
  it("tracks each card as open, committed, revealed, or stale", async () => {
    const { session } = setup();
    expect(session.state("D1")).toBe("open");
    session.commit("D1", 0, "Unbounded is fine here.");
    expect(session.state("D1")).toBe("committed");
    session.reveal("D1");
    expect(session.state("D1")).toBe("revealed");
  });

  // @spec SESS-STATE-002, SESS-STATE-003
  it("requires an option, and on high-stakes cards any non-empty rationale", () => {
    const { session } = setup();
    expect(() => session.commit("D1", undefined as never, "x")).toThrow(SessionError);
    expect(() => session.commit("D1", 0, "   ")).toThrow(/rationale/);
    expect(() => session.commit("D1", 7, "fine")).toThrow(/option/);
    session.commit("D1", 0, "seems fine");
    expect(session.canCommit("D2", 1, "").ok).toBe(true);
  });

  // @spec SESS-STATE-004, SESS-REC-001
  it("writes the commitment to the record immediately", () => {
    const { session, store } = setup();
    session.commit("D1", 1, "Cap it.");
    const rec = store.reader("r1").readRecord("rev")!;
    expect(rec.answers[0]).toMatchObject({ card_id: "D1", chosen_option: 1, rationale: "Cap it.", committed_at: expect.any(String), revealed_at: null });
  });

  // @spec SESS-STATE-005
  it("refuses a high-stakes card's recommendation before commitment", () => {
    const { session } = setup();
    expect(session.recommendationFor("D1")).toBeNull();
    expect(() => session.reveal("D1")).toThrow(/commit/);
  });

  // @spec SESS-STATE-006
  it("reveals a committed card's recommendation and records the time and agreement", () => {
    const { session, store } = setup();
    session.commit("D1", 0, "Keep.");
    const r = session.reveal("D1");
    expect(r).toMatchObject({ kind: "recommendation", recommendation: { option: 1 } });
    const a = store.reader("r1").readRecord("rev")!.answers[0];
    expect(a.revealed_at).not.toBeNull();
    expect(a.agreed_with_ai).toBe(false);
  });

  // @spec SESS-STATE-007, SESS-STATE-008
  it("keeps the card committed when no matching recommendation is available, and reveals it later", () => {
    const s = setup({ recs: false, recStage: "running" });
    s.session.commit("D1", 1, "Cap.");
    expect(s.session.reveal("D1")).toEqual({ kind: "unavailable", stage: "running" });
    expect(s.session.state("D1")).toBe("committed");
    expect(s.store.reader("r1").readRecord("rev")!.answers[0]).toMatchObject({ revealed_at: null, agreed_with_ai: null });
    // A recommendation for different card content does not count.
    s.p.write("recommendations", { schema_version: "1.0", entries: [{ card_id: "D1", option: 1, confidence: 50, reasoning: "r", what_would_change_my_mind: "w", card_hash: "other" }] });
    expect(s.session.reveal("D1").kind).toBe("unavailable");
    s.p.write("recommendations", { schema_version: "1.0", entries: [{ card_id: "D1", option: 1, confidence: 50, reasoning: "r", what_would_change_my_mind: "w", card_hash: cardHash(s.cards[0]) }] });
    expect(s.session.reveal("D1").kind).toBe("recommendation");
    expect(s.store.reader("r1").readRecord("rev")!.answers[0].agreed_with_ai).toBe(true);
  });

  // @spec SESS-STATE-009, SESS-STATE-012
  it("shows a low-stakes recommendation before commitment and needs only an option to commit", () => {
    const { session, store } = setup();
    expect(session.recommendationFor("D2")?.option).toBe(1);
    session.commit("D2", 1, "");
    const a = store.reader("r1").readRecord("rev")!.answers.find((x) => x.card_id === "D2")!;
    expect(a.revealed_at).not.toBeNull();
    expect(a.revealed_at! < a.committed_at).toBe(true);
    expect(a.agreed_with_ai).toBe(true);
  });

  // @spec SESS-STATE-010
  it("requires a reason to change a committed option and records the change", () => {
    const { session, store } = setup();
    session.commit("D1", 0, "Keep.");
    expect(() => session.changeOption("D1", 1, "")).toThrow(/reason/);
    session.reveal("D1");
    session.changeOption("D1", 1, "Claude's point about overload convinced me.");
    const a = store.reader("r1").readRecord("rev")!.answers[0];
    expect(a.chosen_option).toBe(1);
    expect(a.changes).toEqual([{ from: 0, to: 1, reason: "Claude's point about overload convinced me.", at: expect.any(String) }]);
    expect(a.agreed_with_ai).toBe(false);
  });

  // @spec SESS-STATE-011, SESS-STATE-013
  it("presents a changed card's answer as stale, reopens it, and keeps the old answer when re-answered", () => {
    const s = setup();
    s.session.commit("D1", 0, "Keep.");
    const changed = { ...s.cards[0], question: "Should retries stop after a deadline instead?" };
    s.p.write("cards", { schema_version: "1.0", cards: [changed, s.cards[1]], no_decisions_summary: "x", settled: [], fact_check: "complete", proposed_status: { status: "complete" } });
    expect(s.session.state("D1")).toBe("stale");
    expect(s.session.canCommit("D1", 1, "Deadline is better.").ok).toBe(true);
    s.session.commit("D1", 1, "Deadline is better.");
    const a = s.store.reader("r1").readRecord("rev")!.answers[0];
    expect(a.chosen_option).toBe(1);
    expect(a.previous).toHaveLength(1);
    expect(a.previous![0].rationale).toBe("Keep.");
  });
});

describe("questions", () => {
  // @spec SESS-ASK-001
  it("tells ask whether the reviewer may see the recommendation", async () => {
    const { session, asks } = setup();
    await session.ask("D1", "What happens on 429?");
    session.commit("D1", 0, "Keep.");
    await session.ask("D1", "And now?");
    session.reveal("D1");
    await session.ask("D1", "Why cap?");
    session.recommendationFor("D2");
    await session.ask("D2", "Low?");
    expect(asks.map((a) => a.mayReveal)).toEqual([false, false, true, true]);
  });

  // @spec SESS-ASK-002, SESS-ASK-003
  it("logs each question and derives the count asked before commitment", async () => {
    const { session, store } = setup();
    await session.ask("D1", "q1");
    await session.ask("D1", "q2");
    session.commit("D1", 0, "Keep.");
    await session.ask("D1", "q3");
    const qa = store.reader("r1").readQa("rev");
    expect(qa.map((q) => [q.question, q.committed])).toEqual([["q1", false], ["q2", false], ["q3", true]]);
    expect(session.questionsBeforeCommit("D1")).toBe(2);
  });
});

describe("findings", () => {
  function withFindings() {
    const s = setup();
    const f = (id: string, file: string, confidence: number, status: "confirmed" | "refuted" | "uncertain") => ({
      id, category: "bug", severity: "high", confidence, title: id, anchors: [anchor(file)], evidence: "e", found_by: ["bugs"], related_cards: [], verification: { status, by: "verifier", notes: "" }, fingerprint: `ffp-${id}`,
    });
    s.p.write("findings", { schema_version: "1.0", findings: [f("F1", "src/upload.ts", 90, "confirmed"), f("F2", "src/upload.ts", 95, "refuted"), f("F3", "lib/x.ts", 85, "uncertain"), f("F4", "src/upload.ts", 60, "confirmed")], coverage: { reviewed: [], skipped: [] }, exploration: { context_gathered: "", budget: "", not_examined: [] } });
    return s;
  }

  // @spec SESS-FIND-001, SESS-FIND-003
  it("offers only unrefuted findings at or above the threshold, grouped by cohort", () => {
    const { session } = withFindings();
    expect(session.findings().map((f) => [f.id, f.cohort])).toEqual([["F1", "Upload"], ["F3", "other"]]);
  });

  // @spec SESS-FIND-002
  it("stores a finding's state by fingerprint", () => {
    const { session, store } = withFindings();
    session.setFindingState("ffp-F1", "dismissed");
    expect(store.reader("r1").readFindingState("rev")!.states).toEqual([{ fingerprint: "ffp-F1", state: "dismissed" }]);
    expect(session.findings().find((f) => f.id === "F1")!.state).toBe("dismissed");
  });
});

describe("ending, the decision log, and posting", () => {
  // @spec SESS-REC-002, SESS-REC-003
  it("ends with the time and incomplete stages, even with cards unanswered", () => {
    const { session, store } = setup();
    session.commit("D1", 0, "Keep.");
    session.end();
    const rec = store.reader("r1").readRecord("rev")!;
    expect(rec.ended_at).not.toBeNull();
    expect(rec.incomplete_stages).toEqual(expect.arrayContaining(["findings", "context", "intent"]));
    expect(rec.answers).toHaveLength(1);
  });

  // @spec SESS-REC-004, SESS-REC-005
  it("produces a decision log with answers, unanswered cards, and incomplete stages", () => {
    const { session } = setup();
    session.commit("D1", 0, "Keep, the server sends Retry-After.");
    session.reveal("D1");
    session.changeOption("D1", 1, "Changed my mind.");
    const log = session.decisionLog();
    expect(log).toContain("Question D1?");
    expect(log).toContain("Cap");
    expect(log).toContain("Keep, the server sends Retry-After.");
    expect(log).toMatch(/Matched Claude's recommendation: yes/);
    expect(log).toMatch(/Changed after commitment: yes/);
    expect(log).toMatch(/Unanswered[\s\S]*Question D2\?/);
    expect(log).toMatch(/Incomplete stages[\s\S]*findings/);
  });

  // @spec SESS-REC-006, SESS-REC-007
  it("signs the exact approved text and records a successful post", () => {
    const { session, store } = setup();
    const signed = session.signPost("pr#5", "Decision log text");
    expect(signed).toMatchObject({ target: "pr#5", text: "Decision log text", signedOffAt: expect.any(String) });
    session.recordPost(signed, { ok: true, postedAt: "2026-10-14T01:00:00Z" });
    session.recordPost(session.signPost("pr#5", "other"), { ok: false, error: "down" });
    const posted = store.reader("r1").readRecord("rev")!.posted;
    expect(posted).toEqual([{ target: "pr#5", text_hash: expect.any(String), signed_off_at: signed.signedOffAt, posted_at: "2026-10-14T01:00:00Z" }]);
  });

  // @spec SESS-REC-008
  it("stops writing a session file that fails validation and says how to fix it", () => {
    const { session, store } = setup();
    writeFileSync(join(store.runDir("r1"), "record.rev.json"), "{ broken");
    expect(() => session.commit("D1", 0, "Keep.")).toThrow(/repaired or moved aside/);
  });
});
