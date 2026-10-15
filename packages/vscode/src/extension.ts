import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, type FSWatcher, readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { ghSink, guardSink, loadConfig } from "@duet/adapters";
import { reviewerIdentity, ReviewSession } from "@duet/session";
import { type Anchor, openStore, type RunManifest, type Store } from "@duet/store";
import { locateAnchor } from "./anchors.ts";
import { engineExitMessage, PLAN_CHOICES, PLAN_PROMPT, runArgs, type StartAnswers, startEngine, startQuestions } from "./engineProcess.ts";
import { buildFindingsTree, findingActions, type FindingsNode } from "./findings.ts";
import { handleMessage, type PanelMessage } from "./panel/controller.ts";
import { renderPanel } from "./panel/html.ts";
import { buildPanelModel } from "./panel/model.ts";
import { githubLinkBase, PostFlow } from "./post.ts";
import { progressText, runStages, stageProgress } from "./progress.ts";
import { listRuns, watchRun } from "./runs.ts";
import { terminalLaunch } from "./terminal.ts";

interface OpenReview {
  runId: string;
  runDir: string;
  session: ReviewSession;
  panel: vscode.WebviewPanel;
  refresh(): void;
}

let current: OpenReview | null = null;

function repoRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

const linkBases = new Map<string, string | undefined>();
/** The GitHub web address of the repository's origin remote, for permalinks in the review comment. */
// @spec EXT-POST-006
function linkBase(root: string): string | undefined {
  if (!linkBases.has(root)) {
    let remote = "";
    try {
      remote = execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      // No origin remote.
    }
    linkBases.set(root, githubLinkBase(remote));
  }
  return linkBases.get(root);
}

function nodePath(): string {
  return vscode.workspace.getConfiguration("duet").get<string>("nodePath") || "node";
}

