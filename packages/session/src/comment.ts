import type { Anchor, Card, Finding, Intent, RunManifest, Stage } from "@duet/store";

/** One card as the review comment shows it. */
export interface CommentDecision {
  card: Card;
  answer?: { option: number; rationale: string; changed: boolean; agreed?: boolean };
}

export interface CommentInput {
  run: RunManifest;
  intent: Intent | null;
  decisions: CommentDecision[];
  /** Open findings offered to the reviewer, in file order. */
  findings: Finding[];
  /** Every finding in the run, for the count of those not included. */
  totalFindings: number;
  threshold: number;
  linkBase?: string;
}

/** GitHub's limit on one comment's length. */
export const COMMENT_LIMIT = 65_536;

const SEVERITIES = [
  ["critical", "🔴", "Critical"],
  ["high", "🟠", "High"],
  ["medium", "🟡", "Medium"],
  ["low", "🟢", "Low"],
  ["nit", "⚪", "Nit"],
] as const;
const CATEGORIES: [string, string][] = [
  ["bugs", "🐛 Bugs"],
  ["security", "🔒 Security"],
  ["tests", "🧪 Tests"],
  ["conventions", "📐 Conventions"],
];

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const splitCode = (s: string) => s.split(/(`[^`\n]+`)/);
const isCode = (part: string) => part.length > 1 && part.startsWith("`") && part.endsWith("`");
/** Run text inside an HTML element: escaped, with backtick spans kept as code. */
const inline = (s: string) => splitCode(s).map((p) => (isCode(p) ? `<code>${escHtml(p.slice(1, -1))}</code>` : escHtml(p))).join("");
/** Run text placed as markdown: angle brackets outside code spans escaped. */
const md = (s: string) => splitCode(s).map((p) => (isCode(p) ? p : p.replace(/</g, "&lt;").replace(/>/g, "&gt;"))).join("");

const lines = (a: Anchor) => {
  const start = a.start_line ?? 1;
  const end = a.end_line ?? start;
  return { start, end, label: end !== start ? `${start}-${end}` : `${start}` };
};

/** A full reference to an anchor: a permalink on its own line (which GitHub renders as the code), or `file:lines`. */
function ref(a: Anchor | undefined, input: CommentInput): string {
  if (!a) return "";
  const l = lines(a);
  if (!input.linkBase) return `\`${a.file}:${l.label}\``;
  return `${input.linkBase.replace(/\/+$/, "")}/blob/${input.run.head}/${a.file}#L${l.start}${l.end !== l.start ? `-L${l.end}` : ""}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function notComplete(run: RunManifest, stage: Stage): string | null {
  const st = run.stages[stage]?.status ?? "pending";
  return st === "complete" ? null : `The ${stage} stage is not complete (${st}${run.stages[stage]?.error ? `: ${md(run.stages[stage].error!)}` : ""}).`;
}

function decisionEntry(d: CommentDecision, n: number, input: CommentInput): string {
  const c = d.card;
  const a = d.answer;
  const verdict = a
    ? `→ ${inline(c.options[a.option]?.summary ?? String(a.option))}${a.agreed === undefined ? "" : ` <sub>(${a.agreed ? "✅ agreed with Claude" : "↔️ differed from Claude"})</sub>`}`
    : "⏳ <i>Not answered</i>";
  const out = [`<details>`, `<summary><b>${n}. ${inline(c.question)}</b><br>${verdict}</summary>`, "", ref(c.anchors[0], input), ""];
  out.push(`**What the code does:** ${md(c.plain_technical)}`, "", `**Why it matters:** ${md(c.why_it_matters)}`, "", "**Options:**");
  c.options.forEach((o, i) => out.push(a?.option === i ? `- **${md(o.summary)}** ← chosen` : `- ${md(o.summary)}`));
  out.push("");
  if (a?.rationale) out.push(`**Reviewer's reasoning:** ${md(a.rationale)}`, "");
  if (a?.changed) out.push("_Changed after commitment._", "");
  out.push("</details>", "");
  return out.join("\n");
}

function findingEntry(f: Finding, input: CommentInput, short: boolean): string {
  const sev = SEVERITIES.find((s) => s[0] === f.severity)!;
  const a = f.anchors[0];
  const where = a ? ` · <code>${escHtml(`${a.file.split("/").pop()}:${lines(a).label}`)}</code>` : "";
  const out = ["<details>", `<summary>${sev[1]} <b>${inline(f.title)}</b> · ${inline(f.category)}${where}</summary>`, ""];
  if (short) out.push("<i>Details left out to fit GitHub's comment size limit.</i>", "");
  else {
    out.push(ref(a, input), "", md(f.evidence), "");
    if (f.suggested_fix) out.push(`**Suggested fix:** ${md(f.suggested_fix)}`, "");
    out.push(`<sub>Confidence ${f.confidence} · ${f.verification.status === "confirmed" ? "confirmed by an independent verifier" : `verifier: ${f.verification.status}`}</sub>`, "");
  }
  out.push("</details>", "");
  return out.join("\n");
}

