---
parent: high-level-design
prefix: CARD
---

# Card Selection

## Context and Design Philosophy

Card selection decides which judgement calls in a change are put to the reviewer, and how each is written. It runs as the pipeline's `cards` stage and produces `cards.json` as defined by the review-artifacts design.

The design has to hold two pressures against each other. Some kinds of change are dangerous enough that a person must always be asked about them, whatever Claude thinks; these form a **floor** that Claude cannot remove. Beyond the floor, models readily invent decisions to look useful, so every card Claude proposes on its own judgement must prove it is a real decision before it reaches the reviewer. And because a confidently wrong card becomes what the reviewer believes about the change, every card's claims are checked against the code before the deck is shown, within a fixed time.

## Triggers

A trigger is a category of change that always produces a card. The trigger list is a data file, replaceable by an overlay, where each category has a description, a default stakes level, and optional deterministic signals. A repository's configuration may set a different default stakes level for a category (for example, lowering `infra-ci` in an infrastructure repository where every change touches it); Claude never lowers stakes.

| Category | Covers | Default stakes |
|---|---|---|
| `auth` | Authentication and authorization logic | high |
| `secrets` | Handling, storage, or transmission of credentials and keys, including third-party CI actions that can reach them | high |
| `money` | Billing, payments, pricing | high |
| `data-model` | Schemas, migrations, persisted or exchanged data formats | high |
| `data-semantics` | Meaning of data: units, null and duplicate handling, join cardinality, metric definitions, feature preprocessing, model and evaluation settings | high |
| `irreversible` | Deletes, sends to external systems, other one-way operations | high |
| `public-interface` | Exported APIs, endpoints, command-line flags, configuration formats others depend on | high |
| `compat-rollout` | Compatibility with deployed clients and versions, deployment and migration order, feature flags, semantic-version level | high |
| `concurrency` | Locking, ordering of asynchronous work, shared mutable state | high |
| `error-semantics` | Swallowed errors, retries, idempotency of reruns and backfills | high |
| `privacy` | Personal data in logs, storage, or transmission; retention; device permissions | high |
| `intent-contradiction` | Code that does the opposite of, or something incompatible with, what the stated intent says | high |
| `intent-unstated` | Code that does things the stated intent does not mention | high |
| `intent-unknown` | No usable statement of intent exists for the change | high |
| `new-dependency` | A dependency added, upgraded by a major version, or taken from a new source; a container base image changed | low |
| `infra-ci` | Build, deployment, and CI configuration | low |
| `cost-performance` | Instance sizes, scaling, query scan size, batch sizes | low |
| `observability` | Alerts, metrics, and logs added, removed, or changed | low |

Trigger hits come from two sources, and their union is the floor:

- **Deterministic signals**, evaluated by code: path patterns (a migrations directory, CI configuration), manifest changes that add a dependency, raise its major version, or change its source, container base-image changes, and references to third-party CI actions (a `secrets` hit).
- **Classification by Claude**: the card-writing call reports, for each category, the parts of the change that fall in it, with anchors and a one-line reason.

**Intent triggers** are derived from `intent.json` by code. Each mismatch of kind `contradiction` is an `intent-contradiction` hit. All mismatches of kind `unstated` together are one `intent-unstated` hit, so they become a single card. When the stated intent is empty or shorter than 15 words, there is instead one `intent-unknown` hit, whose card asks what the change is for, and no `intent-unstated` hit.

Several hits may be one decision, and one decision may fall in several categories, so a trigger card lists one or more categories. Code checks that every hit is covered by a trigger card whose categories include the hit's category and whose anchors include the hit's file. Uncovered hits make the card-writing output invalid, and the pipeline's single retry names them.

## Proposed Cards

The card-writing call may propose further cards for judgement calls outside the trigger list. A proposed card must state `alternative_and_consequence`: a concrete alternative a reasonable engineer could have chosen instead of what the code does, and what would differ for users, data, cost, or on-call.

Proposed cards then go to a **card refuter**: a separate, fresh CLI call that sees the context pack, the briefing, and the proposed cards but not the reasoning that produced them. It rejects a card when the alternative is not one a reasonable engineer would choose, when the consequence is not concrete, or when the decision is already fixed by the stated intent or an external constraint. Cards rejected as already fixed are not lost: they move to the deck's `settled` list with what fixed them, and the interface shows them alongside the briefing's choices, because "this was settled by Z" is part of why the change went the way it did. Other rejected cards are dropped. Trigger cards are never sent to the refuter.

If the refuter call fails, all proposed cards are left out and `proposed_status` records the failure, so the reviewer sees that Claude's own proposals could not be vetted.

## Fact Check

After the deck is assembled, one fresh CLI call checks every card, trigger and proposed alike, against its anchors and the context pack: the literal technical statement, each option's description (including which option is the current behavior), and the factual parts of why it matters. It may correct a claim's text or flag a claim it cannot confirm. It may not add, drop, or merge cards, change their categories, or lower their stakes. A correction that would make a card invalid is discarded and the claim is flagged instead.