export function activate(context: vscode.ExtensionContext): void {
  const cli = join(context.extensionPath, "dist", "engine", "duet.mjs");
  const findings = new FindingsProvider();
  const controller = vscode.comments.createCommentController("duet", "Duet");
  const threads = createCommentThreads(controller);
  const log = vscode.window.createOutputChannel("Duet");
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  status.command = "duet.showLog";
  status.tooltip = "Show Duet's log";
  /** Runs whose engine this window started; their log is the output channel. */
  const startedHere = new Set<string>();
  context.subscriptions.push(controller, threads, log, status, vscode.window.registerTreeDataProvider("duet.findings", findings));

  const setup = () => {
    const root = repoRoot();
    if (!root) throw new Error("Open a folder with a git repository to use Duet.");
    const config = loadConfig({ repoRoot: root });
    const store = openStore({ repoRoot: root, root: config.root, tracked: config.tracked });
    return { root, config, store, reviewer: reviewerIdentity(root, config.reviewer) };
  };

  // @spec EXT-LOG-003
  const showStatus = (run: RunManifest | null) => {
    if (!run) return void status.hide();
    status.text = `Duet: ${progressText(stageProgress(runStages(run)))}`;
    status.show();
  };

  // @spec EXT-LOG-002
  const showLog = async () => {
    if (!current || startedHere.has(current.runId)) return void log.show(true);
    const path = join(current.runDir, "engine.log");
    if (!existsSync(path)) return void vscode.window.showInformationMessage("This review has no engine log yet.");
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(path), { preview: true });
  };

  /** The review-comment draft being edited, while one is open. */
  let draft: { doc: vscode.TextDocument; flow: PostFlow; pr: string } | null = null;
  const setDraftContext = (on: boolean) => void vscode.commands.executeCommand("setContext", "duet.reviewCommentDraft", on);
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor?.((e) => setDraftContext(!!draft && e?.document === draft.doc)) ?? { dispose() {} },
  );

  // @spec EXT-POST-002, EXT-POST-003, EXT-POST-008
  const approveAndPost = async () => {
    if (!draft) return;
    const { doc, flow, pr } = draft;
    flow.edit(doc.getText());
    flow.approve();
    const result = await flow.post();
    if (!result.ok) return void vscode.window.showErrorMessage(`Not posted: ${result.error}`);
    draft = null;
    setDraftContext(false);
    void vscode.window.showInformationMessage(`Posted to pull request #${pr}.`);
  };

  const postComment = async () => {
    if (!current) return void vscode.window.showInformationMessage("Open a Duet review first.");
    const { root, store } = setup();
    const recorded = store.reader(current.runId).read("run")?.pr;
    const pr = recorded !== undefined ? String(recorded) : await vscode.window.showInputBox({ prompt: "Post the review comment to pull request #", validateInput: (v) => (/^\d+$/.test(v) ? null : "Enter a number"), ignoreFocusOut: true });
    if (!pr) return;
    const flow = new PostFlow(current.session, `pr#${pr}`, guardSink(ghSink({ cwd: root })), { linkBase: linkBase(root) });
    const doc = await vscode.workspace.openTextDocument({ language: "markdown", content: flow.draft });
    await vscode.window.showTextDocument(doc);
    draft = { doc, flow, pr };
    setDraftContext(true);
    const choice = await vscode.window.showInformationMessage(
      `Edit the comment if you like, then post it to pull request #${pr} here or with the Post button in the editor's title bar. What is in the editor when you approve is what gets posted.`,
      "Approve and post",
    );
    if (choice === "Approve and post" && draft?.doc === doc) await approveAndPost();
  };

  const open = (runId: string) => {
    const { root, config, store, reviewer } = setup();
    current?.panel.dispose();
    const session = new ReviewSession({
      store,
      runId,
      reviewer,
      confidenceThreshold: config.confidenceThreshold,
      ask: async ({ cardId, question, mayReveal }) => {
        const args = ["ask", "--run", runId, "--card", cardId, "--question", question, "--reviewer", reviewer, ...(mayReveal ? ["--may-see-recommendation"] : [])];
        const res = await startEngine(nodePath(), cli, args, root).done;
        if (res.code !== 0) throw new Error(res.stderr.trim() || "Claude could not answer");
        return res.stdout.trim();
      },
    });
    const panel = vscode.window.createWebviewPanel("duet.review", "Duet review", vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
    let rendered = "";
    const refresh = () => {
      const reader = store.reader(runId);
      const run = reader.read("run");
      panel.title = `Duet: ${run?.title ?? runId}`;
      const model = buildPanelModel(reader, session, reviewer);
      // @spec EXT-VIEW-017
      const content = renderPanel(model, "", panel.webview.cspSource);
      if (content !== rendered) {
        rendered = content;
        panel.webview.html = renderPanel(model, randomBytes(16).toString("hex"), panel.webview.cspSource);
      }
      findings.update(session);
      threads.refresh(session, root);
      showStatus(run);
      void sendPreview();
    };
    // @spec EXT-POST-007
    const sendPreview = async () => {
      try {
        const html = await vscode.commands.executeCommand<string>("markdown.api.render", session.reviewComment({ linkBase: linkBase(root) }));
        void panel.webview.postMessage({ type: "preview", html });
      } catch {
        // No markdown renderer or no run yet: the preview stays empty.
      }
    };
    panel.webview.onDidReceiveMessage((m: PanelMessage) =>
      handleMessage(session, {
        post: (x) => void panel.webview.postMessage(x),
        refresh,
        askReason: () => Promise.resolve(vscode.window.showInputBox({ prompt: "Why are you changing your answer?", ignoreFocusOut: true })),
        openAnchor: (a) => void openAnchor(root, a),
        openTerminal: (cardId) => openTerminal(store, runId, session, cardId),
        showLog: () => void showLog(),
        postComment: () => void postComment(),
        ready: () => void sendPreview(),
      }, m),
    );
    // @spec EXT-CMD-004, EXT-CMD-007
    const watcher = watchRun(store.runDir(runId), refresh);
    panel.onDidDispose(() => {
      watcher.close();
      if (current?.panel === panel) {
        current = null;
        status.hide();
      }
    });
    current = { runId, runDir: store.runDir(runId), session, panel, refresh };
    refresh();
  };

  context.subscriptions.push(
    // @spec EXT-CMD-001, EXT-CMD-002, EXT-CMD-005, EXT-CMD-008, EXT-CMD-009, EXT-CMD-010, EXT-CMD-011, EXT-LOG-001, EXT-LOG-004
    vscode.commands.registerCommand("duet.startReview", async () => {
      const { root, store } = setup();
      const kind = await vscode.window.showQuickPick(
        [
          { label: "Current branch against a base", choice: "branch" as const },
          { label: "My working tree against a base", description: "for reviewing your own changes before committing", choice: "worktree" as const },
          { label: "A pull request", choice: "pr" as const },
        ],
        { placeHolder: "What do you want to review?" },
      );
      if (!kind) return;
      const answers: Partial<StartAnswers> & { base?: string; pr?: number } = {};
      for (const q of startQuestions(kind.choice)) {
        if (q === "base") {
          answers.base = await vscode.window.showInputBox({ prompt: "Base branch", value: "main", ignoreFocusOut: true });
          if (answers.base === undefined) return;
        } else if (q === "pr") {
          const n = await vscode.window.showInputBox({ prompt: "Pull request number", validateInput: (v) => (/^\d+$/.test(v) ? null : "Enter a number"), ignoreFocusOut: true });
          if (n === undefined) return;
          answers.pr = Number(n);
        } else if (q === "statement") {
          answers.statement = await vscode.window.showInputBox({
            prompt: kind.choice === "worktree" ? "In a line or two: what do you believe this change does, and why? (optional)" : "Optional: what does this change do and why, in your words?",
            ignoreFocusOut: true,
          });
        } else if (q === "plan") {
          const pick = await vscode.window.showQuickPick([PLAN_CHOICES.skip, PLAN_CHOICES.choose], { placeHolder: PLAN_PROMPT });
          if (pick === PLAN_CHOICES.choose) answers.planFile = (await vscode.window.showOpenDialog({ canSelectMany: false }))?.[0]?.fsPath;
        }
      }
      const change = kind.choice === "pr" ? { kind: "pr" as const, number: answers.pr! } : kind.choice === "worktree" ? { kind: "worktree" as const, base: answers.base! } : { kind: "branch" as const, base: answers.base! };
      const args = runArgs({ change, statement: answers.statement, planFile: answers.planFile });
      log.appendLine(`Starting: duet ${args.join(" ")}`);
      let announced: string | undefined;
      const res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Duet review" }, async (progress) => {
        let reported = 0;
        let watcher: FSWatcher | undefined;
        const report = (runId: string) => {
          const run = store.reader(runId).read("run");
          if (!run) return;
          const p = stageProgress(runStages(run));
          progress.report({ message: progressText(p), increment: p.percent - reported });
          reported = p.percent;
        };
        const handle = startEngine(nodePath(), cli, args, root, (runId, runDir) => {
          announced = runId;
          startedHere.add(runId);
          open(runId);
          report(runId);
          watcher = watchRun(runDir, (f) => f === "run.json" && report(runId));
        }, (line) => log.appendLine(line));
        try {
          return await handle.done;
        } finally {
          watcher?.close();
        }
      });
      const runId = /"runId":"([^"]+)"/.exec(res.stdout)?.[1] ?? announced;
      const message = engineExitMessage(res.code, res.stderr, runId ? store.reader(runId).read("run") : null);
      if (message && res.code !== 1) void vscode.window.showErrorMessage(message);
      else if (message) void vscode.window.showWarningMessage(message);
      if (runId && current?.runId === runId) current.refresh();
    }),
    // @spec EXT-CMD-003
    vscode.commands.registerCommand("duet.openReview", async () => {
      const { store } = setup();
      const runs = listRuns(store.root);
      if (!runs.length) return void vscode.window.showInformationMessage("No Duet reviews in this workspace yet.");
      const pick = await vscode.window.showQuickPick(
        runs.map((r) => ({ label: r.title, description: Object.entries(r.stages).map(([k, v]) => `${k} ${v}`).join(" · "), detail: new Date(r.updated).toLocaleString(), runId: r.runId })),
        { placeHolder: "Open a review" },
      );
      if (pick) open(pick.runId);
    }),
    // @spec EXT-LOG-002
    vscode.commands.registerCommand("duet.showLog", showLog),
    // @spec EXT-POST-001, EXT-POST-002, EXT-POST-003, EXT-POST-005
    vscode.commands.registerCommand("duet.postReviewComment", postComment),
    // @spec EXT-POST-008
    vscode.commands.registerCommand("duet.postReviewComment.approve", approveAndPost),
    // @spec EXT-VIEW-007
    ...(["dismissed", "fixed", "open"] as const).map((state) =>
      vscode.commands.registerCommand(`duet.finding.${state}`, (node: FindingsNode) => {
        if (!current || !node.finding) return;
        current.session.setFindingState(node.finding.fingerprint, state);
        current.refresh();
      }),
    ),
  );
}

