import { describe, expect, it } from "vitest";
import { cardHash, findingFingerprint, openStore, upsertAnswer, validate } from "../src/index.ts";
import { answer, briefing, card, cards, finding, findings, record, recommendations, SHA_A, SHA_B, tempRepo } from "./fixtures.ts";

function setup() {
  const store = openStore({ repoRoot: tempRepo() });
  const pipeline = store.pipeline("r1");
  pipeline.initRun({ base: SHA_A, head: SHA_B, title: "t" });
  pipeline.write("briefing", briefing());
  return { store, pipeline };
}

describe("findings", () => {
  // @spec ART-FIND-001, ART-FIND-002
  it("holds findings with all fields plus coverage and exploration summaries", () => {
    expect(validate("findings", findings()).ok).toBe(true);
    expect(validate("findings", { ...findings(), exploration: undefined }).ok).toBe(false);
    const f = finding();
    delete (f as Record<string, unknown>).related_cards;
    expect(validate("findings", findings([f])).ok).toBe(false);
  });

  // @spec ART-FIND-003, ART-FIND-004
  it("restricts severity and verification status", () => {
    expect(validate("findings", findings([finding({ severity: "urgent" })])).ok).toBe(false);
    expect(validate("findings", findings([finding({ verification: { status: "maybe", by: "v", notes: "" } })])).ok).toBe(false);
  });

  // @spec ART-FIND-005
  it("rejects findings.json when any finding lacks a verification status", () => {
    const { pipeline } = setup();
    expect(() => pipeline.write("findings", findings([finding({ verification: { by: "v", notes: "" } })]))).toThrow();
  });

  // @spec ART-FIND-006
  it("fingerprints by file, pattern or normalized code, and category, ignoring line numbers", () => {
    const a = findingFingerprint({ file: "a.ts", pattern: "while \\(", category: "bug" });
    expect(findingFingerprint({ file: "a.ts", pattern: "while \\(", category: "bug" })).toBe(a);
    expect(findingFingerprint({ file: "a.ts", pattern: "while \\(", category: "security" })).not.toBe(a);
    const c1 = findingFingerprint({ file: "a.ts", code: "if (x)  {\n  go();\n}", category: "bug" });
    const c2 = findingFingerprint({ file: "a.ts", code: "if (x) { go(); }", category: "bug" });
    expect(c1).toBe(c2);
  });

  // @spec ART-FIND-007, ART-FIND-008
  it("applies a reviewer's finding states by fingerprint", () => {
    const { store, pipeline } = setup();
    pipeline.write("findings", findings([finding(), finding({ id: "F2", fingerprint: "ffp2" })]));
    expect(validate("finding-state", { schema_version: "1.0", states: [{ fingerprint: "x", state: "gone" }] }).ok).toBe(false);
    store.session("r1", "rev").writeFindingState({ schema_version: "1.0", states: [{ fingerprint: "ffp2", state: "dismissed" }] });
    const result = store.reader("r1").findingsFor("rev");
    expect(result.map((f) => [f.id, f.state])).toEqual([["F1", "open"], ["F2", "dismissed"]]);
  });
});

describe("recommendation lookup", () => {
  // @spec ART-LEAN-003
  it("never returns a recommendation written against different card content", () => {
    const { store, pipeline } = setup();
    const c = card();
    pipeline.write("cards", cards([c]));
    const entry = { card_id: "D1", option: 1, confidence: 70, reasoning: "r", what_would_change_my_mind: "w" };
    pipeline.write("recommendations", recommendations([{ ...entry, card_hash: "stale" }]));
    expect(store.reader("r1").getRecommendation(c as never)).toBeNull();
    pipeline.write("recommendations", recommendations([{ ...entry, card_hash: cardHash(c as never) }]));
    expect(store.reader("r1").getRecommendation(c as never)?.option).toBe(1);
  });
});

describe("session files", () => {
  // @spec ART-LOG-001
  it("validates question-log entries", () => {
    expect(validate("qa-entry", { card_id: "D1", asked_at: "t", question: "q", answer: "a", committed: false }).ok).toBe(true);
    expect(validate("qa-entry", { card_id: "D1", question: "q" }).ok).toBe(false);
  });

  // @spec ART-LOG-002, ART-LOG-003, ART-LOG-004, ART-LOG-005, ART-LOG-006
  it("validates the record's identity, answers, changes, and posts", () => {
    const full = record({
      ended_at: "2026-10-14T01:00:00Z",
      incomplete_stages: ["findings"],
      answers: [answer({ changes: [{ from: 1, to: 0, reason: "r", at: "t" }] })],
      posted: [{ target: "pr#1", text_hash: "h", signed_off_at: "t1", posted_at: "t2" }],
    });
    expect(validate("record", full).ok).toBe(true);
    expect(validate("record", record({ answers: [answer({ agreed_with_ai: null })] })).ok).toBe(true);
    const noFp = answer();
    delete (noFp as Record<string, unknown>).fingerprint;
    expect(validate("record", record({ answers: [noFp] })).ok).toBe(false);
    expect(validate("record", record({ answers: [answer({ changes: [{ from: 1, to: 0, at: "t" }] })] })).ok).toBe(false);
    expect(validate("record", record({ posted: [{ target: "pr#1", text_hash: "h", signed_off_at: "t1" }] })).ok).toBe(false);
  });

  // @spec ART-LOG-007
  it("reports an answer stale when the card with the same fingerprint has changed", () => {
    const { store } = setup();
    const c = card();
    const rec = record({ answers: [answer({ card_hash: cardHash(c as never) })] });
    expect(store.reader("r1").answerFor(rec as never, c as never).status).toBe("current");
    const changed = card({ question: "Should retries stop after a deadline?" });
    const r = store.reader("r1").answerFor(rec as never, changed as never);
    expect(r.status).toBe("stale");
    expect(store.reader("r1").answerFor(rec as never, card({ fingerprint: "other" }) as never).status).toBe("none");
  });

  // @spec ART-LOG-008
  it("replaces a stale answer and keeps it as previous", () => {
    const old = answer({ card_hash: "old" });
    const next = answer({ card_hash: "new", chosen_option: 0 });
    const updated = upsertAnswer(record({ answers: [old] }) as never, next as never);
    expect(updated.answers).toHaveLength(1);
    expect(updated.answers[0].card_hash).toBe("new");
    expect(updated.answers[0].previous).toEqual([{ ...old, previous: undefined }].map(({ previous, ...rest }) => rest));
  });
});
