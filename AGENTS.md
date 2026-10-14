# Duet

**Name.** The project is Duet: the command is `duet`, packages are scoped `@duet/*` and private (the unscoped npm name `duet` belongs to someone else), and the run directory is `.duet/`. EARS prefixes are named by function, not by the project.

A two-layer AI code reviewer: a human layer that explains changes and asks the reviewer to make the few judgement calls that matter, and a machine layer that handles bugs, security, and the like. `doc.md` holds the research and early proposal this project grew from; it is background, not the source of truth. The HLD at `docs/high-level-design.md` is.

## LID
- Mode: Full
- Version: 1.4.0

## Linked-Intent Development (MANDATORY)

**Consult the `linked-intent-dev` skill for ALL code changes.** All changes flow through the arrow of intent in one direction:

```
HLD → LLDs → EARS → Tests → Code
```

- **All changes**: consult the `linked-intent-dev` skill if your harness provides it; otherwise read `docs/lid/workflow.md` before making changes, and if it is missing and `## LID` records no decline, offer the user once to add it from https://raw.githubusercontent.com/jszmajda/lid/v1.4.0/plugins/linked-intent-dev/skills/update-lid/references/workflow-doc.md (on decline, add `- Workflow doc: declined` to `## LID`). The workflow in one line: HLD check → LLD → EARS specs → edge audit → failing tests first → code — inspected at each phase.
- **Bug fixes**: walk the arrow like any other change — find where behavior diverged from intent and cascade from there. No short-circuit.

Each phase's output is inspected — by the user or an inspector they name — before the next begins; ambiguous spec readings go back to the user. **Docs carry current intent, written to be read cold** — write each doc as if authored fresh today, from current intent alone: no narration of how it changed, no meaning that needs the conversation that produced it, no rebuttals to questions only a past discussion raised. Rationale, considered alternatives, and constraints a fresh author would independently write stay; record rejected alternatives and why in the LLD's Decisions & Alternatives table, not as asides in body prose.

**Memory vs. intent.** Before saving durable project knowledge to agent or tool memory, test whether it is project *intent* — would a fresh agent, in any tool, next session, need it to build this system correctly? If yes, record it in the arrow (HLD / LLD / EARS / decision doc), which travels and cascades — not in private, per-tool memory, where intent escapes the arrow. Knowledge about the user or how they like to work stays in memory.

### Navigation

| What you need | Where to look |
|---|---|
| High-level design | `docs/high-level-design.md` |
| Design tree (sub-HLDs, LLDs, their specs) | `docs/intent/` — one folder per node |
| EARS specs | beside each design doc as `{node}-specs.md` in the node's folder under `docs/intent/` |
| Decision docs | `docs/decisions/` (project-level) and `docs/intent/<segment>/decisions/` |
| Background research | `doc.md` |

### Terminology

- **HLD**: High-Level Design — single project-level doc at `docs/high-level-design.md`.
- **LLD**: Low-Level Design — detailed component design doc in `docs/intent/`. The design layer is a recursive tree: the root is the HLD, leaf LLDs own EARS, and a component deep enough to outgrow one doc becomes a sub-HLD (HLD-shaped, owns no EARS) with children beneath it. "HLD" and "LLD" are roles by position; depth-2 (one HLD over flat leaf LLDs) is the default.
- **EARS**: Easy Approach to Requirements Syntax — structured one-line requirements beside each design doc as `{node}-specs.md` in the node's folder under `docs/intent/`. IDs are path-concatenated — the root-to-leaf path of the owning segment plus a number — so a prefix grep gathers a subtree. Markers: `[x]` implemented, `[ ]` active gap, `[D]` deferred.
- **Arrow**: the unidirectional chain from vision to code (HLD → LLDs → EARS → Tests → Code). Strictly a DAG of intent.
- **Arrow segment**: the territory owned by one leaf LLD — the LLD itself plus the specs, tests, and code that cite its EARS IDs. The boundary is the leaf prefix. Within-segment cascade is free; across-segment cascade pauses.
- **Cascade**: propagating a change downstream through the arrow so adjacent levels stay coherent.

### Code annotations

Annotate code and tests with `@spec` comments citing EARS IDs:

```
// @spec AUTH-UI-001, AUTH-UI-002
```

Place the annotation at the *entry point of the behavior's implementation graph* — the topmost function or module owning the specified behavior, not every helper. When a behavior spans multiple subsystems (UI + API + database, for example), annotate at the entry point in each subsystem. Tests follow the same rule: annotate the test that directly exercises the spec, not every inner assertion.

## LID Tooling

- **Coherence check**: `node scripts/coherence-check.mjs [PREFIX...]` — reports `@spec` annotations that name no spec, active specs with no test, and active specs with no code annotation (JSON Schemas carry theirs in `$comment`). Exits non-zero on dangling annotations or untested specs.
- **Tests**: `npm test` (Vitest); **typecheck**: `npm run typecheck`.