export function deactivate(): void {
  current?.panel.dispose();
}

// @spec EXT-VIEW-009
async function openAnchor(root: string, a: Anchor): Promise<void> {
  const path = join(root, a.file);
  if (!existsSync(path)) return void vscode.window.showWarningMessage(`${a.file} is not in your working copy.`);
  const { start, end } = locateAnchor(readFileSync(path, "utf8"), a);
  const doc = await vscode.workspace.openTextDocument(path);
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(start - 1, 0, end - 1, Number.MAX_SAFE_INTEGER) });
}

// @spec EXT-ASK-002, EXT-ASK-003
function openTerminal(store: Store, runId: string, session: ReviewSession, cardId: string): void {
  const card = session.cards().find((c) => c.id === cardId);
  if (!card) return;
  const rec = session.recommendationFor(cardId);
  const runDir = store.runDir(runId);
  const worktree = existsSync(join(runDir, "head")) ? join(runDir, "head") : store.repoRoot;
  const launch = terminalLaunch(card, { worktree, runDir, mayReveal: !!rec, recommendationText: rec ? `option ${rec.option}: ${rec.reasoning}` : undefined });
  vscode.window.createTerminal({ name: `Duet: ${card.question.slice(0, 40)}`, cwd: launch.cwd, shellPath: launch.command, shellArgs: launch.args }).show();
}

