import { execFileSync } from "node:child_process";
import { type PostResult, type SignedPost, signPost } from "@duet/adapters";
import {
  type Answer,
  type Card,
  cardHash,
  type DecisionRecord,
  type Finding,
  type FindingStateValue,
  type Recommendation,
  SCHEMA_VERSION,
  sha256,
  STAGES,
  type Store,
  StoreError,
  upsertAnswer,
} from "@duet/store";

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}

export type CardState = "open" | "committed" | "revealed" | "stale";

export type RevealResult = { kind: "recommendation"; recommendation: Recommendation } | { kind: "unavailable"; stage: string };

export interface AskFn {
  (args: { cardId: string; question: string; mayReveal: boolean }): Promise<string>;
}

export interface SessionOptions {
  store: Store;
  runId: string;
  reviewer: string;
  ask: AskFn;
  confidenceThreshold?: number;
  now?: () => Date;
}

export type OfferedFinding = Finding & { state: FindingStateValue; cohort: string };

/** The reviewer's identity, filename-safe: the repository's git email unless overridden. */
// @spec SESS-ID-001, SESS-ID-002
export function reviewerIdentity(repoRoot: string, override?: string | null): string {
  let raw = override ?? "";
  if (!raw) {
    try {
      raw = execFileSync("git", ["config", "user.email"], { cwd: repoRoot, encoding: "utf8" }).trim();
    } catch {
      raw = "";
    }
  }
  const safe = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "reviewer";
}

/**
 * One reviewer working through one run. Interfaces draw; the session decides what may be shown and
 * records what happened. Blind-first is enforced here so every interface gets it.
 */
export class ReviewSession {
  private store: Store;
  private runId: string;
  readonly reviewer: string;
  private askFn: AskFn;
  private threshold: number;
  private now: () => Date;
  /** Low-stakes cards whose recommendation has been shown before commitment, with when. */
  private shownEarly = new Map<string, string>();

  constructor(opts: SessionOptions) {
    this.store = opts.store;
    this.runId = opts.runId;
    this.reviewer = opts.reviewer;
    this.askFn = opts.ask;
    this.threshold = opts.confidenceThreshold ?? 80;
    this.now = opts.now ?? (() => new Date());
  }

  private get reader() {
    return this.store.reader(this.runId);
  }

  private iso() {
    return this.now().toISOString();
  }

  cards(): Card[] {
    return this.reader.read("cards")?.cards ?? [];
  }

  private card(cardId: string): Card {
    const c = this.cards().find((x) => x.id === cardId);
    if (!c) throw new SessionError(`no card ${cardId} in this run`);
    return c;
  }

  // @spec SESS-REC-008
  private record(): DecisionRecord {
    let rec: DecisionRecord | null;
    try {
      rec = this.reader.readRecord(this.reviewer);
    } catch (e) {
      throw new SessionError(`${(e as Error).message}. The record must be repaired or moved aside before this review can continue.`);
    }
    return rec ?? { schema_version: SCHEMA_VERSION, run_id: this.runId, reviewer: this.reviewer, started_at: this.iso(), ended_at: null, incomplete_stages: [], answers: [], posted: [] };
  }

  // @spec SESS-REC-001, SESS-REC-008
  private save(rec: DecisionRecord): void {
    try {
      this.store.session(this.runId, this.reviewer).writeRecord(rec);
    } catch (e) {
      throw new SessionError(e instanceof StoreError ? e.message : String(e));
    }
  }

  private currentAnswer(card: Card): { status: "none" } | { status: "current" | "stale"; answer: Answer } {
    return this.reader.answerFor(this.record(), card);
  }

  /** `revealed` means Claude's recommendation has been shown for the current answer. */
  // @spec SESS-STATE-001, SESS-STATE-011
  state(cardId: string): CardState {
    const a = this.currentAnswer(this.card(cardId));
    if (a.status === "none") return "open";
    if (a.status === "stale") return "stale";
    return a.answer.revealed_at ? "revealed" : "committed";
  }

