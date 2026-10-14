# VS Code Extension — EARS Specs

Design: `vscode-extension-design.md`. "The extension" is the VS Code extension. It reads run files through the artifact store (`docs/intent/review-artifacts/`) and performs reviewer actions through the review session (`docs/intent/review-session/`).

## Commands and the engine

- [ ] **EXT-CMD-001**: The extension shall provide a Start review command that lets the reviewer choose the current branch against a base, the working tree against a base, or a pull request number.
- [ ] **EXT-CMD-008**: The Start review command shall let the reviewer enter an optional statement of what the change does and why, and choose an optional agent plan or transcript file, and pass both to the engine's `run`.
- [ ] **EXT-CMD-009**: When the reviewer starts a working-tree review, the extension shall show the statement entry before starting the engine.
- [ ] **EXT-CMD-002**: When the reviewer starts a review, the extension shall run the engine's `run` operation as a background child process.
- [ ] **EXT-CMD-003**: The extension shall provide an Open review command that lists existing runs in the workspace.
- [ ] **EXT-CMD-004**: When a file in the open run's directory changes, the extension shall re-read it through the artifact store and refresh the views that use it.
- [ ] **EXT-CMD-005**: If the engine process exits with an error, then the extension shall show the error and the stage states from `run.json`.
- [ ] **EXT-CMD-006**: The extension shall never read `recommendations.json` directly; it shall obtain recommendations only from the review session.
- [ ] **EXT-CMD-007**: When the reviewer opens a run whose engine process is still running, the extension shall show the run's current state and keep refreshing as files change.

## Views

- [ ] **EXT-VIEW-001**: The review panel shall show a stage strip with the state of every stage in `run.json`.
- [ ] **EXT-VIEW-002**: While a stage is running or has failed, the review panel shall show that state, and any `detail`, where the stage's content would appear.
- [ ] **EXT-VIEW-003**: The review panel's Briefing tab shall show the briefing steps in order, with each card shown at the step its `step_ref` names.
- [ ] **EXT-VIEW-004**: The review panel's Decisions tab shall list every card in deck order.
- [ ] **EXT-VIEW-005**: When the deck has more than seven cards, the review panel shall show a banner saying the change likely holds more decisions than one review handles well and may be worth splitting.
- [ ] **EXT-VIEW-006**: The extension shall show findings offered by the review session in a side-bar tree grouped by the cohort the review session assigns, then severity.
- [ ] **EXT-VIEW-007**: The findings tree shall let the reviewer mark a finding dismissed, fixed, or open.
- [ ] **EXT-VIEW-008**: The extension shall show a read-only comment thread at each card's and each offered finding's anchors.
- [ ] **EXT-VIEW-009**: When opening an anchor whose lines no longer match its pattern, the extension shall locate the code by the pattern.
- [ ] **EXT-VIEW-010**: The review panel's Briefing tab shall show the change's choices before the steps, each with the choice, the alternative, the trade-off, and the rationale labelled by its source, followed by the deck's settled decisions.
- [ ] **EXT-VIEW-011**: When a choice's rationale source is `inferred` or `none`, the review panel shall label it as inferred by Claude or as not found, never as the author's.
- [ ] **EXT-VIEW-012**: When `cards.json` has `fact_check` of `timed_out` or `failed`, or `proposed_status` of `failed`, the review panel's Decisions tab shall say so above the cards.

## Cards

- [ ] **EXT-DECK-001**: The review panel shall show each card's question, why it matters, technical statement, options, and code links, its metaphor with where the analogy breaks down when present, the briefing choice it names in `choice_ref` when present, and its fact-check flags.
- [ ] **EXT-DECK-002**: While a high-stakes card is not committed, the review panel shall show no recommendation and state that it appears after commitment.
- [ ] **EXT-DECK-003**: The review panel shall keep a card's Commit control disabled until the review session would accept the commitment.
- [ ] **EXT-DECK-004**: When the reviewer commits to a card, the review panel shall request the reveal from the review session and show the recommendation or the recommendations stage's state.
- [ ] **EXT-DECK-005**: When the reviewer changes a revealed card's option, the review panel shall ask for a reason.

## Questions

- [ ] **EXT-ASK-001**: Each card in the review panel shall have a question box that sends the question through the review session and shows the answer under the card with the card's earlier questions.
- [ ] **EXT-ASK-002**: The extension shall provide a command that opens an integrated terminal running interactive Claude in the run's head worktree, started with a prompt naming the card and the files holding its context.
- [ ] **EXT-ASK-003**: When opening the terminal for a card whose recommendation the review session would not yet return, the extension shall exclude the recommendation from the starting prompt, state that Claude does not give a recommendation before commitment, and start Claude with reading the run directory denied.

## Posting

- [ ] **EXT-POST-001**: When the reviewer chooses Post decision log, the extension shall show the exact decision-log text from the review session in an editable view.
- [ ] **EXT-POST-002**: When the reviewer approves the shown text, the extension shall create a signed post for exactly that text through the review session and send it to the configured sink.
- [ ] **EXT-POST-003**: When the reviewer edits the text after approving it, the extension shall require approval again before posting.
