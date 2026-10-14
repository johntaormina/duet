# Pipeline — EARS Specs

Design: `pipeline-design.md`. "The engine" is the pipeline program. "Human-layer stages" are `intent`, `briefing`, `cards`, and `recommendations`; "the machine layer" is the `findings` stage (specialists and verifier). Run files and stage statuses are as defined in `docs/intent/review-artifacts/`.

## Invocation

- [ ] **PIPE-CLI-001**: The engine shall provide a `run` operation that accepts a change named as a pull request, as a base and head ref, or as the working tree against a base.
- [ ] **PIPE-CLI-005**: The `run` operation shall accept an optional author statement and an optional agent plan or transcript file, and include each in the context pack as author reasoning.
- [ ] **PIPE-CLI-002**: When `run` is invoked, the engine shall create the run if it does not exist and execute every stage that the artifact store does not report as reusable.
- [ ] **PIPE-CLI-003**: The engine shall provide an `ask` operation that takes a run, a card id, a question, and whether the reviewer may see that card's recommendation, and returns Claude's answer.
- [ ] **PIPE-CLI-004**: The engine shall provide a `clean` operation that removes named runs, or runs older than a given age, together with their head worktrees and snapshot refs.

## Head worktree

- [ ] **PIPE-WT-001**: The engine shall create a git worktree of the run's head commit in a tool-owned location and run every Claude CLI call for the run with that worktree as the working directory.
- [ ] **PIPE-WT-002**: The engine shall create the head worktree without changing the reviewer's checked-out branch, working tree, or index.
- [ ] **PIPE-WT-003**: The engine shall reuse one head worktree across all stages of a run.

## Stage order

- [ ] **PIPE-STG-001**: The engine shall run the human-layer stages in the order `intent`, `briefing`, `cards`, `recommendations`, each starting only after the `context` stage and its predecessor are complete.
- [ ] **PIPE-STG-002**: The engine shall start the machine layer's specialists once the `context` stage is complete, concurrently with the human-layer stages.
- [ ] **PIPE-STG-003**: The engine shall start the machine layer's verifier only after all specialists have finished and the `cards` stage is complete or failed.
- [ ] **PIPE-STG-004**: When invoking Claude for the `intent`, `briefing`, or `cards` stage, the engine shall allow no tools by default.
- [ ] **PIPE-STG-005**: When invoking Claude for a recommendation, a specialist, the verifier, or an `ask`, the engine shall allow only read-only tools scoped to the head worktree.
- [ ] **PIPE-STG-006**: The engine shall instruct the `briefing` stage to order its steps by dependency between cohorts.
- [ ] **PIPE-STG-007**: The engine shall instruct the `briefing` stage to list the choices the change made, starting with its overall approach, each with the alternative it chose against and a rationale labelled `stated`, `inferred`, or `none`.
- [ ] **PIPE-STG-008**: If a briefing choice's rationale is labelled `stated` and its quote does not appear verbatim in the context-pack item it cites, then the engine shall treat the briefing output as invalid.

## Context pack

- [ ] **PIPE-CTX-001**: The engine shall assemble the context pack in code, without calling Claude, so the same change and configuration always produce the same pack.
- [ ] **PIPE-CTX-002**: The engine shall consider context-pack items in priority order: the normalized diff; author reasoning (author statement, agent plan, title, description, linked issue text, and commit messages between base and head); changed files at head; linked documents; project documents and code-owner entries; history of the changed lines; tool output supplied through adapters; then direct callers.
- [ ] **PIPE-CTX-003**: When a context-pack item does not fit in the remaining size budget, the engine shall exclude it, record it as excluded with the reason, and continue considering later items.
- [ ] **PIPE-CTX-004**: If the normalized diff and the author reasoning together exceed the context-pack size budget, then the engine shall fail the `context` stage with a message that the change is too large to review as one.
- [ ] **PIPE-CTX-005**: Where a caller resolver is configured for a changed file's ecosystem, the engine shall find that file's direct callers with the resolver.
- [ ] **PIPE-CTX-006**: Where no caller resolver applies, the engine shall find direct callers by text search for names defined in the changed file, skipping names on a stop-list, capping matches per name, ordering by path distance, and recording in the pack that callers were found by text search only.
- [ ] **PIPE-CTX-007**: The engine shall compute the diff with rename and copy detection.
- [ ] **PIPE-CTX-008**: The engine shall replace a changed lockfile with a summary of packages added, removed, and changed in version, recorded as a `summarized-file` item with the reason.
- [ ] **PIPE-CTX-009**: The engine shall replace a changed generated or vendored file (marked in `.gitattributes`, by a generated-file header, or by a configured path) with a one-line note, recorded as a `summarized-file` item with the reason.
- [ ] **PIPE-CTX-010**: The engine shall include a changed notebook with its cell outputs removed.
- [ ] **PIPE-CTX-011**: The engine shall replace a changed binary or large-file-storage file with its path, size, and hash, recorded as a `summarized-file` item.
- [ ] **PIPE-CTX-012**: The engine shall collapse hunks that only rename, reformat, or reorder imports into a summary item.
- [ ] **PIPE-CTX-013**: When a changed file exceeds the per-file size limit, the engine shall include it as a `file-outline` item holding its outline and its changed hunks with surrounding lines.
- [ ] **PIPE-CTX-014**: The engine shall include as `linked-doc` items the in-repository documents linked from the change description and the design-record files whose paths match the changed files.
- [ ] **PIPE-CTX-015**: The engine shall include as `project-doc` items the nearest instruction and README files above each changed path, then the repository root's, and as `codeowners` items the code-owner entries for the changed paths.
- [ ] **PIPE-CTX-016**: The engine shall include as `history` items up to a configured number of the most recent earlier commits that touched the changed lines, with their messages.
- [ ] **PIPE-CTX-017**: Where a tool-output adapter is configured, the engine shall include its output as a `tool-output` item.

