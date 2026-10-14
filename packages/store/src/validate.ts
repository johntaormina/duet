import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv, type ValidateFunction } from "ajv";
import { countWords } from "./hash.ts";
import type { Briefing, Cards, SchemaName } from "./types.ts";

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas");
const ajv = new Ajv({ allErrors: true, strict: false });
const compiled = new Map<SchemaName, ValidateFunction>();

function validator(name: SchemaName): ValidateFunction {
  let v = compiled.get(name);
  if (!v) {
    v = ajv.compile(JSON.parse(readFileSync(join(SCHEMA_DIR, `${name}.schema.json`), "utf8")));
    compiled.set(name, v);
  }
  return v;
}

export interface ValidationContext {
  /** The run's briefing, needed to check card references to steps and choices. */
  briefing?: Briefing | null;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/** Word limits on card text, enforced here because a schema cannot count words. */
export const CARD_WORD_LIMITS = { question: 30, why_it_matters: 60, plain_technical: 60, option_summary: 25 };

/**
 * Validates a run file against its JSON Schema and the checks a schema cannot express.
 */
// @spec ART-FILE-007, ART-FILE-009
export function validate(name: SchemaName, data: unknown, ctx: ValidationContext = {}): ValidationResult {
  const v = validator(name);
  const errors: string[] = [];
  if (!v(data)) {
    for (const e of v.errors ?? []) errors.push(`${e.instancePath || "/"} ${e.message}`);
    return { ok: false, errors };
  }
  if (name === "briefing") errors.push(...checkBriefing(data as Briefing));
  if (name === "cards") errors.push(...checkCards(data as Cards, ctx));
  return { ok: errors.length === 0, errors };
}

// @spec ART-BRIEF-008
function checkBriefing(b: Briefing): string[] {
  return b.choices[0]?.kind === "approach" ? [] : ["/choices/0 must describe the overall approach"];
}

// @spec ART-DECK-010, ART-DECK-012, ART-DECK-013
function checkCards(c: Cards, ctx: ValidationContext): string[] {
  const errors: string[] = [];
  const steps = new Set((ctx.briefing?.steps ?? []).map((s) => s.id));
  const choices = new Set((ctx.briefing?.choices ?? []).map((ch) => ch.id));
  c.cards.forEach((card, i) => {
    const at = `/cards/${i}`;
    if (card.options.filter((o) => o.is_current).length !== 1) errors.push(`${at}/options must mark exactly one option as current`);
    if (!steps.has(card.step_ref)) errors.push(`${at}/step_ref names no step in briefing.json`);
    if (card.choice_ref !== undefined && !choices.has(card.choice_ref)) errors.push(`${at}/choice_ref names no choice in briefing.json`);
    const limits: [string, string, number][] = [
      ["question", card.question, CARD_WORD_LIMITS.question],
      ["why_it_matters", card.why_it_matters, CARD_WORD_LIMITS.why_it_matters],
      ["plain_technical", card.plain_technical, CARD_WORD_LIMITS.plain_technical],
      ...card.options.map((o, j): [string, string, number] => [`options/${j}/summary`, o.summary, CARD_WORD_LIMITS.option_summary]),
    ];
    for (const [field, text, max] of limits) {
      if (countWords(text) > max) errors.push(`${at}/${field} exceeds ${max} words`);
    }
  });
  return errors;
}
