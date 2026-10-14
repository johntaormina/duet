import { parse as parseYaml } from "yaml";
import type { AssetResolver, DuetConfig } from "@duet/adapters";
import type { ToolSet } from "./claude.ts";

export interface PromptSettings {
  model?: string;
  maxTurns?: number;
  timeoutSec: number;
  tools: ToolSet;
}

export interface PromptFile {
  name: string;
  settings: PromptSettings;
  body: string;
  /** Raw file text, for cache keys. */
  raw: string;
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

/** Loads `prompts/<name>.md`, applying configuration overrides to its frontmatter settings. */
// @spec PIPE-CALL-002
export function loadPrompt(assets: AssetResolver, name: string, config: Pick<DuetConfig, "stages">): PromptFile {
  const raw = assets.read(`prompts/${name}.md`);
  const m = FRONTMATTER.exec(raw);
  const front = (m ? parseYaml(m[1]) : {}) as Partial<PromptSettings>;
  const override = config.stages[name] ?? {};
  return {
    name,
    raw,
    body: (m ? raw.slice(m[0].length) : raw).replace(/^<!--[\s\S]*?-->\n?/, ""),
    settings: {
      model: override.model ?? front.model,
      maxTurns: override.maxTurns ?? front.maxTurns,
      timeoutSec: override.timeoutSec ?? front.timeoutSec ?? 300,
      tools: front.tools ?? "none",
    },
  };
}

/** Fills `{{name}}` placeholders. Unknown placeholders are left visible so a broken prompt is obvious. */
export function render(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{(\w+)\}\}/g, (all, k: string) => (k in vars ? vars[k] : all));
}
