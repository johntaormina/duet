import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A fresh git repository with one commit containing `a.txt`. */
export function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "duet-store-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "initial");
  return dir;
}

export function anchor(file = "src/a.ts", start = 1, end = 3) {
  return { file, commit: SHA_B, start_line: start, end_line: end };
}

export function contextPack() {
  return {
    schema_version: "1.0",
    budget: 1000,
    items: [{ id: "i1", kind: "diff", source: "diff", size: 10, content: "diff --git" }],
    excluded: [{ kind: "caller", source: "src/b.ts", reason: "over budget" }],
  };
}

export function intent() {
  return {
    schema_version: "1.0",
    stated: "Add retry with backoff to the upload client so transient failures recover.",
    sources: ["i2"],
    observed: "Adds retries and also lowers the default timeout.",
    mismatches: [{ statement: "Timeout lowered from 30s to 5s", anchors: [anchor()], kind: "unstated" }],
  };
}

export function briefing() {
  return {
    schema_version: "1.0",
    effort: { score: 3, minutes: 25, drivers: ["async control flow"] },
    coverage: { reviewed: ["src/a.ts"], skipped: [{ path: "docs/gen.md", reason: "generated" }] },
    cohorts: [{ id: "C1", title: "Retry policy", summary: "Adds retries.", files: ["src/a.ts"], depends_on: [] }],
    steps: [{ id: "S1", title: "Retry loop", explanation: "The client retries.", anchors: [anchor()] }],
    choices: [
      {
        id: "H1",
        kind: "approach",
        choice: "Retry inside the client",
        alternative: "Retry in each caller",
        tradeoff: "One place to change, less control per caller",
        rationale: { source: "inferred", text: "Keeps callers simple." },
        anchors: [anchor()],
        step_ref: "S1",
      },
    ],
  };
}

export function card(overrides: Record<string, unknown> = {}) {
  return {
    id: "D1",
    order: 0,
    fingerprint: "fp-d1",
    source: "trigger",
    categories: ["error-semantics"],
    stakes: "high",
    stakes_basis: "category default",
    question: "Should a failed upload retry forever?",
    why_it_matters: "Unbounded retries can overload the server and hang jobs.",
    plain_technical: "The loop has no attempt limit on 429 without Retry-After.",
    options: [
      { summary: "Keep unbounded retries", pros: [], cons: [], reversibility: "easy", is_current: true },
      { summary: "Cap at five attempts", pros: [], cons: [], reversibility: "easy", is_current: false },
    ],
    anchors: [anchor()],
    step_ref: "S1",
    basis: ["i1"],
    not_examined: [],
    flags: [],
    ...overrides,
  };
}

export function cards(list: unknown[] = [card()]) {
  return {
    schema_version: "1.0",
    cards: list,
    no_decisions_summary: "Remaining files are mechanical.",
    settled: [],
    fact_check: "complete",
    proposed_status: { status: "complete" },
  };
}

export function finding(overrides: Record<string, unknown> = {}) {
  return {
    id: "F1",
    category: "bug",
    severity: "high",
    confidence: 90,
    title: "Unbounded retry",
    anchors: [{ ...anchor(), pattern: "while \\(retry" }],
    evidence: "Loop has no limit.",
    found_by: ["bugs"],
    related_cards: ["D1"],
    verification: { status: "confirmed", by: "verifier", notes: "" },
    fingerprint: "ffp1",
    ...overrides,
  };
}

export function findings(list: unknown[] = [finding()]) {
  return {
    schema_version: "1.0",
    findings: list,
    coverage: { reviewed: ["src/a.ts"], skipped: [] },
    exploration: { context_gathered: "pack only", budget: "10 turns", not_examined: [] },
  };
}

export function recommendations(entries: unknown[]) {
  return { schema_version: "1.0", entries };
}

export function record(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "1.0",
    run_id: "r1",
    reviewer: "test-example-com",
    started_at: "2026-10-14T00:00:00Z",
    ended_at: null,
    incomplete_stages: [],
    answers: [],
    posted: [],
    ...overrides,
  };
}

export function answer(overrides: Record<string, unknown> = {}) {
  return {
    card_id: "D1",
    fingerprint: "fp-d1",
    card_hash: "h1",
    chosen_option: 1,
    rationale: "Bounded retries protect the server.",
    committed_at: "2026-10-14T00:01:00Z",
    revealed_at: null,
    agreed_with_ai: null,
    changes: [],
    previous: [],
    ...overrides,
  };
}
