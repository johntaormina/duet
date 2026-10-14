import type { Briefing } from "./types.ts";

const SOURCE_LABEL = { stated: "stated by the author", inferred: "inferred by Claude", none: "no reason found" } as const;

/** Renders a briefing as markdown for reading without an interface. Pure: returns text only. */
// @spec ART-FILE-012
export function renderBriefingMarkdown(b: Briefing): string {
  const lines: string[] = [];
  lines.push(`# Briefing`, "", `Effort ${b.effort.score}/5 (~${b.effort.minutes} min): ${b.effort.drivers.join(", ")}`, "");
  lines.push("## Choices this change made", "");
  for (const c of b.choices) {
    const why = c.rationale.source === "stated" ? `"${c.rationale.quote}"` : c.rationale.text;
    lines.push(`- **${c.choice}** over ${c.alternative}. Trade-off: ${c.tradeoff}. Why (${SOURCE_LABEL[c.rationale.source]}): ${why}`);
  }
  lines.push("", "## Walkthrough", "");
  b.steps.forEach((s, i) => lines.push(`### ${i + 1}. ${s.title}`, "", s.explanation, ""));
  if (b.coverage.skipped.length) {
    lines.push("## Not reviewed", "", ...b.coverage.skipped.map((s) => `- ${s.path}: ${s.reason}`), "");
  }
  return lines.join("\n");
}