/**
 * The read-only comment threads at card and finding anchors. The set is owned here, not stored on the
 * controller (VS Code's API objects are frozen); each thread is tracked as soon as it exists, and every
 * refresh disposes the previous set first, so threads never accumulate.
 */
// @spec EXT-VIEW-008, EXT-VIEW-014, EXT-VIEW-015
export function createCommentThreads(controller: vscode.CommentController): { refresh(session: ReviewSession, root: string): void; dispose(): void } {
  let threads: vscode.CommentThread[] = [];
  const dispose = () => {
    const old = threads;
    threads = [];
    for (const t of old) t.dispose();
  };
  const refresh = (session: ReviewSession, root: string) => {
    dispose();
    const seen = new Set<string>();
    const texts = new Map<string, string>();
    const add = (a: Anchor | undefined, body: string) => {
      if (!a) return;
      const path = join(root, a.file);
      if (!texts.has(path)) texts.set(path, existsSync(path) ? readFileSync(path, "utf8") : "");
      if (!existsSync(path)) return;
      const { start, end } = locateAnchor(texts.get(path)!, a);
      const key = JSON.stringify([path, start, end, body]);
      if (seen.has(key)) return;
      seen.add(key);
      const thread = controller.createCommentThread(vscode.Uri.file(path), new vscode.Range(start - 1, 0, end - 1, 0), [
        { body: new vscode.MarkdownString(body), mode: vscode.CommentMode.Preview, author: { name: "Duet" } },
      ]);
      threads.push(thread);
      thread.canReply = false;
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    };
    for (const c of session.cards()) for (const a of c.anchors) add(a, `**Decision:** ${c.question}\n\nAnswer it in the Duet review panel.`);
    for (const f of session.findings()) add(f.anchors[0], `**${f.severity} finding:** ${f.title}\n\n${f.evidence}`);
  };
  return { refresh, dispose };
}

class FindingsProvider implements vscode.TreeDataProvider<FindingsNode> {
  private nodes: FindingsNode[] = [];
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  // @spec EXT-VIEW-006
  update(session: ReviewSession): void {
    this.nodes = buildFindingsTree(session.findings());
    this.emitter.fire();
  }

  getChildren(node?: FindingsNode): FindingsNode[] {
    return node ? node.children : this.nodes;
  }

  getTreeItem(node: FindingsNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, node.children.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    if (node.finding) {
      item.tooltip = node.finding.evidence;
      item.contextValue = `finding-${findingActions(node.finding.state).join("-")}`;
      const a = node.finding.anchors[0];
      const root = repoRoot();
      if (root && a) item.command = { title: "Open", command: "vscode.open", arguments: [vscode.Uri.file(join(root, a.file)), { selection: new vscode.Range((a.start_line ?? 1) - 1, 0, (a.end_line ?? a.start_line ?? 1) - 1, 0) }] };
    }
    return item;
  }
}
