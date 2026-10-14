import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssetResolver, DEFAULT_CONFIG } from "@duet/adapters";
import { type Briefing, type Card, type Intent, validate } from "@duet/store";
import { describe, expect, it } from "vitest";
import { CORE_ASSETS } from "../src/engine.ts";
import {
  applyFactCheck,
  assembleDeck,
  buildContextPack,
  CallTimeoutError,
  cardFingerprint,
  defaultStakes,
  ensureHeadWorktree,
  intentHits,
  InvalidOutputError,
  loadTriggers,
  runCards,
  Scheduler,
  signalHits,
  uncoveredHits,
  type DraftCard,
} from "../src/index.ts";
import { withAnchorsAtHead } from "../src/stages/human.ts";
import { card, coveringCards, fakeClaude, fixtureRepo, git, happyHandlers, type Handler, noSleep, OUT, write } from "./kit.ts";

const core = createAssetResolver(CORE_ASSETS, null);
const triggers = loadTriggers(core);

async function setup(handlers: Record<string, Handler> = {}, config = DEFAULT_CONFIG, assets = core) {
  const { dir, base, head } = fixtureRepo();
  const worktree = ensureHeadWorktree(dir, join(dir, ".duet", "r"), head);
  const pack = await buildContextPack({ repo: dir, worktree, change: { base, head, title: "t", description: "", linkedIssues: [], comments: [] }, budget: 100_000, perFileLimit: 20_000, historyCount: 0, generatedPaths: [], resolvers: [], toolOutput: [] });
  const fake = fakeClaude({ ...happyHandlers(), ...handlers });
  const intent = withAnchorsAtHead({ schema_version: "1.0", ...OUT.intent }, head) as unknown as Intent;
  const briefing = withAnchorsAtHead({ schema_version: "1.0", ...OUT.briefing }, head) as unknown as Briefing;
  const input = { env: { runner: fake.runner, assets, config, scheduler: new Scheduler(3), cwd: worktree, sleep: noSleep }, repo: dir, base, head, pack, intent, briefing, stakesOverrides: config.stakes };
  return { ...fake, input, dir, base, head, briefing };
}

const draft = (over: Record<string, unknown> = {}) => card(over) as unknown as DraftCard;
const ctx = (briefing: Briefing, overrides: Record<string, "high" | "low"> = {}) => ({ triggers, overrides, briefing, head: "b".repeat(40) });

