import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AdapterRegistry,
  type AssetResolver,
  type Change,
  type ChangeRef,
  createAssetResolver,
  type DuetConfig,
  ghSource,
  gitSource,
  loadAdapters,
  loadConfig,
  type Source,
} from "@duet/adapters";
import {
  type Briefing,
  type Cards,
  canonicalJson,
  computeCacheKey,
  type ContextPack,
  deriveRunId,
  type Findings,
  type Intent,
  openStore,
  type PipelineFiles,
  type PipelineWriter,
  SCHEMA_VERSION,
  sha256,
  type Stage,
  type Store,
} from "@duet/store";
import { callJson, type CallEnv } from "./call.ts";
import { cliRunner, type ClaudeRunner } from "./claude.ts";
import { buildContextPack } from "./context/pack.ts";
import { changedFiles } from "./context/git.ts";
import { loadPrompt } from "./prompts.ts";
import { renderBriefing, renderCard, renderPack } from "./render.ts";
import { Scheduler, unlimited } from "./scheduler.ts";
import { runCards } from "./stages/cards.ts";
import { runBriefing, runIntent } from "./stages/human.ts";
import { runMachine, runRecommendations, SPECIALISTS } from "./stages/machine.ts";
import { ensureHeadWorktree, removeHeadWorktree } from "./worktree.ts";

export const CORE_ASSETS = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");

export interface EngineDeps {
  runner?: ClaudeRunner;
  sources?: Source[];
  coreAssets?: string;
  userConfigDir?: string;
  sleep?: (ms: number) => Promise<void>;
}

export interface RunOptions extends EngineDeps {
  repoRoot: string;
  change: ChangeRef;
  authorStatement?: string;
  agentPlanFile?: string;
  flags?: Partial<DuetConfig>;
  /** Called as soon as the run exists, before any stage runs. */
  onRun?: (runId: string, runDir: string) => void;
}

export interface RunSummary {
  runId: string;
  runDir: string;
  stages: Record<Stage, string>;
}

export class LockHeldError extends Error {
  constructor(pid: number) {
    super(`another duet process (pid ${pid}) is already working on this run`);
    this.name = "LockHeldError";
  }
}

const HUMAN_CHAIN: Stage[] = ["intent", "briefing", "cards", "recommendations"];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Takes the run's lock, taking over a lock whose process has exited. Returns a release function. */
// @spec PIPE-RES-001, PIPE-RES-002, PIPE-RES-003
export function acquireLock(runDir: string): () => void {
  const path = join(runDir, "lock");
  if (existsSync(path)) {
    const pid = Number(readFileSync(path, "utf8").trim());
    if (pid && pid !== process.pid && alive(pid)) throw new LockHeldError(pid);
  }
  writeFileSync(path, String(process.pid));
  return () => {
    try {
      if (readFileSync(path, "utf8").trim() === String(process.pid)) rmSync(path);
    } catch {
      // Already gone.
    }
  };
}

interface Setup {
  config: DuetConfig;
  store: Store;
  assets: AssetResolver;
  adapters: AdapterRegistry;
}

async function setup(repoRoot: string, deps: EngineDeps, flags?: Partial<DuetConfig>): Promise<Setup> {
  const config = loadConfig({ repoRoot, userConfigDir: deps.userConfigDir, flags });
  const store = openStore({ repoRoot, root: config.root, tracked: config.tracked });
  const assets = createAssetResolver(deps.coreAssets ?? CORE_ASSETS, config.overlay);
  const adapters = await loadAdapters({ overlay: config.overlay, modules: [...config.resolvers, ...config.toolOutput], baseDir: repoRoot });
  return { config, store, assets, adapters };
}

async function resolveChange(s: Setup, deps: EngineDeps, repoRoot: string, ref: ChangeRef): Promise<Change> {
  const sources = [...(deps.sources ?? []), ...s.adapters.sources, gitSource(), ghSource()];
  const wanted = ref.kind === "pr" ? (s.config.defaultSource === "git" ? "gh" : s.config.defaultSource) : "git";
  const source = sources.find((x) => x.name === wanted) ?? sources.find((x) => x.name === (ref.kind === "pr" ? "gh" : "git"))!;
  return source.resolve(ref, { repoRoot, runRoot: s.store.rootName });
}

