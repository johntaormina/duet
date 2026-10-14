import type { Briefing, Card, ContextPack, Intent } from "@duet/store";

/** The context pack as prompt text, each item labelled with the id Claude cites it by. */
export function renderPack(pack: ContextPack): string {
  const items = pack.items.map((i) => `### [${i.id}] ${i.kind}: ${i.source}\n${i.content}`).join("\n\n");
  const excluded = pack.excluded.length
    ? `\n\n### Not included\n${pack.excluded.map((e) => `- ${e.kind} ${e.source}: ${e.reason}`).join("\n")}`
    : "";
  return items + excluded;
}

export const renderIntent = (i: Intent) => JSON.stringify({ stated: i.stated, observed: i.observed, mismatches: i.mismatches }, null, 2);

export const renderBriefing = (b: Briefing) =>
  JSON.stringify({ cohorts: b.cohorts, steps: b.steps.map(({ id, title, explanation }) => ({ id, title, explanation })), choices: b.choices }, null, 2);

/** A card as Claude sees it in later calls: content only, no ids it could leak or anchors it need not repeat. */
export const renderCard = (c: Card) =>
  JSON.stringify(
    {
      question: c.question,
      why_it_matters: c.why_it_matters,
      plain_technical: c.plain_technical,
      options: c.options.map((o, i) => ({ index: i, ...o })),
      anchors: c.anchors.map((a) => `${a.file}${a.start_line ? `:${a.start_line}-${a.end_line}` : ""}`),
    },
    null,
    2,
  );
