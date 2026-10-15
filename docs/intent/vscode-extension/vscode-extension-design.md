---
parent: high-level-design
prefix: EXT
---

# VS Code Extension

## Context and Design Philosophy

The extension is the first interface. It starts reviews, shows them as they fill in, and lets the reviewer work through the briefing, the deck, and the findings without leaving the editor, including asking Claude questions. It holds no review logic: it runs the engine, reads run files through the artifact store, and calls the review session for everything a reviewer does.

## Commands

- **Start review**: choose the change (the current branch against a base, the working tree against a base, or a pull request number) and run the engine in the background. The reviewer may add a line or two on what the change does and why, and may attach a plan or transcript explaining why the change was made (for example, the Claude Code session that wrote it). The attachment prompt reads "Attach a plan or transcript explaining why this change was made? (optional)" with the choices "No, skip" and "Choose a plan or transcript file… (e.g. a Claude Code session)", so it reads as supplying context, not as choosing who reviews. For a working-tree review the statement box is shown first, since the reviewer is usually the author. A review whose engine finishes without error ends the command quietly: no error or warning is shown.
- **Open review**: pick an existing run in the workspace.
- **Show log**: show the engine's log for the open review (see *Progress and Logs*).
- **Ask Claude about this card** and **Open Claude in a terminal for this card**.
- **Post decision log**.

## Running the Engine

The extension starts the engine as a child process and watches the run directory. Each file change re-reads that file through the artifact store and refreshes the views that use it. Closing the editor does not stop the engine; reopening the review picks up where it is. If the engine process exits with an error, the extension shows the error and the stage states from `run.json`.

## Progress and Logs

A review takes minutes, so the extension shows how far it has got without making the reviewer watch a log:

- **Progress notification**: while an engine started by Start review runs, a VS Code progress notification shows the number of stages complete out of the total, read from `run.json`, and the stages running now. It closes when the engine exits.
- **Status bar item**: while a review is open, a status bar item shows the same count and running stages (for example `Duet: 3/6 stages · briefing…`). Clicking it shows the log.
- **Output channel**: a "Duet" output channel receives every line the engine writes to standard error, as it arrives: the engine's progress lines (see the pipeline design) and any error output. Lines are added without bringing the channel to the front; the reviewer opens it when they want it.
- **Show log**: shows the log of the open review. When this window started the run's engine, that is the output channel; otherwise, for a run reopened with Open review, it opens the run's `engine.log`, which holds the same progress lines with timestamps.

The review panel's stage strip also carries a progress bar (the share of stages complete) and a Show log control.

## Views

```
┌ Review: <title> ──────────────────────────────────────────────┐
│ Intent ✓  Briefing ✓  Cards ✓  Recommendations …  Findings ✗  │ ← stage strip
│ Stated vs observed: 1 mismatch ▲      Effort 3/5 (~25 min)     │
├───────────────┬───────────────────────────────────────────────┤
│ Briefing      │ Step 2 of 5 — Retry policy                     │
│ Decisions (4) │ explanation…            [Open code]            │
│               │ ┌ Decision ── high stakes ───────────────────┐ │
│               │ │ Should a failed upload retry forever?      │ │
│               │ │ Why it matters / what the code does        │ │
│               │ │ ( ) A  ( ) B  (•) C current                │ │
│               │ │ Rationale: [______________________]        │ │
│               │ │ [Commit]        Ask Claude: [_______] [?]  │ │
│               │ └────────────────────────────────────────────┘ │
└───────────────┴───────────────────────────────────────────────┘
```

- **Review panel** (a webview). A stage strip across the top shows every stage's state. When the deck has more than seven cards, a banner says the change likely holds more decisions than one review handles well and may be worth splitting. The Briefing tab opens with the change's choices: each choice, what it chose against, the trade-off, and where the reason came from, with inferred reasons and missing reasons labelled as such, followed by the deck's settled decisions. It then walks the steps in order with the cards that point at each step shown in place; the Decisions tab lists the deck. A stage that is still running or has failed is shown, with its state, where its content would be.
- **Deck notices**: when the fact check timed out or failed, or Claude's proposed cards could not be vetted, the Decisions tab says so above the cards.
- **Findings** (a tree view in the side bar): grouped by cohort, then severity, using the cohort the review session assigns. Selecting a finding opens the code. Each finding offers dismiss, mark fixed, and reopen.
- **Inline threads** (the editor comments API): a read-only thread at each finding's and each card's anchors, linking back to the panel. Threads are placed on the files in the reviewer's working copy, at the line the anchor's pattern finds there, falling back to the recorded lines. The extension owns the set of threads it has created: every refresh disposes the previous set before creating the next, a thread is tracked the moment it is created so a refresh that fails partway cannot orphan it, and identical threads (same file, same lines, same text) are created once. Refreshing therefore never adds threads; the reviewer sees one thread per card or finding anchor.
- **Code links**: opening an anchor opens the file at the anchor's lines, finding the code by its pattern if the lines have moved.
- **Panel state across refreshes**: the panel refreshes as run files change. When the refreshed content would be identical, the panel is left as it is. When it does change, the panel keeps the reviewer's place: the active tab, the scroll position within each tab, and, on cards not yet committed, the chosen option and any rationale or question typed but not yet sent. The panel keeps this in the webview's own state, which survives the page being reloaded.