describe("triggers", () => {
  // @spec CARD-TRIG-001, CARD-TRIG-002
  it("reads every core category with its default stakes from the trigger file", () => {
    const high = ["auth", "secrets", "money", "data-model", "data-semantics", "irreversible", "public-interface", "compat-rollout", "concurrency", "error-semantics", "privacy", "intent-contradiction", "intent-unstated", "intent-unknown"];
    const low = ["new-dependency", "infra-ci", "cost-performance", "observability"];
    expect(triggers.map((t) => t.category).sort()).toEqual([...high, ...low].sort());
    for (const c of high) expect(triggers.find((t) => t.category === c)!.stakes, c).toBe("high");
    for (const c of low) expect(triggers.find((t) => t.category === c)!.stakes, c).toBe("low");
    for (const t of triggers) expect(t.description.length).toBeGreaterThan(5);
  });

  // @spec CARD-TRIG-003, CARD-TRIG-011
  it("finds path, manifest, and base-image signals in code", () => {
    const { dir, base, head } = fixtureRepo();
    const hits = signalHits(dir, base, head, triggers);
    expect(hits).toContainEqual(expect.objectContaining({ category: "data-model", file: "migrations/001_add_attempts.sql" }));
    const depReasons = hits.filter((h) => h.category === "new-dependency").map((h) => h.reason);
    expect(depReasons).toEqual(expect.arrayContaining([expect.stringMatching(/adds dependency p-retry/), expect.stringMatching(/raises lodash/)]));
    write(dir, "Dockerfile", "FROM node:20\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "docker");
    const mid = git(dir, "rev-parse", "HEAD");
    write(dir, "Dockerfile", "FROM node:22\n");
    write(dir, "package.json", JSON.stringify({ name: "x", dependencies: { lodash: "github:lodash/lodash", "p-retry": "^6.0.0" } }));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "bump");
    const reasons = signalHits(dir, mid, git(dir, "rev-parse", "HEAD"), triggers).map((h) => h.reason);
    expect(reasons).toContain("changes a container base image");
    expect(reasons).toContain("changes the source of lodash");
  });

  // @spec CARD-TRIG-012
  it("treats an added third-party CI action as a secrets hit", () => {
    const { dir, head } = fixtureRepo();
    write(dir, ".github/workflows/ci.yml", "jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n      - uses: someone/deploy-action@v1\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "ci");
    const hits = signalHits(dir, head, git(dir, "rev-parse", "HEAD"), triggers).filter((h) => h.category === "secrets");
    expect(hits).toHaveLength(1);
    expect(hits[0].reason).toContain("someone/deploy-action@v1");
    expect(hits[0].reason).not.toContain("actions/checkout");
  });

  // @spec CARD-TRIG-004, CARD-TRIG-009, CARD-TRIG-010
  it("derives intent hits: one per contradiction, unstated grouped, unknown when intent is thin", () => {
    const i = withAnchorsAtHead({ schema_version: "1.0", ...OUT.intent }, "b".repeat(40)) as unknown as Intent;
    const withContradiction = { ...i, mismatches: [...i.mismatches, { statement: "Deletes instead of archiving", kind: "contradiction" as const, anchors: i.mismatches[0].anchors }, { statement: "Logs payloads", kind: "unstated" as const, anchors: [] }] };
    const hits = intentHits(withContradiction);
    expect(hits.filter((h) => h.category === "intent-contradiction")).toHaveLength(1);
    expect(hits.filter((h) => h.category === "intent-unstated")).toHaveLength(1);
    expect(hits.find((h) => h.category === "intent-unstated")!.reason).toMatch(/timeout.*Logs payloads/s);
    expect(intentHits({ ...withContradiction, stated: "fix" }).map((h) => h.category)).toEqual(["intent-unknown"]);
    expect(intentHits({ ...withContradiction, stated: "" }).map((h) => h.category)).toEqual(["intent-unknown"]);
  });

  // @spec CARD-TRIG-013
  it("uses repository configuration for a category's default stakes", () => {
    expect(defaultStakes(triggers, {}, "infra-ci")).toBe("low");
    expect(defaultStakes(triggers, { "data-model": "low" }, "data-model")).toBe("low");
  });

  // @spec CARD-TRIG-006
  it("requires every hit to be covered by a trigger card with its category and file", () => {
    const hit = { category: "auth", file: "src/a.ts", reason: "r", source: "claude" as const };
    expect(uncoveredHits([hit], [draft({ categories: ["auth"], anchors: [{ file: "src/b.ts", start_line: 1, end_line: 1 }] })])).toHaveLength(1);
    expect(uncoveredHits([hit], [draft({ categories: ["auth", "money"], anchors: [{ file: "src/a.ts", start_line: 1, end_line: 1 }] })])).toHaveLength(0);
    expect(uncoveredHits([hit], [draft({ source: "proposed", categories: ["auth"], anchors: [{ file: "src/a.ts", start_line: 1, end_line: 1 }] })])).toHaveLength(1);
  });

  // @spec CARD-TRIG-005, CARD-TRIG-007
  it("asks Claude for hits and retries naming any hit left uncovered", async () => {
    const s = await setup({
      cards: (req, n) => {
        expect(req.prompt).toContain("data-model in migrations/001_add_attempts.sql");
        const cards = n === 1 ? coveringCards().slice(1) : coveringCards();
        return { hits: [{ category: "error-semantics", file: "src/upload.ts", reason: "unbounded retry" }], cards, no_decisions_summary: "rest is mechanical" };
      },
    });
    const out = await runCards(s.input);
    expect(s.count("cards")).toBe(2);
    expect(s.calls.filter((c) => c.name === "cards")[1].prompt).toContain("error-semantics in src/upload.ts");
    expect(out.cards.some((c) => c.categories?.includes("error-semantics"))).toBe(true);
  });

  // @spec CARD-TRIG-008
  it("fails when a hit is still uncovered after the retry", async () => {
    const s = await setup({ cards: () => ({ hits: [{ category: "error-semantics", file: "src/upload.ts", reason: "unbounded retry" }], cards: coveringCards().slice(1), no_decisions_summary: "x" }) });
    await expect(runCards(s.input)).rejects.toBeInstanceOf(InvalidOutputError);
  });
});

describe("proposed cards", () => {
  const proposed = (q: string) => card({ source: "proposed", categories: undefined, question: q, alternative_and_consequence: "Use a queue; failed uploads would be retried later instead of blocking." });

  // @spec CARD-PROP-001, CARD-PROP-002, CARD-PROP-004
  it("sends only proposed cards to a fresh refuter told to reject non-decisions", async () => {
    const s = await setup({ cards: () => ({ hits: [], cards: [...coveringCards(), proposed("Should uploads be queued?")], no_decisions_summary: "x" }) });
    await runCards(s.input);
    const ref = s.calls.find((c) => c.name === "refute-cards")!;
    expect(ref.prompt).toContain("Should uploads be queued?");
    expect(ref.prompt).not.toContain("retry forever, or give up");
    expect(ref.prompt).toMatch(/reasonable engineer/);
    expect(ref.prompt).toMatch(/already fixed/);
    expect(ref.prompt).not.toContain("stakes_reason");
  });

  // @spec CARD-PROP-003, CARD-PROP-005
  it("drops rejected cards and moves settled ones to the settled list", async () => {
    const s = await setup({
      cards: () => ({ hits: [], cards: [...coveringCards(), proposed("Queue?"), proposed("Log?"), proposed("Cache?")], no_decisions_summary: "x" }),
      "refute-cards": () => ({ verdicts: [{ index: 0, verdict: "reject", reason: "no real alternative" }, { index: 1, verdict: "settled", reason: "ticket", fixed_by: "The linked issue requires logging" }, { index: 2, verdict: "keep", reason: "real" }] }),
    });
    const out = await runCards(s.input);
    const questions = out.cards.map((c) => c.question);
    expect(questions).toContain("Cache?");
    expect(questions).not.toContain("Queue?");
    expect(questions).not.toContain("Log?");
    expect(out.settled).toEqual([expect.objectContaining({ decision: "Log?", fixed_by: "The linked issue requires logging" })]);
  });

  // @spec CARD-PROP-006
  it("leaves out all proposed cards when the refuter fails", async () => {
    const s = await setup({
      cards: () => ({ hits: [], cards: [...coveringCards(), proposed("Queue?")], no_decisions_summary: "x" }),
      "refute-cards": () => {
        throw new Error("refuter crashed");
      },
    });
    const out = await runCards(s.input);
    expect(out.cards.some((c) => c.source === "proposed")).toBe(false);
    expect(out.proposed_status).toEqual({ status: "failed", note: expect.stringMatching(/could not be vetted.*refuter crashed/) });
  });
});

describe("the deck", () => {
  const briefing = withAnchorsAtHead({ schema_version: "1.0", ...OUT.briefing, steps: [...OUT.briefing.steps, { id: "S2", title: "Second", explanation: "e", anchors: [] }] }, "b".repeat(40)) as unknown as Briefing;

  // @spec CARD-DECK-001, CARD-DECK-003
  it("keeps every trigger card even beyond seven, adding no proposed cards", () => {
    const triggerDrafts = Array.from({ length: 9 }, (_, i) => draft({ question: `Q${i}?`, anchors: [{ file: `f${i}.ts`, start_line: 1, end_line: 1 }] }));
    const deck = assembleDeck(triggerDrafts, [draft({ source: "proposed", categories: undefined })], ctx(briefing));
    expect(deck).toHaveLength(9);
    expect(deck.every((c) => c.source === "trigger")).toBe(true);
  });

  // @spec CARD-DECK-002
  it("fills up to seven with proposed cards, high stakes first", () => {
    const triggerDrafts = Array.from({ length: 5 }, (_, i) => draft({ anchors: [{ file: `f${i}.ts`, start_line: 1, end_line: 1 }] }));
    const p = (q: string, s: string) => draft({ source: "proposed", categories: undefined, question: q, assessed_stakes: s, anchors: [{ file: `${q}.ts`, start_line: 1, end_line: 1 }] });
    const deck = assembleDeck(triggerDrafts, [p("low1", "low"), p("high1", "high"), p("high2", "high")], ctx(briefing));
    expect(deck).toHaveLength(7);
    expect(deck.filter((c) => c.source === "proposed").map((c) => c.question).sort()).toEqual(["high1", "high2"]);
  });

  // @spec CARD-DECK-004, CARD-DECK-005, CARD-DECK-006
  it("sets stakes to the highest of category defaults and Claude's assessment, never lower, and names the basis", () => {
    const [a] = assembleDeck([draft({ categories: ["new-dependency", "secrets"], assessed_stakes: "low" })], [], ctx(briefing));
    expect(a.stakes).toBe("high");
    expect(a.stakes_basis).toMatch(/default stakes of category secrets/);
    const [b] = assembleDeck([draft({ categories: ["new-dependency"], assessed_stakes: "high", stakes_reason: "pulls in an unmaintained package" })], [], ctx(briefing));
    expect(b.stakes).toBe("high");
    expect(b.stakes_basis).toBe("pulls in an unmaintained package");
    const [c] = assembleDeck([draft({ categories: ["infra-ci"], assessed_stakes: "low", stakes_reason: "routine" })], [], ctx(briefing, { "infra-ci": "low" }));
    expect(c.stakes).toBe("low");
  });

  // @spec CARD-DECK-007
  it("orders by briefing step, then high stakes before low", () => {
    const deck = assembleDeck(
      [
        draft({ question: "late", step_ref: "S2", anchors: [{ file: "a", start_line: 1, end_line: 1 }] }),
        draft({ question: "early-low", step_ref: "S1", categories: ["infra-ci"], assessed_stakes: "low", anchors: [{ file: "b", start_line: 1, end_line: 1 }] }),
        draft({ question: "early-high", step_ref: "S1", anchors: [{ file: "c", start_line: 1, end_line: 1 }] }),
      ],
      [],
      ctx(briefing),
    );
    expect(deck.map((c) => c.question)).toEqual(["early-high", "early-low", "late"]);
    expect(deck.map((c) => c.id)).toEqual(["D1", "D2", "D3"]);
  });

  // @spec CARD-DECK-008
  it("fingerprints by categories, files, and patterns, adding an ordinal on collision", () => {
    const a = draft({ categories: ["auth", "money"] });
    expect(cardFingerprint(a)).toBe(cardFingerprint(draft({ categories: ["money", "auth"], question: "reworded?" })));
    expect(cardFingerprint(a)).not.toBe(cardFingerprint(draft({ categories: ["auth"] })));
    const deck = assembleDeck([draft(), draft({ question: "twin?" })], [], ctx(briefing));
    expect(deck[1].fingerprint).toBe(`${deck[0].fingerprint}-2`);
  });

  // @spec CARD-DECK-009
  it("writes an empty deck with a summary when nothing needs deciding", async () => {
    const s = await setup({ cards: () => ({ hits: [], cards: [], no_decisions_summary: "Only docs changed." }) });
    // No hits: use a change with no signals and a stated intent with no mismatches.
    s.input.intent = { ...s.input.intent, mismatches: [] };
    const out = await runCards({ ...s.input, base: s.head, head: s.head });
    expect(out.cards).toEqual([]);
    expect(out.no_decisions_summary).toBe("Only docs changed.");
  });
});

describe("fact check", () => {
  const b = withAnchorsAtHead({ schema_version: "1.0", ...OUT.briefing }, "b".repeat(40)) as unknown as Briefing;
  const deck = () => assembleDeck([draft()], [], ctx(b));

  // @spec CARD-CHECK-001
  it("checks every card in one call after the deck is assembled", async () => {
    const s = await setup();
    await runCards(s.input);
    expect(s.count("fact-check")).toBe(1);
    const fc = s.calls.find((c) => c.name === "fact-check")!;
    expect(fc.prompt).toContain("Retry forever");
    expect(fc.prompt).toContain("Should attempts be stored");
  });

  // @spec CARD-CHECK-002
  it("applies corrections and flags", () => {
    const [c] = applyFactCheck(deck(), { cards: [{ index: 0, corrections: { plain_technical: "The loop retries on 429 up to five times." }, flags: [{ claim: "jobs hang", note: "only if the server keeps returning 429" }] }] }, b);
    expect(c.plain_technical).toBe("The loop retries on 429 up to five times.");
    expect(c.flags).toEqual([{ claim: "jobs hang", note: "only if the server keeps returning 429" }]);
  });

  // @spec CARD-CHECK-003
  it("never lets the fact check change identity, categories, stakes, or the set of cards", () => {
    const before = deck();
    const after = applyFactCheck(before, { cards: [{ index: 0, corrections: {} }, { index: 5, corrections: { plain_technical: "new card?" } }] } as never, b);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: before[0].id, fingerprint: before[0].fingerprint, stakes: "high", categories: ["error-semantics"] });
  });

  // @spec CARD-CHECK-004
  it("flags instead of applying a correction that would make the card invalid", () => {
    const long = Array(80).fill("word").join(" ");
    const [c] = applyFactCheck(deck(), { cards: [{ index: 0, corrections: { plain_technical: long } }] }, b);
    expect(c.plain_technical).not.toBe(long);
    expect(c.flags[0].claim).toBe(deck()[0].plain_technical);
  });

  // @spec CARD-CHECK-005
  it("runs with a turn limit and a 90-second default timeout", async () => {
    const s = await setup();
    await runCards(s.input);
    const fc = s.calls.find((c) => c.name === "fact-check")!;
    expect(fc.timeoutMs).toBe(90_000);
    expect(fc.maxTurns).toBeGreaterThan(0);
  });

  // @spec CARD-CHECK-006
  it("writes the deck unchecked when the fact check times out or fails", async () => {
    const t = await setup({ "fact-check": () => { throw new CallTimeoutError("fact-check", 90_000); } });
    expect((await runCards(t.input)).fact_check).toBe("timed_out");
    const f = await setup({ "fact-check": () => { throw new Error("boom"); } });
    const out = await runCards(f.input);
    expect(out.fact_check).toBe("failed");
    expect(out.cards.length).toBeGreaterThan(0);
  });
});

