import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Sink } from "./sinks.ts";
import type { Source } from "./sources.ts";

export interface AssetResolver {
  /** Absolute path of the file that applies: the overlay's if present, else the core's. */
  path(rel: string): string;
  read(rel: string): string;
  exists(rel: string): boolean;
  /** Where the file came from, for cache keys and diagnostics. */
  origin(rel: string): "overlay" | "core";
}

// @spec ADPT-OVL-001, ADPT-OVL-002
export function createAssetResolver(coreDir: string, overlayDir: string | null): AssetResolver {
  const fromOverlay = (rel: string) => !!overlayDir && existsSync(join(overlayDir, rel));
  const path = (rel: string) => (fromOverlay(rel) ? join(overlayDir!, rel) : join(coreDir, rel));
  return {
    path,
    read: (rel) => readFileSync(path(rel), "utf8"),
    exists: (rel) => existsSync(path(rel)),
    origin: (rel) => (fromOverlay(rel) ? "overlay" : "core"),
  };
}

/** Finds files at head that refer to a changed file, for one ecosystem. */
export interface CallerResolver {
  ecosystem: string;
  matches(file: string): boolean;
  callers(file: string, worktree: string): Promise<string[]>;
}

/** Produces a report about a change the diff alone does not show (e.g. an infrastructure plan). */
export interface ToolOutputProvider {
  name: string;
  produce(ctx: { worktree: string; base: string; head: string; files: string[] }): Promise<string | null>;
}

export interface AdapterRegistry {
  sources: Source[];
  sinks: Sink[];
  resolvers: CallerResolver[];
  toolOutput: ToolOutputProvider[];
}

/** Loads adapter modules named in configuration and every module in `<overlay>/adapters/`. */
// @spec ADPT-OVL-003, ADPT-SRC-008
export async function loadAdapters(opts: { overlay: string | null; modules: string[]; baseDir?: string }): Promise<AdapterRegistry> {
  const reg: AdapterRegistry = { sources: [], sinks: [], resolvers: [], toolOutput: [] };
  const files = opts.modules.map((m) => resolve(opts.baseDir ?? process.cwd(), m));
  if (opts.overlay && existsSync(join(opts.overlay, "adapters"))) {
    for (const f of readdirSync(join(opts.overlay, "adapters")).sort()) {
      if (/\.(m?js)$/.test(f)) files.push(join(opts.overlay, "adapters", f));
    }
  }
  for (const file of files) {
    const mod = (await import(pathToFileURL(file).href)) as Partial<AdapterRegistry>;
    reg.sources.push(...(mod.sources ?? []));
    reg.sinks.push(...(mod.sinks ?? []));
    reg.resolvers.push(...(mod.resolvers ?? []));
    reg.toolOutput.push(...(mod.toolOutput ?? []));
  }
  return reg;
}
