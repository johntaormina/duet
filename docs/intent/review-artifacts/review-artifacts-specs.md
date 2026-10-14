# Review Artifacts — EARS Specs

Design: `review-artifacts-design.md`. "The artifact store" is the shared library through which the pipeline, the review session, and interfaces read and write run files. "Pipeline outputs" are `run.json`, `context-pack.json`, `intent.json`, `briefing.json`, `cards.json`, `recommendations.json`, and `findings.json`. "Session files" are `qa.<reviewer>.jsonl`, `record.<reviewer>.json`, and `finding-state.<reviewer>.json`.

## Run directory

- [ ] **ART-RUN-001**: The artifact store shall place all files of a run in the directory `<root>/<run-id>/`, where `<root>` defaults to `.duet` under the repository root and is configurable.
- [ ] **ART-RUN-002**: The artifact store shall derive the run id deterministically from the full base and head commit SHAs.
- [ ] **ART-RUN-003**: When the review is of the working tree, the artifact store shall snapshot it (tracked changes and untracked files that are not ignored, excluding the run root) into a commit object whose parent is the current HEAD, and use that commit as the run's head.
- [ ] **ART-RUN-004**: When snapshotting the working tree, the artifact store shall leave the working tree, the index, and every branch unchanged.
- [ ] **ART-RUN-005**: The artifact store shall keep each snapshot commit reachable through a ref under the `refs/duet/` namespace until the run directory that uses it is removed.
- [ ] **ART-RUN-006**: When the artifact store creates the root directory, it shall write a `.gitignore` inside the root that ignores the root's contents, unless configuration marks the root as tracked.
- [ ] **ART-RUN-007**: When snapshotting the working tree, the artifact store shall create the snapshot commit with a fixed author, committer, timestamp, and message, so the same base and working-tree contents always produce the same snapshot SHA and the same run id.

## Writing, validation, and versioning

- [ ] **ART-FILE-001**: The artifact store shall write every JSON file by writing a temporary file in the same directory and renaming it into place.
- [ ] **ART-FILE-002**: The artifact store shall write `qa.<reviewer>.jsonl` only by appending one complete line per entry, never rewriting existing lines.
- [ ] **ART-FILE-003**: When reading a `.jsonl` file whose last line is incomplete, the artifact store shall ignore that line and return the complete lines.
- [ ] **ART-FILE-013**: Before appending to a `.jsonl` file whose last line is incomplete, the artifact store shall remove the incomplete line.
- [ ] **ART-FILE-004**: Every JSON file written by the artifact store shall include a `schema_version` field of the form `major.minor`.
- [ ] **ART-FILE-005**: When reading a file whose schema major version it supports, the artifact store shall accept the file whatever its minor version, ignoring fields it does not recognize.
- [ ] **ART-FILE-006**: If the artifact store reads a file whose schema major version it does not support, then it shall report an error naming the file and its version and shall return none of the file's content.
- [ ] **ART-FILE-007**: The artifact store shall validate every pipeline output against its JSON Schema before writing it.
- [ ] **ART-FILE-008**: If a pipeline output fails schema validation, then the artifact store shall not write the file and shall mark the producing stage failed with the validation error.
- [ ] **ART-FILE-009**: The artifact store shall validate every session file against its JSON Schema when reading it.
- [ ] **ART-FILE-010**: If a session file fails schema validation, then the artifact store shall report the error and shall leave the file unchanged on disk.
- [ ] **ART-FILE-014**: While a session file fails schema validation, the artifact store shall refuse writes to it and report that it must be repaired or moved aside.
- [ ] **ART-FILE-011**: The artifact store shall reject a write to a pipeline output made through the session's writer, and a write to a session file made through the pipeline's writer.
- [D] **ART-FILE-012**: The artifact store shall render `briefing.json` to markdown with a function that returns text and has no other effect.

## Manifest and stage status

- [ ] **ART-STAGE-001**: `run.json` shall record the run id, the full base and head commit SHAs, and the review title.
- [ ] **ART-STAGE-002**: `run.json` shall hold one entry for each of the stages `context`, `intent`, `briefing`, `cards`, `recommendations`, and `findings`.
- [ ] **ART-STAGE-003**: Each stage entry in `run.json` shall record a status of `pending`, `running`, `complete`, or `failed`, a start time, a finish time, and a cache key.
- [ ] **ART-STAGE-004**: When a stage entry's status is `failed`, the entry shall include an error summary.
- [ ] **ART-STAGE-005**: The artifact store shall compute a stage's cache key as a hash of the stage's inputs, the hashes of the upstream outputs it read, the contents of the prompt, guide, and trigger files it used, the stage's resolved configuration (model, turn limits, and budgets), and the schema version.
- [ ] **ART-STAGE-006**: When asked whether a stage can be reused, the artifact store shall answer yes only if the stage's recorded status is `complete` and its recorded cache key equals the key computed for the current inputs.
- [ ] **ART-STAGE-007**: A stage entry in `run.json` shall allow an optional `detail` text describing the stage's current condition (for example, waiting on a rate limit until a given time).

