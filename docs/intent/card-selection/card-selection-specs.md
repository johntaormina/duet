# Card Selection — EARS Specs

Design: `card-selection-design.md`. Card selection runs as the pipeline's `cards` stage and writes `cards.json` (defined in `docs/intent/review-artifacts/`). A "trigger hit" is a part of the change that falls in a trigger category. A "trigger card" is a card whose `source` is `trigger` (it lists one or more trigger categories); a "proposed card" is one whose `source` is `proposed`.

## Triggers

- [x] **CARD-TRIG-001**: The cards stage shall read the trigger categories, each with a description, a default stakes level, and optional deterministic signals, from a trigger file that an overlay can replace.
- [x] **CARD-TRIG-002**: The core trigger file shall define the categories `auth`, `secrets`, `money`, `data-model`, `data-semantics`, `irreversible`, `public-interface`, `compat-rollout`, `concurrency`, `error-semantics`, `privacy`, `intent-contradiction`, `intent-unstated`, and `intent-unknown` with default stakes `high`, and `new-dependency`, `infra-ci`, `cost-performance`, and `observability` with default stakes `low`.
- [x] **CARD-TRIG-003**: The cards stage shall evaluate each category's deterministic signals (path patterns, manifest and base-image changes, and CI action references) in code and record each match as a trigger hit.
- [x] **CARD-TRIG-004**: The cards stage shall record each mismatch in `intent.json` of kind `contradiction` as an `intent-contradiction` trigger hit.
- [x] **CARD-TRIG-005**: The cards stage shall ask the card-writing call to report, for each category, the parts of the change that fall in it, with anchors and a reason, and record each as a trigger hit.
- [x] **CARD-TRIG-006**: The cards stage shall check that every trigger hit is covered by a trigger card whose categories include the hit's category and whose anchors include the hit's file.
- [x] **CARD-TRIG-007**: If a trigger hit is not covered by a trigger card, then the cards stage shall treat the card-writing output as invalid, naming the uncovered hits for the pipeline's single retry.
- [x] **CARD-TRIG-008**: If a trigger hit is still not covered after the pipeline's retry, then the cards stage shall fail.
- [x] **CARD-TRIG-009**: When the stated intent in `intent.json` has 15 or more words and at least one mismatch of kind `unstated` exists, the cards stage shall record all `unstated` mismatches together as one `intent-unstated` trigger hit.
- [x] **CARD-TRIG-010**: When the stated intent in `intent.json` is empty or shorter than 15 words, the cards stage shall record one `intent-unknown` trigger hit and no `intent-unstated` hit.
- [x] **CARD-TRIG-011**: The `new-dependency` deterministic signals shall match a manifest change that adds a dependency, raises a dependency's major version, or changes a dependency's source, and a change to a container base image.
- [x] **CARD-TRIG-012**: The `secrets` deterministic signals shall match an added or changed reference to a third-party CI action.
- [x] **CARD-TRIG-013**: Where the repository configuration sets a default stakes level for a trigger category, the cards stage shall use it in place of the trigger file's default for that category.

## Proposed cards

- [x] **CARD-PROP-001**: The cards stage shall send every proposed card to a card refuter: a fresh Claude CLI call that receives the context pack, the briefing, and the proposed cards but not the reasoning that produced them.
- [x] **CARD-PROP-002**: The cards stage shall instruct the card refuter to reject a proposed card whose alternative is not one a reasonable engineer would choose, whose consequence is not concrete, or whose decision is already fixed by the stated intent or an external constraint.
- [x] **CARD-PROP-003**: The cards stage shall drop every proposed card the card refuter rejects for a reason other than being already fixed by the stated intent or an external constraint.
- [x] **CARD-PROP-004**: The cards stage shall never send a trigger card to the card refuter.
- [x] **CARD-PROP-005**: When the card refuter rejects a proposed card as already fixed by the stated intent or an external constraint, the cards stage shall add it to `cards.json`'s `settled` list with what fixed it, and not to the deck.
- [x] **CARD-PROP-006**: If the card refuter call fails, then the cards stage shall leave out all proposed cards and set `proposed_status` to `failed` with a note.

