import {
  type Anchor,
  type Briefing,
  type Card,
  type CardOption,
  type Cards,
  type ContextPack,
  type Intent,
  CARD_WORD_LIMITS,
  countWords,
  normalizeCode,
  SCHEMA_VERSION,
  sha256,
  validate,
} from "@duet/store";
import { callJson, type CallEnv } from "../call.ts";
import { CallTimeoutError } from "../claude.ts";
import { renderBriefing, renderIntent, renderPack } from "../render.ts";
import { defaultStakes, intentHits, loadTriggers, signalHits, type TriggerCategory, type TriggerHit } from "./triggers.ts";

/** A card as the card-writing call returns it, before code assigns identity and stakes. */
export interface DraftCard {
  source: "trigger" | "proposed";
  categories?: string[];
  assessed_stakes: "high" | "low";
  stakes_reason: string;
  question: string;
  why_it_matters: string;
  plain_technical: string;
  metaphor?: string;
  analogy_breaks_down_when?: string;
  options: CardOption[];
  alternative_and_consequence?: string;
  anchors: Omit<Anchor, "commit">[];
  step_ref: string;
  choice_ref?: string;
  basis: string[];
  not_examined: string[];
}

interface WriterOutput {
  hits: { category: string; file?: string; reason: string }[];
  cards: DraftCard[];
  no_decisions_summary: string;
}

export interface CardsInput {
  env: CallEnv;
  repo: string;
  base: string;
  head: string;
  pack: ContextPack;
  intent: Intent;
  briefing: Briefing;
  stakesOverrides: Record<string, "high" | "low">;
}

const MAX_DECK = 7;

/** Every hit must be covered by a trigger card whose categories include it and whose anchors include its file. */
// @spec CARD-TRIG-006, CARD-TRIG-007
export function uncoveredHits(hits: TriggerHit[], cards: DraftCard[]): TriggerHit[] {
  return hits.filter(
    (h) =>
      !cards.some(
        (c) => c.source === "trigger" && (c.categories ?? []).includes(h.category) && (h.file === undefined || c.anchors.some((a) => a.file === h.file)),
      ),
  );
}

function draftProblems(cards: DraftCard[], briefing: Briefing): string[] {
  const steps = new Set(briefing.steps.map((s) => s.id));
  const choices = new Set(briefing.choices.map((c) => c.id));
  const problems: string[] = [];
  cards.forEach((c, i) => {
    const at = `cards/${i}`;
    if (c.source !== "trigger" && c.source !== "proposed") problems.push(`${at}/source must be trigger or proposed`);
    if (c.source === "trigger" && !(c.categories ?? []).length) problems.push(`${at} is a trigger card with no categories`);
    if (c.source === "proposed" && !c.alternative_and_consequence) problems.push(`${at} is proposed but has no alternative_and_consequence`);
    if (!Array.isArray(c.options) || c.options.length < 2 || c.options.length > 4) problems.push(`${at} needs two to four options`);
    else if (c.options.filter((o) => o.is_current).length !== 1) problems.push(`${at} must mark exactly one option as what the code currently does`);
    if (!steps.has(c.step_ref)) problems.push(`${at}/step_ref ${c.step_ref} is not a briefing step`);
    if (c.choice_ref !== undefined && !choices.has(c.choice_ref)) problems.push(`${at}/choice_ref ${c.choice_ref} is not a briefing choice`);
    if (c.metaphor && !c.analogy_breaks_down_when) problems.push(`${at} has a metaphor without analogy_breaks_down_when`);
    if (countWords(c.question ?? "") > CARD_WORD_LIMITS.question) problems.push(`${at}/question exceeds ${CARD_WORD_LIMITS.question} words`);
    if (countWords(c.why_it_matters ?? "") > CARD_WORD_LIMITS.why_it_matters) problems.push(`${at}/why_it_matters exceeds ${CARD_WORD_LIMITS.why_it_matters} words`);
    if (countWords(c.plain_technical ?? "") > CARD_WORD_LIMITS.plain_technical) problems.push(`${at}/plain_technical exceeds ${CARD_WORD_LIMITS.plain_technical} words`);
    (c.options ?? []).forEach((o, j) => {
      if (countWords(o.summary ?? "") > CARD_WORD_LIMITS.option_summary) problems.push(`${at}/options/${j}/summary exceeds ${CARD_WORD_LIMITS.option_summary} words`);
    });
  });
  return problems;
}

/** Stable identity for a card across reruns. */
// @spec CARD-DECK-008
export function cardFingerprint(c: Pick<DraftCard, "source" | "categories" | "anchors">): string {
  const cats = c.source === "trigger" ? [...(c.categories ?? [])].sort().join(",") : "proposed";
  const files = [...new Set(c.anchors.map((a) => a.file))].sort().join(",");
  const locators = c.anchors.map((a) => a.pattern ?? normalizeCode(`${a.file}:${a.start_line ?? ""}`)).sort().join(",");
  return sha256([cats, files, locators].join("\0")).slice(0, 16);
}

const rank = (s: "high" | "low") => (s === "high" ? 0 : 1);

