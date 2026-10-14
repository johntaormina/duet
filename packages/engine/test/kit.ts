import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ClaudeRequest, ClaudeResponse, ClaudeRunner } from "../src/index.ts";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function write(dir: string, rel: string, content: string) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), content);
}

export const UPLOAD_BASE = `export async function upload(data: Buffer) {
  return send(data);
}
`;
export const UPLOAD_HEAD = `export async function upload(data: Buffer) {
  let attempt = 0;
  while (true) {
    const res = await send(data);
    if (res.status !== 429) return res;
    attempt++;
  }
}

export const DEFAULT_TIMEOUT_MS = 5000;
`;

/** A repo whose `feature` branch changes an upload client, adds a dependency and a migration. */
export function fixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), "duet-engine-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "T");
  write(dir, "README.md", "# Uploader\nUploads things.\n");
  write(dir, "src/upload.ts", UPLOAD_BASE);
  write(dir, "src/caller.ts", `import { upload } from "./upload";\nexport const go = () => upload(Buffer.from("x"));\n`);
  write(dir, "package.json", JSON.stringify({ name: "x", dependencies: { lodash: "^4.0.0" } }, null, 2));
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "initial upload client");
  const base = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "-b", "feature");
  write(dir, "src/upload.ts", UPLOAD_HEAD);
  write(dir, "package.json", JSON.stringify({ name: "x", dependencies: { lodash: "^5.0.0", "p-retry": "^6.0.0" } }, null, 2));
  write(dir, "migrations/001_add_attempts.sql", "ALTER TABLE uploads ADD COLUMN attempts INT;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "Retry uploads on 429 so transient overload does not fail the whole import job for customers");
  const head = git(dir, "rev-parse", "HEAD");
  return { dir, base, head };
}

export type Handler = (req: ClaudeRequest, n: number) => unknown | Promise<unknown>;

/** A Claude runner that answers each prompt from a handler table and records every call. */
export function fakeClaude(handlers: Record<string, Handler>) {
  const calls: ClaudeRequest[] = [];
  const counts = new Map<string, number>();
  const runner: ClaudeRunner = async (req): Promise<ClaudeResponse> => {
    calls.push(req);
    const n = (counts.get(req.name) ?? 0) + 1;
    counts.set(req.name, n);
    const h = handlers[req.name] ?? (req.name.startsWith("specialist-") ? handlers["specialist"] : undefined);
    if (!h) throw new Error(`no fake handler for ${req.name}`);
    const out = await h(req, n);
    if (out && typeof out === "object" && "__response" in (out as object)) return (out as { __response: ClaudeResponse }).__response;
    return { text: typeof out === "string" ? out : JSON.stringify(out), truncated: false };
  };
  return { runner, calls, count: (name: string) => counts.get(name) ?? 0 };
}

const A = (file: string, start = 1, end = 2) => ({ file, start_line: start, end_line: end });

export const OUT = {
  intent: {
    stated: "Retry uploads on 429 so transient overload does not fail the whole import job for customers",
    sources: ["i5"],
    observed: "Retries forever on 429, lowers the default timeout to 5 seconds, adds p-retry and an attempts column.",
    mismatches: [
      { statement: "Default timeout lowered to 5 seconds", kind: "unstated", anchors: [A("src/upload.ts", 10, 10)] },
    ],
  },
  briefing: {
    effort: { score: 3, minutes: 20, drivers: ["retry control flow"] },
    coverage: { reviewed: ["src/upload.ts"], skipped: [] },
    cohorts: [{ id: "C1", title: "Retry loop", summary: "Upload retries on 429.", files: ["src/upload.ts"], depends_on: [] }],
    steps: [{ id: "S1", title: "Retry loop", explanation: "The client now loops on 429.", anchors: [A("src/upload.ts", 2, 7)] }],
    choices: [
      {
        id: "H1",
        kind: "approach",
        choice: "Retry inside the upload client",
        alternative: "Let each caller retry",
        tradeoff: "One place to change; callers lose control",
        rationale: { source: "stated", text: "Avoid failing the whole job", quote: "transient overload does not fail the whole import job", item: "i5" },
        anchors: [A("src/upload.ts", 2, 7)],
        step_ref: "S1",
      },
    ],
  },
};

export function card(over: Record<string, unknown> = {}) {
  return {
    source: "trigger",
    categories: ["error-semantics"],
    assessed_stakes: "high",
    stakes_reason: "jobs can hang",
    question: "Should a failed upload retry forever, or give up after a limit?",
    why_it_matters: "An overloaded server gets hammered and import jobs hang.",
    plain_technical: "The loop retries on 429 with no attempt limit or delay.",
    options: [
      { summary: "Retry forever", pros: [], cons: [], reversibility: "easy", is_current: true },
      { summary: "Cap at five attempts with backoff", pros: [], cons: [], reversibility: "easy", is_current: false },
    ],
    anchors: [{ ...A("src/upload.ts", 2, 7), pattern: "while \\(true\\)" }],
    step_ref: "S1",
    basis: ["i1"],
    not_examined: [],
    ...over,
  };
}

/** Cards covering every hit the fixture produces: data-model, new-dependency, intent-unstated, error-semantics. */
export function coveringCards() {
  return [
    card(),
    card({ categories: ["data-model"], question: "Should attempts be stored on the uploads table?", anchors: [A("migrations/001_add_attempts.sql", 1, 1)], options: [{ summary: "Add the column", pros: [], cons: [], reversibility: "hard", is_current: true }, { summary: "Do not store attempts", pros: [], cons: [], reversibility: "easy", is_current: false }] }),
    card({ categories: ["new-dependency"], assessed_stakes: "low", question: "Is upgrading lodash to 5 and adding p-retry acceptable?", anchors: [A("package.json", 1, 3)] }),
    card({ categories: ["intent-unstated"], question: "Should the default timeout drop from 30 to 5 seconds?", anchors: [A("src/upload.ts", 10, 10)] }),
  ];
}

export function happyHandlers(): Record<string, Handler> {
  return {
    intent: () => OUT.intent,
    briefing: () => OUT.briefing,
    cards: () => ({ hits: [{ category: "error-semantics", file: "src/upload.ts", reason: "unbounded retry" }], cards: coveringCards(), no_decisions_summary: "The caller change is mechanical." }),
    "refute-cards": () => ({ verdicts: [] }),
    "fact-check": () => ({ cards: [] }),
    recommendation: () => ({ option: 1, confidence: 70, reasoning: "Bounded retries are safer.", what_would_change_my_mind: "If the server sends Retry-After." }),
    specialist: (req) => ({ findings: req.name === "specialist-bugs" ? [{ category: "bug", severity: "high", title: "Unbounded retry", anchors: [{ ...A("src/upload.ts", 3, 7), pattern: "while \\(true\\)" }], evidence: "No exit on repeated 429." }] : [], not_examined: [] }),
    verifier: () => ({ verdicts: [{ index: 0, status: "confirmed", confidence: 90, notes: "Loop has no bound.", related_cards: ["D1"] }] }),
    ask: (req) => ({ answer: req.prompt.includes("(withheld)") ? "The loop retries on every 429." : "I recommended capping attempts." }),
  };
}

export const noSleep = async () => {};
