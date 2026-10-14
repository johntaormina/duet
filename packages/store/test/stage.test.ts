import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeCacheKey, openStore, STAGES } from "../src/index.ts";
import { SHA_A, SHA_B, tempRepo } from "./fixtures.ts";

function setup() {
  const store = openStore({ repoRoot: tempRepo() });
  const pipeline = store.pipeline("r1");
  pipeline.initRun({ base: SHA_A, head: SHA_B, title: "Retry change" });
  return { store, pipeline };
}

const keyParts = {
  inputs: { diff: "x" },
  upstream: { intent: "h1" },
  files: { "prompts/cards.md": "prompt text" },
  config: { model: "sonnet", turns: 5, budget: 1000 },
  schemaVersion: "1.0",
};

describe("manifest and stage status", () => {
  // @spec ART-STAGE-001, ART-STAGE-002
  it("records the run identity and one entry per stage", () => {
    const { store } = setup();
    const run = store.reader("r1").read("run")!;
    expect(run).toMatchObject({ run_id: "r1", base: SHA_A, head: SHA_B, title: "Retry change" });
    expect(Object.keys(run.stages).sort()).toEqual([...STAGES].sort());
    expect(STAGES).toEqual(["context", "intent", "briefing", "cards", "recommendations", "findings"]);
  });

  // @spec ART-STAGE-003
  it("records status, start time, finish time, and cache key for each stage", () => {
    const { store, pipeline } = setup();
    pipeline.setStage("intent", { status: "running", started_at: "t0", cache_key: "k" });
    pipeline.setStage("intent", { status: "complete", finished_at: "t1" });
    expect(store.reader("r1").read("run")!.stages.intent).toMatchObject({
      status: "complete",
      started_at: "t0",
      finished_at: "t1",
      cache_key: "k",
    });
  });

  // @spec ART-STAGE-004
  it("requires an error summary when a stage is failed", () => {
    const { pipeline } = setup();
    expect(() => pipeline.setStage("intent", { status: "failed" })).toThrow();
    pipeline.setStage("intent", { status: "failed", error: "bad output" });
  });

  // @spec ART-STAGE-007
  it("allows an optional detail describing the stage's condition", () => {
    const { store, pipeline } = setup();
    pipeline.setStage("cards", { status: "running", detail: "waiting on a rate limit until 12:05" });
    expect(store.reader("r1").read("run")!.stages.cards.detail).toMatch(/rate limit/);
  });

  // @spec ART-STAGE-005
  it("computes a cache key that changes with inputs, upstream hashes, file contents, configuration, and schema version", () => {
    const base = computeCacheKey(keyParts);
    expect(computeCacheKey({ ...keyParts })).toBe(base);
    expect(computeCacheKey({ ...keyParts, inputs: { diff: "y" } })).not.toBe(base);
    expect(computeCacheKey({ ...keyParts, upstream: { intent: "h2" } })).not.toBe(base);
    expect(computeCacheKey({ ...keyParts, files: { "prompts/cards.md": "edited" } })).not.toBe(base);
    expect(computeCacheKey({ ...keyParts, config: { ...keyParts.config, model: "opus" } })).not.toBe(base);
    expect(computeCacheKey({ ...keyParts, schemaVersion: "1.1" })).not.toBe(base);
  });

  // @spec ART-STAGE-006
  it("reports a stage reusable only when complete with a matching cache key", () => {
    const { store, pipeline } = setup();
    const key = computeCacheKey(keyParts);
    const reader = () => store.reader("r1");
    pipeline.setStage("cards", { status: "running", cache_key: key });
    expect(reader().isReusable("cards", key)).toBe(false);
    pipeline.setStage("cards", { status: "complete" });
    expect(reader().isReusable("cards", key)).toBe(true);
    expect(reader().isReusable("cards", "other")).toBe(false);
  });

  it("keeps run.json valid JSON on disk", () => {
    const { store } = setup();
    JSON.parse(readFileSync(join(store.runDir("r1"), "run.json"), "utf8"));
  });
});