/** Turns vetted drafts into the deck: stakes, cap, order, ids, fingerprints. */
// @spec CARD-DECK-001, CARD-DECK-002, CARD-DECK-003, CARD-DECK-004, CARD-DECK-005, CARD-DECK-006, CARD-DECK-007
export function assembleDeck(
  triggerDrafts: DraftCard[],
  proposedDrafts: DraftCard[],
  ctx: { triggers: TriggerCategory[]; overrides: Record<string, "high" | "low">; briefing: Briefing; head: string },
): Card[] {
  const toCard = (d: DraftCard): Omit<Card, "id" | "order"> => {
    let stakes: "high" | "low" = d.assessed_stakes === "high" ? "high" : "low";
    let basis = d.stakes_reason;
    if (d.source === "trigger") {
      const defaults = (d.categories ?? []).map((c) => [c, defaultStakes(ctx.triggers, ctx.overrides, c)] as const);
      const highDefault = defaults.find(([, s]) => s === "high");
      if (highDefault && stakes !== "high") {
        stakes = "high";
        basis = `default stakes of category ${highDefault[0]}`;
      } else if (highDefault && stakes === "high") {
        basis = `default stakes of category ${highDefault[0]}`;
      }
    }
    const { assessed_stakes: _a, stakes_reason: _r, ...rest } = d;
    return {
      ...rest,
      categories: d.source === "trigger" ? d.categories : undefined,
      anchors: d.anchors.map((a) => ({ ...a, commit: ctx.head })),
      stakes,
      stakes_basis: basis,
      fingerprint: cardFingerprint(d),
      flags: [],
    };
  };
  const triggerCards = triggerDrafts.map(toCard);
  const room = Math.max(0, MAX_DECK - triggerCards.length);
  const proposed = proposedDrafts.map(toCard).sort((a, b) => rank(a.stakes) - rank(b.stakes)).slice(0, room);
  const stepIndex = new Map(ctx.briefing.steps.map((s, i) => [s.id, i]));
  const all = [...triggerCards, ...proposed].sort(
    (a, b) => (stepIndex.get(a.step_ref) ?? 0) - (stepIndex.get(b.step_ref) ?? 0) || rank(a.stakes) - rank(b.stakes),
  );
  const seen = new Map<string, number>();
  return all.map((c, i) => {
    const n = seen.get(c.fingerprint) ?? 0;
    seen.set(c.fingerprint, n + 1);
    const fingerprint = n === 0 ? c.fingerprint : `${c.fingerprint}-${n + 1}`;
    return { ...c, id: `D${i + 1}`, order: i, fingerprint } as Card;
  });
}

interface RefuterVerdict {
  index: number;
  verdict: "keep" | "reject" | "settled";
  reason: string;
  fixed_by?: string;
}

interface FactCheckOutput {
  cards: {
    index: number;
    corrections?: { plain_technical?: string; why_it_matters?: string; options?: { index: number; summary: string }[] };
    flags?: { claim: string; note: string }[];
  }[];
}

/** Applies fact-check corrections and flags without adding, dropping, or reclassifying cards. */
// @spec CARD-CHECK-002, CARD-CHECK-003, CARD-CHECK-004
export function applyFactCheck(cards: Card[], out: FactCheckOutput, briefing: Briefing): Card[] {
  return cards.map((card, i) => {
    const entry = (out.cards ?? []).find((c) => c.index === i);
    if (!entry) return card;
    let next: Card = { ...card, flags: [...card.flags, ...(entry.flags ?? []).filter((f) => f.claim && f.note)] };
    const tryApply = (claim: string, apply: (c: Card) => Card) => {
      const candidate = apply(next);
      const ok = validate("cards", { schema_version: SCHEMA_VERSION, cards: [candidate], no_decisions_summary: "x", settled: [], fact_check: "complete", proposed_status: { status: "complete" } }, { briefing }).ok;
      if (ok) next = candidate;
      else next = { ...next, flags: [...next.flags, { claim, note: "The fact check proposed a correction that could not be applied; treat this claim with care." }] };
    };
    const c = entry.corrections ?? {};
    if (c.plain_technical) tryApply(card.plain_technical, (x) => ({ ...x, plain_technical: c.plain_technical! }));
    if (c.why_it_matters) tryApply(card.why_it_matters, (x) => ({ ...x, why_it_matters: c.why_it_matters! }));
    for (const o of c.options ?? []) {
      if (!card.options[o.index]) continue;
      tryApply(card.options[o.index].summary, (x) => ({ ...x, options: x.options.map((opt, j) => (j === o.index ? { ...opt, summary: o.summary } : opt)) }));
    }
    // Identity, categories, stakes, and the set of cards are never taken from the fact check.
    return { ...next, id: card.id, order: card.order, fingerprint: card.fingerprint, categories: card.categories, stakes: card.stakes, source: card.source };
  });
}