## Context pack

- [ ] **ART-CTX-001**: `context-pack.json` shall record the size budget the pack was assembled under.
- [ ] **ART-CTX-002**: `context-pack.json` shall list each included item with its kind, its path or source, and its size.
- [ ] **ART-CTX-003**: `context-pack.json` shall list each excluded item with its kind, its path or source, and the reason it was excluded.
- [ ] **ART-CTX-004**: A context-pack item's kind shall be one of `diff`, `author-statement`, `intent-source`, `commit-message`, `history`, `linked-doc`, `changed-file`, `file-outline`, `summarized-file`, `project-doc`, `codeowners`, `tool-output`, or `caller`.

## Anchors

- [ ] **ART-ANCH-001**: Every code reference in `intent.json`, `briefing.json`, `cards.json`, and `findings.json` shall be an anchor holding a file path and the full commit SHA it refers to, and, unless the file is binary, a start line and an end line.
- [ ] **ART-ANCH-002**: An anchor shall allow an optional `pattern` (a regular expression that locates the code if its lines have moved).

## Intent and briefing

- [ ] **ART-BRIEF-001**: `intent.json` shall hold `stated` (what the change claims to do), the list of sources `stated` was drawn from, `observed` (what the code does), and `mismatches`, each mismatch a short statement with anchors and a `kind` of `contradiction` or `unstated`.
- [ ] **ART-BRIEF-002**: When no intent source exists for the change, `intent.json` shall record `stated` as empty and its source list as empty.
- [ ] **ART-BRIEF-003**: `briefing.json` shall hold an effort score from 1 to 5, an estimated review time, and the drivers of the score.
- [ ] **ART-BRIEF-004**: `briefing.json` shall list the files reviewed and the files skipped, each skipped file with a reason.
- [ ] **ART-BRIEF-005**: `briefing.json` shall hold cohorts, each with an id, a title, a plain-language summary, its files, and the ids of the cohorts it depends on.
- [ ] **ART-BRIEF-006**: `briefing.json` shall hold an ordered list of steps, each with an id, a title, an explanation, and anchors.
- [ ] **ART-BRIEF-007**: `briefing.json` shall hold a list of the choices the change made, each with an id, the choice, the strongest alternative it chose against, the trade-off, a rationale, anchors, and the id of the step where it applies.
- [ ] **ART-BRIEF-008**: The first entry in `briefing.json`'s choices shall describe the change's overall approach.
- [ ] **ART-BRIEF-009**: Each choice's rationale shall have a `source` of `stated`, `inferred`, or `none`.
- [ ] **ART-BRIEF-010**: When a choice's rationale `source` is `stated`, the rationale shall include a quote and the id of the context-pack item the quote came from.

## Decision cards

- [ ] **ART-DECK-001**: `cards.json` shall hold an ordered list of decision cards and a `no_decisions_summary`.
- [ ] **ART-DECK-002**: Schema validation of `cards.json` shall fail when `no_decisions_summary` is missing or empty, whether or not the card list is empty.
- [ ] **ART-DECK-003**: Each decision card shall have `id`, `order`, `fingerprint`, `source`, `stakes`, `stakes_basis`, `question`, `why_it_matters`, `plain_technical`, `options`, `anchors`, `step_ref`, `basis`, and `not_examined`.
- [ ] **ART-DECK-004**: A decision card's `source` shall be `trigger` or `proposed`.
- [ ] **ART-DECK-005**: When a decision card's `source` is `trigger`, the card shall list one or more trigger categories.
- [ ] **ART-DECK-006**: When a decision card's `source` is `proposed`, the card shall include `alternative_and_consequence`.
- [ ] **ART-DECK-007**: When a decision card includes a `metaphor`, the card shall include `analogy_breaks_down_when`.
- [ ] **ART-DECK-008**: A decision card shall have between two and four options, each with a `summary`, `pros`, `cons`, and `reversibility`.
- [ ] **ART-DECK-009**: A decision card's `stakes` shall be `high` or `low`.
- [ ] **ART-DECK-010**: When validating `cards.json`, the artifact store shall reject a card whose `step_ref` does not name a step id in the same run's `briefing.json`.
- [ ] **ART-DECK-011**: A decision card in `cards.json` shall contain no recommendation fields and no links to findings.
- [ ] **ART-DECK-012**: Each option of a decision card shall have an `is_current` flag, and exactly one option per card shall have `is_current` true (the option describing what the code currently does).
- [ ] **ART-DECK-013**: A decision card shall allow an optional `choice_ref` naming the id of a choice in the same run's `briefing.json`.
- [ ] **ART-DECK-014**: A decision card shall hold `flags`, each naming a claim on the card that the fact check could not confirm and a note.
- [ ] **ART-DECK-015**: `cards.json` shall hold a `settled` list, each entry with a decision, the alternative, and what already fixed it (the stated intent or an external constraint).
- [ ] **ART-DECK-016**: `cards.json` shall hold a `fact_check` status of `complete`, `timed_out`, or `failed`.
- [ ] **ART-DECK-017**: `cards.json` shall hold a `proposed_status` of `complete` or `failed`, with a note when `failed`.

