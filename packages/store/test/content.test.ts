import { describe, expect, it } from "vitest";
import { cardHash, CONTEXT_KINDS, validate } from "../src/index.ts";
import { anchor, briefing, card, cards, contextPack, intent } from "./fixtures.ts";

const ok = (file: Parameters<typeof validate>[0], data: unknown, ctx?: Parameters<typeof validate>[2]) =>
  validate(file, data, ctx).ok;

describe("context pack", () => {
  // @spec ART-CTX-001, ART-CTX-002, ART-CTX-003
  it("records the budget, included items with kind, source, and size, and excluded items with a reason", () => {
    expect(ok("context-pack", contextPack())).toBe(true);
    expect(ok("context-pack", { ...contextPack(), budget: undefined })).toBe(false);
    const noSize = contextPack();
    delete (noSize.items[0] as Record<string, unknown>).size;
    expect(ok("context-pack", noSize)).toBe(false);
    const noReason = contextPack();
    delete (noReason.excluded[0] as Record<string, unknown>).reason;
    expect(ok("context-pack", noReason)).toBe(false);
  });

  // @spec ART-CTX-004
  it("restricts item kinds to the defined set", () => {
    expect(CONTEXT_KINDS).toEqual([
      "diff", "author-statement", "intent-source", "commit-message", "history", "linked-doc",
      "changed-file", "file-outline", "summarized-file", "project-doc", "codeowners", "tool-output", "caller",
    ]);
    const pack = contextPack();
    pack.items[0].kind = "rumor";
    expect(ok("context-pack", pack)).toBe(false);
  });
});

describe("anchors", () => {
  // @spec ART-ANCH-001
  it("requires file and full commit SHA, and line numbers unless the file is binary", () => {
    const withAnchor = (a: unknown) => ({ ...intent(), mismatches: [{ statement: "s", anchors: [a], kind: "unstated" }] });
    expect(ok("intent", withAnchor(anchor()))).toBe(true);
    expect(ok("intent", withAnchor({ file: "x", commit: "abc" }))).toBe(false);
    expect(ok("intent", withAnchor({ file: "model.bin", commit: "b".repeat(40) }))).toBe(false);
    expect(ok("intent", withAnchor({ file: "model.bin", commit: "b".repeat(40), binary: true }))).toBe(true);
  });

  // @spec ART-ANCH-002
  it("allows an optional pattern", () => {
    const m = { statement: "s", anchors: [{ ...anchor(), pattern: "while \\(" }], kind: "unstated" };
    expect(ok("intent", { ...intent(), mismatches: [m] })).toBe(true);
  });
});

describe("intent and briefing", () => {
  // @spec ART-BRIEF-001
  it("holds stated, sources, observed, and mismatches with a kind", () => {
    expect(ok("intent", intent())).toBe(true);
    const bad = intent();
    (bad.mismatches[0] as Record<string, unknown>).kind = "other";
    expect(ok("intent", bad)).toBe(false);
  });

  // @spec ART-BRIEF-002
  it("records empty sources when no intent source exists", () => {
    expect(ok("intent", { ...intent(), stated: "", sources: [] })).toBe(true);
    expect(ok("intent", { ...intent(), stated: "", sources: ["i2"] })).toBe(false);
  });

  // @spec ART-BRIEF-003, ART-BRIEF-004, ART-BRIEF-005, ART-BRIEF-006
  it("holds effort 1-5, coverage, cohorts, and ordered steps", () => {
    expect(ok("briefing", briefing())).toBe(true);
    expect(ok("briefing", { ...briefing(), effort: { score: 6, minutes: 1, drivers: [] } })).toBe(false);
    const b = briefing();
    delete (b.coverage.skipped[0] as Record<string, unknown>).reason;
    expect(ok("briefing", b)).toBe(false);
    const c = briefing();
    delete (c.cohorts[0] as Record<string, unknown>).depends_on;
    expect(ok("briefing", c)).toBe(false);
    const s = briefing();
    delete (s.steps[0] as Record<string, unknown>).id;
    expect(ok("briefing", s)).toBe(false);
  });

  // @spec ART-BRIEF-007, ART-BRIEF-008
  it("holds choices whose first entry is the overall approach", () => {
    const b = briefing();
    b.choices[0].kind = "choice";
    expect(ok("briefing", b)).toBe(false);
    expect(ok("briefing", { ...briefing(), choices: [] })).toBe(false);
  });

  // @spec ART-BRIEF-009, ART-BRIEF-010
  it("labels each rationale's source and requires quote and item when stated", () => {
    const b = briefing();
    b.choices[0].rationale = { source: "stated", text: "t" } as never;
    expect(ok("briefing", b)).toBe(false);
    b.choices[0].rationale = { source: "stated", text: "t", quote: "keep callers simple", item: "i2" } as never;
    expect(ok("briefing", b)).toBe(true);
    b.choices[0].rationale = { source: "guessed", text: "t" } as never;
    expect(ok("briefing", b)).toBe(false);
  });
});

