import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export interface StageSettings {
  model?: string;
  maxTurns?: number;
  timeoutSec?: number;
}

export interface DuetConfig {
  root: string;
  tracked: boolean;
  stages: Record<string, StageSettings>;
  contextBudget: number;
  perFileLimit: number;
  historyCount: number;
  concurrency: number;
  confidenceThreshold: number;
  factCheckTimeoutSec: number;
  stakes: Record<string, "high" | "low">;
  generatedPaths: string[];
  resolvers: string[];
  toolOutput: string[];
  reviewer: string | null;
  defaultSource: "git" | "gh" | string;
  overlay: string | null;
  rateLimitCeilingSec: number;
  /** Extra arguments passed to every Claude CLI call, for environments that need them. */
  claudeArgs: string[];
}

export const DEFAULT_CONFIG: DuetConfig = {
  root: ".duet",
  tracked: false,
  stages: {},
  contextBudget: 200_000,
  perFileLimit: 20_000,
  historyCount: 5,
  concurrency: 3,
  confidenceThreshold: 80,
  factCheckTimeoutSec: 90,
  stakes: {},
  generatedPaths: [],
  resolvers: [],
  toolOutput: [],
  reviewer: null,
  defaultSource: "git",
  overlay: null,
  rateLimitCeilingSec: 600,
  claudeArgs: [],
};

function readConfigFile(dir: string, base: string): Partial<DuetConfig> {
  for (const ext of ["json", "yaml", "yml"]) {
    const p = join(dir, `${base}.${ext}`);
    if (existsSync(p)) {
      const text = readFileSync(p, "utf8");
      return (ext === "json" ? JSON.parse(text) : parseYaml(text)) ?? {};
    }
  }
  return {};
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function merge<T>(base: T, over: Partial<T>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over ?? {})) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? merge(out[k], v) : v;
  }
  return out as T;
}

export interface LoadConfigOptions {
  repoRoot: string;
  /** Directory holding `duet/config.*`; defaults to XDG_CONFIG_HOME or ~/.config. */
  userConfigDir?: string;
  flags?: Partial<DuetConfig>;
}

/** Resolves settings: defaults < user < repository < overlay < command-line flags. */
// @spec ADPT-CFG-001, ADPT-CFG-002
export function loadConfig(opts: LoadConfigOptions): DuetConfig {
  const userDir = join(opts.userConfigDir ?? process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "duet");
  const user = readConfigFile(userDir, "config");
  const repo = readConfigFile(opts.repoRoot, "duet.config");
  const flags = opts.flags ?? {};
  const withoutOverlay = merge(merge(merge(DEFAULT_CONFIG, user), repo), flags);
  const overlay = withoutOverlay.overlay ? readConfigFile(withoutOverlay.overlay, "config") : {};
  return merge(merge(merge(merge(DEFAULT_CONFIG, user), repo), overlay), flags);
}
