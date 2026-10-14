---
parent: high-level-design
prefix: EXT
---

# VS Code Extension

## Context and Design Philosophy

The extension is the first interface. It starts reviews, shows them as they fill in, and lets the reviewer work through the briefing, the deck, and the findings without leaving the editor, including asking Claude questions. It holds no review logic: it runs the engine, reads run files through the artifact store, and calls the review session for everything a reviewer does.

## Commands

- **Start review**: choose the change (the current branch against a base, the working tree against a base, or a pull request number) and run the engine in the background. The reviewer may add a line or two on what the change does and why, and point to an agent plan or transcript file; for a working-tree review the statement box is shown first, since the reviewer is usually the author.
- **Open review**: pick an existing run in the workspace.
- **Ask Claude about this card** and **Open Claude in a terminal for this card**.
- **Post decision log**.

## Running the Engine

The extension starts the engine as a child process and watches the run directory. Each file change re-reads that file through the artifact store and refreshes the views that use it. Closing the editor does not stop the engine; reopening the review picks up where it is. If the engine process exits with an error, the extension shows the error and the stage states from `run.json`.

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
- **Inline threads** (the editor comments API): a read-only thread at each finding's and each card's anchors, linking back to the panel.
- **Code links**: opening an anchor opens the file at the anchor's lines, finding the code by its pattern if the lines have moved.

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

## Open Questions & Future Decisions

### Deferred
1. The guided tour: stepping through the briefing steps in the editor, highlighting each anchor, with cards shown at their step.
2. Rendering diagrams in the briefing.
3. A terminal-only view over the same files.

## References

- `docs/high-level-design.md`
- `docs/intent/review-session/review-session-design.md`
- `docs/intent/review-artifacts/review-artifacts-design.md`