describe("writing cards", () => {
  // @spec CARD-WRITE-001
  it("gives the card-writing call the card guide, which an overlay can replace", async () => {
    const s = await setup();
    await runCards(s.input);
    expect(s.calls.find((c) => c.name === "cards")!.prompt).toContain("# Card guide");
    const overlay = mkdtempSync(join(tmpdir(), "duet-ovl-"));
    mkdirSync(join(overlay, "guides"));
    writeFileSync(join(overlay, "guides", "card-guide.md"), "OVERLAY GUIDE");
    const o = await setup({}, DEFAULT_CONFIG, createAssetResolver(CORE_ASSETS, overlay));
    await runCards(o.input);
    expect(o.calls.find((c) => c.name === "cards")!.prompt).toContain("OVERLAY GUIDE");
  });

  // @spec CARD-WRITE-002, CARD-WRITE-003, CARD-WRITE-004, CARD-WRITE-005
  it("rejects cards over the word limits", () => {
    const words = (n: number) => Array(n).fill("w").join(" ");
    const b = withAnchorsAtHead({ schema_version: "1.0", ...OUT.briefing }, "b".repeat(40)) as unknown as Briefing;
    const base = assembleDeck([draft()], [], ctx(b))[0];
    const wrap = (c: Card) => ({ schema_version: "1.0", cards: [c], no_decisions_summary: "x", settled: [], fact_check: "complete", proposed_status: { status: "complete" } });
    expect(validate("cards", wrap(base), { briefing: b }).ok).toBe(true);
    expect(validate("cards", wrap({ ...base, question: words(31) }), { briefing: b }).ok).toBe(false);
    expect(validate("cards", wrap({ ...base, why_it_matters: words(61) }), { briefing: b }).ok).toBe(false);
    expect(validate("cards", wrap({ ...base, plain_technical: words(61) }), { briefing: b }).ok).toBe(false);
    expect(validate("cards", wrap({ ...base, options: base.options.map((o, i) => (i ? { ...o, summary: words(26) } : o)) }), { briefing: b }).ok).toBe(false);
  });

  // @spec CARD-WRITE-006, CARD-WRITE-007, CARD-WRITE-008, CARD-WRITE-009, CARD-WRITE-010, CARD-WRITE-011
  it("has a card guide that states each writing rule", () => {
    const guide = readFileSync(join(CORE_ASSETS, "guides", "card-guide.md"), "utf8");
    expect(guide).toMatch(/consequence for users, data, money, or on-call/);
    expect(guide).toMatch(/one decision, answerable by a capable engineer who does not specialize/);
    expect(guide).toMatch(/from everyday life/);
    expect(guide).toMatch(/same level of abstraction/);
    expect(guide).toMatch(/set `choice_ref` to that choice's id/);
    expect(guide).toMatch(/`public-interface`, `data-model`, and `compat-rollout` cards, always include consumers outside this repository/);
  });
});