## The deck

- [x] **CARD-DECK-001**: The cards stage shall include every trigger card in `cards.json`, whatever the number of cards.
- [x] **CARD-DECK-002**: When there are fewer than seven trigger cards, the cards stage shall add surviving proposed cards, high stakes before low, until the deck has seven cards or no proposed cards remain.
- [x] **CARD-DECK-003**: When there are seven or more trigger cards, the cards stage shall add no proposed cards.
- [x] **CARD-DECK-004**: The cards stage shall set a trigger card's stakes to the highest of its categories' default stakes (after repository configuration) and Claude's assessed stakes.
- [x] **CARD-DECK-005**: The cards stage shall never set a card's stakes lower than Claude's assessed stakes for that card.
- [x] **CARD-DECK-006**: The cards stage shall set `stakes_basis` to name the category default or Claude's reason, whichever determined the stakes.
- [x] **CARD-DECK-007**: The cards stage shall order cards by the position of the briefing step each card points at, and within one step, high stakes before low.
- [x] **CARD-DECK-008**: The cards stage shall compute a card's fingerprint as a hash of its sorted trigger categories (or `proposed`), the sorted file paths of its anchors, and its anchors' patterns (or whitespace-normalized anchored code), adding an ordinal when two cards in one run would otherwise share a fingerprint.
- [x] **CARD-DECK-009**: When no trigger hit exists and no proposed card survives, the cards stage shall write an empty card list with a `no_decisions_summary` stating what was reviewed and why nothing needed a decision.

## Fact check

- [x] **CARD-CHECK-001**: After assembling the deck, the cards stage shall check every card's technical statement, option descriptions, and factual claims in why it matters against its anchors and the context pack in one fresh Claude CLI call.
- [x] **CARD-CHECK-002**: The fact check shall be able to correct a claim's text or add a flag for a claim it cannot confirm.
- [x] **CARD-CHECK-003**: The cards stage shall not let the fact check add, drop, or merge cards, change their categories, or lower their stakes.
- [x] **CARD-CHECK-004**: If a fact-check correction would make a card invalid, then the cards stage shall discard the correction and flag the claim instead.
- [x] **CARD-CHECK-005**: The cards stage shall run the fact check with a turn limit and a timeout, defaulting to 90 seconds.
- [x] **CARD-CHECK-006**: If the fact check times out or fails, then the cards stage shall write the deck as assembled and set `fact_check` to `timed_out` or `failed`.

## Writing cards

- [x] **CARD-WRITE-001**: The cards stage shall give the card-writing call the card guide, a markdown file that an overlay can replace.
- [x] **CARD-WRITE-002**: Validation of `cards.json` shall reject a card whose `question` exceeds 30 words.
- [x] **CARD-WRITE-003**: Validation of `cards.json` shall reject a card whose `why_it_matters` exceeds 60 words.
- [x] **CARD-WRITE-004**: Validation of `cards.json` shall reject a card whose `plain_technical` exceeds 60 words.
- [x] **CARD-WRITE-005**: Validation of `cards.json` shall reject a card with an option whose `summary` exceeds 25 words.
- [x] **CARD-WRITE-006**: The card guide shall instruct that `why_it_matters` names a consequence for users, data, money, or on-call.
- [x] **CARD-WRITE-007**: The card guide shall instruct that each card poses one decision, answerable by a capable engineer who does not specialize in the area.
- [x] **CARD-WRITE-008**: The card guide shall instruct that a metaphor, when used, comes from everyday life.
- [x] **CARD-WRITE-009**: The card guide shall instruct that a card's options are at the same level of abstraction.
- [x] **CARD-WRITE-010**: The card guide shall instruct that a card asking about one of the briefing's choices sets `choice_ref` to that choice's id.
- [x] **CARD-WRITE-011**: The card guide shall instruct that `not_examined` on a card with category `public-interface`, `data-model`, or `compat-rollout` includes consumers outside the repository.
