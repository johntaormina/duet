---
parent: high-level-design
prefix: ART
---

# Review Artifacts

## Context and Design Philosophy

The pipeline, the review session, and every interface communicate through files. This component defines those files: what each one holds, who writes it, how it is validated, and how it changes over time. It is the contract that lets the engine and the interfaces evolve independently, so it is deliberately boring: plain JSON on disk, a schema per file, one writer per file.

Four principles shape the contract:

- **One writer per file.** Stage outputs are written only by the pipeline. Everything a human produces (choices, rationales, questions, dismissals, sign-offs) is written only by the review session. A pipeline rerun therefore cannot overwrite human input, and a session cannot corrupt a stage output.
- **Content and Claude's opinion are separate files.** A decision card describes a question and its options. Claude's recommendation for it lives in a different file, so an interface can show the card without having the recommendation in hand until the reviewer has committed.
- **Everything is anchored to commits.** A review is bound to a base and head commit. Every code reference carries enough to find the code again if lines drift. Uncommitted work is snapshotted into a commit first, so an author reviewing their own changes before committing gets the same guarantees.
- **Absence must be distinguishable from emptiness.** "No decisions needed" is a positive, validated result. A missing or empty file is a failure.

All reading and writing goes through one shared **artifact store** library, used by the pipeline, the review session, and the interfaces. It enforces this contract in one place: paths, atomic writes, validation, versioning, cache keys, hashes, and which side may write which file.

## Run Directory

Each review is a run, stored in one directory, by default `.duet/<run-id>/` under the repository root, where the run id is derived from the base and head commits. When the review is of the working tree, the head is a snapshot commit of it (tracked changes plus untracked files that are not ignored, excluding the run root, with the current HEAD as parent), created without touching the working tree, the index, or any branch, with fixed author, timestamp, and message so the same contents always give the same commit and therefore the same run, and kept alive by a ref under the tool-owned `refs/duet/` namespace until the run is cleaned up. The root directory name is configurable. The directory is untracked by default (the store writes a `.gitignore` inside the root that ignores its contents), because it holds diffs, reviewer rationale, and Claude's answers; exporting a decision record is a separate, explicit act. Nothing is redacted: the tool assumes the changes it reviews do not contain secrets.

```
.duet/<run-id>/
  run.json                 manifest and stage status         (pipeline)
  context-pack.json        what Claude was given             (pipeline)
  intent.json              stated vs observed intent         (pipeline)
  briefing.json            cohorts, steps, effort, coverage  (pipeline)
  cards.json               decision cards                    (pipeline)
  recommendations.json     Claude's lean per card            (pipeline)
  findings.json            machine-layer findings            (pipeline)
  qa.<reviewer>.jsonl      questions and answers per card    (session)
  record.<reviewer>.json   the decision record               (session)
  finding-state.<reviewer>.json  dismissals by fingerprint   (session)
  engine.log               progress log, plain text          (pipeline)
```

JSON files are written atomically (to a temporary file, then renamed), so an interface watching the directory never reads a partial file. The `.jsonl` question logs are append-only; each entry is one complete line, a reader ignores an incomplete trailing line, and a writer removes an incomplete trailing line before appending. Every JSON file carries `schema_version` (`major.minor`). A reader accepts any minor version of the major it knows and treats an unknown major as a failure it reports, not as data it guesses at.

Every file validates against a JSON Schema kept with the project. The pipeline validates before writing and the session validates on read. A pipeline output that fails validation marks its stage failed; nothing partial is kept or shown as complete. A session file that fails validation is reported and left untouched, and the store refuses further writes to it until it is repaired or moved aside, because it holds human input that cannot be regenerated.

`engine.log` is the one file that is neither JSON nor a contract between components: a human-readable, append-only record of the engine's progress (stages starting and finishing, each Claude CLI call and how long it took), one timestamped line per entry, written through the pipeline's writer. It has no schema, nothing parses it, and nothing reads it back to decide anything; interfaces show it to a person who wants to know what the engine is doing or did.

A markdown rendering of the briefing may be produced from `briefing.json` by a pure function. It is for reading without an interface and is never read back.

## Manifest and Stage Status

`run.json` holds the run identity (run id, base and head commit SHAs in full, review title) and one entry per stage:

