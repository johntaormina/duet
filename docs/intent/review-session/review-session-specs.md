# Review Session — EARS Specs

Design: `review-session-design.md`. "The session" is the review-session library one reviewer uses on one run. Card stakes, recommendations, findings, and session files are as defined in `docs/intent/review-artifacts/`; `ask` is the engine operation defined in `docs/intent/pipeline/`.

## Reviewer

- [x] **SESS-ID-001**: The session shall identify the reviewer by the repository's version-control user email unless a reviewer identity setting is configured.
- [x] **SESS-ID-002**: The session shall convert the reviewer identity into a filename-safe form for the `<reviewer>` part of session file names.

## Card states

- [x] **SESS-STATE-001**: The session shall track each card as `open`, `committed`, `revealed`, or `stale` for the reviewer.
- [x] **SESS-STATE-002**: When the reviewer commits to a card, the session shall require a chosen option.
- [x] **SESS-STATE-003**: When the reviewer commits to a high-stakes card, the session shall require a non-empty rationale and accept any non-empty text.
- [x] **SESS-STATE-004**: When the reviewer commits to a card, the session shall write the choice, the rationale, and the commit time to the record immediately.
- [x] **SESS-STATE-005**: While a high-stakes card is not committed, the session shall refuse to return its recommendation.
- [x] **SESS-STATE-006**: When asked to reveal a committed card whose recommendation is available, the session shall return the recommendation, move the card to `revealed`, and record the reveal time and whether the recommended option equals the reviewer's option at that moment as `agreed_with_ai`.
- [x] **SESS-STATE-007**: When asked to reveal a committed card whose recommendation is not available, the session shall return the recommendations stage's state, keep the card `committed`, and leave the reveal time and `agreed_with_ai` unset.
- [x] **SESS-STATE-008**: The session shall treat a card's recommendation as available only when the artifact store returns one whose `card_hash` matches the current card.
- [x] **SESS-STATE-009**: While a low-stakes card's recommendation is available, the session shall return it before commitment and record the time it was first returned as the reveal time.
- [x] **SESS-STATE-010**: When the reviewer changes a committed card's option, the session shall require a reason and record the earlier option, the new option, the reason, and the time.
- [x] **SESS-STATE-011**: When the current card's hash differs from the hash recorded with the reviewer's answer to the card with the same fingerprint, the session shall present the answer as stale and treat the card as `open`.
- [x] **SESS-STATE-012**: When the reviewer commits to a low-stakes card, the session shall require only a chosen option and shall record `agreed_with_ai` against the recommendation available at that moment, or leave it null when none is available.
- [x] **SESS-STATE-013**: When the reviewer answers a card whose recorded answer is stale, the session shall replace the entry and keep the stale answer as previous.

## Questions

- [x] **SESS-ASK-001**: When the reviewer asks a question about a card, the session shall call the engine's `ask` stating whether the reviewer may see that card's recommendation: for a high-stakes card only once it has been revealed, and for a low-stakes card once it has been shown.
- [x] **SESS-ASK-002**: When the reviewer asks a question about a card, the session shall append the question and answer to the reviewer's question log.
- [x] **SESS-ASK-003**: The session shall derive the number of questions asked about a card before commitment from the reviewer's question log.

## Findings

- [x] **SESS-FIND-001**: The session shall offer the reviewer only findings that are not refuted and whose confidence meets the configured threshold, defaulting to 80.
- [x] **SESS-FIND-002**: When the reviewer marks a finding dismissed, fixed, or open, the session shall store that state under the finding's fingerprint in the reviewer's finding-state file.
- [x] **SESS-FIND-003**: The session shall assign each offered finding to the briefing cohort containing its first anchor's file, or to "other" when no cohort contains it.

## Record and decision log

- [x] **SESS-REC-001**: The session shall write the record after every change the reviewer makes.
- [x] **SESS-REC-002**: When the reviewer ends a review, the session shall record the end time and the stages not complete at that moment.
- [x] **SESS-REC-003**: The session shall allow a review to end with cards unanswered.
- [x] **SESS-REC-004**: The session shall produce a decision log in markdown listing, for each answered card, the question, the chosen option, the rationale, whether it matched Claude's recommendation, and whether it changed after commitment.
- [x] **SESS-REC-005**: The decision log shall list the unanswered cards and the stages that were not complete.
- [x] **SESS-REC-006**: When the reviewer approves the exact text of a post, the session shall create a signed post holding the target, the text, and the approval time.
- [x] **SESS-REC-007**: When a sink reports that a signed post was posted, the session shall record the target, the hash of the posted text, the sign-off time, and the posting time in the record.
- [x] **SESS-REC-008**: If a session file fails validation, then the session shall stop writing to it and tell the reviewer that it must be repaired or moved aside.
