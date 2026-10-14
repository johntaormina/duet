# Duet

Two-layer code review. A person and Claude each do the part of review they are suited to.

- **The human layer** explains the change: what it claims to do, what it actually does, and **the choices it made and what it chose against**, with each reason labelled as stated by the author, inferred by Claude, or not found. It then puts the few decisions that need a human owner in front of you as decision cards. On high-stakes cards you commit to your own answer before you see Claude's.
- **The machine layer** runs in the background. Specialist Claude calls hunt for bugs, security issues, test gaps, and convention violations, and a separate verifier tries to refute each finding before you see it.

Duet never approves or blocks a change. It records the decisions you made, and posts them to a pull request only after you approve the exact text.

## Requirements

- Node.js 20 or later (developed on 24)
- git
- The [Claude CLI](https://docs.claude.com/en/docs/claude-code) (`claude`), signed in. Duet talks to Claude only through it, and needs no API key.
- [`gh`](https://cli.github.com/), signed in, to review pull requests and post decision logs

## Install

```sh
git clone https://github.com/johntaormina/duet.git
cd duet
npm install
npm run build
```

Run `npm run build` again after pulling changes.

### VS Code extension

Package the extension and install the result:

```sh
npm run package        # writes packages/vscode/duet-<version>.vsix
```

In VS Code, open Extensions, choose **…** → **Install from VSIX…**, and pick `packages/vscode/duet-<version>.vsix`. With a terminal where `code` is on your PATH you can instead run `code --install-extension duet-<version>.vsix`.

The extension runs Duet's engine with `node` from your PATH. Set `duet.nodePath` if you need another one.

## Use

### In VS Code

Open a git repository, then from the Command Palette:

- **Duet: Start review**: review the current branch against a base, your working tree (to check your own changes before committing), or a pull request. You can add a line on what you believe the change does and why, and point Duet at an agent's plan or transcript.
- **Duet: Open review**: reopen an earlier review.
- **Duet: Post decision log**: post your decisions to a pull request, after you approve the exact text.

The review panel opens as soon as the review starts, and fills in as stages finish. A usable briefing usually arrives within a few minutes; findings follow when the background checks finish. Findings appear in the Duet view in the activity bar and as comments on the code.

### From the command line

```sh
node path/to/duet/packages/engine/bin/duet.mjs run --base main                 # this branch against main
node path/to/duet/packages/engine/bin/duet.mjs run --worktree --base main      # uncommitted work
node path/to/duet/packages/engine/bin/duet.mjs run --pr 12                     # a GitHub pull request
node path/to/duet/packages/engine/bin/duet.mjs run --base main --statement "Retry uploads so imports survive a busy server"
node path/to/duet/packages/engine/bin/duet.mjs clean --older-than 14           # remove old reviews
```

Run it from inside the repository you are reviewing. Results go to `.duet/<run-id>/` in that repository, which Duet keeps out of git. `run.json` shows each stage's status, `briefing.json` and `cards.json` hold the human layer, and `findings.json` the machine layer.

## Configuration

Settings are read in this order, each overriding the last: built-in defaults, `~/.config/duet/config.json` (or `.yaml`), `duet.config.json` (or `.yaml`) in the repository, an overlay's `config.json`, then command-line flags.

| Setting | Default | What it does |
|---|---|---|
| `concurrency` | `3` | Claude calls at once in one review |
| `contextBudget` | `200000` | Characters of context Claude is given |
| `confidenceThreshold` | `80` | Findings below this confidence are not shown |
| `factCheckTimeoutSec` | `90` | Time limit for checking the cards' claims |
| `stakes` | `{}` | Per-category default stakes for this repository, e.g. `{"infra-ci": "low"}` |
| `generatedPaths` | `[]` | Extra glob patterns for generated files to summarize instead of review |
| `stages` | `{}` | Per-prompt overrides, e.g. `{"briefing": {"model": "opus", "timeoutSec": 300}}` |
| `overlay` | `null` | Path to an overlay directory |
| `claudeArgs` | `[]` | Extra arguments added to every `claude` call, for environments that need them |

### Overlays

An overlay customizes Duet for one environment without forking it. It is a directory laid out like Duet's own assets; any file in it replaces the core file at the same path:

```
my-overlay/
  config.json               settings
  prompts/<stage>.md        stage prompts
  guides/card-guide.md      how decision cards are written
  triggers.json             the categories that always produce a card
  adapters/*.js             extra sources, sinks, caller resolvers, tool-output providers
```

Point `overlay` at it in your user or repository configuration. Keep organization-specific rules, rubrics, and access methods in an overlay rather than in this repository.

## How it works

`duet run` resolves the change, snapshots it if it is your working tree, and checks out the head commit into a private worktree so your own checkout is never touched. It builds a context pack in code (the diff with lockfiles, generated files, and renames summarized; the author's reasoning from the description, commit messages, history, and linked docs; the changed files; nearby docs; and callers), then runs two branches at once:

- **Human layer:** intent → briefing → decision cards (a fixed set of trigger categories, plus cards Claude proposes that a separate call must fail to refute, then a bounded fact check) → one recommendation per card, each from a fresh call.
- **Machine layer:** four specialists in parallel → a verifier in a fresh context.

Every stage's output is validated against a schema, retried once if invalid, and cached, so an interrupted review resumes where it stopped.

## Development

```sh
npm test                              # all tests (Vitest)
npm run typecheck
node scripts/coherence-check.mjs      # every spec has a test and code, and no annotation is dangling
```

The design lives in `docs/`: the high-level design in `docs/high-level-design.md`, and one folder per component under `docs/intent/` with its design and its EARS specs. Code and tests cite the specs they implement with `@spec` comments. `AGENTS.md` describes the workflow; `doc.md` is the research the project grew from.

| Package | Role |
|---|---|
| `packages/store` | Run files: schemas, validation, atomic writes, cache keys |
| `packages/adapters` | Sources, sinks, configuration, overlays |
| `packages/engine` | The `duet` command: context pack, stages, prompts |
| `packages/session` | One reviewer's session: blind-first, answers, the decision log |
| `packages/vscode` | The VS Code extension |
