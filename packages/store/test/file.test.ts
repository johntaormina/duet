import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fsOps, openStore, renderBriefingMarkdown, StoreError } from "../src/index.ts";
import { briefing, cards, contextPack, record, SHA_A, SHA_B, tempRepo } from "./fixtures.ts";

function setup() {
  const repo = tempRepo();
  const store = openStore({ repoRoot: repo });
  const pipeline = store.pipeline("r1");
  pipeline.initRun({ base: SHA_A, head: SHA_B, title: "t" });
  return { repo, store, pipeline, dir: store.runDir("r1") };
}

describe("writing, validation, and versioning", () => {
  // @spec ART-FILE-001
  it("writes JSON files through a temporary file renamed into place", () => {
    const { pipeline, dir } = setup();
    const spy = vi.spyOn(fsOps, "renameSync");
    pipeline.write("context-pack", contextPack());
    const call = spy.mock.calls.find(([, to]) => String(to).endsWith("context-pack.json"));
    expect(call).toBeDefined();
    expect(String(call![0])).not.toBe(String(call![1]));
    expect(String(call![0]).startsWith(dir)).toBe(true);
    spy.mockRestore();
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  // @spec ART-FILE-002
  it("appends one complete line per question-log entry without rewriting earlier lines", () => {
    const { store, dir } = setup();
    const session = store.session("r1", "rev");
    const e = { card_id: "D1", asked_at: "t", question: "q", answer: "a", committed: false };
    session.appendQa(e);
    const first = readFileSync(join(dir, "qa.rev.jsonl"), "utf8");
    session.appendQa({ ...e, question: "q2" });
    const second = readFileSync(join(dir, "qa.rev.jsonl"), "utf8");
    expect(second.startsWith(first)).toBe(true);
    expect(second.trim().split("\n")).toHaveLength(2);
  });

  // @spec ART-FILE-003
  it("ignores an incomplete trailing line when reading a .jsonl file", () => {
    const { store, dir } = setup();
    store.session("r1", "rev").appendQa({ card_id: "D1", asked_at: "t", question: "q", answer: "a", committed: false });
    appendFileSync(join(dir, "qa.rev.jsonl"), '{"card_id":"D1","ask');
    expect(store.reader("r1").readQa("rev")).toHaveLength(1);
  });

  // @spec ART-FILE-013
  it("removes an incomplete trailing line before appending", () => {
    const { store, dir } = setup();
    const session = store.session("r1", "rev");
    session.appendQa({ card_id: "D1", asked_at: "t", question: "q", answer: "a", committed: false });
    appendFileSync(join(dir, "qa.rev.jsonl"), '{"card_id":"D1","ask');
    session.appendQa({ card_id: "D1", asked_at: "t2", question: "q2", answer: "a2", committed: true });
    const lines = readFileSync(join(dir, "qa.rev.jsonl"), "utf8").trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).question)).toEqual(["q", "q2"]);
  });

  // @spec ART-FILE-004
  it("writes schema_version as major.minor in every JSON file", () => {
    const { store, pipeline, dir } = setup();
    pipeline.write("context-pack", contextPack());
    store.session("r1", "rev").writeRecord(record());
    for (const f of ["run.json", "context-pack.json", "record.rev.json"]) {
      expect(JSON.parse(readFileSync(join(dir, f), "utf8")).schema_version).toMatch(/^\d+\.\d+$/);
    }
  });

  // @spec ART-FILE-005
  it("accepts a newer minor version of a supported major, ignoring unknown fields", () => {
    const { store, dir } = setup();
    writeFileSync(join(dir, "context-pack.json"), JSON.stringify({ ...contextPack(), schema_version: "1.7", extra: 1 }));
    expect(store.reader("r1").read("context-pack")?.budget).toBe(1000);
  });

  // @spec ART-FILE-006
  it("reports an unsupported major version, naming the file and version, and returns no content", () => {
    const { store, dir } = setup();
    writeFileSync(join(dir, "context-pack.json"), JSON.stringify({ ...contextPack(), schema_version: "2.0" }));
    expect(() => store.reader("r1").read("context-pack")).toThrow(/context-pack\.json.*2\.0/);
  });

  // @spec ART-FILE-007, ART-FILE-008
  it("validates pipeline outputs before writing and marks the producing stage failed when invalid", () => {
    const { store, pipeline, dir } = setup();
    const bad = { ...cards(), no_decisions_summary: "" };
    pipeline.write("briefing", briefing());
    expect(() => pipeline.write("cards", bad)).toThrow(StoreError);
    expect(readdirSync(dir)).not.toContain("cards.json");
    const run = store.reader("r1").read("run")!;
    expect(run.stages.cards.status).toBe("failed");
    expect(run.stages.cards.error).toMatch(/no_decisions_summary/);
  });

  // @spec ART-FILE-009, ART-FILE-010
  it("validates session files on read and leaves an invalid one unchanged", () => {
    const { store, dir } = setup();
    const path = join(dir, "record.rev.json");
    writeFileSync(path, JSON.stringify({ schema_version: "1.0", reviewer: 5 }));
    expect(() => store.reader("r1").readRecord("rev")).toThrow(StoreError);
    expect(readFileSync(path, "utf8")).toBe(JSON.stringify({ schema_version: "1.0", reviewer: 5 }));
  });

  // @spec ART-FILE-014
  it("refuses writes to a session file while it fails validation", () => {
    const { store, dir } = setup();
    const path = join(dir, "record.rev.json");
    writeFileSync(path, "{ not json");
    expect(() => store.session("r1", "rev").writeRecord(record())).toThrow(/repaired or moved aside/);
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });

  // @spec ART-FILE-011
  it("rejects pipeline outputs written by the session and session files written by the pipeline", () => {
    const { store, pipeline } = setup();
    expect(() => store.session("r1", "rev").write("cards", cards())).toThrow(/session.*cards/);
    expect(() => pipeline.write("record.rev", record())).toThrow(/pipeline.*record/);
  });

  // @spec ART-FILE-012
  it("renders the briefing to markdown without other effects", () => {
    const md = renderBriefingMarkdown(briefing() as never);
    expect(md).toContain("Retry loop");
    expect(md).toContain("Retry inside the client");
  });
});

