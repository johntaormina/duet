import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { deleteRef, updateRef } from "./git.ts";
import { cardHash } from "./hash.ts";
import {
  type Answer,
  type Card,
  type DecisionRecord,
  type Finding,
  type FindingState,
  type FindingStateValue,
  type PipelineFile,
  type PipelineFiles,
  type QaEntry,
  type Recommendation,
  type RunManifest,
  type SchemaName,
  type Stage,
  type StageEntry,
  FILE_STAGE,
  PIPELINE_FILES,
  SCHEMA_VERSION,
  STAGES,
  SUPPORTED_MAJOR,
} from "./types.ts";
import { validate } from "./validate.ts";

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}

/** File operations used for writes; an object so tests can observe them. */
export const fsOps = { writeFileSync, renameSync };

let tmpCounter = 0;

// @spec ART-FILE-001
function writeJsonAtomic(path: string, data: unknown): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${tmpCounter++}.tmp`);
  fsOps.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  fsOps.renameSync(tmp, path);
}

function checkVersion(file: string, data: unknown): void {
  const v = (data as { schema_version?: unknown })?.schema_version;
  const major = typeof v === "string" ? Number(v.split(".")[0]) : NaN;
  if (major !== SUPPORTED_MAJOR) {
    throw new StoreError(`${file} has schema version ${String(v)}, which this version of Duet does not support`);
  }
}

// @spec ART-FILE-005, ART-FILE-006
function readVersioned<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, "utf8"));
  checkVersion(basename(path), data);
  return data as T;
}

// @spec ART-FILE-003
function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
  const out: T[] = [];
  for (const line of complete.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // A damaged line is skipped rather than failing the whole log.
    }
  }
  return out;
}

// @spec ART-FILE-002, ART-FILE-013
function appendJsonl(path: string, entry: unknown): void {
  if (existsSync(path)) {
    const text = readFileSync(path, "utf8");
    if (text.length > 0 && !text.endsWith("\n")) truncateSync(path, text.lastIndexOf("\n") + 1);
  }
  appendFileSync(path, JSON.stringify(entry) + "\n");
}

export interface StoreOptions {
  repoRoot: string;
  /** Run root, relative to the repository root unless absolute. Defaults to `.duet`. */
  root?: string;
  /** When true, the root is left trackable by version control. */
  tracked?: boolean;
}

export interface Store {
  readonly repoRoot: string;
  readonly root: string;
  readonly rootName: string;
  runDir(runId: string): string;
  ensureRoot(): void;
  keepSnapshot(runId: string, sha: string): void;
  removeRun(runId: string): void;
  pipeline(runId: string): PipelineWriter;
  session(runId: string, reviewer: string): SessionWriter;
  reader(runId: string): RunReader;
}

// @spec ART-RUN-001
export function openStore(opts: StoreOptions): Store {
  const rootName = opts.root ?? ".duet";
  const root = isAbsolute(rootName) ? rootName : join(opts.repoRoot, rootName);
  const store: Store = {
    repoRoot: opts.repoRoot,
    root,
    rootName,
    runDir: (runId) => join(root, runId),
    // @spec ART-RUN-006
    ensureRoot() {
      if (existsSync(root)) return;
      mkdirSync(root, { recursive: true });
      if (!opts.tracked) writeFileSync(join(root, ".gitignore"), "*\n");
    },
    // @spec ART-RUN-005
    keepSnapshot(runId, sha) {
      updateRef(opts.repoRoot, `refs/duet/${runId}`, sha);
    },
    removeRun(runId) {
      rmSync(join(root, runId), { recursive: true, force: true });
      deleteRef(opts.repoRoot, `refs/duet/${runId}`);
    },
    pipeline: (runId) => new PipelineWriter(store, runId),
    session: (runId, reviewer) => new SessionWriter(store, runId, reviewer),
    reader: (runId) => new RunReader(store, runId),
  };
  return store;
}

function ensureRunDir(store: Store, runId: string): string {
  store.ensureRoot();
  const dir = store.runDir(runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function emptyStage(): StageEntry {
  return { status: "pending", started_at: null, finished_at: null, cache_key: null };
}

export class PipelineWriter {
  readonly dir: string;
  constructor(
    private store: Store,
    readonly runId: string,
  ) {
    this.dir = ensureRunDir(store, runId);
  }

  // @spec ART-STAGE-001, ART-STAGE-002
  initRun(id: { base: string; head: string; title: string }): RunManifest {
    const existing = readVersioned<RunManifest>(join(this.dir, "run.json"));
    if (existing) return existing;
    const run: RunManifest = {
      schema_version: SCHEMA_VERSION,
      run_id: this.runId,
      base: id.base,
      head: id.head,
      title: id.title,
      stages: Object.fromEntries(STAGES.map((s) => [s, emptyStage()])) as Record<Stage, StageEntry>,
    };
    this.writeChecked("run", run);
    return run;
  }

  // @spec ART-STAGE-003, ART-STAGE-004, ART-STAGE-007
  setStage(stage: Stage, patch: Partial<StageEntry>): RunManifest {
    const run = readVersioned<RunManifest>(join(this.dir, "run.json"));
    if (!run) throw new StoreError(`run ${this.runId} has no run.json`);
    const next = { ...run.stages[stage], ...patch };
    if (next.status !== "failed") delete next.error;
    run.stages[stage] = next;
    this.writeChecked("run", run);
    return run;
  }

  /** Writes a pipeline output after validating it; an invalid output fails its stage instead. */
  // @spec ART-FILE-008, ART-FILE-011
  write(file: PipelineFile | string, data: unknown): void {
    if (!PIPELINE_FILES.includes(file as PipelineFile)) {
      throw new StoreError(`the pipeline's writer cannot write ${file}: it is a session file`);
    }
    this.writeChecked(file as PipelineFile, data);
  }

  private writeChecked(file: PipelineFile, data: unknown): void {
    const ctx = file === "cards" ? { briefing: readVersioned<PipelineFiles["briefing"]>(join(this.dir, "briefing.json")) } : {};
    const result = validate(file, data, ctx);
    if (!result.ok) {
      const message = `${file}.json failed validation: ${result.errors.join("; ")}`;
      const stage = FILE_STAGE[file];
      if (stage) this.setStage(stage, { status: "failed", error: message, finished_at: new Date().toISOString() });
      throw new StoreError(message);
    }
    writeJsonAtomic(join(this.dir, `${file}.json`), data);
  }
}