  /** The recommendation, when the reviewer may see it; null otherwise. */
  // @spec SESS-STATE-005, SESS-STATE-008, SESS-STATE-009
  recommendationFor(cardId: string): Recommendation | null {
    const card = this.card(cardId);
    const rec = this.reader.getRecommendation(card);
    if (!rec) return null;
    if (card.stakes === "low") {
      if (this.currentAnswer(card).status !== "current" && !this.shownEarly.has(cardId)) this.shownEarly.set(cardId, this.iso());
      return rec;
    }
    const a = this.currentAnswer(card);
    return a.status === "current" && a.answer.revealed_at ? rec : null;
  }

  canCommit(cardId: string, option: number | undefined, rationale: string): { ok: true } | { ok: false; reason: string } {
    const card = this.card(cardId);
    if (option === undefined || option === null || !Number.isInteger(option)) return { ok: false, reason: "choose an option" };
    if (option < 0 || option >= card.options.length) return { ok: false, reason: `option ${option} does not exist on this card` };
    if (card.stakes === "high" && !rationale.trim()) return { ok: false, reason: "a high-stakes card needs a rationale; any words of your own will do" };
    return { ok: true };
  }

  /** Commits the reviewer's own answer, before they see Claude's for a high-stakes card. */
  // @spec SESS-STATE-002, SESS-STATE-003, SESS-STATE-004, SESS-STATE-012, SESS-STATE-013
  commit(cardId: string, option: number, rationale: string): void {
    const check = this.canCommit(cardId, option, rationale);
    if (!check.ok) throw new SessionError(check.reason);
    const card = this.card(cardId);
    const at = this.iso();
    const existing = this.currentAnswer(card);
    if (existing.status === "current") throw new SessionError("this card is already committed; change the option with a reason instead");
    let revealed_at: string | null = null;
    let agreed: boolean | null = null;
    if (card.stakes === "low") {
      const rec = this.reader.getRecommendation(card);
      revealed_at = this.shownEarly.get(cardId) ?? null;
      agreed = rec ? rec.option === option : null;
    }
    const answer: Answer = { card_id: card.id, fingerprint: card.fingerprint, card_hash: cardHash(card), chosen_option: option, rationale, committed_at: at, revealed_at, agreed_with_ai: agreed, changes: [] };
    this.save(upsertAnswer(this.record(), answer));
  }

  /** Shows Claude's recommendation for a committed card, or says why it cannot yet. */
  // @spec SESS-STATE-006, SESS-STATE-007
  reveal(cardId: string): RevealResult {
    const card = this.card(cardId);
    const a = this.currentAnswer(card);
    if (a.status !== "current") throw new SessionError("commit to an option before revealing Claude's recommendation");
    const rec = this.reader.getRecommendation(card);
    if (!rec) {
      return { kind: "unavailable", stage: this.reader.read("run")?.stages.recommendations.status ?? "pending" };
    }
    const rec0 = this.record();
    const i = rec0.answers.findIndex((x) => x.fingerprint === card.fingerprint);
    const ans = rec0.answers[i];
    if (!ans.revealed_at) {
      // Agreement compares the recommendation with the option held at the moment it is first seen.
      const agreed_with_ai = ans.agreed_with_ai ?? rec.option === ans.chosen_option;
      rec0.answers[i] = { ...ans, revealed_at: this.iso(), agreed_with_ai };
      this.save(rec0);
    }
    return { kind: "recommendation", recommendation: rec };
  }

  // @spec SESS-STATE-010
  changeOption(cardId: string, option: number, reason: string): void {
    const card = this.card(cardId);
    const a = this.currentAnswer(card);
    if (a.status !== "current") throw new SessionError("only a committed card's option can be changed");
    if (!reason.trim()) throw new SessionError("changing a committed option needs a reason");
    if (option < 0 || option >= card.options.length) throw new SessionError(`option ${option} does not exist on this card`);
    const rec = this.record();
    const i = rec.answers.findIndex((x) => x.fingerprint === card.fingerprint);
    const ans = rec.answers[i];
    if (ans.chosen_option === option) return;
    rec.answers[i] = { ...ans, chosen_option: option, changes: [...ans.changes, { from: ans.chosen_option, to: option, reason, at: this.iso() }] };
    this.save(rec);
  }

