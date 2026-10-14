# Adapters and Overlay — EARS Specs

Design: `adapters-and-overlay-design.md`. A "source" reads a change; a "sink" writes text back to a code host; a "signed post" (created by the review session in `docs/intent/review-session/`) holds a target, exact text, and approval time.

## Sources

- [ ] **ADPT-SRC-001**: Every source shall return the base commit, the head commit, a title, a description, the text of linked issues, and existing review comments, with empty values where it has none.
- [ ] **ADPT-SRC-002**: The `git` source shall accept a base and head ref, or the working tree against a base.
- [ ] **ADPT-SRC-003**: When the `git` source is used without a reviewer-supplied description, it shall return empty intent sources.
- [ ] **ADPT-SRC-004**: The `gh` source shall accept a GitHub pull request number and read it with the `gh` command-line tool.
- [ ] **ADPT-SRC-005**: When a pull request's base or head commit is missing locally, the `gh` source shall fetch it without changing the checked-out branch.
- [ ] **ADPT-SRC-006**: Sources shall not write to the code host.
- [ ] **ADPT-SRC-007**: When resolving a pull request, the `gh` source shall return as the base commit the merge-base of the pull request's head commit and its target branch.
- [ ] **ADPT-SRC-008**: Where a caller resolver or tool-output provider is configured, the engine shall load it as an adapter and pass its output to the pipeline.

## Sinks

- [ ] **ADPT-SINK-001**: A sink shall accept only a signed post.
- [ ] **ADPT-SINK-002**: If the text a sink is about to send is not byte-identical to the signed post's text, then the sink shall refuse to post.
- [ ] **ADPT-SINK-003**: The `gh` sink shall post a signed post's text as a pull request comment.
- [ ] **ADPT-SINK-004**: No sink shall submit a review approval or a request for changes.
- [ ] **ADPT-SINK-005**: A sink shall report to its caller whether each post succeeded.

## Configuration

- [ ] **ADPT-CFG-001**: Every package that reads configuration shall resolve each setting from, in increasing precedence, built-in defaults, the user configuration file, the repository configuration file, the overlay configuration, and command-line flags.
- [ ] **ADPT-CFG-002**: Configuration shall cover the run root directory, the model and budgets per stage, the concurrency cap, the findings confidence threshold, per-category default stakes, generated-file paths, caller resolvers, tool-output providers, the reviewer identity, the default source, and the overlay location.

## Overlay

- [ ] **ADPT-OVL-001**: Where an overlay location is configured, the engine shall use a file at a relative path in the overlay in place of the core file at the same relative path.
- [ ] **ADPT-OVL-002**: Where an overlay location is configured, the engine shall use the core file for any relative path the overlay does not contain.
- [ ] **ADPT-OVL-003**: An overlay shall be able to replace stage prompts, the card guide, the trigger file, and configuration, and to add sources, sinks, caller resolvers, and tool-output providers as JavaScript modules.