const SESSION_PREFIXES = ["record.", "finding-state.", "qa."];

export class SessionWriter {
  readonly dir: string;
  constructor(
    private store: Store,
    readonly runId: string,
    readonly reviewer: string,
  ) {
    this.dir = ensureRunDir(store, runId);
  }

  // @spec ART-FILE-011
  write(file: string, data: unknown): void {
    if (!SESSION_PREFIXES.some((p) => file.startsWith(p))) {
      throw new StoreError(`the session's writer cannot write ${file}: it is a pipeline output`);
    }
    if (file.startsWith("record.")) this.writeRecord(data as DecisionRecord);
    else if (file.startsWith("finding-state.")) this.writeFindingState(data as FindingState);
    else throw new StoreError(`use appendQa to add to ${file}`);
  }

  writeRecord(record: DecisionRecord): void {
    this.writeSessionJson("record", `record.${this.reviewer}.json`, record);
  }

  writeFindingState(state: FindingState): void {
    this.writeSessionJson("finding-state", `finding-state.${this.reviewer}.json`, state);
  }

  // @spec ART-FILE-002
  appendQa(entry: QaEntry): void {
    const result = validate("qa-entry", entry);
    if (!result.ok) throw new StoreError(`question-log entry failed validation: ${result.errors.join("; ")}`);
    appendJsonl(join(this.dir, `qa.${this.reviewer}.jsonl`), entry);
  }

