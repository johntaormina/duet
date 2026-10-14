import { type Briefing, type ContextPack, type Intent, SCHEMA_VERSION, validate } from "@duet/store";
import { callJson, type CallEnv } from "../call.ts";
import { renderIntent, renderPack } from "../render.ts";

function withAnchorsAtHead<T>(value: T, head: string): T {
  return JSON.parse(JSON.stringify(value), (k, v) =>
    v && typeof v === "object" && !Array.isArray(v) && typeof v.file === "string" && ("start_line" in v || "binary" in v) ? { ...v, commit: head } : v,
  );
}

export async function runIntent(env: CallEnv, pack: ContextPack, head: string): Promise<Intent> {
  const ids = new Set(pack.items.map((i) => i.id));
  const { value } = await callJson<Omit<Intent, "schema_version">>(env, {
    prompt: "intent",
    branch: "human",
    vars: { context: renderPack(pack) },
    check: (out) => {
      const full = withAnchorsAtHead({ schema_version: SCHEMA_VERSION, ...out }, head);
      const problems = validate("intent", full).errors;
      for (const s of out.sources ?? []) if (!ids.has(s)) problems.push(`sources names unknown context item ${s}`);
      return problems;
    },
  });
  return withAnchorsAtHead({ schema_version: SCHEMA_VERSION, ...value }, head);
}

/** Problems with `stated` rationales whose quote is not verbatim in the item they cite. */
// @spec PIPE-STG-008
export function checkStatedQuotes(b: Pick<Briefing, "choices">, pack: ContextPack): string[] {
  const byId = new Map(pack.items.map((i) => [i.id, i.content]));
  const problems: string[] = [];
  b.choices.forEach((c, i) => {
    if (c.rationale.source !== "stated") return;
    const item = c.rationale.item ? byId.get(c.rationale.item) : undefined;
    if (item === undefined) problems.push(`choices/${i} cites context item ${c.rationale.item}, which does not exist`);
    else if (!c.rationale.quote || !item.includes(c.rationale.quote)) {
      problems.push(`choices/${i} labels its rationale stated, but the quote does not appear verbatim in ${c.rationale.item}; quote exactly or label it inferred`);
    }
  });
  return problems;
}

/** Repairs omissions with one obvious fix, so a missing field does not cost a retry. */
function normalizeBriefing<T extends { choices?: { rationale?: { source?: string; text?: string; quote?: string } }[] }>(out: T): T {
  for (const c of out.choices ?? []) {
    if (c.rationale && typeof c.rationale.text !== "string") c.rationale.text = c.rationale.quote ?? "";
  }
  return out;
}

// @spec PIPE-STG-006, PIPE-STG-007
export async function runBriefing(env: CallEnv, pack: ContextPack, intent: Intent, head: string): Promise<Briefing> {
  const { value } = await callJson<Omit<Briefing, "schema_version">>(env, {
    prompt: "briefing",
    branch: "human",
    vars: { context: renderPack(pack), intent: renderIntent(intent) },
    check: (out) => {
      const full = withAnchorsAtHead({ schema_version: SCHEMA_VERSION, ...normalizeBriefing(out) }, head);
      const v = validate("briefing", full);
      return v.ok ? checkStatedQuotes(full, pack) : v.errors;
    },
  });
  return withAnchorsAtHead({ schema_version: SCHEMA_VERSION, ...normalizeBriefing(value) }, head);
}

export { withAnchorsAtHead };
