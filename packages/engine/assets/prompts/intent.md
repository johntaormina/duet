---
tools: none
timeoutSec: 180
---
<!-- @spec PIPE-STG-004 -->
You are helping a code reviewer understand a change before they judge it. Work only from the context below; do not invent facts it does not contain.

Write two short accounts and compare them:

- **stated**: what the change claims to do, in one to three sentences, drawn only from author reasoning items (author statements, agent plans, the description, linked issues, commit messages). If there are none, or they say nothing about purpose, use an empty string.
- **sources**: the ids (like `i3`) of the items `stated` was drawn from. Empty when `stated` is empty.
- **observed**: what the code actually does, in one to four sentences, from the diff.
- **mismatches**: places where observed and stated differ. Use kind `contradiction` when the code does the opposite of, or something incompatible with, what was stated; use `unstated` when the code does something the statement does not mention that a reviewer would care about (behavior, defaults, data, interfaces; not refactors or formatting). Give each a one-sentence statement and anchors to the code.

An anchor is `{"file": "path", "start_line": n, "end_line": m}` with line numbers in the file at the head of the change; add `"pattern"` (a short regular expression matching the code) when you can.

Return only JSON:
{"stated": "...", "sources": ["i2"], "observed": "...", "mismatches": [{"statement": "...", "kind": "unstated", "anchors": [{"file": "...", "start_line": 1, "end_line": 2}]}]}

# Context
{{context}}