  private mayReveal(card: Card): boolean {
    const a = this.currentAnswer(card);
    if (card.stakes === "low") return this.shownEarly.has(card.id) || (a.status === "current" && a.answer.revealed_at !== null);
    return a.status === "current" && a.answer.revealed_at !== null;
  }

  // @spec SESS-ASK-001, SESS-ASK-002
  async ask(cardId: string, question: string): Promise<string> {
    const card = this.card(cardId);
    const answer = await this.askFn({ cardId, question, mayReveal: this.mayReveal(card) });
    const committed = this.currentAnswer(card).status === "current";
    try {
      this.store.session(this.runId, this.reviewer).appendQa({ card_id: cardId, asked_at: this.iso(), question, answer, committed });
    } catch (e) {
      throw new SessionError((e as Error).message);
    }
    return answer;
  }

  // @spec SESS-ASK-003
  questionsBeforeCommit(cardId: string): number {
    return this.reader.readQa(this.reviewer).filter((q) => q.card_id === cardId && !q.committed).length;
  }

  // @spec SESS-FIND-001, SESS-FIND-003
  findings(): OfferedFinding[] {
    const cohorts = this.reader.read("briefing")?.cohorts ?? [];
    return this.reader
      .findingsFor(this.reviewer)
      .filter((f) => f.verification.status !== "refuted" && f.confidence >= this.threshold)
      .map((f) => ({ ...f, cohort: cohorts.find((c) => c.files.includes(f.anchors[0]?.file))?.title ?? "other" }));
  }

  // @spec SESS-FIND-002
  setFindingState(fingerprint: string, state: FindingStateValue): void {
    const current = this.reader.readFindingState(this.reviewer)?.states ?? [];
    const states = [...current.filter((s) => s.fingerprint !== fingerprint), { fingerprint, state }];
    this.store.session(this.runId, this.reviewer).writeFindingState({ schema_version: SCHEMA_VERSION, states });
  }

  // @spec SESS-REC-002, SESS-REC-003
  end(): DecisionRecord {
    const run = this.reader.read("run");
    const rec = { ...this.record(), ended_at: this.iso(), incomplete_stages: STAGES.filter((s) => run?.stages[s].status !== "complete") };
    this.save(rec);
    return rec;
  }

  // @spec SESS-REC-004, SESS-REC-005
  decisionLog(): string {
    const rec = this.record();
    const cards = this.cards();
    const run = this.reader.read("run");
    const lines = ["## Duet decision log", ""];
    const answered = cards.map((c) => ({ c, a: this.reader.answerFor(rec, c) })).filter((x) => x.a.status === "current");
    for (const { c, a } of answered) {
      if (a.status === "none") continue;
      const ans = a.answer;
      const recm = this.reader.getRecommendation(c);
      lines.push(`### ${c.question}`, "");
      lines.push(`- Chose: ${c.options[ans.chosen_option]?.summary ?? ans.chosen_option}`);
      if (ans.rationale) lines.push(`- Rationale: ${ans.rationale}`);
      lines.push(`- Matched Claude's recommendation: ${recm ? (recm.option === ans.chosen_option ? "yes" : "no") : "not available"}`);
      lines.push(`- Changed after commitment: ${ans.changes.length ? "yes" : "no"}`, "");
    }
    const unanswered = cards.filter((c) => this.reader.answerFor(rec, c).status !== "current");
    if (unanswered.length) lines.push("### Unanswered", "", ...unanswered.map((c) => `- ${c.question}`), "");
    const incomplete = STAGES.filter((s) => run?.stages[s].status !== "complete");
    if (incomplete.length) lines.push("### Incomplete stages", "", ...incomplete.map((s) => `- ${s}: ${run?.stages[s].status ?? "unknown"}`), "");
    return lines.join("\n");
  }

  // @spec SESS-REC-006
  signPost(target: string, text: string): SignedPost {
    return signPost({ target, text, signedOffAt: this.iso() });
  }

  // @spec SESS-REC-007
  recordPost(signed: SignedPost, result: PostResult): void {
    if (!result.ok || !result.postedAt) return;
    const rec = this.record();
    this.save({ ...rec, posted: [...rec.posted, { target: signed.target, text_hash: sha256(signed.text), signed_off_at: signed.signedOffAt, posted_at: result.postedAt }] });
  }
}
