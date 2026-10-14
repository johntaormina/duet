---
tools: none
timeoutSec: 300
---
<!-- @spec PIPE-STG-004 -->
You are choosing the decisions in this change that a human reviewer must own, and writing each as a decision card. Follow the card guide exactly. Work only from the context.

## Trigger categories
These categories always produce a card when the change touches them:
{{triggers}}

## Hits you must cover
These were found by code and must each be covered by a trigger card (`source: "trigger"`) whose `categories` include the hit's category and whose anchors include the hit's file:
{{required_hits}}

## What to return
- `hits`: every other part of the change you judge to fall in a trigger category: `{"category": "...", "file": "path", "reason": "one line"}`. Each must also be covered by a trigger card.
- `cards`: the cards. Group hits that are one decision into one card; a card may list several categories. Beyond the triggers, you may propose cards (`source: "proposed"`) for real judgement calls, each with `alternative_and_consequence`. Do not invent decisions; an empty list is a valid answer.
- `no_decisions_summary`: always present: what you reviewed and why the rest needed no decision.

Each card: `source`, `categories` (trigger cards), `assessed_stakes` ("high" or "low"), `stakes_reason`, `question`, `why_it_matters`, `plain_technical`, optional `metaphor` with `analogy_breaks_down_when`, `options` (2 to 4; each `summary`, `pros`, `cons`, `reversibility`, `is_current`; exactly one is_current), `alternative_and_consequence` (proposed cards), `anchors`, `step_ref` (a briefing step id), optional `choice_ref` (a briefing choice id), `basis` (context item ids), `not_examined`.

Return only JSON: {"hits": [...], "cards": [...], "no_decisions_summary": "..."}

# Card guide
{{guide}}

# Briefing
{{briefing}}

# What the change claims and does
{{intent}}

# Context
{{context}}