const fileHash = (data: unknown) => sha256(canonicalJson(data));

/**
 * Reviews a change: creates or resumes its run, reuses every stage whose cache key still matches,
 * and runs the rest as two concurrent branches.
 */
// @spec PIPE-CLI-001, PIPE-CLI-002, PIPE-CLI-005, PIPE-STG-001, PIPE-FAIL-001, PIPE-FAIL-002, PIPE-FAIL-003, PIPE-FAIL-004, PIPE-RES-004
export async function run(opts: RunOptions): Promise<RunSummary> {
  const s = await setup(opts.repoRoot, opts, opts.flags);
  const change = await resolveChange(s, opts, opts.repoRoot, opts.change);
  const runId = deriveRunId(change.base, change.head);
  const pipeline = s.store.pipeline(runId);
  const release = acquireLock(pipeline.dir);
  try {
    if (change.worktree) s.store.keepSnapshot(runId, change.head);
    pipeline.initRun({ base: change.base, head: change.head, title: change.title });
    opts.onRun?.(runId, pipeline.dir);
    const worktree = ensureHeadWorktree(opts.repoRoot, pipeline.dir, change.head);
    const reader = () => s.store.reader(runId);
    const scheduler = new Scheduler(s.config.concurrency);
    const env = (stage: Stage): CallEnv => ({
      runner: opts.runner ?? cliRunner,
      assets: s.assets,
      config: s.config,
      scheduler,
      cwd: worktree,
      sleep: opts.sleep,
      onWait: (detail) => pipeline.setStage(stage, { detail: detail ?? undefined }),
    });
    const promptFiles = (names: string[], extra: string[] = []) =>
      Object.fromEntries([...names.map((n) => [`prompts/${n}.md`, s.assets.read(`prompts/${n}.md`)]), ...extra.map((r) => [r, s.assets.read(r)])]);
    const stageConfig = (names: string[]) => Object.fromEntries(names.map((n) => [n, loadPrompt(s.assets, n, s.config).settings]));
    const agentPlan = opts.agentPlanFile ? readFileSync(opts.agentPlanFile, "utf8") : undefined;

    const stage = async <T>(name: Stage, key: string, produce: () => Promise<T>, file: keyof PipelineFiles, writeOutput = true): Promise<T> => {
      if (reader().isReusable(name, key)) return reader().read(file) as T;
      pipeline.setStage(name, { status: "running", started_at: new Date().toISOString(), finished_at: null, cache_key: key, detail: undefined });
      try {
        const out = await produce();
        if (writeOutput) pipeline.write(file, out);
        pipeline.setStage(name, { status: "complete", finished_at: new Date().toISOString(), detail: undefined });
        return out;
      } catch (e) {
        const current = reader().read("run")?.stages[name];
        if (current?.status !== "failed") pipeline.setStage(name, { status: "failed", error: (e as Error).message, finished_at: new Date().toISOString(), detail: undefined });
        throw e;
      }
    };
    const failDownstream = (from: Stage, stages: Stage[]) => {
      for (const st of stages) pipeline.setStage(st, { status: "failed", error: `upstream stage ${from} failed`, finished_at: new Date().toISOString(), detail: undefined });
    };

    // Context, shared by both branches.
    const contextKey = computeCacheKey({
      inputs: { change, authorStatement: opts.authorStatement ?? "", agentPlan: agentPlan ?? "" },
      upstream: {},
      files: {},
      config: { budget: s.config.contextBudget, perFile: s.config.perFileLimit, history: s.config.historyCount, generated: s.config.generatedPaths, resolvers: s.config.resolvers, toolOutput: s.config.toolOutput },
      schemaVersion: SCHEMA_VERSION,
    });
    let pack: ContextPack;
    try {
      pack = await stage("context", contextKey, () =>
        buildContextPack({
          repo: opts.repoRoot,
          worktree,
          change,
          authorStatement: opts.authorStatement,
          agentPlan,
          budget: s.config.contextBudget,
          perFileLimit: s.config.perFileLimit,
          historyCount: s.config.historyCount,
          generatedPaths: s.config.generatedPaths,
          resolvers: s.adapters.resolvers,
          toolOutput: s.adapters.toolOutput,
        }), "context-pack");
    } catch {
      failDownstream("context", [...HUMAN_CHAIN, "findings"]);
      return summary(s.store, runId);
    }
    const files = changedFiles(opts.repoRoot, change.base, change.head).map((f) => f.path);

    let resolveCards!: (c: Cards | null) => void;
    const cardsDone = new Promise<Cards | null>((r) => (resolveCards = r));

    // @spec PIPE-STG-001, PIPE-FAIL-003
    const human = (async () => {
      let current: Stage = "intent";
      try {
        const intent = await stage<Intent>("intent", computeCacheKey({ inputs: {}, upstream: { context: fileHash(pack) }, files: promptFiles(["intent"]), config: stageConfig(["intent"]), schemaVersion: SCHEMA_VERSION }), () => runIntent(env("intent"), pack, change.head), "intent");
        current = "briefing";
        const briefing = await stage<Briefing>("briefing", computeCacheKey({ inputs: {}, upstream: { context: fileHash(pack), intent: fileHash(intent) }, files: promptFiles(["briefing"]), config: stageConfig(["briefing"]), schemaVersion: SCHEMA_VERSION }), () => runBriefing(env("briefing"), pack, intent, change.head), "briefing");
        current = "cards";
        const cards = await stage<Cards>(
          "cards",
          computeCacheKey({ inputs: { base: change.base, head: change.head }, upstream: { context: fileHash(pack), intent: fileHash(intent), briefing: fileHash(briefing) }, files: promptFiles(["cards", "refute-cards", "fact-check"], ["guides/card-guide.md", s.assets.exists("triggers.yaml") ? "triggers.yaml" : "triggers.json"]), config: { ...stageConfig(["cards", "refute-cards", "fact-check"]), stakes: s.config.stakes, factCheck: s.config.factCheckTimeoutSec }, schemaVersion: SCHEMA_VERSION }),
          () => runCards({ env: env("cards"), repo: opts.repoRoot, base: change.base, head: change.head, pack, intent, briefing, stakesOverrides: s.config.stakes }),
          "cards",
        );
        resolveCards(cards);
        current = "recommendations";
        await stage("recommendations", computeCacheKey({ inputs: {}, upstream: { context: fileHash(pack), briefing: fileHash(briefing), cards: fileHash(cards) }, files: promptFiles(["recommendation"]), config: stageConfig(["recommendation"]), schemaVersion: SCHEMA_VERSION }), async () => {
          const entries = await runRecommendations(env("recommendations"), pack, briefing, cards.cards, (e) => pipeline.write("recommendations", { schema_version: SCHEMA_VERSION, entries: e }));
          if (cards.cards.length === 0) pipeline.write("recommendations", { schema_version: SCHEMA_VERSION, entries: [] });
          return entries;
        }, "recommendations", false);
      } catch {
        resolveCards(null);
        const after = HUMAN_CHAIN.slice(HUMAN_CHAIN.indexOf(current) + 1);
        failDownstream(current, after);
      }
    })();

    // @spec PIPE-STG-002, PIPE-STG-003, PIPE-FAIL-004
    const machine = (async () => {
      const specialistNames = [...SPECIALISTS.map((n) => `specialist-${n}`), "verifier"];
      // The key covers the cards, because the verifier links findings to them. Waiting for the cards
      // is only worth it when a completed result might be reusable; otherwise specialists start now.
      const keyFor = (cards: Cards | null) =>
        computeCacheKey({ inputs: { files }, upstream: { context: fileHash(pack), cards: cards ? fileHash(cards) : "none" }, files: promptFiles(specialistNames), config: { ...stageConfig(specialistNames), threshold: s.config.confidenceThreshold }, schemaVersion: SCHEMA_VERSION });
      if (reader().read("run")?.stages.findings.status === "complete" && reader().isReusable("findings", keyFor(await cardsDone))) return;
      pipeline.setStage("findings", { status: "running", started_at: new Date().toISOString(), finished_at: null, cache_key: null, detail: undefined });
      try {
        const findings = await runMachine({ env: env("findings"), pack, cardsDone, files, head: change.head });
        pipeline.write("findings", findings);
        pipeline.setStage("findings", { status: "complete", finished_at: new Date().toISOString(), cache_key: keyFor(await cardsDone), detail: undefined });
      } catch (e) {
        if (reader().read("run")?.stages.findings.status !== "failed") {
          pipeline.setStage("findings", { status: "failed", error: (e as Error).message, finished_at: new Date().toISOString(), detail: undefined });
        }
      }
    })();

    await Promise.all([human, machine]);
    return summary(s.store, runId);
  } finally {
    release();
  }
}

