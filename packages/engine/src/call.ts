import type { AssetResolver, DuetConfig } from "@duet/adapters";
import { type ClaudeRunner, extractJson, RateLimitError } from "./claude.ts";
import { loadPrompt, render } from "./prompts.ts";
import type { Branch } from "./scheduler.ts";

export class InvalidOutputError extends Error {
  constructor(name: string, readonly problems: string[]) {
    super(`${name} produced invalid output twice: ${problems.join("; ")}`);
    this.name = "InvalidOutputError";
  }
}

export interface CallEnv {
  runner: ClaudeRunner;
  assets: AssetResolver;
  config: DuetConfig;
  scheduler: { run<T>(branch: Branch, fn: () => Promise<T>): Promise<T> };
  /** Head worktree every call runs in. */
  cwd: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Reports rate-limit waits so the stage can show them; called with null when the wait ends. */
  onWait?: (detail: string | null) => void;
}

export interface CallSpec<T> {
  prompt: string;
  vars: Record<string, string>;
  branch: Branch;
  /** Checks beyond JSON parsing; returns problems, empty when the output is acceptable. */
  check?: (out: T) => string[];
}

export interface CallResult<T> {
  value: T;
  truncated: boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * One logical Claude call: rate limits are waited out with exponential backoff; output that fails
 * parsing or the stage's checks is retried once with the problems listed, then rejected.
 */
// @spec PIPE-CALL-003, PIPE-CALL-004, PIPE-CALL-005, PIPE-CALL-006, PIPE-CALL-009
export async function callJson<T>(env: CallEnv, spec: CallSpec<T>): Promise<CallResult<T>> {
  const prompt = loadPrompt(env.assets, spec.prompt, env.config);
  const base = render(prompt.body, spec.vars);
  const sleep = env.sleep ?? defaultSleep;
  const now = env.now ?? (() => new Date());
  let problems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = attempt === 0 ? base : `${base}\n\nYour previous output had these problems. Return corrected JSON only.\n- ${problems.join("\n- ")}`;
    let backoff = 15_000;
    for (;;) {
      try {
        const res = await env.scheduler.run(spec.branch, () =>
          env.runner({
            name: spec.prompt,
            prompt: text,
            cwd: env.cwd,
            model: prompt.settings.model,
            tools: prompt.settings.tools,
            maxTurns: prompt.settings.maxTurns,
            timeoutMs: prompt.settings.timeoutSec * 1000,
            extraArgs: env.config.claudeArgs,
          }),
        );
        env.onWait?.(null);
        let value: T;
        try {
          value = extractJson(res.text) as T;
        } catch (e) {
          problems = [(e as Error).message];
          break;
        }
        problems = spec.check ? spec.check(value) : [];
        if (problems.length === 0) return { value, truncated: res.truncated };
        break;
      } catch (e) {
        if (!(e instanceof RateLimitError)) throw e;
        const ceiling = env.config.rateLimitCeilingSec * 1000;
        const wait = Math.min(e.retryAfterMs ?? backoff, ceiling);
        const until = new Date(now().getTime() + wait);
        env.onWait?.(`waiting on a rate limit until ${until.toISOString().slice(11, 19)} UTC`);
        await sleep(wait);
        backoff = Math.min(backoff * 2, ceiling);
      }
    }
  }
  throw new InvalidOutputError(spec.prompt, problems);
}
