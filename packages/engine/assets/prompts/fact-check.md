---
tools: none
timeoutSec: 90
maxTurns: 2
---
Check each decision card's factual claims against the code and the rest of the context below. Check `plain_technical`, the factual parts of `why_it_matters`, and each option's `summary`, including that the option marked `is_current` really is what the code does now.

For a claim that is wrong and you can state correctly, give a correction. For a claim you cannot confirm, add a flag with a one-line note. Leave correct claims alone. You may not add, remove, merge, or reclassify cards.

Return only JSON: {"cards": [{"index": 0, "corrections": {"plain_technical": "...", "why_it_matters": "...", "options": [{"index": 1, "summary": "..."}]}, "flags": [{"claim": "...", "note": "..."}]}]}
Omit cards with nothing to report.

# Cards
{{cards}}

# Context
{{context}}
