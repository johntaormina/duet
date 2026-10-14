import type { Card } from "@duet/store";

export interface TerminalLaunch {
  cwd: string;
  command: string;
  args: string[];
}

/**
 * Interactive Claude for one card, in the head worktree. While the reviewer may not yet see Claude's
 * recommendation, the prompt leaves it out and Claude is started with the run directory unreadable.
 */
// @spec EXT-ASK-002, EXT-ASK-003
export function terminalLaunch(card: Card, opts: { worktree: string; runDir: string; mayReveal: boolean; recommendationText?: string }): TerminalLaunch {
  const files = [...new Set(card.anchors.map((a) => (a.start_line ? `${a.file}:${a.start_line}-${a.end_line ?? a.start_line}` : a.file)))].join(", ");
  const lines = [
    `I am reviewing a change and deciding this question: "${card.question}"`,
    `Why it matters: ${card.why_it_matters}`,
    `What the code does: ${card.plain_technical}`,
    `Options: ${card.options.map((o, i) => `(${i}) ${o.summary}${o.is_current ? " [current code]" : ""}`).join("; ")}`,
    `The code involved is in: ${files}.`,
  ];
  if (opts.mayReveal && opts.recommendationText) lines.push(`I have already seen your recommendation: ${opts.recommendationText}`);
  else lines.push("I have not committed to an answer yet. Help me understand the code and the trade-offs, but do not tell me which option you would choose until I say I have committed.");
  const args: string[] = [];
  if (!opts.mayReveal) {
    const runDir = opts.runDir.replace(/^\/+/, "");
    args.push("--settings", JSON.stringify({ permissions: { deny: [`Read(//${runDir}/**)`] } }));
  }
  args.push(lines.join("\n"));
  return { cwd: opts.worktree, command: "claude", args };
}