## Cards in the Panel

A card shows its question, why it matters, the literal technical statement, the metaphor and where it breaks down when present, the options, links to its code, the briefing choice it asks about when it names one, and any claims the fact check could not confirm. For a high-stakes card the recommendation area is empty and says it will appear after commitment; the commit button stays disabled until an option is chosen and, on a high-stakes card, some rationale has been written. After commitment the panel asks the session to reveal and shows the result: the lean, its confidence and reasoning, what would change Claude's mind, or the recommendation stage's state if it is not available. Changing the option after the reveal asks for a reason.

## Asking Claude

Each card has a question box. The extension passes the question to the review session and shows the answer under the card with earlier questions. **Open Claude in a terminal** opens an integrated terminal running interactive Claude in the run's head worktree, started with a prompt that names the card and the files that hold its context. While the review session would not yet show the recommendation, the prompt excludes it and repeats the rule that Claude does not give a lean before commitment, and Claude is started with reading the run directory denied, so it cannot open the recommendation itself. Questions asked in the terminal are not recorded.

## Posting the Decision Log

The extension shows the exact decision-log text produced by the session, editable. Approving that text creates the signed post through the session; posting goes through the configured sink. Any edit after approval requires approving again.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|---|---|---|---|
| Logic in the extension | None; artifact store and review session only | Logic in the extension | Keeps blind-first and recording identical across interfaces |
| Briefing and deck | One panel; cards shown in place within the briefing and also listed | Separate panels | Reading the step a card belongs to is how the reviewer gets the context to answer it; this is also the shape the guided tour extends |
| Webview technology | Plain TypeScript and HTML, no framework | React or similar | The panel is small; a framework adds build weight without adding capability here |
| Terminal access to the run directory | Denied while the recommendation is withheld | Rely on the prompt alone | The terminal is a full Claude session; a prompt asking it not to look is a request, a denied path is a rule |
| Terminal questions | Not recorded | Capture the terminal transcript | The terminal is an escape hatch for open-ended exploration; recording it reliably is not possible from the extension |
| Comment thread bookkeeping | A list owned by the extension, filled as each thread is created | Properties stored on the comment controller | VS Code's API objects are frozen; storing state on them fails, and a list that is filled only at the end of a refresh loses every thread created before a failure |
| Keeping the panel's place | Skip unchanged renders; the panel script saves tab, scroll, and drafts in webview state and restores them after a reload | Patch the DOM in place through messages | Re-rendering the whole page keeps the panel a pure function of the run files; restoring a few pieces of view state is far smaller than an incremental renderer |
| Progress display | A progress notification for a running Start review, a status bar item for the open review, and a bar in the panel's stage strip, all counted from `run.json` | Parse the engine's progress lines | `run.json` is the contract; the progress lines are for people and may change wording |
| Engine output | Streamed to an output channel that is never forced to the front | Open the channel on start; show nothing | Most reviewers do not want a log; the ones diagnosing a slow or failed run need it to be there |
| Show log for a reopened run | Open the run's `engine.log` | Replay it into the output channel | The file is the record and keeps updating while an engine started elsewhere writes to it; a replayed copy goes stale |

## Open Questions & Future Decisions

### Deferred
1. The guided tour: stepping through the briefing steps in the editor, highlighting each anchor, with cards shown at their step.
2. Rendering diagrams in the briefing.
3. A terminal-only view over the same files.

## References

- `docs/high-level-design.md`
- `docs/intent/review-session/review-session-design.md`
- `docs/intent/review-artifacts/review-artifacts-design.md`