## Machine layer

- [ ] **PIPE-MACH-001**: The engine shall run the bugs, security, tests, and conventions specialists as separate Claude CLI calls in parallel, each with its own prompt file.
- [ ] **PIPE-MACH-002**: The engine shall give each specialist call a maximum number of agent turns and a wall-clock timeout.
- [ ] **PIPE-MACH-003**: When a specialist call reaches its turn limit or its timeout after producing output, the engine shall keep that output and record in the exploration summary what it did not examine.
- [ ] **PIPE-MACH-004**: If a specialist call times out without output, then the engine shall fail the `findings` stage.
- [ ] **PIPE-MACH-005**: The engine shall merge specialist findings and remove duplicates that share a fingerprint before verification.
- [ ] **PIPE-MACH-006**: The engine shall verify findings in a fresh Claude CLI call that receives the diff, the context pack, the cards when the `cards` stage is complete, and each finding's claim and evidence, and no specialist reasoning.
- [ ] **PIPE-MACH-007**: The engine shall instruct the verifier to try to refute each finding and to set its verification status and confidence.
- [ ] **PIPE-MACH-008**: The engine shall never write `findings.json` without having run the verifier.
- [ ] **PIPE-MACH-009**: When the `cards` stage is complete, the engine shall have the verifier link each finding to the cards it bears on.
- [ ] **PIPE-MACH-010**: When the `cards` stage has failed, the engine shall write findings with no card links and shall not fail the `findings` stage for that reason.

## Recommendations

- [ ] **PIPE-LEAN-001**: The engine shall produce each card's recommendation in its own fresh Claude CLI call that receives the context pack, the briefing, and that one card.
- [ ] **PIPE-LEAN-002**: The engine shall write each card's recommendation to `recommendations.json` as soon as it is produced, and mark the `recommendations` stage complete when every card has one.

## Calling the Claude CLI

- [ ] **PIPE-CALL-001**: The engine shall invoke Claude only through the Claude CLI in headless mode, requesting JSON output.
- [ ] **PIPE-CALL-002**: The engine shall take each call's model, turn limit, and timeout from its prompt file's frontmatter, overridden by configuration when configured.
- [ ] **PIPE-CALL-003**: If a Claude call's output fails schema validation or a stage's own checks, then the engine shall retry the call once, listing the problems in the prompt, before writing anything.
- [ ] **PIPE-CALL-004**: The engine shall allow each Claude call at most one retry for invalid output in total, and if the retried output is also invalid, shall fail the stage without writing its output.
- [ ] **PIPE-CALL-005**: When the Claude CLI reports a rate limit, the engine shall wait with exponential backoff up to the configured ceiling and retry the call.
- [ ] **PIPE-CALL-006**: While a stage is waiting on a rate limit, the engine shall keep the stage `running` and set its `detail` to say it is waiting on a rate limit and until when.
- [ ] **PIPE-CALL-007**: Within one `run`, the engine shall run no more Claude CLI calls at once than the configured concurrency cap, defaulting to 3; `ask` calls are not counted against it.
- [ ] **PIPE-CALL-008**: When calls from both branches are waiting for a free slot under the concurrency cap, the engine shall start human-layer calls first.

## Failure

- [ ] **PIPE-FAIL-001**: When a stage fails, the engine shall record its error in `run.json`.
- [ ] **PIPE-FAIL-002**: When a stage fails, the engine shall mark every stage downstream of it in the same branch failed with an error naming the failed upstream stage.
- [ ] **PIPE-FAIL-003**: When a stage in one branch fails, the engine shall continue running the other branch.
- [ ] **PIPE-FAIL-004**: The engine shall never mark the `findings` stage failed because a human-layer stage failed, nor a human-layer stage failed because the `findings` stage failed.

## Resume and locking

- [ ] **PIPE-RES-001**: When the `run` operation starts work on a run, the engine shall take a lock file in the run directory.
- [ ] **PIPE-RES-002**: If the run's lock is held by a live process, then the engine shall exit with a message naming the holding process.
- [ ] **PIPE-RES-003**: When the run's lock is held by a process that no longer exists, the engine shall take over the lock.
- [ ] **PIPE-RES-004**: When resuming a run, the engine shall rerun every stage recorded as `running`.
- [ ] **PIPE-RES-005**: The `ask` operation shall not take or wait for the run's lock.

## Questions

- [ ] **PIPE-ASK-001**: When answering an `ask`, the engine shall give Claude a fresh context containing the card, the context pack, the briefing, and the earlier questions and answers about the same card.
- [ ] **PIPE-ASK-002**: When answering an `ask` for a card whose recommendation the caller states the reviewer may not yet see, the engine shall exclude that card's recommendation from Claude's context.
- [ ] **PIPE-ASK-003**: When answering an `ask` for a card whose recommendation the caller states the reviewer may not yet see, the engine shall instruct Claude to answer factual questions and to decline to say which option it would choose.
- [ ] **PIPE-ASK-004**: The engine shall return the `ask` answer to the caller without writing it to the run directory.