describe("decision cards", () => {
  const ctx = { briefing: briefing() as never };

  // @spec ART-DECK-001, ART-DECK-002
  it("requires a non-empty no_decisions_summary whether or not cards exist", () => {
    expect(ok("cards", cards(), ctx)).toBe(true);
    expect(ok("cards", { ...cards([]), no_decisions_summary: "" }, ctx)).toBe(false);
    expect(ok("cards", { ...cards(), no_decisions_summary: undefined }, ctx)).toBe(false);
  });

  // @spec ART-DECK-003
  it("requires every card field", () => {
    for (const f of ["id", "order", "fingerprint", "source", "stakes", "stakes_basis", "question", "why_it_matters",
      "plain_technical", "options", "anchors", "step_ref", "basis", "not_examined", "flags"]) {
      const c = card();
      delete (c as Record<string, unknown>)[f];
      expect(ok("cards", cards([c]), ctx), f).toBe(false);
    }
  });

  // @spec ART-DECK-004, ART-DECK-005
  it("accepts trigger or proposed sources, and requires categories on trigger cards", () => {
    expect(ok("cards", cards([card({ source: "other" })]), ctx)).toBe(false);
    expect(ok("cards", cards([card({ categories: [] })]), ctx)).toBe(false);
    expect(ok("cards", cards([card({ categories: ["auth", "money"] })]), ctx)).toBe(true);
  });

  // @spec ART-DECK-006
  it("requires alternative_and_consequence on proposed cards", () => {
    expect(ok("cards", cards([card({ source: "proposed", categories: undefined })]), ctx)).toBe(false);
    expect(ok("cards", cards([card({ source: "proposed", categories: undefined, alternative_and_consequence: "a" })]), ctx)).toBe(true);
  });

  // @spec ART-DECK-007
  it("requires analogy_breaks_down_when with a metaphor", () => {
    expect(ok("cards", cards([card({ metaphor: "Like redialling" })]), ctx)).toBe(false);
    expect(ok("cards", cards([card({ metaphor: "Like redialling", analogy_breaks_down_when: "Servers say when" })]), ctx)).toBe(true);
  });

  // @spec ART-DECK-008
  it("requires two to four complete options", () => {
    const opt = card().options[0];
    expect(ok("cards", cards([card({ options: [opt] })]), ctx)).toBe(false);
    const five = [opt, ...Array(4).fill({ ...opt, is_current: false })];
    expect(ok("cards", cards([card({ options: five })]), ctx)).toBe(false);
  });

  // @spec ART-DECK-009
  it("accepts only high or low stakes", () => {
    expect(ok("cards", cards([card({ stakes: "medium" })]), ctx)).toBe(false);
  });

  // @spec ART-DECK-010
  it("rejects a card whose step_ref names no briefing step", () => {
    expect(ok("cards", cards([card({ step_ref: "S9" })]), ctx)).toBe(false);
  });

  // @spec ART-DECK-011
  it("rejects recommendation fields and finding links on cards", () => {
    expect(ok("cards", cards([card({ recommendation: { option: 1 } })]), ctx)).toBe(false);
    expect(ok("cards", cards([card({ related_findings: ["F1"] })]), ctx)).toBe(false);
  });

  // @spec ART-DECK-012
  it("requires exactly one option marked as current", () => {
    const opts = card().options;
    expect(ok("cards", cards([card({ options: opts.map((o) => ({ ...o, is_current: false })) })]), ctx)).toBe(false);
    expect(ok("cards", cards([card({ options: opts.map((o) => ({ ...o, is_current: true })) })]), ctx)).toBe(false);
  });

  // @spec ART-DECK-013
  it("allows a choice_ref that names a briefing choice", () => {
    expect(ok("cards", cards([card({ choice_ref: "H1" })]), ctx)).toBe(true);
    expect(ok("cards", cards([card({ choice_ref: "H9" })]), ctx)).toBe(false);
  });

  // @spec ART-DECK-014
  it("holds fact-check flags with claim and note", () => {
    expect(ok("cards", cards([card({ flags: [{ claim: "no limit", note: "line 90 caps at 5" }] })]), ctx)).toBe(true);
    expect(ok("cards", cards([card({ flags: [{ claim: "no limit" }] })]), ctx)).toBe(false);
  });

  // @spec ART-DECK-015, ART-DECK-016, ART-DECK-017
  it("holds settled decisions, fact_check status, and proposed_status with a note when failed", () => {
    const base = cards();
    expect(ok("cards", { ...base, settled: [{ decision: "d", alternative: "a", fixed_by: "ticket" }] }, ctx)).toBe(true);
    expect(ok("cards", { ...base, settled: [{ decision: "d" }] }, ctx)).toBe(false);
    expect(ok("cards", { ...base, fact_check: "skipped" }, ctx)).toBe(false);
    expect(ok("cards", { ...base, proposed_status: { status: "failed" } }, ctx)).toBe(false);
    expect(ok("cards", { ...base, proposed_status: { status: "failed", note: "refuter timed out" } }, ctx)).toBe(true);
  });
});

describe("recommendations", () => {
  // @spec ART-LEAN-001
  it("holds produced entries with card id, option, confidence, reasoning, and card hash", () => {
    const e = { card_id: "D1", option: 1, confidence: 70, reasoning: "r", what_would_change_my_mind: "w", card_hash: "h" };
    expect(ok("recommendations", { schema_version: "1.0", entries: [e] })).toBe(true);
    expect(ok("recommendations", { schema_version: "1.0", entries: [] })).toBe(true);
    expect(ok("recommendations", { schema_version: "1.0", entries: [{ ...e, confidence: 120 }] })).toBe(false);
  });

  // @spec ART-LEAN-002
  it("hashes cards canonically so equal content gives equal hashes", () => {
    const a = card();
    const b = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(card()).reverse())));
    expect(cardHash(a as never)).toBe(cardHash(b));
    expect(cardHash(card({ question: "Different?" }) as never)).not.toBe(cardHash(a as never));
  });
});
