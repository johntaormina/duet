import type { ReviewSession } from "@duet/session";
import { type Anchor, type Card, type RunReader, type Stage, type StageEntry, STAGES } from "@duet/store";

export interface Placeholder {
  placeholder: true;
  stage: Stage;
  status: StageEntry["status"];
  detail?: string;
  error?: string;
}

export type RecView =
  | { kind: "hidden"; note: string }
  | { kind: "shown"; option: number; confidence: number; reasoning: string; whatWouldChangeMyMind: string }
  | { kind: "unavailable"; stage: string };

export interface CardView {
  id: string;
  stakes: "high" | "low";
  categories: string[];
  question: string;
  whyItMatters: string;
  plainTechnical: string;
  metaphor?: { text: string; breaksDownWhen: string };
  options: { index: number; summary: string; pros: string[]; cons: string[]; reversibility: string; isCurrent: boolean }[];
  anchors: Anchor[];
  choice?: { id: string; choice: string };
  flags: { claim: string; note: string }[];
  state: ReturnType<ReviewSession["state"]>;
  committed?: { option: number; rationale: string };
  recommendation: RecView;
  qa: { question: string; answer: string }[];
}

export interface ChoiceView {
  id: string;
  choice: string;
  alternative: string;
  tradeoff: string;
  rationale: { source: "stated" | "inferred" | "none"; label: string; text: string; quote?: string };
}

export interface PanelModel {
  title: string;
  stages: { name: Stage; status: StageEntry["status"]; detail?: string; error?: string }[];
  intent: { stated: string; observed: string; mismatches: { statement: string; kind: string }[] } | Placeholder;
  effort?: { score: number; minutes: number };
  choices: ChoiceView[] | Placeholder;
  settled: { decision: string; alternative: string; fixedBy: string }[];
  steps: { id: string; title: string; explanation: string; anchors: Anchor[]; cards: CardView[] }[] | Placeholder;
  deck: CardView[] | Placeholder;
  deckNotices: string[];
  banner?: string;
  noDecisionsSummary?: string;
}

export const SOURCE_LABELS = { stated: "Stated by the author", inferred: "Inferred by Claude", none: "No reason found" } as const;

export const SPLIT_BANNER = "This change holds more decisions than one review handles well; it may be worth splitting.";

function placeholder(stage: Stage, entry: StageEntry | undefined): Placeholder {
  return { placeholder: true, stage, status: entry?.status ?? "pending", detail: entry?.detail, error: entry?.error };
}

/**
 * Everything the review panel shows, built from run files and the review session. Recommendations
 * come only from the session, which applies blind-first.
 */
// @spec EXT-VIEW-001, EXT-VIEW-002, EXT-VIEW-003, EXT-VIEW-004, EXT-VIEW-005, EXT-VIEW-010, EXT-VIEW-011, EXT-VIEW-012, EXT-DECK-001, EXT-DECK-002, EXT-CMD-006
export function buildPanelModel(reader: RunReader, session: ReviewSession, reviewer: string): PanelModel {
  const run = reader.read("run");
  const stage = (s: Stage) => run?.stages[s];
  const complete = (s: Stage) => stage(s)?.status === "complete";
  const intent = complete("intent") ? reader.read("intent") : null;
  const briefing = complete("briefing") ? reader.read("briefing") : null;
  const cards = complete("cards") ? reader.read("cards") : null;
  const qa = reader.readQa(reviewer);

  const cardView = (c: Card): CardView => {
    const state = session.state(c.id);
    const answer = session.cards().length ? reader.answerFor(reader.readRecord(reviewer), c) : { status: "none" as const };
    const rec = session.recommendationFor(c.id);
    let recommendation: RecView;
    if (rec) recommendation = { kind: "shown", option: rec.option, confidence: rec.confidence, reasoning: rec.reasoning, whatWouldChangeMyMind: rec.what_would_change_my_mind };
    else if (c.stakes === "high" && (state === "open" || state === "stale")) recommendation = { kind: "hidden", note: "Claude's recommendation appears after you commit to your own answer." };
    else recommendation = { kind: "unavailable", stage: stage("recommendations")?.status ?? "pending" };
    const choice = c.choice_ref ? briefing?.choices.find((ch) => ch.id === c.choice_ref) : undefined;
    return {
      id: c.id,
      stakes: c.stakes,
      categories: c.categories ?? [],
      question: c.question,
      whyItMatters: c.why_it_matters,
      plainTechnical: c.plain_technical,
      metaphor: c.metaphor ? { text: c.metaphor, breaksDownWhen: c.analogy_breaks_down_when ?? "" } : undefined,
      options: c.options.map((o, index) => ({ index, summary: o.summary, pros: o.pros, cons: o.cons, reversibility: o.reversibility, isCurrent: o.is_current })),
      anchors: c.anchors,
      choice: choice ? { id: choice.id, choice: choice.choice } : undefined,
      flags: c.flags,
      state,
      committed: answer.status === "current" ? { option: answer.answer.chosen_option, rationale: answer.answer.rationale } : undefined,
      recommendation,
      qa: qa.filter((q) => q.card_id === c.id).map((q) => ({ question: q.question, answer: q.answer })),
    };
  };

  const deck = cards ? cards.cards.map(cardView) : null;
  const deckNotices: string[] = [];
  if (cards?.fact_check === "timed_out") deckNotices.push("The fact check timed out: these cards' claims were not checked against the code.");
  if (cards?.fact_check === "failed") deckNotices.push("The fact check failed: these cards' claims were not checked against the code.");
  if (cards?.proposed_status.status === "failed") deckNotices.push(cards.proposed_status.note ?? "Claude's own proposed decisions could not be vetted and are left out.");

  return {
    title: run?.title ?? "Review",
    stages: STAGES.map((s) => ({ name: s, status: stage(s)?.status ?? "pending", detail: stage(s)?.detail, error: stage(s)?.error })),
    intent: intent ? { stated: intent.stated, observed: intent.observed, mismatches: intent.mismatches.map((m) => ({ statement: m.statement, kind: m.kind })) } : placeholder("intent", stage("intent")),
    effort: briefing ? { score: briefing.effort.score, minutes: briefing.effort.minutes } : undefined,
    choices: briefing
      ? briefing.choices.map((c) => ({
          id: c.id,
          choice: c.choice,
          alternative: c.alternative,
          tradeoff: c.tradeoff,
          rationale: { source: c.rationale.source, label: SOURCE_LABELS[c.rationale.source], text: c.rationale.text, quote: c.rationale.source === "stated" ? c.rationale.quote : undefined },
        }))
      : placeholder("briefing", stage("briefing")),
    settled: (cards?.settled ?? []).map((s) => ({ decision: s.decision, alternative: s.alternative, fixedBy: s.fixed_by })),
    steps: briefing
      ? briefing.steps.map((s) => ({ id: s.id, title: s.title, explanation: s.explanation, anchors: s.anchors, cards: (deck ?? []).filter((c) => cards!.cards.find((x) => x.id === c.id)!.step_ref === s.id) }))
      : placeholder("briefing", stage("briefing")),
    deck: deck ?? placeholder("cards", stage("cards")),
    deckNotices,
    banner: deck && deck.length > 7 ? SPLIT_BANNER : undefined,
    noDecisionsSummary: cards?.no_decisions_summary,
  };
}
