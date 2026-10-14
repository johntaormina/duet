import type { AssetResolver } from "@duet/adapters";
import type { Intent } from "@duet/store";
import { parse as parseYaml } from "yaml";
import { changedFiles, showFile } from "../context/git.ts";
import { globToRegex } from "../context/glob.ts";

export interface TriggerCategory {
  category: string;
  description: string;
  stakes: "high" | "low";
  signals?: { paths?: string[] };
}

export interface TriggerHit {
  category: string;
  /** The file the hit is in; absent for hits about the change as a whole. */
  file?: string;
  reason: string;
  source: "signal" | "intent" | "claude";
}

/** Reads the trigger file (replaceable by an overlay). */
// @spec CARD-TRIG-001
export function loadTriggers(assets: AssetResolver): TriggerCategory[] {
  const rel = assets.exists("triggers.yaml") ? "triggers.yaml" : "triggers.json";
  const text = assets.read(rel);
  const data = rel.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  return (data.categories ?? data) as TriggerCategory[];
}

/** A category's default stakes after repository configuration. */
// @spec CARD-TRIG-013
export function defaultStakes(triggers: TriggerCategory[], overrides: Record<string, "high" | "low">, category: string): "high" | "low" {
  return overrides[category] ?? triggers.find((t) => t.category === category)?.stakes ?? "high";
}


type Deps = Map<string, string>;

/** Dependencies declared in a manifest, name to version specifier. */
export function manifestDeps(path: string, text: string | null): Deps {
  const deps: Deps = new Map();
  if (!text) return deps;
  const name = path.split("/").pop()!;
  try {
    if (name === "package.json") {
      const j = JSON.parse(text);
      for (const k of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) for (const [d, v] of Object.entries<string>(j[k] ?? {})) deps.set(d, v);
    } else if (/^requirements.*\.txt$/.test(name)) {
      for (const line of text.split("\n")) {
        const m = /^\s*([A-Za-z0-9_.\-[\]]+)\s*(.*?)\s*(#.*)?$/.exec(line);
        if (m && m[1] && !line.trim().startsWith("#") && !line.trim().startsWith("-")) deps.set(m[1].toLowerCase(), m[2]);
      }
    } else if (name === "go.mod") {
      for (const m of text.matchAll(/^\s*(?:require\s+)?([\w.\-/]+\.[\w.\-/]+)\s+(v[\w.\-+]+)/gm)) deps.set(m[1], m[2]);
    } else if (name === "Cargo.toml" || name === "pyproject.toml") {
      const section = /^\[(?:.*dependencies.*)\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/gm;
      for (const s of text.matchAll(section)) for (const m of s[1].matchAll(/^\s*([\w\-]+)\s*=\s*(.+)$/gm)) deps.set(m[1], m[2].trim());
    }
  } catch {
    // An unparsable manifest yields no dependency signals.
  }
  return deps;
}

const MANIFESTS = /(^|\/)(package\.json|requirements[^/]*\.txt|go\.mod|Cargo\.toml|pyproject\.toml)$/;

function major(spec: string): string | null {
  const m = /(\d+)\.\d+|(?:^|[^\d.])(\d+)(?:$|[^\d.])/.exec(spec.replace(/^[v^~>=<\s]+/, ""));
  return m ? (m[1] ?? m[2]) : null;
}

function isSourceSpec(spec: string): boolean {
  return /(git\+|github:|https?:|file:|link:|git =|path =|\bgit\b)/.test(spec);
}

/**
 * Trigger hits found by code alone: configured path patterns, dependency changes in manifests,
 * container base-image changes, and third-party CI action references.
 */
// @spec CARD-TRIG-003, CARD-TRIG-011, CARD-TRIG-012
export function signalHits(repo: string, base: string, head: string, triggers: TriggerCategory[]): TriggerHit[] {
  const hits: TriggerHit[] = [];
  const files = changedFiles(repo, base, head);
  for (const t of triggers) {
    const patterns = (t.signals?.paths ?? []).map(globToRegex);
    for (const f of files) if (patterns.some((p) => p.test(f.path))) hits.push({ category: t.category, file: f.path, reason: `path matches a ${t.category} pattern`, source: "signal" });
  }
  for (const f of files) {
    const before = f.status === "A" ? null : showFile(repo, base, f.oldPath ?? f.path);
    const after = f.status.startsWith("D") ? null : showFile(repo, head, f.path);
    if (MANIFESTS.test(f.path)) {
      const a = manifestDeps(f.path, before);
      const b = manifestDeps(f.path, after);
      for (const [dep, spec] of b) {
        const old = a.get(dep);
        if (old === undefined) hits.push({ category: "new-dependency", file: f.path, reason: `adds dependency ${dep} ${spec}`, source: "signal" });
        else if (isSourceSpec(spec) !== isSourceSpec(old) || (isSourceSpec(spec) && spec !== old)) hits.push({ category: "new-dependency", file: f.path, reason: `changes the source of ${dep}`, source: "signal" });
        else if (major(old) !== null && major(spec) !== null && major(old) !== major(spec)) hits.push({ category: "new-dependency", file: f.path, reason: `raises ${dep} from ${old} to ${spec}`, source: "signal" });
      }
    }
    if (/(^|\/)(Dockerfile|Containerfile)[^/]*$/.test(f.path)) {
      const from = (t: string | null) => (t ?? "").split("\n").filter((l) => /^\s*FROM\s/i.test(l)).join("\n");
      if (from(before) !== from(after)) hits.push({ category: "new-dependency", file: f.path, reason: "changes a container base image", source: "signal" });
    }
    if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(f.path) || /(^|\/)action\.ya?ml$/.test(f.path)) {
      const uses = (t: string | null) => new Set([...(t ?? "").matchAll(/uses:\s*["']?([^\s"'#]+)/g)].map((m) => m[1]).filter((u) => !/^(actions|github)\//.test(u) && !u.startsWith("./")));
      const a = uses(before);
      const added = [...uses(after)].filter((u) => !a.has(u));
      if (added.length) hits.push({ category: "secrets", file: f.path, reason: `references third-party CI action ${added.join(", ")}`, source: "signal" });
    }
  }
  return hits;
}

const MIN_INTENT_WORDS = 15;

/** Intent hits: one per contradiction, all unstated behavior as one, or one for missing intent. */
// @spec CARD-TRIG-004, CARD-TRIG-009, CARD-TRIG-010
export function intentHits(intent: Intent): TriggerHit[] {
  const words = intent.stated.trim() ? intent.stated.trim().split(/\s+/).length : 0;
  if (words < MIN_INTENT_WORDS) return [{ category: "intent-unknown", reason: "no usable statement of intent exists for this change", source: "intent" }];
  const hits: TriggerHit[] = intent.mismatches
    .filter((m) => m.kind === "contradiction")
    .map((m) => ({ category: "intent-contradiction", file: m.anchors[0]?.file, reason: m.statement, source: "intent" as const }));
  const unstated = intent.mismatches.filter((m) => m.kind === "unstated");
  if (unstated.length) hits.push({ category: "intent-unstated", reason: unstated.map((m) => m.statement).join("; "), source: "intent" });
  return hits;
}
