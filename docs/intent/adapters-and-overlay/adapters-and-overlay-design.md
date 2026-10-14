---
parent: high-level-design
prefix: ADPT
---

# Adapters and Overlay

## Context and Design Philosophy

The core must run unchanged in environments that reach code hosts differently and have their own conventions. This component defines the seams where an environment plugs in: **sources** that read a change, **sinks** that write back to it, **caller resolvers** and **tool-output providers** that give the pipeline knowledge it cannot get from text, **configuration**, and an **overlay** that replaces the core's prompts, rules, and adapters without forking it.

Writing back is the one outward-facing, irreversible act the tool performs. It is gated in code by the reviewer's sign-off on the exact text.

## Sources

A source turns a reference to a change into what the pipeline needs: base and head commits (for a pull request, the base is the merge-base of the pull request's head and its target branch, so unrelated changes on the target are not part of the review), a title, a description, the text of linked issues, and existing review comments. Two sources ship with the core:

- **git**: a base and head ref, or the working tree against a base. As with pull requests, the base commit is the merge-base, so commits that landed on the base branch after the change branched off are not part of the review. No description or comments; the intent sources are empty unless the reviewer supplies a description.
- **gh**: a pull request number on GitHub, read with the `gh` command-line tool. The source fetches the pull request's base and head commits into the local repository when they are missing, without changing the checked-out branch.

An overlay may add sources, for example one that reaches the code host through an MCP server by calling the Claude CLI with that server enabled. Sources are read-only.

## Caller Resolvers and Tool Output

A **caller resolver** answers, for one ecosystem, which files at head refer to a changed file (for example, a data-lineage manifest, a build index, or module call sites in infrastructure code). A **tool-output provider** produces a deterministic report about the change that the diff alone does not show (for example, an infrastructure plan distinguishing replacement from update, a data-lineage impact list, or an API compatibility report). Neither ships with the core beyond the text-search fallback; both are added through configuration or an overlay. Their output enters the context pack like any other item.

## Sinks and Sign-off

A sink posts text to a target: a pull request comment through `gh` ships with the core. A sink accepts only a **signed post**, and reports success or failure to its caller so the session can record when a post was made. A signed post is the target, the exact text, and the time the reviewer approved that text. The signed post is created by the review session when the reviewer approves the exact text shown to them. Before posting, the sink checks that the text it is about to send is byte-identical to the signed text; any difference refuses the post. After a successful post, the session records the target, the text's hash, and the sign-off time in the decision record.

The tool never posts a review approval or a request for changes. It posts comments only.

## Configuration

Settings come from, in increasing precedence: built-in defaults, a user configuration file, a repository configuration file, the overlay, and command-line flags. Settings cover the run root directory, the model and budgets per stage, the concurrency cap, the confidence threshold for findings, per-category default stakes for the repository, generated-file paths, caller resolvers and tool-output providers, extra arguments for every Claude CLI call, the reviewer identity override, the default source, and the overlay location.

## Overlay

An overlay is a directory with the same layout as the core's overridable files:

```
<overlay>/
  config.(json|yaml)        settings, applied above repository configuration
  prompts/<stage>.md        replaces a stage prompt
  guides/card-guide.md      replaces the card guide
  triggers.(json|yaml)      replaces the trigger list
  adapters/*.js             adds sources, sinks, caller resolvers, and tool-output providers
```

A file in the overlay replaces the core file at the same relative path; anything not present falls through to the core. The overlay is located by configuration, so a private overlay can live outside the repository under review. A stage's cache key includes the contents of every prompt, guide, and trigger file it used, wherever it came from, so changing an overlay file reruns exactly the stages that used it.

Overlay adapters are code that runs with the reviewer's permissions; an overlay is trusted exactly as much as the person who configured it.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|---|---|---|---|
| Customization | Overlay directory replacing files by path | Fork; plugin API with hooks | Replacing files is the simplest model that covers prompts, guides, triggers, and adapters, and needs no API design. A fork drifts from the core |
| Sign-off enforcement | The sink verifies the text against a signed post | Interfaces ask for confirmation | Enforcement in the sink holds for every interface and every overlay sink built on it |
| What may be posted | Comments only | Approvals and change requests | The tool records decisions; it does not approve or block |
| Adapter code in overlays | JavaScript modules loaded from the overlay | Configuration only | Environments differ in how they reach code hosts; configuration alone cannot express a new access method |

## Open Questions & Future Decisions

### Deferred
1. Inline comments on specific lines, beyond a single pull request comment.
2. Sources for code hosts other than GitHub.

## References

- `docs/high-level-design.md`
- `docs/intent/review-session/review-session-design.md`
- `docs/intent/pipeline/pipeline-design.md`
