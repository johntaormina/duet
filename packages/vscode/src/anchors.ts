import type { Anchor } from "@duet/store";

/**
 * Where an anchor's code is now: its recorded lines if they still match its pattern, otherwise the
 * first place the pattern matches, otherwise the recorded lines.
 */
// @spec EXT-VIEW-009
export function locateAnchor(text: string, a: Anchor): { start: number; end: number } {
  const lines = text.split("\n");
  const start = a.start_line ?? 1;
  const end = a.end_line ?? start;
  if (!a.pattern) return { start, end };
  let re: RegExp;
  try {
    re = new RegExp(a.pattern);
  } catch {
    return { start, end };
  }
  if (re.test(lines.slice(start - 1, end).join("\n"))) return { start, end };
  const span = end - start;
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines.slice(i, i + span + 1).join("\n"))) return { start: i + 1, end: i + 1 + span };
  }
  return { start, end };
}