The fact check has a turn limit and a timeout (default 90 seconds). If it times out or fails, the deck is written as assembled, with `fact_check` recording `timed_out` or `failed`, so the briefing is never held up by it and the reviewer can see that the cards were not checked.

## The Deck

- **Cap.** Proposed cards fill the deck up to seven cards, high stakes before low, after all trigger cards. Trigger cards are never dropped to meet the cap: when there are more than seven, every one is kept, no proposed card is added, and the interface tells the reviewer that the change likely holds more decisions than one review handles well and may be worth splitting.
- **Stakes.** A trigger card's stakes are the highest of its categories' default stakes (after repository configuration) and Claude's assessment. A proposed card's stakes are Claude's assessment. Code never lowers stakes, and `stakes_basis` names the category default or Claude's reason.
- **Order.** Cards follow the order of the briefing steps they point at, and within a step, high stakes before low.
- **Choices.** A card that asks about one of the briefing's choices names it in `choice_ref`.
- **Nothing to decide.** When no trigger fires and no proposed card survives, the deck is empty and `no_decisions_summary` explains what was reviewed and why nothing needed a decision.
- **Fingerprint.** A hash of the card's sorted categories (or `proposed`), the sorted file paths of its anchors, and its anchors' patterns (or whitespace-normalized anchored code), with an ordinal added when two cards in one run would otherwise collide.

## Writing a Card

The card guide (a markdown file, replaceable by an overlay) holds these rules, and validation of `cards.json` enforces the word limits (a check in the artifact store, since a schema cannot count words):

- One decision per card. The `question` is answerable by a capable engineer who does not specialize in this area. At most 30 words.
- `why_it_matters` names a consequence for users, data, money, or on-call, not a property of the code. At most 60 words.
- `plain_technical` states literally what the code does. At most 60 words. It is always present, so a metaphor is never the only explanation.
- A `metaphor`, when used, comes from everyday life and carries `analogy_breaks_down_when`.
- Two to four options, at the same level of abstraction. One option is what the code currently does. Each option summary is at most 25 words.
- `basis` lists the context pack items the card was written from, and `not_examined` lists relevant things outside the pack. For `public-interface`, `data-model`, and `compat-rollout` cards, `not_examined` always includes consumers outside the repository.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|---|---|---|---|
| Floor sources | Deterministic signals plus Claude's classification, as a union | Deterministic only; Claude only | Path rules miss logic changes in ordinary files; Claude alone can talk itself out of a dangerous category. The union means neither blind spot removes a card |
| Categories per card | One or more | Exactly one | One migration can be a data-model, irreversible, and compatibility decision at once; one category per card would turn a single decision into three cards |
| Lowering stakes | Repository configuration only | Claude judges per change; never | Some repositories hit a category on every change; letting the repository say so keeps decks useful, while Claude still cannot downgrade the cards that matter |
| Intent triggers | Contradictions one card each; everything unstated as one card; no usable intent as one card | One card per mismatch | With a thin description every behavior is "unstated"; one card each would bury the deck, and a change with no stated intent needs one question, not many |
| Grouping hits | Claude groups hits into decisions; code checks every hit is covered | One card per hit | Several hits are often one decision; the coverage check keeps grouping from becoming a way to drop a hit |
| Proposed-card check | A fresh refuter call | Self-check in the writing call | The writer favors its own proposals; the refuter has no stake in them |
| Already-settled decisions | Kept in the deck's settled list and shown with the briefing's choices | Dropped | What fixed a decision is part of why the change went the way it did |
| Trigger cards and the refuter | Never refuted | Refute all cards | The floor exists precisely so that Claude's judgement cannot remove these |
| Fact check | One bounded call over every card that may correct or flag, never drop | No check; a check per card; a check that can drop cards | Wrong cards become what the reviewer believes. One bounded call keeps the cost to a fixed time, and never dropping keeps the floor intact |
| Fact check timing out | Show the deck unchecked and say so | Wait; fail the stage | The reviewer should not wait on a check, and should know when one did not happen |
| Floor versus cap | Trigger cards are never dropped; proposed cards fill only up to seven | Drop lowest-stakes trigger cards; group harder to fit | Dropping breaks the floor; forced grouping merges unrelated decisions. A deck over seven is a finding about the change |
| Current behavior as an option | Always one of the options | Options are only alternatives | The real choice is usually keep or change; without the current behavior as an option, the reviewer cannot say "this is fine as it is" |
| Stakes | Code takes the highest of defaults and assessment; never lowers | Claude assigns freely | The tool must not be able to downgrade the cards that matter |

## Open Questions & Future Decisions

### Deferred
1. Measuring card precision and recall against a set of past changes with known decisions.
2. A threshold other than 15 words for treating stated intent as unusable, set from real use.

## References

- `docs/high-level-design.md`
- `docs/intent/review-artifacts/review-artifacts-design.md`
- `docs/intent/pipeline/pipeline-design.md`
