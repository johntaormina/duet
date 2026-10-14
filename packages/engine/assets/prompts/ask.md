---
tools: read-only
timeoutSec: 180
maxTurns: 8
---
<!-- @spec PIPE-STG-005 -->
A reviewer working through a decision card is asking you a question. Answer it clearly and briefly, from the code (you may read files in the working directory) and the context. If you do not know, say so.

{{rule}}

Return only JSON: {"answer": "..."}

# Question
{{question}}

# Earlier questions about this card
{{earlier}}

# Card
{{card}}

# Recommendation
{{recommendation}}

# Briefing
{{briefing}}

# Context
{{context}}
