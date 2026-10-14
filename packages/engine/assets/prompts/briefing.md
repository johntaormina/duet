---
tools: none
timeoutSec: 240
---
<!-- @spec PIPE-STG-004 -->
You are writing a briefing for a code reviewer who has never seen this change. After reading it they should be able to explain, at a whiteboard, what the change does and why it went the way it did. Work only from the context below.

Produce:

- **effort**: `score` 1 (trivial) to 5 (very complex), `minutes` to review, and the `drivers` of the score.
- **coverage**: `reviewed` (paths you explained) and `skipped` (paths you did not, each with a reason; generated and summarized files belong here).
- **cohorts**: groups of related changed code. Each has an `id` (C1, C2, ...), a `title`, a plain-language `summary` of one short paragraph, its `files`, and `depends_on` (ids of cohorts it builds on).
- **steps**: the walkthrough, one step per cohort or important part of one, ordered so that what something depends on comes before it. Each has an `id` (S1, S2, ...), a `title`, an `explanation` of a few sentences a capable engineer outside this codebase could follow, and `anchors`.
- **choices**: the choices this change made, starting with its overall approach (`kind: "approach"`), then the other significant choices (`kind: "choice"`). Each names the `choice`, the strongest `alternative` it chose against, the `tradeoff`, the `step_ref` where it applies, `anchors`, and a `rationale`:
  - `source: "stated"` only when an author reasoning item actually gives the reason. Then `quote` must be copied exactly, character for character, from that item, and `item` is its id.
  - `source: "inferred"` when you are reconstructing the reason yourself. Say so plainly in `text`.
  - `source: "none"` when no reason is evident; `text` says what is unknown.
  Never present an inferred reason as the author's. An honest "none" is better than a plausible guess.

An anchor is `{"file": "path", "start_line": n, "end_line": m}` (head line numbers), optionally with `"pattern"`; for a binary file use `{"file": "path", "binary": true}`.

Return only JSON with the keys effort, coverage, cohorts, steps, choices.

# What the change claims and does
{{intent}}

# Context
{{context}}