| Stage | Output file |
|---|---|
| `context` | `context-pack.json` |
| `intent` | `intent.json` |
| `briefing` | `briefing.json` |
| `cards` | `cards.json` |
| `recommendations` | `recommendations.json` |
| `findings` | `findings.json` (including each finding's verification) |

Each stage entry records `status` (`pending`, `running`, `complete`, `failed`), start and finish times, an error summary when failed, an optional `detail` describing its current condition (for example, waiting on a rate limit until a given time), and a `cache_key`. The cache key is a hash of the stage's inputs (including the hashes of the upstream outputs it read), the contents of the prompt, guide, and trigger files it used, the stage's resolved configuration (model, turn limits, budgets), and the schema version, so a changed upstream result invalidates every stage downstream of it. A stage whose recorded key matches what would be computed now is reusable; any other state is rerun. Interfaces render stage status from this file alone.

## Context Pack

`context-pack.json` records exactly what Claude was given: the size budget, each included item (its kind, its path or source, and its size), and each excluded item with the reason it was left out. Kinds are `diff`, `author-statement` (what the reviewer-as-author says the change does and why), `intent-source` (description, linked issue), `commit-message`, `history` (earlier commits touching the changed code), `linked-doc`, `changed-file`, `file-outline` (the outline and changed hunks of a file too large to include whole), `summarized-file` (a compact stand-in for a lockfile, generated or vendored file, notebook, or binary), `project-doc`, `codeowners`, `tool-output` (output an environment supplies, such as an infrastructure plan), and `caller`. A substituted or excluded item is listed with the reason.

## Anchors

A code reference is an anchor: `{file, start_line, end_line, commit, pattern}`. `commit` is the full head SHA the line numbers refer to. For a binary file the line range is omitted and the anchor names the file only. `pattern` is an optional regular expression that locates the code if the lines have moved. Briefing steps, cards, and findings all use anchors, and a tour is built from them.

## Briefing

`intent.json` and `briefing.json` hold:

- **Intent** (in `intent.json`). `stated` (what the change claims to do, from its description and linked ticket, with the sources), `observed` (what the code does), and `mismatches` (each a short statement with anchors and a `kind`: `contradiction` when the code does the opposite of or something incompatible with what was stated, `unstated` when it does something the stated intent does not mention). An empty `stated` records that no intent source existed.
- **Effort.** A score from 1 to 5 with an estimated review time and the drivers.
- **Coverage.** Files reviewed, and files skipped each with a reason.
- **Cohorts.** Groups of related changed code, each with a title, a one-paragraph plain-language summary, its files, and the cohorts it depends on.
- **Choices.** The choices the change made, the first being its overall approach. Each has an `id`, the choice, the strongest alternative it chose against, the trade-off, a `rationale` with a `source` of `stated`, `inferred`, or `none`, a quote and the context item it came from when `stated`, anchors, and the step where it applies.
- **Steps.** An ordered list that walks the cohorts in dependency order. Each step has an `id`, a title, an explanation, and anchors. Cards point at the step where they apply, so the same list serves as a briefing now and as the path of a guided tour later.

## Decision Cards

`cards.json` holds an ordered list of cards and, always, a `no_decisions_summary` that explains what was reviewed and why nothing else needed a decision. When the list is empty the summary is required and states why.

A card has:

- `id`, `order`, and a `fingerprint` that is stable across reruns for the same underlying question. How the fingerprint is derived belongs to the card-selection design.
- `source`: `trigger` (one or more categories that always produce a card) or `proposed` (raised by Claude's own judgement), with the trigger categories listed when applicable.
- `choice_ref`, optionally: the briefing choice the card asks about.
- `stakes`: `high` or `low`, with `stakes_basis` naming why.
- `question`, `why_it_matters` (a consequence), and `plain_technical` (a literal statement of what the code does).
- Optionally `metaphor`; when present, `analogy_breaks_down_when` is required.
- `options`: two to four, each with a `summary`, `pros`, `cons`, `reversibility`, and `is_current`, which is true for exactly one option: what the code currently does.
- `alternative_and_consequence`: for proposed cards, the reasonable alternative to what the code does and what would differ for users, data, cost, or on-call. Required when `source` is `proposed`.
- `anchors` and `step_ref` (the id of the briefing step where it applies).
- `basis`: the context items the card was written from, and `not_examined`: relevant things it did not look at.
- `flags`: claims on the card that the fact check could not confirm, each with a note.

Beside the cards, `cards.json` holds `settled`: decisions Claude raised that turned out to be already fixed by the stated intent or an external constraint, each with the decision, the alternative, and what fixed it; interfaces show these with the briefing's choices. It also holds `fact_check` (`complete`, `timed_out`, or `failed`) and `proposed_status` (`complete` or `failed`, with a note), so a reviewer can see when cards were not fact-checked or when Claude's own proposals could not be vetted and were left out.

The word limits on card text and the rules for choosing cards belong to the card-selection design; this schema enforces structure.

## Recommendations

`recommendations.json` has an entry for each card whose recommendation has been produced, and is rewritten as each arrives; the stage is complete when every card has one. An entry has the `option` Claude leans toward, a `confidence` from 0 to 100, `reasoning`, and `what_would_change_my_mind`. Each entry carries the `card_hash` of the card content it was written against, and an entry whose hash does not match the current card is never returned as that card's recommendation.

The separation is a convention that interfaces honor, not a security boundary: the files are readable by anyone with the directory. The guarantee the tool makes is about its own interfaces and its own record, which logs when each recommendation was revealed.

## Findings

`findings.json` holds the machine layer's output: a list of findings and the `coverage` and `exploration` summary (how much context was gathered, the budget, and what was not examined). A finding has an `id`, `category`, `severity` (`critical`, `high`, `medium`, `low`, `nit`), `confidence` (0 to 100), `title`, anchors, `evidence`, an optional `suggested_fix`, `found_by`, `related_cards` (ids of decision cards the finding bears on), and a `verification` (`status` of `confirmed`, `refuted`, or `uncertain`, who verified it, and notes). Each finding has a `fingerprint` derived from its first anchor's file, its pattern (or, when it has none, a whitespace-normalized form of the anchored code), and its category, which stays stable when line numbers change.

`findings.json` is written once, after verification has finished. Unverified findings are never written or shown.

Links between findings and cards live only on the finding. Findings arrive after the deck is shown, and writing the link onto a card would change a card the reviewer may already have answered.

A finding's state (open, dismissed, fixed) is human data and lives in `finding-state.<reviewer>.json`, keyed by fingerprint, so a dismissal survives a rerun and does not reappear.

## Session Files

`qa.<reviewer>.jsonl` has one line per question: `card_id`, `asked_at`, the question, the answer, and whether the card was committed when it was asked.

`record.<reviewer>.json` is the decision record, one file per reviewer. It holds the run id, the reviewer, start and end times, a list of any stages whose status was not `complete` when the review ended, and for each card answered:

- `card_id` and `card_hash` (the content the reviewer answered),
- `chosen_option`, `rationale`, `committed_at`,
- `revealed_at`, and `agreed_with_ai` (null when no recommendation was available at the reveal),
- `changes` after commitment, each with the earlier option, the new option, the reason, and a time,
- `previous`: earlier answers to the same card that went stale, kept when the reviewer answers again.

Answers are matched to cards by fingerprint. Counts of questions asked before commitment are derived from the question log, not stored twice.

It also holds `posted`: each external post made, with the target, a hash of the exact text, the time the reviewer signed off, and the time it was posted. A record whose `card_hash` no longer matches the current card is reported as stale, not silently applied to the new content.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|---|---|---|---|
| Storage | Plain JSON files in a run directory | A database; one large document | Files are readable, diffable, and watchable by any interface, and need no server. Per-stage files let each stage's result be shown the moment it exists |
| Engine progress log | Plain-text `engine.log` in the run directory, no schema | Progress events in `run.json`; a JSON log with a schema; standard error only | Stage state already lives in `run.json`; the log is for a person, not a program. Keeping it in the run directory lets an interface show it for a run the engine is no longer running, and keeping it schemaless keeps it out of the contract |
| Writers | One writer per file; human data in separate files | Single shared document updated by all | A rerun cannot overwrite a reviewer's answers, and no locking between engine and session is needed |
| Recommendations | Separate file from cards | Embedded in each card | The card can be shown with no recommendation in the interface's hands; blind-first becomes a matter of when the file is read |
| Schemas | Language-neutral JSON Schema, validated on write and on read | Type definitions in one language only | The engine and interfaces may be written in different languages; a schema is the one place the contract is stated |
| Stage reuse | Cache key from inputs, prompt files, and schema version | Timestamps; always rerun | A key changes exactly when a result could differ, so resume and re-review redo only what must be redone |
| Empty result | `no_decisions_summary` required | Empty list means none | An empty or missing file could be a failure; requiring a reason makes "no decisions" something the engine asserted |
| Dismissals | Keyed by finding fingerprint in a session file | A state field on the finding | Findings are pipeline output and are rewritten on rerun; a fingerprint lets a dismissal outlast the rewrite |
| Run directory | Untracked by default | Committed by default | It contains diffs and rationale; publishing a record is a deliberate export |
| When findings appear | Once, after verification | Stream each finding as found, marked unverified | Unverified findings are the noise the verifier exists to remove; the machine layer already runs in the background, so waiting for verification costs the reviewer nothing on the critical path |
| Card and finding links | Stored on the finding only | On the card; on both | Findings arrive after the deck is shown. Writing to a card would change its hash and mark a reviewer's answer stale for a reason that has nothing to do with the question |
| Uncommitted changes | Snapshot to a commit object held by a tool-owned ref | Anchor to the working tree; require a commit first | The working tree changes under the reviewer; requiring a commit excludes the author reviewing before committing. A snapshot keeps one anchoring model for both cases |
| Invalid session file | Report and leave untouched | Discard and start fresh | It holds a reviewer's choices and rationale, which cannot be regenerated |

## Open Questions & Future Decisions

### Deferred
1. Two sessions open for the same reviewer and run: whether to detect it and how.
2. Carrying a reviewer's answers to a new run after the change is revised, matching cards by fingerprint. Until then, any change to a card's content, including rewording, marks the reviewer's answer stale.
3. Retention: when old run directories are cleaned up.
4. The trigger category list, card word limits, and stakes rules (owned by the card-selection design).

## References

- `docs/high-level-design.md`
- `docs/intent/review-session/review-session-design.md` (where `<reviewer>` comes from)
