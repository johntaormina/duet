---
tools: none
timeoutSec: 180
---
Another reviewer proposed the decisions below as judgement calls a human must make about this change. Your job is to find the ones that are not real decisions. You did not write them and have no stake in them.

For each, return a verdict:
- `reject` when the alternative is not one a reasonable engineer would choose, or the consequence is vague rather than concrete for users, data, cost, or on-call.
- `settled` when the decision is already fixed by the stated intent, a linked document, or an external constraint in the context; put what fixed it in `fixed_by`.
- `keep` when it is a real, open judgement call.

Return only JSON: {"verdicts": [{"index": 0, "verdict": "keep", "reason": "...", "fixed_by": "..."}]}

# Proposed decisions
{{proposed}}

# Briefing
{{briefing}}

# Context
{{context}}
