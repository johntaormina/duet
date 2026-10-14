---
tools: read-only
timeoutSec: 600
maxTurns: 25
---
<!-- @spec PIPE-STG-005 -->
Other reviewers made the claims below about this change. You did not see their reasoning. Try to refute each one against the actual code (you may read files in the working directory).

For each claim set `status`: `refuted` if the code does not have the problem, `confirmed` if you verified it, `uncertain` if you cannot tell. Set `confidence` (0 to 100) that the issue is real, and `notes` with what you checked. Set `related_cards` to the ids of decision cards the finding bears on, from the list below.

Return only JSON: {"verdicts": [{"index": 0, "status": "confirmed", "confidence": 85, "notes": "...", "related_cards": ["D1"]}]}
Give a verdict for every index.

# Claims
{{claims}}

# Decision cards
{{cards}}

# Context
{{context}}
