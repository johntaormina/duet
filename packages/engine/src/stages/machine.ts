import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Anchor,
  type Briefing,
  type Card,
  type Cards,
  type ContextPack,
  type Finding,
  type Findings,
  type Recommendation,
  cardHash,
  findingFingerprint,
  SCHEMA_VERSION,
  validate,
} from "@duet/store";
import { callJson, type CallEnv } from "../call.ts";
import { loadPrompt } from "../prompts.ts";
import { renderBriefing, renderCard, renderPack } from "../render.ts";

export const SPECIALISTS = ["bugs", "security", "tests", "conventions"] as const;

interface SpecialistFinding {
  category: string;
  severity: Finding["severity"];
  title: string;
  anchors: Omit<Anchor, "commit">[];
  evidence: string;
  suggested_fix?: string;
}

interface Merged extends SpecialistFinding {
  found_by: string[];
  fingerprint: string;
  anchors: Anchor[];
}

function anchoredCode(worktree: string, a: Omit<Anchor, "commit">): string {
  const p = join(worktree, a.file);
  if (!existsSync(p) || !a.start_line) return "";
  return readFileSync(p, "utf8").split("\n").slice(a.start_line - 1, a.end_line ?? a.start_line).join("\n");
}

/** Merges specialist output and removes duplicates that share a fingerprint. */
// @spec PIPE-MACH-005
export function mergeFindings(perSpecialist: { name: string; findings: SpecialistFinding[] }[], worktree: string, head: string): Merged[] {
  const byFp = new Map<string, Merged>();
  for (const { name, findings } of perSpecialist) {
    for (const f of findings) {
      const first = f.anchors[0];
      if (!first) continue;
      const fingerprint = findingFingerprint({ file: first.file, pattern: first.pattern, code: anchoredCode(worktree, first), category: f.category });
      const existing = byFp.get(fingerprint);
      if (existing) existing.found_by = [...new Set([...existing.found_by, name])];
      else byFp.set(fingerprint, { ...f, anchors: f.anchors.map((a) => ({ ...a, commit: head })), found_by: [name], fingerprint });
    }
  }
  return [...byFp.values()];
}

interface Verdict {
  index: number;
  status: "confirmed" | "refuted" | "uncertain";
  confidence: number;
  notes: string;
  related_cards?: string[];
}

export interface MachineInput {
  env: CallEnv;
  pack: ContextPack;
  /** Resolves when the cards stage has finished: its cards when complete, null when failed. */
  cardsDone: Promise<Cards | null>;
  files: string[];
  head: string;
}

/**
 * Specialists in parallel, then a verifier in a fresh context that sees claims and evidence but not
 * the specialists' reasoning. Findings are produced only after verification.
 */
// @spec PIPE-MACH-001, PIPE-MACH-002, PIPE-MACH-003, PIPE-MACH-004, PIPE-MACH-006, PIPE-MACH-007, PIPE-MACH-008, PIPE-MACH-009, PIPE-MACH-010, PIPE-STG-002, PIPE-STG-003
export async function runMachine(input: MachineInput): Promise<Findings> {
  const { env } = input;
  const notExamined: string[] = [];
  const results = await Promise.all(
    SPECIALISTS.map(async (name) => {
      const { value, truncated } = await callJson<{ findings: SpecialistFinding[]; not_examined?: string[] }>(env, {
        prompt: `specialist-${name}`,
        branch: "machine",
        vars: { context: renderPack(input.pack) },
        check: (out) => (Array.isArray(out.findings) ? [] : ["output must have a findings array"]),
      });
      notExamined.push(...(value.not_examined ?? []).map((n) => `${name}: ${n}`));
      if (truncated) notExamined.push(`${name}: stopped at its exploration budget before finishing`);
      return { name, findings: value.findings };
    }),
  );
  const merged = mergeFindings(results, env.cwd, input.head);
  const cards = await input.cardsDone;
  const cardList = cards?.cards ?? [];
  const { value } = await callJson<{ verdicts: Verdict[] }>(env, {
    prompt: "verifier",
    branch: "machine",
    vars: {
      context: renderPack(input.pack),
      cards: cards ? JSON.stringify(cardList.map((c) => ({ id: c.id, question: c.question, anchors: c.anchors.map((a) => a.file) })), null, 2) : "(the decision cards are not available; set related_cards to [])",
      claims: JSON.stringify(merged.map((f, index) => ({ index, category: f.category, title: f.title, evidence: f.evidence, anchors: f.anchors.map((a) => `${a.file}:${a.start_line ?? ""}-${a.end_line ?? ""}`) })), null, 2),
    },
    check: (out) => {
      if (!Array.isArray(out.verdicts)) return ["output must have a verdicts array"];
      const missing = merged.map((_, i) => i).filter((i) => !out.verdicts.some((v) => v.index === i));
      return missing.length ? [`no verdict for findings ${missing.join(", ")}`] : [];
    },
  });
  const cardIds = new Set(cardList.map((c) => c.id));
  const findings: Finding[] = merged.map((f, i) => {
    const v = value.verdicts.find((x) => x.index === i)!;
    return {
      id: `F${i + 1}`,
      category: f.category,
      severity: f.severity,
      confidence: Math.max(0, Math.min(100, v.confidence)),
      title: f.title,
      anchors: f.anchors,
      evidence: f.evidence,
      ...(f.suggested_fix ? { suggested_fix: f.suggested_fix } : {}),
      found_by: f.found_by,
      related_cards: cards ? (v.related_cards ?? []).filter((id) => cardIds.has(id)) : [],
      verification: { status: v.status, by: "verifier", notes: v.notes ?? "" },
      fingerprint: f.fingerprint,
    };
  });
  const settings = loadPrompt(env.assets, "specialist-bugs", env.config).settings;
  return {
    schema_version: SCHEMA_VERSION,
    findings,
    coverage: { reviewed: input.files, skipped: input.pack.excluded.map((e) => `${e.source}: ${e.reason}`) },
    exploration: {
      context_gathered: `context pack of ${input.pack.items.length} items, plus read-only exploration of the head commit`,
      budget: `${settings.maxTurns ?? "unlimited"} turns and ${settings.timeoutSec}s per specialist`,
      not_examined: notExamined,
    },
  };
}

/** One fresh call per card, each written as soon as it is produced. */
// @spec PIPE-LEAN-001, PIPE-LEAN-002
export async function runRecommendations(
  env: CallEnv,
  pack: ContextPack,
  briefing: Briefing,
  cards: Card[],
  write: (entries: Recommendation[]) => void,
): Promise<Recommendation[]> {
  const entries: Recommendation[] = [];
  await Promise.all(
    cards.map(async (card) => {
      const { value } = await callJson<Omit<Recommendation, "card_id" | "card_hash">>(env, {
        prompt: "recommendation",
        branch: "human",
        vars: { context: renderPack(pack), briefing: renderBriefing(briefing), card: renderCard(card) },
        check: (out) => {
          const entry = { ...out, card_id: card.id, card_hash: "x" };
          const problems = validate("recommendations", { schema_version: SCHEMA_VERSION, entries: [entry] }).errors;
          if (!(out.option >= 0 && out.option < card.options.length)) problems.push(`option must be an index from 0 to ${card.options.length - 1}`);
          return problems;
        },
      });
      entries.push({ card_id: card.id, option: value.option, confidence: value.confidence, reasoning: value.reasoning, what_would_change_my_mind: value.what_would_change_my_mind, card_hash: cardHash(card) });
      write([...entries].sort((a, b) => a.card_id.localeCompare(b.card_id, undefined, { numeric: true })));
    }),
  );
  return entries;
}