function summary(store: Store, runId: string): RunSummary {
  const run = store.reader(runId).read("run")!;
  return { runId, runDir: store.runDir(runId), stages: Object.fromEntries(Object.entries(run.stages).map(([k, v]) => [k, v.status])) as Record<Stage, string> };
}

export interface AskOptions extends EngineDeps {
  repoRoot: string;
  runId: string;
  cardId: string;
  question: string;
  /** Whether the reviewer may see this card's recommendation (decided by the review session). */
  mayRevealRecommendation: boolean;
  reviewer: string;
  flags?: Partial<DuetConfig>;
}

/** Answers one question about one card. Takes no lock and writes nothing. */
// @spec PIPE-CLI-003, PIPE-RES-005, PIPE-ASK-001, PIPE-ASK-002, PIPE-ASK-003, PIPE-ASK-004
export async function ask(opts: AskOptions): Promise<string> {
  const s = await setup(opts.repoRoot, opts, opts.flags);
  const reader = s.store.reader(opts.runId);
  const cards = reader.read("cards");
  const card = cards?.cards.find((c) => c.id === opts.cardId);
  if (!card) throw new Error(`run ${opts.runId} has no card ${opts.cardId}`);
  const pack = reader.read("context-pack")!;
  const briefing = reader.read("briefing")!;
  const earlier = reader.readQa(opts.reviewer).filter((q) => q.card_id === opts.cardId);
  const rec = opts.mayRevealRecommendation ? reader.getRecommendation(card) : null;
  const runDir = s.store.runDir(opts.runId);
  const worktree = existsSync(join(runDir, "head")) ? join(runDir, "head") : opts.repoRoot;
  const { value } = await callJson<{ answer: string }>(
    { runner: opts.runner ?? cliRunner, assets: s.assets, config: s.config, scheduler: unlimited, cwd: worktree, sleep: opts.sleep },
    {
      prompt: "ask",
      branch: "human",
      vars: {
        context: renderPack(pack),
        briefing: renderBriefing(briefing),
        card: renderCard(card),
        earlier: earlier.length ? earlier.map((q) => `Q: ${q.question}\nA: ${q.answer}`).join("\n\n") : "(none)",
        recommendation: rec ? `Claude's recommendation, which the reviewer has already seen: option ${rec.option} (confidence ${rec.confidence}). ${rec.reasoning}` : "(withheld)",
        rule: rec
          ? "The reviewer has seen your recommendation; you may discuss it."
          : "The reviewer has not yet committed to an option. Answer factual questions about the code and the change. Do not say, hint, or rank which option you would choose; if asked, say you will share your view after they commit.",
        question: opts.question,
      },
      check: (out) => (typeof out.answer === "string" && out.answer.trim() ? [] : ["output must have a non-empty answer"]),
    },
  );
  return value.answer;
}

export interface CleanOptions {
  repoRoot: string;
  runIds?: string[];
  olderThanDays?: number;
  userConfigDir?: string;
}

/** Removes runs with their head worktrees and snapshot refs. */
// @spec PIPE-CLI-004
export async function clean(opts: CleanOptions): Promise<string[]> {
  const config = loadConfig({ repoRoot: opts.repoRoot, userConfigDir: opts.userConfigDir });
  const store = openStore({ repoRoot: opts.repoRoot, root: config.root, tracked: config.tracked });
  if (!existsSync(store.root)) return [];
  const cutoff = opts.olderThanDays !== undefined ? Date.now() - opts.olderThanDays * 86_400_000 : null;
  const removed: string[] = [];
  for (const id of readdirSync(store.root)) {
    const dir = store.runDir(id);
    if (!statSync(dir).isDirectory()) continue;
    const named = opts.runIds?.includes(id) ?? false;
    const old = cutoff !== null && statSync(existsSync(join(dir, "run.json")) ? join(dir, "run.json") : dir).mtimeMs < cutoff;
    if (!named && !old) continue;
    removeHeadWorktree(opts.repoRoot, dir);
    store.removeRun(id);
    removed.push(id);
  }
  return removed;
}

export type { PipelineWriter };
