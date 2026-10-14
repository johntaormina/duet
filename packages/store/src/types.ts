export const STAGES = ["context", "intent", "briefing", "cards", "recommendations", "findings"] as const;
export type Stage = (typeof STAGES)[number];
export type StageStatus = "pending" | "running" | "complete" | "failed";

export interface StageEntry {
  status: StageStatus;
  started_at: string | null;
  finished_at: string | null;
  cache_key: string | null;
  error?: string;
  detail?: string;
}

export interface RunManifest {
  schema_version: string;
  run_id: string;
  base: string;
  head: string;
  title: string;
  stages: Record<Stage, StageEntry>;
}

export interface Anchor {
  file: string;
  commit: string;
  start_line?: number;
  end_line?: number;
  pattern?: string;
  binary?: boolean;
}

export const CONTEXT_KINDS = [
  "diff",
  "author-statement",
  "intent-source",
  "commit-message",
  "history",
  "linked-doc",
  "changed-file",
  "file-outline",
  "summarized-file",
  "project-doc",
  "codeowners",
  "tool-output",
  "caller",
] as const;
export type ContextKind = (typeof CONTEXT_KINDS)[number];

export interface ContextItem {
  id: string;
  kind: ContextKind;
  source: string;
  size: number;
  content: string;
}

export interface ContextPack {
  schema_version: string;
  budget: number;
  items: ContextItem[];
  excluded: { kind: ContextKind; source: string; reason: string }[];
}

export interface Intent {
  schema_version: string;
  stated: string;
  sources: string[];
  observed: string;
  mismatches: { statement: string; anchors: Anchor[]; kind: "contradiction" | "unstated" }[];
}

export interface Rationale {
  source: "stated" | "inferred" | "none";
  text: string;
  quote?: string;
  item?: string;
}

export interface Choice {
  id: string;
  kind: "approach" | "choice";
  choice: string;
  alternative: string;
  tradeoff: string;
  rationale: Rationale;
  anchors: Anchor[];
  step_ref: string;
}

export interface Briefing {
  schema_version: string;
  effort: { score: number; minutes: number; drivers: string[] };
  coverage: { reviewed: string[]; skipped: { path: string; reason: string }[] };
  cohorts: { id: string; title: string; summary: string; files: string[]; depends_on: string[] }[];
  steps: { id: string; title: string; explanation: string; anchors: Anchor[] }[];
  choices: Choice[];
}

export interface CardOption {
  summary: string;
  pros: string[];
  cons: string[];
  reversibility: string;
  is_current: boolean;
}

export interface Card {
  id: string;
  order: number;
  fingerprint: string;
  source: "trigger" | "proposed";
  categories?: string[];
  stakes: "high" | "low";
  stakes_basis: string;
  question: string;
  why_it_matters: string;
  plain_technical: string;
  metaphor?: string;
  analogy_breaks_down_when?: string;
  options: CardOption[];
  alternative_and_consequence?: string;
  anchors: Anchor[];
  step_ref: string;
  choice_ref?: string;
  basis: string[];
  not_examined: string[];
  flags: { claim: string; note: string }[];
}

export interface Cards {
  schema_version: string;
  cards: Card[];
  no_decisions_summary: string;
  settled: { decision: string; alternative: string; fixed_by: string }[];
  fact_check: "complete" | "timed_out" | "failed";
  proposed_status: { status: "complete" | "failed"; note?: string };
}

export interface Recommendation {
  card_id: string;
  option: number;
  confidence: number;
  reasoning: string;
  what_would_change_my_mind: string;
  card_hash: string;
}

export interface Recommendations {
  schema_version: string;
  entries: Recommendation[];
}

export interface Finding {
  id: string;
  category: string;
  severity: "critical" | "high" | "medium" | "low" | "nit";
  confidence: number;
  title: string;
  anchors: Anchor[];
  evidence: string;
  suggested_fix?: string;
  found_by: string[];
  related_cards: string[];
  verification: { status: "confirmed" | "refuted" | "uncertain"; by: string; notes: string };
  fingerprint: string;
}

export interface Findings {
  schema_version: string;
  findings: Finding[];
  coverage: { reviewed: string[]; skipped: string[] };
  exploration: { context_gathered: string; budget: string; not_examined: string[] };
}

export type FindingStateValue = "open" | "dismissed" | "fixed";

export interface FindingState {
  schema_version: string;
  states: { fingerprint: string; state: FindingStateValue }[];
}

export interface QaEntry {
  card_id: string;
  asked_at: string;
  question: string;
  answer: string;
  committed: boolean;
}

export interface Answer {
  card_id: string;
  fingerprint: string;
  card_hash: string;
  chosen_option: number;
  rationale: string;
  committed_at: string;
  revealed_at: string | null;
  agreed_with_ai: boolean | null;
  changes: { from: number; to: number; reason: string; at: string }[];
  previous?: Omit<Answer, "previous">[];
}

export interface DecisionRecord {
  schema_version: string;
  run_id: string;
  reviewer: string;
  started_at: string;
  ended_at: string | null;
  incomplete_stages: string[];
  answers: Answer[];
  posted: { target: string; text_hash: string; signed_off_at: string; posted_at: string }[];
}

/** Files written by the pipeline, keyed by their name without extension. */
export interface PipelineFiles {
  run: RunManifest;
  "context-pack": ContextPack;
  intent: Intent;
  briefing: Briefing;
  cards: Cards;
  recommendations: Recommendations;
  findings: Findings;
}
export type PipelineFile = keyof PipelineFiles;

export const PIPELINE_FILES: PipelineFile[] = [
  "run",
  "context-pack",
  "intent",
  "briefing",
  "cards",
  "recommendations",
  "findings",
];

/** The stage whose output each pipeline file is. */
export const FILE_STAGE: Partial<Record<PipelineFile, Stage>> = {
  "context-pack": "context",
  intent: "intent",
  briefing: "briefing",
  cards: "cards",
  recommendations: "recommendations",
  findings: "findings",
};

export type SchemaName = PipelineFile | "record" | "finding-state" | "qa-entry";

export const SCHEMA_VERSION = "1.0";
export const SUPPORTED_MAJOR = 1;
