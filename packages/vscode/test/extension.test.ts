import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardSink, type Sink } from "@duet/adapters";
import { ReviewSession } from "@duet/session";
import { cardHash, openStore, type Card } from "@duet/store";
import { describe, expect, it } from "vitest";
import { locateAnchor } from "../src/anchors.ts";
import { engineExitMessage, PLAN_CHOICES, PLAN_PROMPT, runArgs, startEngine, startQuestions } from "../src/engineProcess.ts";
import * as vscode from "vscode";
import { activate, createCommentThreads } from "../src/extension.ts";
import { buildFindingsTree, findingActions } from "../src/findings.ts";
import { handleMessage, type ControllerHooks } from "../src/panel/controller.ts";
import { CLIENT, renderPanel } from "../src/panel/html.ts";
import { buildPanelModel, SPLIT_BANNER, type PanelModel, type Placeholder } from "../src/panel/model.ts";
import { PostFlow } from "../src/post.ts";
import { progressText, stageProgress } from "../src/progress.ts";
import { listRuns, watchRun } from "../src/runs.ts";
import { terminalLaunch } from "../src/terminal.ts";

const HEAD = "b".repeat(40);
const anchor = (file: string, s = 2, e = 3, pattern?: string) => ({ file, commit: HEAD, start_line: s, end_line: e, ...(pattern ? { pattern } : {}) });

function card(id: string, stakes: "high" | "low", step = "S1", over: Partial<Card> = {}): Card {
  return {
    id, order: 0, fingerprint: `fp-${id}`, source: "trigger", categories: ["error-semantics"], stakes, stakes_basis: "d",
    question: `Question ${id}?`, why_it_matters: "Jobs hang.", plain_technical: "Loop has no limit.",
    options: [{ summary: "Keep", pros: ["simple"], cons: ["hangs"], reversibility: "easy", is_current: true }, { summary: "Cap", pros: [], cons: [], reversibility: "easy", is_current: false }],
    anchors: [anchor("src/upload.ts")], step_ref: step, basis: [], not_examined: [], flags: [], ...over,
  };
}

const briefing = {
  schema_version: "1.0",
  effort: { score: 2, minutes: 10, drivers: [] },
  coverage: { reviewed: [], skipped: [] },
  cohorts: [{ id: "C1", title: "Upload", summary: "s", files: ["src/upload.ts"], depends_on: [] }],
  steps: [{ id: "S1", title: "Retry loop", explanation: "Loops.", anchors: [] }, { id: "S2", title: "Timeout", explanation: "Shorter.", anchors: [] }],
  choices: [
    { id: "H1", kind: "approach", choice: "Retry in upload()", alternative: "Retry in callers", tradeoff: "simple", rationale: { source: "stated", text: "avoid failures", quote: "busy server", item: "i3" }, anchors: [], step_ref: "S1" },
    { id: "H2", kind: "choice", choice: "Timeout 5s", alternative: "Keep 30s", tradeoff: "fails fast", rationale: { source: "none", text: "No reason given." }, anchors: [], step_ref: "S2" },
    { id: "H3", kind: "choice", choice: "No backoff", alternative: "Backoff", tradeoff: "fast", rationale: { source: "inferred", text: "Probably simplicity." }, anchors: [], step_ref: "S1" },
  ],
};

