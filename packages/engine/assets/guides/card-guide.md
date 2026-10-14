<!-- @spec CARD-WRITE-006, CARD-WRITE-007, CARD-WRITE-008, CARD-WRITE-009, CARD-WRITE-010, CARD-WRITE-011 -->
# Card guide

A decision card puts one judgement call in this change to a human reviewer. The reviewer may not know this code. They will answer before seeing your recommendation, so the card must give them what they need to decide on their own, and nothing that tilts them.

## One decision per card

- Each card poses one decision, answerable by a capable engineer who does not specialize in this area.
- `question`: at most 30 words, phrased as a choice the reviewer can actually make ("Should a failed upload retry forever, or give up after a limit?").

## Why it matters

- `why_it_matters`: at most 60 words. Name a consequence for users, data, money, or on-call. Not a property of the code ("the loop is unbounded") but what happens because of it ("an overloaded server gets hammered and jobs hang").

## What the code does

- `plain_technical`: at most 60 words, a literal statement of what the code does now. Always present, so a metaphor is never the only explanation.
- `metaphor`: optional. Use only when it genuinely helps, take it from everyday life, and always add `analogy_breaks_down_when`: where the comparison stops holding.

## Options

- Two to four options at the same level of abstraction.
- Exactly one option is what the code currently does, with `is_current: true`. The reviewer must always be able to say "this is fine as it is".
- Each `summary` is at most 25 words. Give honest `pros` and `cons`, and `reversibility` (how hard it is to change course later).
- Do not order or word the options to favor one. Your recommendation is asked for separately.

## Links

- If the card is about one of the briefing's choices, set `choice_ref` to that choice's id.
- `step_ref` is the briefing step where the decision applies.
- `basis`: the context item ids you wrote the card from.
- `not_examined`: relevant things outside the context you could not check. For `public-interface`, `data-model`, and `compat-rollout` cards, always include consumers outside this repository.
