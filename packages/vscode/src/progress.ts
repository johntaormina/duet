export interface StageProgress {
  done: number;
  total: number;
  /** Share of stages complete, as a whole percentage. */
  percent: number;
  running: string[];
}

/** How far a run has got: stages complete out of the total, and the ones running now. */
// @spec EXT-LOG-003, EXT-LOG-004, EXT-VIEW-013
export function stageProgress(stages: { name: string; status: string }[]): StageProgress {
  const done = stages.filter((s) => s.status === "complete").length;
  const total = stages.length;
  return { done, total, percent: total ? Math.round((done / total) * 100) : 0, running: stages.filter((s) => s.status === "running").map((s) => s.name) };
}

/** For example `3/6 stages · briefing…`. */
export function progressText(p: StageProgress): string {
  return `${p.done}/${p.total} stages${p.running.length ? ` · ${p.running.join(", ")}…` : ""}`;
}

/** The stage list of a `run.json` manifest. */
export function runStages(run: { stages: Record<string, { status: string }> }): { name: string; status: string }[] {
  return Object.entries(run.stages).map(([name, v]) => ({ name, status: v.status }));
}