## Recommendations

- [ ] **ART-LEAN-001**: `recommendations.json` shall hold an entry for each decision card whose recommendation has been produced, each with the card id, the recommended option, a confidence from 0 to 100, `reasoning`, `what_would_change_my_mind`, and the `card_hash` of the card it was written against.
- [ ] **ART-LEAN-002**: The artifact store shall compute a decision card's hash from the card's canonical JSON serialization, so cards with equal content have equal hashes.
- [ ] **ART-LEAN-003**: When a recommendation's `card_hash` differs from the hash of the current card with the same id, the artifact store shall not return it as that card's recommendation.

## Findings

- [ ] **ART-FIND-001**: `findings.json` shall hold a list of findings, a coverage summary, and an exploration summary stating the context gathered, the exploration budget, and what was not examined.
- [ ] **ART-FIND-002**: Each finding shall have `id`, `category`, `severity`, `confidence` from 0 to 100, `title`, anchors, `evidence`, `found_by`, `related_cards`, `verification`, and `fingerprint`, and may have `suggested_fix`.
- [ ] **ART-FIND-003**: A finding's `severity` shall be `critical`, `high`, `medium`, `low`, or `nit`.
- [ ] **ART-FIND-004**: A finding's verification shall record a status of `confirmed`, `refuted`, or `uncertain`, the verifier, and notes.
- [ ] **ART-FIND-005**: The artifact store shall reject a `findings.json` in which any finding lacks a verification status.
- [ ] **ART-FIND-006**: The artifact store shall derive a finding's fingerprint from its first anchor's file, its pattern (or, when it has none, a whitespace-normalized form of the anchored code), and its category, so the fingerprint is unchanged when only line numbers move.
- [ ] **ART-FIND-007**: When reading findings for a reviewer, the artifact store shall apply that reviewer's states from `finding-state.<reviewer>.json` to findings with matching fingerprints.
- [ ] **ART-FIND-008**: Each entry in `finding-state.<reviewer>.json` shall hold a finding fingerprint and a state of `open`, `dismissed`, or `fixed`.

## Session files

- [ ] **ART-LOG-001**: Each line of `qa.<reviewer>.jsonl` shall hold a card id, the time asked, the question, the answer, and whether the card was committed when the question was asked.
- [ ] **ART-LOG-002**: `record.<reviewer>.json` shall hold the run id, the reviewer, start and end times, and the stages whose status was not `complete` when the review ended.
- [ ] **ART-LOG-003**: Each answered-card entry in `record.<reviewer>.json` shall hold the card id, the card fingerprint, the `card_hash` answered, the chosen option, the rationale, the commit time, the reveal time, `agreed_with_ai`, and the changes made after commitment.
- [ ] **ART-LOG-004**: When no recommendation was available at a card's reveal, the record entry's `agreed_with_ai` shall be null.
- [ ] **ART-LOG-005**: Each change after commitment shall record the earlier option, the new option, the reason, and the time.
- [ ] **ART-LOG-006**: `record.<reviewer>.json` shall hold a `posted` list, each entry with the target, a hash of the exact text posted, the time the reviewer signed off, and the time it was posted.
- [ ] **ART-LOG-007**: When a record entry's `card_hash` differs from the hash of the current card with the same fingerprint, the artifact store shall report the entry as stale and shall not return it as the answer to the current card.
- [ ] **ART-LOG-008**: When the reviewer answers a card whose recorded answer is stale, the artifact store shall replace the entry and keep the stale answer in the entry's `previous` list.