/** The cards stage: floor triggers, vetted proposals, a bounded fact check. */
// @spec CARD-TRIG-005, CARD-TRIG-008, CARD-WRITE-001, CARD-DECK-009
export async function runCards(input: CardsInput): Promise<Cards> {
  const { env } = input;
  const triggers = loadTriggers(env.assets);
  const floor = [...signalHits(input.repo, input.base, input.head, triggers), ...intentHits(input.intent)];
  const guide = env.assets.read("guides/card-guide.md").replace(/^<!--[\s\S]*?-->\n?/, "");
  let claudeHits: TriggerHit[] = [];
  const { value: written } = await callJson<WriterOutput>(env, {
    prompt: "cards",
    branch: "human",
    vars: {
      context: renderPack(input.pack),
      intent: renderIntent(input.intent),
      briefing: renderBriefing(input.briefing),
      guide,
      triggers: triggers.map((t) => `- ${t.category} (${t.stakes}): ${t.description}`).join("\n"),
      required_hits: floor.map((h) => `- ${h.category}${h.file ? ` in ${h.file}` : ""}: ${h.reason}`).join("\n") || "(none)",
    },
    check: (out) => {
      if (!Array.isArray(out.cards) || typeof out.no_decisions_summary !== "string" || !out.no_decisions_summary.trim()) {
        return ["output must have cards (an array) and a non-empty no_decisions_summary"];
      }
      claudeHits = (out.hits ?? []).map((h) => ({ ...h, source: "claude" as const }));
      const problems = draftProblems(out.cards, input.briefing);
      for (const h of uncoveredHits([...floor, ...claudeHits], out.cards)) {
        problems.push(`trigger hit not covered by a trigger card: ${h.category}${h.file ? ` in ${h.file}` : ""} (${h.reason})`);
      }
      return problems;
    },
  });

  const triggerDrafts = written.cards.filter((c) => c.source === "trigger");
  let proposedDrafts = written.cards.filter((c) => c.source === "proposed");
  const settled: Cards["settled"] = [];
  let proposedStatus: Cards["proposed_status"] = { status: "complete" };

  // @spec CARD-PROP-001, CARD-PROP-002, CARD-PROP-003, CARD-PROP-004, CARD-PROP-005, CARD-PROP-006
  if (proposedDrafts.length) {
    try {
      const { value } = await callJson<{ verdicts: RefuterVerdict[] }>(env, {
        prompt: "refute-cards",
        branch: "human",
        vars: {
          context: renderPack(input.pack),
          briefing: renderBriefing(input.briefing),
          proposed: JSON.stringify(
            proposedDrafts.map((d, index) => ({ index, question: d.question, why_it_matters: d.why_it_matters, plain_technical: d.plain_technical, alternative_and_consequence: d.alternative_and_consequence, options: d.options.map((o) => o.summary) })),
            null,
            2,
          ),
        },
        check: (out) => (Array.isArray(out.verdicts) ? [] : ["output must have a verdicts array"]),
      });
      const verdict = (i: number) => value.verdicts.find((v) => v.index === i);
      for (const [i, d] of proposedDrafts.entries()) {
        const v = verdict(i);
        if (v?.verdict === "settled") settled.push({ decision: d.question, alternative: d.alternative_and_consequence ?? "", fixed_by: v.fixed_by || v.reason });
      }
      proposedDrafts = proposedDrafts.filter((_, i) => (verdict(i)?.verdict ?? "keep") === "keep");
    } catch (e) {
      proposedDrafts = [];
      proposedStatus = { status: "failed", note: `Claude's own proposed decisions could not be vetted and are left out: ${(e as Error).message}` };
    }
  }

  let cards = assembleDeck(triggerDrafts, proposedDrafts, { triggers, overrides: input.stakesOverrides, briefing: input.briefing, head: input.head });

  // @spec CARD-CHECK-001, CARD-CHECK-005, CARD-CHECK-006
  let factCheck: Cards["fact_check"] = "complete";
  if (cards.length) {
    try {
      const { value, truncated } = await callJson<FactCheckOutput>(
        { ...env, config: { ...env.config, stages: { ...env.config.stages, "fact-check": { timeoutSec: env.config.factCheckTimeoutSec, ...env.config.stages["fact-check"] } } } },
        {
          prompt: "fact-check",
          branch: "human",
          vars: {
            context: renderPack(input.pack),
            cards: JSON.stringify(cards.map((c, index) => ({ index, question: c.question, plain_technical: c.plain_technical, why_it_matters: c.why_it_matters, options: c.options.map((o, j) => ({ index: j, summary: o.summary, is_current: o.is_current })), anchors: c.anchors })), null, 2),
          },
          check: (out) => (Array.isArray(out.cards) ? [] : ["output must have a cards array"]),
        },
      );
      if (truncated) factCheck = "timed_out";
      else cards = applyFactCheck(cards, value, input.briefing);
    } catch (e) {
      factCheck = e instanceof CallTimeoutError ? "timed_out" : "failed";
    }
  }

  return {
    schema_version: SCHEMA_VERSION,
    cards,
    no_decisions_summary: written.no_decisions_summary,
    settled,
    fact_check: factCheck,
    proposed_status: proposedStatus,
  };
}