function setup(opts: { cards?: Card[]; complete?: boolean; recs?: boolean; extra?: Record<string, unknown> } = {}) {
  const repo = mkdtempSync(join(tmpdir(), "duet-ext-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const store = openStore({ repoRoot: repo });
  const p = store.pipeline("r1");
  p.initRun({ base: "a".repeat(40), head: HEAD, title: "Retry uploads" });
  const cards = opts.cards ?? [card("D1", "high", "S1", { choice_ref: "H1", metaphor: "Like redialling", analogy_breaks_down_when: "Servers send Retry-After", flags: [{ claim: "jobs hang", note: "only if 429 persists" }] }), card("D2", "low", "S2")];
  if (opts.complete !== false) {
    p.write("intent", { schema_version: "1.0", stated: "Retry uploads on 429 so a busy server does not fail imports for customers", sources: [], observed: "Retries forever.", mismatches: [{ statement: "Timeout lowered", anchors: [], kind: "unstated" }] });
    p.write("briefing", briefing);
    p.write("cards", { schema_version: "1.0", cards, no_decisions_summary: "rest mechanical", settled: [{ decision: "Log retries?", alternative: "No logs", fixed_by: "the linked issue" }], fact_check: "timed_out", proposed_status: { status: "failed", note: "Claude's proposals could not be vetted." }, ...(opts.extra ?? {}) });
    for (const s of ["context", "intent", "briefing", "cards"] as const) p.setStage(s, { status: "complete" });
    if (opts.recs !== false) p.write("recommendations", { schema_version: "1.0", entries: cards.map((c) => ({ card_id: c.id, option: 1, confidence: 75, reasoning: "Cap is safer.", what_would_change_my_mind: "Retry-After", card_hash: cardHash(c) })) });
  }
  p.setStage("findings", { status: "running", detail: "waiting on a rate limit until 12:05:00 UTC" });
  const asked: string[] = [];
  const session = new ReviewSession({ store, runId: "r1", reviewer: "rev", ask: async ({ question }) => { asked.push(question); return `A: ${question}`; } });
  return { repo, store, p, session, asked, cards };
}

const model = (s: ReturnType<typeof setup>) => buildPanelModel(s.store.reader("r1"), s.session, "rev");
const isPh = (x: unknown): x is Placeholder => !!x && (x as Placeholder).placeholder === true;

describe("review panel model", () => {
  // @spec EXT-VIEW-001, EXT-VIEW-002
  it("shows every stage's state, and a running or failed stage where its content would be", () => {
    const s = setup({ complete: false });
    s.p.setStage("intent", { status: "failed", error: "invalid output twice" });
    s.p.setStage("briefing", { status: "running", detail: "waiting on a rate limit until 12:05:00 UTC" });
    const m = model(s);
    expect(m.stages.map((x) => x.name)).toEqual(["context", "intent", "briefing", "cards", "recommendations", "findings"]);
    expect(m.intent).toMatchObject({ placeholder: true, status: "failed", error: "invalid output twice" });
    expect(m.steps).toMatchObject({ placeholder: true, status: "running", detail: expect.stringMatching(/rate limit/) });
    const html = renderPanel(m, "n", "csp");
    expect(html).toContain("The intent stage failed: invalid output twice");
    expect(html).toMatch(/briefing stage is running \(waiting on a rate limit/);
  });

  // @spec EXT-VIEW-003, EXT-VIEW-010
  it("shows the choices before the steps, then each card at its step", () => {
    const m = model(setup());
    expect(isPh(m.steps)).toBe(false);
    const steps = m.steps as Exclude<PanelModel["steps"], Placeholder>;
    expect(steps.map((s) => [s.title, s.cards.map((c) => c.id)])).toEqual([["Retry loop", ["D1"]], ["Timeout", ["D2"]]]);
    const html = renderPanel(m, "n", "csp");
    expect(html.indexOf("Choices this change made")).toBeLessThan(html.indexOf("1. Retry loop"));
    expect(html.indexOf("Already settled")).toBeLessThan(html.indexOf("1. Retry loop"));
    expect(html).toContain("settled by the linked issue");
  });

  // @spec EXT-VIEW-011
  it("labels inferred and missing reasons as such, never as the author's", () => {
    const m = model(setup());
    const choices = m.choices as Exclude<PanelModel["choices"], Placeholder>;
    expect(choices.map((c) => c.rationale.label)).toEqual(["Stated by the author", "No reason found", "Inferred by Claude"]);
    const html = renderPanel(m, "n", "csp");
    expect(html).toMatch(/Inferred by Claude:<\/span> Probably simplicity/);
    expect(html).toMatch(/No reason found:<\/span> No reason given/);
  });

  // @spec EXT-VIEW-004
  it("lists every card in deck order on the Decisions tab", () => {
    const m = model(setup());
    expect((m.deck as { id: string }[]).map((c) => c.id)).toEqual(["D1", "D2"]);
  });

  // @spec EXT-VIEW-005
  it("shows a split banner when the deck has more than seven cards", () => {
    const many = Array.from({ length: 8 }, (_, i) => card(`D${i + 1}`, "high", "S1", { fingerprint: `fp${i}` }));
    expect(model(setup({ cards: many })).banner).toBe(SPLIT_BANNER);
    expect(model(setup()).banner).toBeUndefined();
  });

  // @spec EXT-VIEW-012
  it("notes an unchecked deck and unvetted proposals above the cards", () => {
    const m = model(setup());
    expect(m.deckNotices).toEqual([expect.stringMatching(/fact check timed out/), "Claude's proposals could not be vetted."]);
  });

  // @spec EXT-DECK-001
  it("shows each card's question, reasons, options, code, metaphor, choice, and flags", () => {
    const html = renderPanel(model(setup()), "n", "csp");
    for (const t of ["Question D1?", "Jobs hang.", "Loop has no limit.", "Keep", "current code", "src/upload.ts:2", "Like redialling", "Servers send Retry-After", "About the choice: Retry in upload()", "Unconfirmed: jobs hang"]) expect(html).toContain(t);
  });

  // @spec EXT-DECK-002
  it("shows no recommendation on an uncommitted high-stakes card and says when it appears", () => {
    const m = model(setup());
    const d1 = (m.deck as { id: string; recommendation: { kind: string } }[]).find((c) => c.id === "D1")!;
    expect(d1.recommendation).toEqual({ kind: "hidden", note: expect.stringMatching(/after you commit/) });
    const html = renderPanel(m, "n", "csp");
    const d1Html = html.slice(html.indexOf('id="card-D1"'), html.indexOf("</section>", html.indexOf('id="card-D1"')));
    expect(d1Html).not.toContain("Cap is safer");
  });

  it("escapes run content in the panel", () => {
    const html = renderPanel(model(setup({ cards: [card("D1", "high", "S1", { question: "<img src=x onerror=alert(1)>?" })] })), "n", "csp");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });
});

describe("panel controller", () => {
  function hooks() {
    const posted: unknown[] = [];
    let refreshed = 0;
    const h: ControllerHooks = { post: (m) => void posted.push(m), refresh: () => void refreshed++, askReason: async () => "Changed my mind.", openAnchor: () => {}, openTerminal: () => {}, showLog: () => {} };
    return { h, posted, refreshes: () => refreshed };
  }

  // @spec EXT-DECK-003
  it("enables Commit only when the session would accept the commitment", async () => {
    const s = setup();
    const { h, posted } = hooks();
    await handleMessage(s.session, h, { type: "check", cardId: "D1", option: 0, rationale: "" });
    await handleMessage(s.session, h, { type: "check", cardId: "D1", option: 0, rationale: "seems fine" });
    expect(posted).toEqual([{ type: "checkResult", cardId: "D1", ok: false, reason: expect.stringMatching(/rationale/) }, { type: "checkResult", cardId: "D1", ok: true, reason: "" }]);
    expect(renderPanel(model(s), "n", "csp")).toMatch(/<button class="commit" data-card="D1" disabled>/);
  });

  // @spec EXT-DECK-004
  it("reveals right after a commitment and shows the recommendation", async () => {
    const s = setup();
    const { h } = hooks();
    await handleMessage(s.session, h, { type: "commit", cardId: "D1", option: 0, rationale: "seems fine" });
    expect(s.session.state("D1")).toBe("revealed");
    expect(renderPanel(model(s), "n", "csp")).toContain("Cap is safer.");
  });

  // @spec EXT-DECK-005
  it("asks for a reason before changing an answer", async () => {
    const s = setup();
    const { h, posted } = hooks();
    await handleMessage(s.session, h, { type: "commit", cardId: "D1", option: 0, rationale: "seems fine" });
    await handleMessage(s.session, { ...h, askReason: async () => undefined }, { type: "change", cardId: "D1", option: 1 });
    expect(posted).toContainEqual({ type: "error", message: "Changing an answer needs a reason." });
    await handleMessage(s.session, h, { type: "change", cardId: "D1", option: 1 });
    expect(s.store.reader("r1").readRecord("rev")!.answers[0].changes[0]).toMatchObject({ reason: "Changed my mind.", to: 1 });
  });

  // @spec EXT-ASK-001
  it("sends questions through the session and shows them under the card", async () => {
    const s = setup();
    const { h } = hooks();
    await handleMessage(s.session, h, { type: "ask", cardId: "D1", question: "What happens on 429?" });
    expect(s.asked).toEqual(["What happens on 429?"]);
    const html = renderPanel(model(s), "n", "csp");
    expect(html).toContain("Q: What happens on 429?");
    expect(html).toContain("A: What happens on 429?");
  });
});

interface FakeThread { body: string; canReply?: boolean; disposed: boolean; dispose(): void }

/** A comment controller like VS Code's: a frozen object that cannot hold extra properties. */
function fakeController(failWhen: () => boolean = () => false) {
  const threads: FakeThread[] = [];
  const controller = Object.freeze({
    createCommentThread: (_u: unknown, _r: unknown, comments: { body: { value: string } }[]) => {
      if (failWhen()) throw new Error("flaky controller");
      const t: FakeThread = { body: comments[0].body.value, canReply: true, disposed: false, dispose() { t.disposed = true; } };
      threads.push(t);
      return t;
    },
    dispose() {},
  });
  return { controller, threads, live: () => threads.filter((t) => !t.disposed) };
}

describe("findings", () => {
  const f = (id: string, cohort: string, severity: string, state = "open") => ({ id, cohort, severity, state, title: id, fingerprint: id, anchors: [anchor("a.ts")] }) as never;

  // @spec EXT-VIEW-006
  it("groups offered findings by cohort, then severity", () => {
    const tree = buildFindingsTree([f("F1", "Upload", "low"), f("F2", "other", "high"), f("F3", "Upload", "critical")]);
    expect(tree.map((n) => n.label)).toEqual(["Upload", "other"]);
    expect(tree[0].children.map((n) => [n.label, n.children.map((x) => x.label)])).toEqual([["critical", ["F3"]], ["low", ["F1"]]]);
  });

  // @spec EXT-VIEW-007
  it("offers dismiss and mark fixed on open findings, and reopen otherwise", () => {
    expect(findingActions("open")).toEqual(["dismissed", "fixed"]);
    expect(findingActions("dismissed")).toEqual(["open"]);
    const manifest = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
    expect(manifest.contributes.commands.map((c: { command: string }) => c.command)).toEqual(expect.arrayContaining(["duet.finding.dismissed", "duet.finding.fixed", "duet.finding.open"]));
  });

  // @spec EXT-VIEW-008
  it("puts a read-only comment thread at each card's and finding's anchors", () => {
    const s = setup();
    mkdirSync(join(s.repo, "src"), { recursive: true });
    writeFileSync(join(s.repo, "src/upload.ts"), "a\nb\nc\nd\n");
    s.p.write("findings", { schema_version: "1.0", findings: [{ id: "F1", category: "bug", severity: "high", confidence: 90, title: "Unbounded", anchors: [anchor("src/upload.ts", 1, 1)], evidence: "e", found_by: ["bugs"], related_cards: [], verification: { status: "confirmed", by: "verifier", notes: "" }, fingerprint: "ffp1" }], coverage: { reviewed: [], skipped: [] }, exploration: { context_gathered: "", budget: "", not_examined: [] } });
    const { controller, threads } = fakeController();
    createCommentThreads(controller as never).refresh(s.session, s.repo);
    expect(threads.map((t) => t.body)).toEqual([expect.stringMatching(/Decision:.*Question D1/), expect.stringMatching(/Decision:.*Question D2/), expect.stringMatching(/high finding:.*Unbounded/)]);
    expect(threads.every((t) => t.canReply === false)).toBe(true);
  });

  // @spec EXT-VIEW-014
  it("never accumulates threads across refreshes, even on a frozen controller or after a refresh that failed partway", () => {
    const s = setup();
    mkdirSync(join(s.repo, "src"), { recursive: true });
    writeFileSync(join(s.repo, "src/upload.ts"), "a\nb\nc\nd\n");
    const { controller, live } = fakeController();
    const comments = createCommentThreads(controller as never);
    for (let i = 0; i < 5; i++) comments.refresh(s.session, s.repo);
    expect(live()).toHaveLength(2);
    let calls = 0;
    const flaky = fakeController(() => ++calls === 2);
    const c2 = createCommentThreads(flaky.controller as never);
    expect(() => c2.refresh(s.session, s.repo)).toThrow(/flaky/);
    c2.refresh(s.session, s.repo);
    expect(flaky.live()).toHaveLength(2);
    c2.dispose();
    expect(flaky.live()).toHaveLength(0);
  });

  // @spec EXT-VIEW-015
  it("shows one thread per distinct file, lines, and text", () => {
    const s = setup({ cards: [card("D1", "high", "S1", { anchors: [anchor("src/upload.ts"), anchor("src/upload.ts")] }), card("D2", "low", "S2", { anchors: [anchor("src/upload.ts")] })] });
    mkdirSync(join(s.repo, "src"), { recursive: true });
    writeFileSync(join(s.repo, "src/upload.ts"), "a\nb\nc\nd\n");
    const { controller, live } = fakeController();
    createCommentThreads(controller as never).refresh(s.session, s.repo);
    expect(live().map((t) => t.body)).toEqual([expect.stringMatching(/Question D1/), expect.stringMatching(/Question D2/)]);
  });
});

describe("anchors", () => {
  // @spec EXT-VIEW-009
  it("finds code by its pattern when the lines have moved", () => {
    const text = "x\ny\nwhile (true) {\n}\n";
    expect(locateAnchor(text, anchor("f", 3, 3, "while \\(true\\)"))).toEqual({ start: 3, end: 3 });
    expect(locateAnchor("new line\n" + text, anchor("f", 3, 3, "while \\(true\\)"))).toEqual({ start: 4, end: 4 });
    expect(locateAnchor(text, anchor("f", 3, 3))).toEqual({ start: 3, end: 3 });
  });
});

describe("terminal", () => {
  const c = card("D1", "high");

  // @spec EXT-ASK-002
  it("starts interactive Claude in the head worktree with the card and its files", () => {
    const l = terminalLaunch(c, { worktree: "/w", runDir: "/repo/.duet/r1", mayReveal: true, recommendationText: "option 1" });
    expect(l).toMatchObject({ cwd: "/w", command: "claude" });
    const prompt = l.args[l.args.length - 1];
    expect(prompt).toContain("Question D1?");
    expect(prompt).toContain("src/upload.ts:2-3");
  });

  // @spec EXT-ASK-003
  it("withholds the recommendation and denies reading the run directory until the reviewer may see it", () => {
    const l = terminalLaunch(c, { worktree: "/w", runDir: "/repo/.duet/r1", mayReveal: false });
    const prompt = l.args[l.args.length - 1];
    expect(prompt).toMatch(/do not tell me which option you would choose/);
    expect(l.args[0]).toBe("--settings");
    expect(JSON.parse(l.args[1]).permissions.deny).toEqual(["Read(//repo/.duet/r1/**)"]);
    expect(terminalLaunch(c, { worktree: "/w", runDir: "/r", mayReveal: true, recommendationText: "x" }).args).not.toContain("--settings");
  });
});

describe("starting and opening reviews", () => {
  // @spec EXT-CMD-001, EXT-CMD-009
  it("offers branch, working tree, or pull request, asking a working-tree author for their statement first", () => {
    expect(startQuestions("branch")).toEqual(["base", "statement", "plan"]);
    expect(startQuestions("pr")).toEqual(["pr", "statement", "plan"]);
    expect(startQuestions("worktree")[0]).toBe("statement");
  });

  // @spec EXT-CMD-008
  it("passes the statement and agent plan to the engine", () => {
    expect(runArgs({ change: { kind: "worktree", base: "main" }, statement: " I meant X ", planFile: "/p.md" })).toEqual(["run", "--worktree", "--base", "main", "--statement", "I meant X", "--plan", "/p.md"]);
    expect(runArgs({ change: { kind: "pr", number: 7 } })).toEqual(["run", "--pr", "7"]);
  });

  // @spec EXT-CMD-002
  it("runs the engine as a background child process and learns the run id early", async () => {
    const dir = mkdtempSync(join(tmpdir(), "duet-cli-"));
    const script = join(dir, "fake.mjs");
    writeFileSync(script, `process.stderr.write("duet-run abc123 /x/.duet/abc123\\n"); setTimeout(() => { process.stdout.write(JSON.stringify({ runId: "abc123", args: process.argv.slice(2) })); }, 50);`);
    let early = "";
    const h = startEngine(process.execPath, script, ["run", "--pr", "1"], dir, (id) => (early = id));
    expect(h.pid).toBeGreaterThan(0);
    const res = await h.done;
    expect(early).toBe("abc123");
    expect(JSON.parse(res.stdout).args).toEqual(["run", "--pr", "1"]);
  });

  // @spec EXT-CMD-010
  it("offers the plan or transcript as context explaining the change, not as a choice of agent", () => {
    expect(PLAN_PROMPT).toBe("Attach a plan or transcript explaining why this change was made? (optional)");
    expect(PLAN_CHOICES).toEqual({ skip: "No, skip", choose: "Choose a plan or transcript file… (e.g. a Claude Code session)" });
  });

  // @spec EXT-LOG-001
  it("hands each complete standard-error line to the caller as it arrives", async () => {
    const dir = mkdtempSync(join(tmpdir(), "duet-cli-"));
    const script = join(dir, "fake.mjs");
    writeFileSync(script, `process.stderr.write("duet: intent: run"); setTimeout(() => { process.stderr.write("ning\\nduet-run abc /x\\nduet: intent: complete in 1s\\n"); }, 30);`);
    const lines: string[] = [];
    let early = "";
    await startEngine(process.execPath, script, [], dir, (id) => (early = id), (l) => lines.push(l)).done;
    expect(lines).toEqual(["duet: intent: running", "duet-run abc /x", "duet: intent: complete in 1s"]);
    expect(early).toBe("abc");
  });

  // @spec EXT-CMD-005
  it("explains an engine error with the stage states", () => {
    const run = { stages: { intent: { status: "complete" }, briefing: { status: "failed", error: "bad output" } } } as never;
    expect(engineExitMessage(1, "duet: Claude CLI call briefing failed\n", run)).toBe("Duet's engine stopped with an error: duet: Claude CLI call briefing failed. Stages: intent: complete; briefing: failed (bad output)");
    expect(engineExitMessage(0, "", run)).toBeNull();
  });

  // @spec EXT-CMD-003
  it("lists existing runs, newest first", () => {
    const s = setup();
    const runs = listRuns(s.store.root);
    expect(runs.map((r) => [r.runId, r.title])).toEqual([["r1", "Retry uploads"]]);
  });

  // @spec EXT-CMD-004, EXT-CMD-007
  it("notices file changes in a run directory while its engine is still writing", async () => {
    const s = setup();
    const changed: string[] = [];
    const w = watchRun(s.store.runDir("r1"), (f) => changed.push(f), 20);
    s.p.setStage("findings", { status: "complete" });
    await new Promise((r) => setTimeout(r, 200));
    w.close();
    expect(changed).toContain("run.json");
  });

  // @spec EXT-CMD-006
  it("never reads recommendations.json itself", () => {
    const src = join(__dirname, "..", "src");
    const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : [join(d, e.name)]));
    for (const f of files(src)) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/recommendations\.json|read\(\s*["']recommendations["']|getRecommendation\(/);
    }
  });
});

describe("posting the decision log", () => {
  function flow() {
    const s = setup();
    const sent: string[] = [];
    const inner: Sink = { name: "fake", async send(_t, text) { sent.push(text); } };
    return { s, sent, flow: new PostFlow(s.session, "pr#9", guardSink(inner)) };
  }

  // @spec EXT-POST-001
  it("starts from the session's exact decision log, editable", () => {
    const { s, flow: f } = flow();
    expect(f.draft).toBe(s.session.decisionLog());
    f.edit("edited text");
    expect(f.draft).toBe("edited text");
  });

  // @spec EXT-POST-002
  it("posts exactly the approved text through a signed post and records it", async () => {
    const { s, sent, flow: f } = flow();
    f.edit("Final log");
    f.approve();
    expect(await f.post()).toMatchObject({ ok: true });
    expect(sent).toEqual(["Final log"]);
    expect(s.store.reader("r1").readRecord("rev")!.posted).toHaveLength(1);
  });

  // @spec EXT-POST-003
  it("requires approval again after an edit", async () => {
    const { sent, flow: f } = flow();
    f.approve();
    f.edit("sneaky change");
    expect(f.approved).toBe(false);
    expect(await f.post()).toEqual({ ok: false, error: "Approve the exact text before posting." });
    expect(sent).toEqual([]);
  });
});

/** Fills the vscode stub with recording fakes, activates the extension, and returns what it recorded. */
function activateWithFakes(repo: string, engineScript: string) {
  const ext = mkdtempSync(join(tmpdir(), "duet-extpath-"));
  mkdirSync(join(ext, "dist", "engine"), { recursive: true });
  writeFileSync(join(ext, "dist", "engine", "duet.mjs"), engineScript);
  const rec = {
    handlers: {} as Record<string, (...a: unknown[]) => Promise<unknown> | unknown>,
    errors: [] as string[],
    warnings: [] as string[],
    infos: [] as string[],
    quickPicks: [] as { items: unknown[]; opts: { placeHolder?: string } }[],
    channel: { name: "", lines: [] as string[], shown: 0 },
    status: { text: "", command: "" as unknown, visible: false },
    progress: [] as { location: unknown; reports: { message?: string; increment?: number }[] }[],
    panels: [] as { htmlSets: number; html: string; send(m: unknown): void }[],
    opened: [] as string[],
    planPick: "No, skip",
    openPick: undefined as string | undefined,
  };
  Object.assign(vscode.workspace, {
    workspaceFolders: [{ uri: { fsPath: repo } }],
    getConfiguration: () => ({ get: (k: string) => (k === "nodePath" ? process.execPath : undefined) }),
    openTextDocument: async (x: unknown) => {
      rec.opened.push(typeof x === "string" ? x : JSON.stringify(x));
      return { getText: () => "" };
    },
  });
  Object.assign(vscode.window, {
    showQuickPick: async (items: unknown[], opts: { placeHolder?: string }) => {
      rec.quickPicks.push({ items, opts });
      if (typeof items[0] === "string") return (items as string[]).find((i) => i === rec.planPick);
      const withRun = (items as { runId?: string }[]).find((i) => i.runId && i.runId === rec.openPick);
      return withRun ?? items[0];
    },
    showInputBox: async (o: { value?: string }) => o.value ?? "",
    showOpenDialog: async () => undefined,
    showErrorMessage: async (m: string) => void rec.errors.push(m),
    showWarningMessage: async (m: string) => void rec.warnings.push(m),
    showInformationMessage: async (m: string) => void rec.infos.push(m),
    showTextDocument: async () => ({}),
    setStatusBarMessage: () => ({ dispose() {} }),
    registerTreeDataProvider: () => ({ dispose() {} }),
    createOutputChannel: (name: string) => {
      rec.channel.name = name;
      return { appendLine: (l: string) => void rec.channel.lines.push(l), append: () => {}, show: () => void rec.channel.shown++, clear: () => {}, dispose() {} };
    },
    createStatusBarItem: () => ({
      get text() { return rec.status.text; },
      set text(v: string) { rec.status.text = v; },
      get command() { return rec.status.command; },
      set command(v: unknown) { rec.status.command = v; },
      tooltip: "",
      show() { rec.status.visible = true; },
      hide() { rec.status.visible = false; },
      dispose() {},
    }),
    withProgress: async (opts: { location: unknown }, task: (p: { report(x: { message?: string; increment?: number }): void }) => Promise<unknown>) => {
      const entry = { location: opts.location, reports: [] as { message?: string; increment?: number }[] };
      rec.progress.push(entry);
      return task({ report: (x) => void entry.reports.push(x) });
    },
    createWebviewPanel: () => {
      let listener: (m: unknown) => void = () => {};
      let html = "";
      const p = { htmlSets: 0, html: "", send: (m: unknown) => listener(m) };
      rec.panels.push(p);
      return {
        title: "",
        webview: {
          cspSource: "csp",
          get html() { return html; },
          set html(v: string) { html = v; p.html = v; p.htmlSets++; },
          onDidReceiveMessage: (cb: (m: unknown) => void) => void (listener = cb),
          postMessage: async () => true,
        },
        onDidDispose: () => {},
        dispose() {},
        reveal() {},
      };
    },
  });
  Object.assign(vscode.commands, {
    registerCommand: (id: string, fn: (...a: unknown[]) => unknown) => {
      rec.handlers[id] = fn as never;
      return { dispose() {} };
    },
  });
  Object.assign(vscode.comments, { createCommentController: () => fakeController().controller });
  activate({ extensionPath: ext, subscriptions: [] } as never);
  return rec;
}

const fakeEngine = (runDir: string) => `process.stderr.write("duet-run r1 ${runDir}\\n");
process.stderr.write("duet: findings: running\\n");
setTimeout(() => { process.stdout.write(JSON.stringify({ runId: "r1", runDir: ${JSON.stringify(runDir)}, stages: {} }) + "\\n"); }, 400);`;

describe("start review, progress, and logs", () => {
  // @spec EXT-CMD-011, EXT-CMD-010, EXT-LOG-001, EXT-LOG-003, EXT-LOG-004, EXT-VIEW-017
  it("starts a review that succeeds without any error, streaming the engine's output and showing progress", async () => {
    const s = setup();
    mkdirSync(join(s.repo, "src"), { recursive: true });
    writeFileSync(join(s.repo, "src/upload.ts"), "a\nb\nc\nd\n");
    const rec = activateWithFakes(s.repo, fakeEngine(s.store.runDir("r1")));
    await rec.handlers["duet.startReview"]();
    expect(rec.errors).toEqual([]);
    expect(rec.warnings).toEqual([]);
    expect(rec.quickPicks[1].opts.placeHolder).toBe(PLAN_PROMPT);
    expect(rec.quickPicks[1].items).toEqual([PLAN_CHOICES.skip, PLAN_CHOICES.choose]);
    expect(rec.channel.name).toBe("Duet");
    expect(rec.channel.lines).toEqual(expect.arrayContaining([expect.stringMatching(/^duet-run r1 /), "duet: findings: running"]));
    expect(rec.channel.shown).toBe(0);
    expect(rec.progress).toHaveLength(1);
    expect(rec.progress[0].location).toBe(vscode.ProgressLocation.Notification);
    expect(rec.progress[0].reports.map((r) => r.message)).toContain("4/6 stages · findings…");
    expect(rec.status).toMatchObject({ text: "Duet: 4/6 stages · findings…", command: "duet.showLog", visible: true });
    expect(rec.panels).toHaveLength(1);
    expect(rec.panels[0].htmlSets).toBe(1);
    s.p.setStage("findings", { status: "complete" });
    await new Promise((r) => setTimeout(r, 400));
    expect(rec.panels[0].htmlSets).toBe(2);
    expect(rec.status.text).toBe("Duet: 5/6 stages");
  });

  // @spec EXT-LOG-002, EXT-VIEW-013
  it("shows the live output channel for a run started here, and the run's engine.log for a reopened one", async () => {
    const s = setup();
    const rec = activateWithFakes(s.repo, fakeEngine(s.store.runDir("r1")));
    await rec.handlers["duet.startReview"]();
    await rec.handlers["duet.showLog"]();
    expect(rec.channel.shown).toBe(1);
    rec.panels[0].send({ type: "showLog" });
    await new Promise((r) => setTimeout(r, 20));
    expect(rec.channel.shown).toBe(2);
    const other = s.store.pipeline("r2");
    other.initRun({ base: "c".repeat(40), head: HEAD, title: "Other" });
    other.appendLog("2026-01-01T00:00:00.000Z duet: intent: running");
    rec.openPick = "r2";
    await rec.handlers["duet.openReview"]();
    await rec.handlers["duet.showLog"]();
    expect(rec.opened).toContain(join(s.store.runDir("r2"), "engine.log"));
    expect(rec.channel.shown).toBe(2);
  });
});

describe("panel progress and view state", () => {
  // @spec EXT-LOG-003, EXT-LOG-004
  it("counts complete stages out of the total and names the running ones", () => {
    const p = stageProgress([
      { name: "context", status: "complete" },
      { name: "intent", status: "complete" },
      { name: "briefing", status: "running" },
      { name: "cards", status: "pending" },
      { name: "recommendations", status: "pending" },
      { name: "findings", status: "running" },
    ]);
    expect(p).toEqual({ done: 2, total: 6, percent: 33, running: ["briefing", "findings"] });
    expect(progressText(p)).toBe("2/6 stages · briefing, findings…");
    expect(progressText(stageProgress([{ name: "context", status: "complete" }]))).toBe("1/1 stages");
  });

  // @spec EXT-VIEW-013
  it("shows a progress bar and a Show log control in the stage strip", () => {
    const html = renderPanel(model(setup()), "n", "csp");
    expect(html).toContain('<div class="progress"><div class="progress-bar" style="width:67%"></div></div>');
    expect(html).toContain('<button class="log-link" data-action="show-log">Show log</button>');
  });

  // @spec EXT-VIEW-013
  it("routes Show log from the panel to the extension", async () => {
    const s = setup();
    let shown = 0;
    let refreshed = 0;
    const h: ControllerHooks = { post: () => {}, refresh: () => void refreshed++, askReason: async () => "", openAnchor: () => {}, openTerminal: () => {}, showLog: () => void shown++ };
    await handleMessage(s.session, h, { type: "showLog" });
    expect([shown, refreshed]).toEqual([1, 0]);
  });

  // @spec EXT-VIEW-016
  it("keeps the active tab, each tab's scroll position, and unsent input on uncommitted cards across a reload", () => {
    let saved: unknown;
    const api = { postMessage: () => {}, getState: () => saved, setState: (s: unknown) => void (saved = JSON.parse(JSON.stringify(s))) };
    const first = fakePanelDom();
    runClient(first, api);
    first.scroll(300);
    first.el("tab-decisions-button").onclick!();
    first.scroll(120);
    first.el("ask-D1").value = "Why five?";
    first.el("ask-D1").oninput!();
    first.el("opt-D1-1").checked = true;
    first.el("opt-D1-1").onchange!();
    first.el("rat-D1").value = "Bounded is safer";
    first.el("rat-D1").oninput!();

    const second = fakePanelDom();
    runClient(second, api);
    expect(second.el("tab-decisions-button").classList.contains("active")).toBe(true);
    expect(second.el("tab-decisions").classList.contains("hidden")).toBe(false);
    expect(second.doc.scrollingElement.scrollTop).toBe(120);
    expect(second.el("ask-D1").value).toBe("Why five?");
    expect(second.el("opt-D1-1").checked).toBe(true);
    expect(second.el("rat-D1").value).toBe("Bounded is safer");
    second.el("tab-briefing-button").onclick!();
    expect(second.doc.scrollingElement.scrollTop).toBe(300);

    const committed = fakePanelDom({ committed: true });
    runClient(committed, api);
    expect(committed.el("rat-D1").value).toBe("");
    expect(committed.el("opt-D1-1").checked).toBe(false);
  });
});

interface FakeEl {
  key: string;
  tag: string;
  id: string;
  classList: { contains(c: string): boolean; toggle(c: string, on?: boolean): void; add(c: string): void };
  dataset: Record<string, string>;
  attrs: Record<string, string>;
  parent: FakeEl | null;
  value: string;
  checked: boolean;
  disabled: boolean;
  textContent: string;
  onclick?: (e?: unknown) => void;
  oninput?: () => void;
  onchange?: () => void;
  querySelector(sel: string): FakeEl | null;
  querySelectorAll(sel: string): FakeEl[];
}

/** The parts of the panel's DOM its script touches: two tabs and one card. Supports simple selectors only. */
function fakePanelDom(opts: { committed?: boolean } = {}) {
  const all: FakeEl[] = [];
  const matches = (e: FakeEl, compound: string): boolean => {
    const m = /^([a-z]+)?(#[\w-]+)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)(:checked)?$/.exec(compound);
    if (!m) throw new Error(`unsupported selector ${compound}`);
    if (m[1] && e.tag !== m[1]) return false;
    if (m[2] && e.id !== m[2].slice(1)) return false;
    for (const c of m[3].split(".").filter(Boolean)) if (!e.classList.contains(c)) return false;
    for (const a of m[4].match(/\[[^\]]+\]/g) ?? []) {
      const [, k, quoted, bare] = /^\[([\w-]+)(?:=(?:"([^"]*)"|([\w-]+)))?\]$/.exec(a)!;
      const want = quoted ?? bare;
      if (!(k in e.attrs) || (want !== undefined && e.attrs[k] !== want)) return false;
    }
    if (m[5] && !e.checked) return false;
    return true;
  };
  const within = (root: FakeEl | null, sel: string) => {
    const parts = sel.trim().split(/\s+/);
    return all.filter((e) => {
      if (!matches(e, parts[parts.length - 1])) return false;
      let anc = e.parent;
      for (let i = parts.length - 2; i >= 0; i--) {
        while (anc && !matches(anc, parts[i])) anc = anc.parent;
        if (!anc) return false;
        anc = anc.parent;
      }
      if (root) {
        let p = e.parent;
        while (p && p !== root) p = p.parent;
        if (!p) return false;
      }
      return true;
    });
  };
  const make = (key: string, tag: string, attrs: Record<string, string>, parent: FakeEl | null): FakeEl => {
    const classes = new Set((attrs.class ?? "").split(" ").filter(Boolean));
    const el: FakeEl = {
      key, tag, id: attrs.id ?? "", attrs, parent, value: attrs.value ?? "", checked: false, disabled: "disabled" in attrs, textContent: "",
      classList: { contains: (c) => classes.has(c), toggle: (c, on) => void ((on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c)), add: (c) => void classes.add(c) },
      dataset: Object.fromEntries(Object.entries(attrs).filter(([k]) => k.startsWith("data-")).map(([k, v]) => [k.slice(5).replace(/-(\w)/g, (_, c: string) => c.toUpperCase()), v])),
      querySelector: (sel) => within(el, sel)[0] ?? null,
      querySelectorAll: (sel) => within(el, sel),
    };
    all.push(el);
    return el;
  };
  const dis: Record<string, string> = opts.committed ? { disabled: "" } : {};
  make("tab-briefing-button", "button", { class: "tab active", "data-tab": "briefing" }, null);
  make("tab-decisions-button", "button", { class: "tab", "data-tab": "decisions" }, null);
  make("tab-briefing", "div", { class: "tabpane", id: "tab-briefing" }, null);
  const pane = make("tab-decisions", "div", { class: "tabpane hidden", id: "tab-decisions" }, null);
  const cardEl = make("card-D1", "section", { class: "card", id: "card-D1", "data-card": "D1" }, pane);
  const fs = make("fs-D1", "fieldset", { ...dis }, cardEl);
  make("opt-D1-0", "input", { type: "radio", name: "opt-D1", value: "0" }, fs);
  make("opt-D1-1", "input", { type: "radio", name: "opt-D1", value: "1" }, fs);
  make("rat-D1", "textarea", { class: "rationale", "data-card": "D1", ...dis }, cardEl);
  make("commit-D1", "button", { class: "commit", "data-card": "D1", disabled: "" }, cardEl);
  make("ask-D1", "input", { class: "ask", "data-card": "D1" }, cardEl);
  make("askbtn-D1", "button", { class: "ask-btn", "data-card": "D1" }, cardEl);
  make("log", "button", { class: "log-link", "data-action": "show-log" }, null);
  const listeners: Record<string, (() => void)[]> = {};
  const doc = {
    scrollingElement: { scrollTop: 0 },
    querySelector: (sel: string) => within(null, sel)[0] ?? null,
    querySelectorAll: (sel: string) => within(null, sel),
    createElement: (tag: string) => make("new", tag, {}, null),
    body: { prepend() {} },
  };
  const win = { addEventListener: (t: string, fn: () => void) => void (listeners[t] ??= []).push(fn) };
  return {
    doc,
    win,
    el: (key: string) => all.find((e) => e.key === key)!,
    scroll: (y: number) => {
      doc.scrollingElement.scrollTop = y;
      (listeners.scroll ?? []).forEach((f) => f());
    },
  };
}

function runClient(dom: ReturnType<typeof fakePanelDom>, api: unknown) {
  new Function("acquireVsCodeApi", "document", "window", CLIENT)(() => api, dom.doc, dom.win);
}