  // @spec ART-FILE-014
  private writeSessionJson(schema: SchemaName, name: string, data: unknown): void {
    const path = join(this.dir, name);
    if (existsSync(path)) {
      try {
        readSessionFile(path, schema);
      } catch (e) {
        throw new StoreError(`${name} fails validation and must be repaired or moved aside before Duet can write it (${(e as Error).message})`);
      }
    }
    const result = validate(schema, data);
    if (!result.ok) throw new StoreError(`${name} failed validation: ${result.errors.join("; ")}`);
    writeJsonAtomic(path, data);
  }
}

// @spec ART-FILE-009, ART-FILE-010
function readSessionFile<T>(path: string, schema: SchemaName): T | null {
  if (!existsSync(path)) return null;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new StoreError(`${basename(path)} is not valid JSON: ${(e as Error).message}`);
  }
  checkVersion(basename(path), data);
  const result = validate(schema, data);
  if (!result.ok) throw new StoreError(`${basename(path)} failed validation: ${result.errors.join("; ")}`);
  return data as T;
}

export type AnswerStatus = { status: "none" } | { status: "current" | "stale"; answer: Answer };

export class RunReader {
  readonly dir: string;
  constructor(
    private store: Store,
    readonly runId: string,
  ) {
    this.dir = store.runDir(runId);
  }

  read<F extends PipelineFile>(file: F): PipelineFiles[F] | null {
    return readVersioned<PipelineFiles[F]>(join(this.dir, `${file}.json`));
  }

  readRecord(reviewer: string): DecisionRecord | null {
    return readSessionFile<DecisionRecord>(join(this.dir, `record.${reviewer}.json`), "record");
  }

  readFindingState(reviewer: string): FindingState | null {
    return readSessionFile<FindingState>(join(this.dir, `finding-state.${reviewer}.json`), "finding-state");
  }

  readQa(reviewer: string): QaEntry[] {
    return readJsonl<QaEntry>(join(this.dir, `qa.${reviewer}.jsonl`));
  }

  // @spec ART-STAGE-006
  isReusable(stage: Stage, key: string): boolean {
    const entry = this.read("run")?.stages[stage];
    return entry?.status === "complete" && entry.cache_key === key;
  }

  // @spec ART-LEAN-003
  getRecommendation(card: Card): Recommendation | null {
    const hash = cardHash(card);
    return this.read("recommendations")?.entries.find((e) => e.card_id === card.id && e.card_hash === hash) ?? null;
  }

  // @spec ART-LOG-007
  answerFor(record: DecisionRecord | null, card: Card): AnswerStatus {
    const answer = record?.answers.find((a) => a.fingerprint === card.fingerprint);
    if (!answer) return { status: "none" };
    return { status: answer.card_hash === cardHash(card) ? "current" : "stale", answer };
  }

  // @spec ART-FIND-007
  findingsFor(reviewer: string): (Finding & { state: FindingStateValue })[] {
    const states = new Map((this.readFindingState(reviewer)?.states ?? []).map((s) => [s.fingerprint, s.state]));
    return (this.read("findings")?.findings ?? []).map((f) => ({ ...f, state: states.get(f.fingerprint) ?? "open" }));
  }
}

/** Records an answer, replacing a stale one for the same card and keeping it as previous. */
// @spec ART-LOG-008
export function upsertAnswer(record: DecisionRecord, answer: Answer): DecisionRecord {
  const i = record.answers.findIndex((a) => a.fingerprint === answer.fingerprint);
  const answers = [...record.answers];
  if (i === -1) {
    answers.push({ ...answer, previous: answer.previous ?? [] });
  } else {
    const old = answers[i];
    const { previous: oldPrevious = [], ...oldRest } = old;
    const previous = old.card_hash === answer.card_hash ? oldPrevious : [...oldPrevious, oldRest];
    answers[i] = { ...answer, previous };
  }
  return { ...record, answers };
}
