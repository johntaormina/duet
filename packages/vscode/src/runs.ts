import { existsSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";

export interface RunListing {
  runId: string;
  title: string;
  updated: number;
  stages: Record<string, string>;
}

/** Existing runs under the run root, newest first. */
// @spec EXT-CMD-003
export function listRuns(root: string): RunListing[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((id) => existsSync(join(root, id, "run.json")))
    .map((id) => {
      const path = join(root, id, "run.json");
      const run = JSON.parse(readFileSync(path, "utf8"));
      return { runId: id, title: run.title, updated: statSync(path).mtimeMs, stages: Object.fromEntries(Object.entries<{ status: string }>(run.stages).map(([k, v]) => [k, v.status])) };
    })
    .sort((a, b) => b.updated - a.updated);
}

/** Calls `onChange` (debounced) whenever a JSON file in the run directory changes. */
// @spec EXT-CMD-004, EXT-CMD-007
export function watchRun(runDir: string, onChange: (file: string) => void, debounceMs = 150): FSWatcher {
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  return watch(runDir, (_event, file) => {
    if (!file || file.startsWith(".") || !/\.(json|jsonl)$/.test(file)) return;
    pending.add(file);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      for (const f of pending) onChange(f);
      pending.clear();
    }, debounceMs);
  });
}