function machineReview(input: CommentInput, shortened: Set<Finding>, removed: Set<Finding>): string {
  const out = ["### 2 · Machine review", ""];
  const pending = notComplete(input.run, "findings");
  if (pending) return [...out, pending, ""].join("\n");
  const fs = input.findings;
  if (!fs.length) out.push(`No findings met the bar (verified, confidence ${input.threshold} or higher, still open).`, "");
  else {
    const sevs = SEVERITIES.filter((s) => s[0] !== "nit" || fs.some((f) => f.severity === "nit"));
    const cats = [...CATEGORIES, ...[...new Set(fs.map((f) => f.category))].filter((c) => !CATEGORIES.some(([k]) => k === c)).map((c) => [c, inline(c)] as [string, string])];
    out.push(`|  | ${sevs.map((s) => `${s[1]} ${s[2]}`).join(" | ")} |`, `|:--|${sevs.map(() => ":-:").join("|")}|`);
    for (const [key, label] of cats) out.push(`| ${label} | ${sevs.map((s) => fs.filter((f) => f.category === key && f.severity === s[0]).length || "·").join(" | ")} |`);
    out.push("");
    for (const [sev, em, label] of SEVERITIES) {
      const group = fs.filter((f) => f.severity === sev);
      if (!group.length) continue;
      out.push(`<details${sev === "critical" || sev === "high" ? " open" : ""}>`, `<summary><b>${em} ${label} (${group.length})</b></summary>`, "");
      for (const f of group) if (!removed.has(f)) out.push(findingEntry(f, input, shortened.has(f)));
      out.push("</details>", "");
    }
  }
  const others = input.totalFindings - fs.length;
  if (others > 0) out.push(`<sub>${plural(others, "other finding")} in this review ${others === 1 ? "is" : "are"} not included: below the confidence threshold, refuted, dismissed, or fixed.</sub>`, "");
  if (shortened.size || removed.size) {
    const parts = [shortened.size ? `${plural(shortened.size, "finding")} shortened` : "", removed.size ? `${plural(removed.size, "finding")} left out` : ""].filter(Boolean);
    out.push(`<sub>To fit GitHub's comment size limit, ${parts.join(" and ")}, lowest severity first. The full review is in Duet.</sub>`, "");
  }
  return out.join("\n");
}

/**
 * The review comment: summary, then the reviewer's decisions, then the machine review, written for
 * GitHub's renderer and kept within its comment size limit.
 */
export function renderReviewComment(input: CommentInput): string {
  const { run, intent, decisions } = input;
  const head = [`## Duet review · ${md(run.title)}`, ""];
  const intentPending = notComplete(run, "intent");
  if (intentPending || !intent) head.push(intentPending ?? "The intent stage is not complete.", "");
  else {
    head.push(md(intent.observed), "");
    if (intent.mismatches.length) head.push("> [!WARNING]", "> **Stated vs. actual**", ...intent.mismatches.map((m) => `> - ${md(m.statement)}`), "");
  }
  const answered = decisions.filter((d) => d.answer).length;
  const findingsPending = notComplete(run, "findings");
  head.push(`**Human layer:** ${answered}/${decisions.length} decisions answered · **Machine layer:** ${findingsPending ? "findings not complete" : plural(input.findings.length, "finding")}`, "");
  const incomplete = (Object.keys(run.stages) as Stage[]).filter((s) => run.stages[s].status !== "complete");
  if (incomplete.length) head.push("> [!NOTE]", `> Not complete when this was written: ${incomplete.map((s) => `${s} (${run.stages[s].status})`).join(", ")}.`, "");

  const dec = ["---", "### 1 · Decisions", ""];
  const cardsPending = notComplete(run, "cards");
  if (cardsPending) dec.push(cardsPending, "");
  else if (!decisions.length) dec.push("This change raised no decisions for the reviewer.", "");
  else {
    dec.push("Calls the reviewer made on questions the code alone can't settle. High-stakes answers were committed before seeing Claude's recommendation.", "");
    decisions.forEach((d, i) => dec.push(decisionEntry(d, i + 1, input)));
  }
  const footer = ["---", "<sub>Posted with the reviewer's approval of this exact text. Duet records decisions; it does not approve or block changes.</sub>"];

  const shortened = new Set<Finding>();
  const removed = new Set<Finding>();
  const render = () => [...head, ...dec, "---", machineReview(input, shortened, removed), ...footer].join("\n");
  // Lowest severity first; within a severity, the last finding first.
  const victims = SEVERITIES.flatMap(([sev]) => input.findings.filter((f) => f.severity === sev)).reverse();
  let text = render();
  for (const f of victims) {
    if (text.length <= COMMENT_LIMIT) break;
    shortened.add(f);
    text = render();
  }
  for (const f of victims) {
    if (text.length <= COMMENT_LIMIT) break;
    shortened.delete(f);
    removed.add(f);
    text = render();
  }
  return text;
}
