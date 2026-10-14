# Designing a "Two-Layer" AI PR Reviewer That Restores Human Judgement: Assessment, Prior Art, Design and Build Plan

**Verdict: build it, but only the human-decision layer is new. That layer only works if it makes the reviewer commit to a judgement before seeing the AI's opinion. Without that, it becomes one more polished rubber stamp.** The machine layer (bugs, severity, confidence, walkthroughs, diagrams) is a solved, commodity problem: CodeRabbit, Qodo PR-Agent, Greptile, Copilot and Anthropic's own code-review plugin all do versions of it. You should copy their patterns rather than invent new ones. None of the surveyed tools does what you describe: pull out the 3–7 judgement calls a human must own, explain them plainly, and record what the human decided. Recent research says that gap is real. In a study of 278,790 review conversations, AI reviewers left almost no "understanding" or knowledge-transfer feedback. That is exactly the kind of feedback your human layer is meant to restore.

## TL;DR

- **Worth building, with a clear differentiator.** Existing tools optimise for *finding defects*. Your tool optimises for *human understanding and ownership of decisions*. That is the gap the research shows: 95%+ of AI review comments are code-improvement or defect-detection, while human reviewers ask "why" questions. Rebuild the machine layer cheaply from known patterns: parallel specialist agents, a 0–100 confidence filter at 80, a 1–5 effort score, and Mermaid sequence diagrams.
- **The biggest risk is that your tool becomes the new rubber stamp.** Counter it by design. The human answers each decision card *before* the AI's recommendation is revealed. Each high-stakes card needs a short human-written rationale. Every metaphor states where it breaks. The verifier runs in a fresh context so the model doesn't approve its own reasoning (LLMs measurably prefer their own outputs).
- **Build plan:** a Claude Code skill (`/pr-brief`) that orchestrates subagents and writes two schema-validated JSON files. A VS Code extension renders them as a webview "Decision Deck", a findings tree view, and inline Comments-API threads. Spec it with a lightweight Kiro-style requirements → design → tasks workflow (not full BMAD). Ship in four phases, and measure success with seeded-defect catch rates and decision-override rates, not satisfaction surveys.

## Key Findings

### 1. The problem is real and measurable

- **AI reviewers and human reviewers do different jobs.** Zhong, Noei, Zou and Adams (Queen's University, arXiv 2603.15911, March 2026) analysed 278,790 inline review conversations across 300 GitHub projects.
  - Over 95% of AI-agent comments were Code Improvement or Defect Detection.
  - Human reviewers spent 31% of comments on human-written code (17% on agent-written code) on "Understanding", i.e. asking about design intent and rationale.
  - AI comments averaged 29.6 tokens per line of code, versus 4.1 for humans.
  - 85–87% of AI-initiated reviews ended after the first comment with no follow-up.
  - AI suggestions were adopted 16.6% of the time, versus 56.5% for human suggestions. Over half of the unadopted AI suggestions were incorrect or fixed differently.
  - The authors explicitly recommend "routing structured labels, tool output, and downstream file lists to automated pipelines, and presenting only the core assessment to human reviewers." That is almost exactly your two-layer split.
- **Your team's "AI approves AI" loop now appears in the data.** In the same dataset, 94% of "agent reviews agent-generated code" conversations were *the same agent reviewing its own code*.
- **Self-agreement is a known model bias.** Panickssery et al. ("LLM Evaluators Recognize and Favor Their Own Generations", NeurIPS 2024, arXiv 2404.13076) found that LLMs can recognise their own outputs and score them higher than humans would. Self-preference strength correlates linearly with self-recognition ability. The "back and forth with different people's skills until Claude agrees" loop is effectively Claude grading Claude.
- **Automation bias rises with complexity.** A 385-participant controlled experiment ("The Effect of Complexity and Provenance on Code Review Decisions: Evidence from a Controlled Experiment", ACM, doi 10.1145/3808165) reports that "higher code complexity significantly (p < .05) increases over-compliance", meaning reviewers accept incorrect revisions more often. The authors also say "the effect of complexity does not statistically depend on whether revisions are AI- or human-labeled", and they treat any AI-label differences as preliminary and exploratory. (I only saw the abstract, via a search snippet.)
- **Skill atrophy is real but depends on how AI is used.** Anthropic's randomised trial (Shen & Tamkin, arXiv 2601.20245, 2026) had 52 mostly junior developers learn the Trio library.
  - The AI-assisted group scored 17% lower on comprehension (about 50% vs 67%), with the biggest gap on debugging.
  - Participants who used AI for conceptual questions and explanations kept high scores (65–86%).
  - Design implication: a tool that *explains and asks* preserves skill, while a tool that *decides* erodes it.
- **AI review comment acceptance varies a lot, and that is a warning.**
  - In an industrial deployment of Qodo PR-Agent (Cihan et al., ICSE-SEIP 2025, arXiv 2412.18531), 73.8% of automated comments were marked resolved. Developers complained that each fix triggered a new, often redundant review.
  - Mozilla/Ubisoft's RevMate study (Olewicki et al., IEEE TSE) reported only 8.1% of LLM comments accepted, with a further 14.6% and 20.5% marked valuable as tips. Median overhead was 43 seconds per patch.
  - High "resolved" rates can measure compliance rather than value.

### 2. Nothing surveyed does the "human decision layer"

Every tool surveyed ranks *findings* or *risk*. None of them produces *decisions a human must make*. The closest are:
- CodeRabbit Review's dependency-ordered "cohorts".
- Qodo's "can this PR be split" section.
- Greptile's rule never to auto-approve critical-risk categories.
- CodeTour's guided walkthroughs.

The gap is genuine. The parts underneath it (structured findings, confidence filtering, walkthroughs) are not new.

### 3. Explanations simplify, and simplification can mislead

- Bernstein et al. ("Like a Nesting Doll", ITiCSE 2024, arXiv 2403.09409) had 385 first-year students generate recursion analogies with LLMs. Students reported better understanding and remembered personally relevant analogies more easily. These are self-reports, not test scores.
- A 2026 preprint by Bernstein & Sibia ("Flawed but Memorable", arXiv 2609.06095, to appear at Koli Calling 2026) states the trap directly: "To tell whether the comparison actually holds, a student needs to know both the concept and the everyday thing it is compared to." Students who knew an analogy's source domain well spotted its structural flaws. The study is small (10 students).
- The classic warning is Halasz & Moran, "Analogy considered harmful" (CHI 1982): analogies are structurally partial. Clancy's survey of programming misconceptions shows how the "variable as a box" metaphor implies a variable can hold several values at once.
- Design implication: every metaphor must ship with a "where this analogy breaks" line. Metaphors should never be the only explanation for high-stakes cards.

## Details

### A. Catalog of existing tools and what to borrow

| Tool | What it does that's worth copying | Notes / caveats |
|---|---|---|
| **CodeRabbit** (docs.coderabbit.ai/pr-reviews/walkthroughs) | Walkthrough comment with three parts: (1) a *changed files summary* that groups related files into rows with plain-language descriptions (e.g., 1 source file + 27 localization files = 2 rows); (2) *Mermaid sequence diagrams* for PRs touching API calls, event flows or async workflows; (3) *estimated review effort* 1 (trivial) to 5 (very complex) plus minutes, based on files changed, nature of changes and logic complexity. Also review "profiles" (chill/assertive) and path-specific natural-language instructions in `.coderabbit.yaml`. The newer **CodeRabbit Review** regroups the diff into "cohorts": it groups related blocks semantically, *orders them by dependency*, and summarises each range. Some PRs now show a "Merge Risk" line with a one-sentence reason. | Commercial. The cohort ordering matches Baum et al.'s research (below). Copy the dependency ordering. |
| **Qodo PR-Agent** (open source: github.com/qodo-ai/pr-agent; prompts in `pr_agent/settings/pr_reviewer_prompts.toml`) | `/review` has toggleable sections: effort to review [1–5], security concerns, tests present, "can be split" (detects multiple themes), ticket compliance (Fully / Partially / Not compliant against a linked Jira or GitHub issue), and optional PR score. A self-reflection pass scores its own suggestions 0–10 before publishing. When a diff exceeds the token budget, it drops whole files and *lists the dropped files in a coverage footer*. | **The best open-source code to study.** Copy the TOML prompt structure, the coverage footer (honesty about what wasn't reviewed), and ticket compliance (as intent checking). **Do not copy** its auto-approval options (`auto_approve_for_low_review_effort`, `auto_approve_for_no_suggestions`). They are exactly the rubber stamp you're fighting. |
| **Greptile** (greptile.com/docs) | PR summary with a 0–5 "confidence score" for merge readiness (5 = production ready … 0–1 = critical problems), an issue table of important files with ratings, and sequence diagrams. Docs note that "a 3/5 on a payments feature is more serious than a 3/5 on an internal script." | Auto-approve exists (beta). A competitor's write-up (Macroscope) says it never auto-approves critical-risk categories: auth, secrets, billing, DB migrations, infra/CI, public APIs. **Borrow that list as your "always generates a human decision card" trigger list.** |
| **Graphite Diamond** (renamed "Graphite Agent") | Low-noise co-reviewer, positioned as a *complement to* human review. Graphite's product page (diamond.graphite.dev) claims a "Less than 5% negative comment rate" and shows a sample dashboard reading "3.5% Comments downvoted". | Vendor claim. Detection in third-party benchmarks was low (6–18%). Graphite's blog says the Diamond name was deprecated on 10/08/2025 in favour of "Graphite Agent". Cursor announced it had acquired Graphite on 19 Dec 2025 (Axios Pro). Terms weren't disclosed, but Axios's source said the price was "way over" Graphite's last private valuation of around $290 million. The lesson: precision vs recall is a product choice. |
| **GitHub Copilot code review** (docs.github.com) | By default leaves a "Comment" review, *not* "Approve", so it doesn't count toward required approvals. Uses repo agent skills (`.github/skills`) and MCP servers. "Fix with Copilot" hands a fix off to the coding agent. GitHub's blog post "60 million Copilot code reviews and counting" (March 2026) says: "In 71% of the reviews, Copilot code review surfaces actionable feedback." That is a vendor figure. | **Copy the "never approves" default.** Known flaw from GitHub's docs: re-reviews "may repeat previous comments, even if you resolved or downvoted them". Persist dismissals in your state file. |
| **Anthropic `code-review` plugin** (github.com/anthropics/claude-code/tree/main/plugins/code-review; also anthropics/claude-plugins-official) | Parallel specialist agents: 2× CLAUDE.md compliance (deliberately redundant), bug detection in the diff, git-blame history context, prior-PR comment history, code-comment compliance. Each issue is scored 0–100 for confidence, and anything **below 80 is dropped**. Skips closed, draft, automated or already-reviewed PRs. Links use full SHA plus line ranges. | Sources disagree on agent count: the repo README says 4, the marketplace listing says 5. The threshold lives in `commands/code-review.md` and is editable. **This is your machine-layer template. You can read it and run it under your Max plan.** |
| **Anthropic `pr-review-toolkit`** (claude-plugins-official) | Six specialised review agents (tests, types, error handling, comments, code quality, simplification) with confidence scoring. | Good source of persona prompts. |
| **claude-code-security-review** (github.com/anthropics/claude-code-security-review) and the built-in `/security-review` | Two stages: an audit prompt (`prompts.py`), then a separate *false-positive filter* (`findings_filter.py`) driven by an org-specific instruction file. You can copy `security-review.md` into `.claude/commands/` and customise it. | **Cautionary tale:** issues #88 and #103 report that the filter model was deprecated, the filter failed with a 404, and it *silently* fell back to "Claude filtering disabled". Design rule: the verifier stage must fail loudly. |
| **Ellipsis, Sourcery, Bito, Cursor BugBot, Macroscope** | Same category of PR bot (inline comments, summaries, fixes). | I didn't research these in depth this session. They add little beyond the patterns above. |
| **PR Lens** (prlens.dev) | Architecture-level diagram of where a PR sits in the system, with a drill-down into the new path. Positioned as complementary to CodeRabbit. | Shows "system shape" as a distinct need. Your human layer's "pathway" cards serve the same need. |
| **CodeTour** (github.com/microsoft/codetour; schema.json in the repo) | Guided walkthroughs saved as `.tour` JSON in `.tours/`. Required: `title`, `steps[]`. Each step has `description` (markdown), `file` + `line` (1-based) *or* `directory` *or* `uri`, plus optional `selection` {start, end}, `pattern` (regex anchor that survives line drift), `title`, `commands`, `view`. Tours chain with `nextTour`. Renders using the VS Code comment API. Exposes an API (`startTour`) for other extensions. | **Copy this schema for your "decision tour".** A known quirk: a content-only first step renders as a blank page, so anchor step 1 to a file. |

**Research on the "riskiest parts first" idea.**
- Baum, Schneider & Bacchelli ("On the Optimal Order of Reading Source Code Changes for Review", ICSME 2017; "Associating working memory capacity and code change ordering with code review performance", EMSE 2019) found:
  - Reviewers start at the top of the (alphabetical) file list, so attention is spread unevenly.
  - The best order is "mainly an optimal grouping of the change parts by relatedness".
  - Working memory capacity correlates with review effectiveness, especially on larger changes.
- A follow-up industrial case study (arXiv 1812.09510) argues for *ordering change parts by importance* and *shrinking the change set* to reduce cognitive load.
- Gonçalves, Fregnan, Baum, Schneider & Bacchelli (Empirical Software Engineering 27:99, 2022) ran an experiment with 70 developers. They report that "we did not identify a strong relationship between the guidance provided and code review performance". A guided-checklist effect appeared only on the small review task.

These findings justify (a) ordering decision cards by dependency and risk, and (b) hiding low-value files from the human layer.

**Google's industrial evidence.**
- *Resolving Code Review Comments with ML* (Frömmgen et al., ICSE-SEIP 2024): in production, authors addressed 7.5% of all reviewer comments with an ML-suggested edit, later over 8%. A UX change ("Show ML-edit" button) roughly doubled preview rates from about 20% to about 40%. So presentation matters as much as model quality.
- *AutoCommenter* (Vijayvergiya et al., AIware 2024, arXiv 2405.13565): comment-resolution rate about 40%. A simple suppression mechanism raised user acceptance from about 54% to over 80%. 66% of the best practices it targets can't be caught by static analysis.
- AutoCommenter's A/B test found *no statistically significant change* in review duration or iterations. AI review doesn't automatically make humans faster or better. You must measure.

### B. Assessment: is it a good idea?

**Strengths**
1. It targets the real failure (loss of judgement), not the solved one (finding bugs).
2. It's cheap to build on a Max plan. You orchestrate existing patterns; you don't train anything.
3. The two-layer split is what the research literature recommends (Zhong et al.).
4. It produces a durable artifact: a record of decisions humans actually made, which works like lightweight ADRs per PR.

**Risks, and the mitigation for each**

| Risk | Why it's likely | Mitigation |
|---|---|---|
| The tool becomes the new rubber stamp ("the deck said fine") | Automation bias grows with complexity; polished output looks authoritative | **Blind-first mode:** the human picks an option *before* the AI's lean and confidence appear. A required rationale on high-stakes cards. The tool can never approve the PR; like Copilot, it only comments. |
| Metaphors oversimplify or mislead | Analogies are structurally partial (Halasz & Moran; Bernstein & Sibia 2026) | A mandatory `analogy_breaks_down_when` field. A literal one-sentence technical statement next to every metaphor. No metaphor-only cards for security, data-loss or concurrency decisions. |
| Same-model self-agreement | Self-preference bias; 94% of agent-on-agent reviews are self-review | The verifier gets only the diff plus the findings, never the author's chat or the PR description's justifications. Instruct it to *refute*. Optionally use a different model tier for verification. |
| Noise and verbosity | AI comments run about 7× more verbose (29.6 vs 4.1 tokens per LOC) | Confidence ≥80 filter. Cap the human layer at 7 cards. Each card body ≤120 words. |
| Inventing decisions that don't matter (false importance) | LLMs will always find "something" | Cards must cite a trigger: a critical-risk category, a public interface change, a new dependency, a data-model change, irreversibility, or a contradiction between stated intent and code. Allow "No human decisions needed beyond spot-checks" as a valid output. |
| Social rejection ("another gate") | Teams already over-rely on Claude | Pitch it as *saving* reviewer time: 5 cards instead of 40 files. Run it optionally at first, and measure. |
| The culture problem isn't technical | A tool can't force caring | Pair it with a team norm: "approver owns the decisions on the cards." The tool makes that ownership visible. |

**Bottom line:** it's a good idea, differentiated in its human layer, and low-cost. Its value depends entirely on the forcing functions above. A version without blind-first and rationale capture would add little over the Anthropic plugin you can already install.

### C. Proposed design

#### C1. Architecture

```
┌──────────────── VS Code Extension (TypeScript) ────────────────┐
│ Commands: "PR Brief: Review current PR / branch"               │
│ ├─ Runner: spawns `claude -p "/pr-brief <base>..<head>"`       │
│ │   --output-format stream-json (progress)  OR Agent SDK query()│
│ ├─ FileWatcher on .pr-brief/<id>/{findings,decisions,tour}.json│
│ ├─ Webview "Decision Deck" (cards, blind-first, rationale box)  │
│ ├─ TreeView "Findings" (grouped by severity/category/cohort)   │
│ ├─ CommentController: inline threads at finding/decision anchors│
│ ├─ Tour player (CodeTour-style step-through of decision path)  │
│ └─ Exporter: decision log → PR comment via `gh pr comment`     │
└────────────────────────────────────────────────────────────────┘
             │ invokes                       ▲ reads JSON
┌──────────── Claude Code (Max) ────────────────────────────────┐
│ .claude/skills/pr-brief/SKILL.md  (orchestrator)              │
│   references/: schemas, severity rubric, card-writing guide,  │
│               critical-risk triggers, analogy rules           │
│   scripts/: collect_diff.sh, validate.py (JSON Schema check)  │
│ .claude/agents/: intent-reader, bug-hunter, design-critic,    │
│   security-scout, verifier (refuter), decision-distiller      │
│ Hooks: PostToolUse/Stop → run validate.py; fail loudly        │
└────────────────────────────────────────────────────────────────┘
```

**Integration choices**
- **Skill first, extension second.** The skill must work from the terminal on its own, so the "brain" stays in versioned markdown your team can review.
  - Anthropic's skill guidance: `SKILL.md` with YAML frontmatter (`name`, `description` are what Claude uses to decide when to load it).
  - Keep the body under 500 lines, and push detail into reference files one level deep ("progressive disclosure").
  - Useful frontmatter options include `allowed-tools` (e.g., `Read, Grep, Glob, Bash(git:*)`), `disable-model-invocation: true` (so it only runs when invoked explicitly), and `context: fork`.
- **Calling Claude from the extension.** Option 1 is headless CLI: `claude -p` with `--output-format json` or `stream-json`, and `--json-schema` for typed output. Option 2 is the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`): `query({prompt, options: {outputFormat: {type: "json_schema", schema}, allowedTools, permissionMode}})`, which returns validated data on `result.structured_output`.
  - Use the SDK for the final schema-bound step. Use file output for multi-agent runs.
  - Known quirk (SDK issue #479): the internal `StructuredOutput` call shows up as an ordinary `tool_use`. Filter it out of any progress UI.
  - Check how your work environment authenticates SDK and CLI calls under the Max plan before relying on either path.
- **Subagents** keep each reviewer's context isolated, which matters for avoiding self-agreement. Run bug-hunter, design-critic and security-scout in parallel. Run the verifier afterwards with no access to their reasoning, only their claims.
- **MCP** is optional. Add an internal MCP server later if you want ticket and intent lookup (Jira) or architecture-doc retrieval.
- **VS Code APIs**
  - `vscode.comments.createCommentController(id, label)`, then `controller.createCommentThread(uri, range, comments)`. Set `commentingRangeProvider` if humans should reply inline.
  - Thread and comment actions are declared as commands under `contributes.menus` (`comments/commentThread/title`, `comments/comment/title`, etc.), controlled with `when` clauses.
  - Study `microsoft/vscode-extension-samples/comment-sample` and `microsoft/vscode-pull-request-github` (`reviewCommentController.ts`), which is the most complete real-world user of this API.
  - Use a `WebviewPanel` for the deck and a `TreeDataProvider` for findings.
  - Let the GitHub Pull Requests extension or `gh pr checkout` handle checkout. Compute the diff yourself with `git diff base...head` rather than depending on another extension's internals.

#### C2. The review pipeline (inside the skill)

1. **Collect:** diff, changed-file list, PR title/description, linked ticket text, CLAUDE.md, recent `git log` on the touched files.
2. **Intent:** intent-reader writes a one-paragraph "what this PR claims to do" plus a separate "what the code actually does". Mismatches become findings and often decision cards. (This is like Qodo's ticket compliance, generalised.)
3. **Find (parallel):** bug-hunter, design-critic (coupling, abstraction, duplication, AI-slop patterns such as over-engineering or dead markdown), security-scout, and convention checker (CLAUDE.md compliance).
4. **Verify:** a refuter agent tries to disprove each finding against the actual code. It sets `verification.status` and a confidence of 0–100. Anything below 80 is dropped from the human view but kept in JSON for Claude to use.
5. **Group and order:** cluster hunks into cohorts by relatedness and order them by dependency (Baum; CodeRabbit). Compute effort 1–5 and a coverage footer listing files skipped and why.
6. **Distill:** decision-distiller produces at most 7 decision cards, only where a trigger fires. It also produces an optional Mermaid sequence diagram per pathway card and a decision tour.
7. **Validate:** a hook runs JSON Schema validation. If validation fails, the run fails visibly.

#### C3. Machine-layer schema (`findings.json`)

```json
{
  "schema_version": "1.0",
  "pr": { "id": "1234", "base": "abc123", "head": "def456", "title": "..." },
  "intent": {
    "stated": "Adds retry with backoff to the ingest client",
    "observed": "Adds retries, also changes default timeout from 30s to 5s",
    "mismatches": ["F-007"]
  },
  "effort": { "score": 3, "minutes_estimate": 25, "drivers": ["async control flow", "12 files"] },
  "coverage": { "files_reviewed": 12, "files_skipped": [{ "path": "docs/gen/api.md", "reason": "generated" }] },
  "cohorts": [{ "id": "C1", "title": "Retry policy", "order": 1, "files": ["src/ingest/client.ts"], "depends_on": [] }],
  "findings": [{
    "id": "F-003",
    "category": "bug | security | design | performance | test-gap | convention | intent-mismatch | docs-drift",
    "severity": "critical | high | medium | low | nit",
    "confidence": 86,
    "title": "Retry loop has no upper bound on 429 without Retry-After",
    "location": { "file": "src/ingest/client.ts", "start_line": 88, "end_line": 104, "pattern": "while \\(shouldRetry" },
    "evidence": { "code_excerpt": "...", "reasoning": "...", "repro_or_test": "unit test idea: ..." },
    "suggested_fix": { "kind": "patch | description", "content": "..." },
    "found_by": ["bug-hunter"],
    "verification": { "status": "confirmed | refuted | uncertain", "by": "verifier", "notes": "..." },
    "escalate_to_decision": "D-02",
    "fingerprint": "sha1(file+pattern+category)",
    "state": "open | dismissed | fixed"
  }]
}
```

Design notes:
- `fingerprint` and `state` stop repeat comments on re-review. This is Copilot's documented flaw, and Cihan et al.'s "recursive review" complaint.
- `pattern`, borrowed from CodeTour, keeps anchors stable when line numbers drift.
- `coverage` is borrowed from PR-Agent.
- Separating `confidence` from `severity` follows the Anthropic plugin and Greptile.

#### C4. Human-layer schema (`decisions.json`), the decision card

```json
{
  "decisions": [{
    "id": "D-02",
    "order": 1,
    "trigger": "behavior-change-not-in-intent | public-interface | data-model | new-dependency | irreversible | security-sensitive | architecture-pathway | tradeoff",
    "stakes": "high | medium | low",
    "question": "Should a failed upload retry forever, or give up after a limit?",
    "why_it_matters": "If the server is overloaded, unlimited retries make it worse and can hang the job indefinitely.",
    "plain_technical": "The retry loop has no max-attempts or deadline when the server returns 429 without Retry-After.",
    "metaphor": "Like redialling a busy phone line non-stop: you never get through and you keep the line jammed for everyone.",
    "analogy_breaks_down_when": "Unlike a phone, the server may send an explicit 'call back in N seconds' (Retry-After) that we should obey.",
    "options": [
      { "label": "A", "summary": "Cap at 5 attempts with exponential backoff", "pros": ["bounded"], "cons": ["may drop data in long outages"], "reversibility": "easy" },
      { "label": "B", "summary": "Deadline-based (give up after 2 min)", "pros": ["predictable latency"], "cons": ["more config"], "reversibility": "easy" },
      { "label": "C", "summary": "Keep unbounded but add circuit breaker", "pros": ["no data loss"], "cons": ["complex"], "reversibility": "medium" }
    ],
    "code_pointers": [{ "file": "src/ingest/client.ts", "start_line": 88, "end_line": 104, "role": "the loop" }],
    "pathway": { "mermaid": "sequenceDiagram\n Client->>API: upload\n API-->>Client: 429\n Client->>API: retry..." },
    "ai_recommendation": { "option": "A", "confidence": 70, "reasoning": "...", "what_would_change_my_mind": "If uploads are not idempotent, prefer C." },
    "related_findings": ["F-003", "F-007"],
    "human": { "chosen_option": null, "rationale": null, "agreed_with_ai": null, "time_spent_s": null, "reviewer": null }
  }],
  "no_decision_needed_summary": "Remaining 9 files are mechanical renames verified by tests."
}
```

Card-writing rules for `references/card-guide.md`:
- One question per card, phrased so a smart non-specialist could answer it.
- `why_it_matters` describes a *consequence* (user, data, money, on-call), not a code property.
- The metaphor must come from everyday life, *and* it needs a `breaks_down_when` line.
- 2–4 options at the same level of abstraction, following MADR's "Considered Options" and "Good, because… / Bad, because…" format.
- Always include `what_would_change_my_mind`.
- Use MADR ("Markdown Any Decision Records") as the conceptual model: context and problem as a question, decision drivers, considered options, outcome, consequences. Accepted high-stakes cards can be exported as ADRs.

#### C5. UI concept

- **Header strip:** intent stated vs observed (a red badge on mismatch), effort 3/5 (~25 min), coverage ("12 reviewed, 1 skipped"), and counts of findings by severity.
- **Decision Deck (main webview):** cards in dependency order. Each card shows the question, why it matters, metaphor plus "where it breaks", options as radio buttons, and code pointers you click to jump. **The AI recommendation and confidence stay hidden until the human picks an option and, for high-stakes cards, writes at least one sentence of rationale.** After the reveal, show agree/disagree, and allow changing the choice with a logged reason.
- **Pathway view:** a Mermaid sequence diagram rendered in the webview (bundle mermaid.js locally, since you have no web access), with a "step through" button that drives a CodeTour-style tour across the code pointers.
- **Findings tree:** grouped Cohort → Severity → Finding. Clicking opens the inline comment thread. Actions: Dismiss (with a reason, persisted by fingerprint), "Send to Claude to fix", Copy JSON.
- **Export:** "Post decision log to PR" writes a compact markdown table (decision, chosen option, reviewer rationale, AI-agreed yes/no) via `gh`. This turns the record of human decisions into a visible artifact.

### D. Spec-driven development: which approach fits

| Approach | Flow | Fit for a small internal tool |
|---|---|---|
| **GitHub Spec Kit** (open source, works with Claude Code) | `/speckit.constitution` → `/speckit.specify` (what and why, no tech) → `/speckit.clarify` → `/speckit.plan` (stack, architecture; plus research.md, data-model.md, contracts/) → `/speckit.tasks` → `/speckit.analyze` → `/speckit.implement`. Artifacts live in `.specify/` and `specs/<n>-feature/`. | Good tooling, but heavy. Böckeler (martinfowler.com, Oct 2025) found it generated so much repetitive markdown that review became the bottleneck. Spec Kit has kept releasing since then. |
| **Amazon Kiro** | requirements.md (user stories with EARS-style "WHEN … THE SYSTEM SHALL …" acceptance criteria) → design.md → tasks.md, inside a VS Code-based IDE | The lightest of the three, but Böckeler saw it turn a small bug into 4 user stories with 16 acceptance criteria. **Copy the three-file shape; you don't need the IDE.** |
| **Tessl** | Aimed at "spec-as-source" (code marked `// GENERATED FROM SPEC - DO NOT EDIT`) | One 2026 review reports Tessl has removed the framework and repositioned as a registry. Not suitable. |
| **BMAD Method** | Analyst → PM (PRD) → Architect → Scrum Master shards stories → Dev → QA agents, with a "Quick Flow" for small changes | Built for multi-epic products. Too much ceremony for this, though its "story file carries full context" idea is worth borrowing. |

**Recommendation: a "Kiro-shaped, Spec-Kit-lite" workflow in plain Claude Code.**
1. `docs/spec/principles.md` (the constitution, about 15 lines). Examples:
   - "The tool never approves a PR."
   - "The human layer has at most 7 cards."
   - "Every metaphor ships with its limit."
   - "Verifier failure is a hard error."
   - "Schemas are the contract between skill and extension."
2. `requirements.md`: EARS acceptance criteria per feature, for example "WHEN a card has stakes=high THE SYSTEM SHALL hide ai_recommendation until human.rationale is non-empty."
3. `design.md`: the architecture above plus the two JSON Schemas, which act as the single contract that lets the skill and the extension evolve independently.
4. `tasks.md`: small, ordered tasks, each tied back to a requirement ID.
5. Spec gates are reviewed **by you, by hand**. Dogfood the problem you're solving: no "Claude says the spec looks fine".

Each phase below gets its own short spec. Don't write one giant up-front spec. That's the waterfall failure the critics describe.

### E. Phased MVP plan

| Phase | Scope | Exit criterion |
|---|---|---|
| **0. Golden set (about 2 days)** | Pick 10–15 past team PRs, including some later reverted or bug-fixed. Hand-write the "real" decisions and known defects for each. | You have an evaluation set before you have a tool. |
| **1. Skill only (about 1 week)** | `/pr-brief` → `findings.json` + `decisions.json` + markdown render. Agents: intent, bug-hunter, verifier, distiller. Schema validation hook. Start from the Anthropic code-review plugin's structure and its 80 threshold. | On the golden set, cards cover most of the hand-written decisions, with fewer than 2 "invented" cards per PR. |
| **2. Extension MVP (1–2 weeks)** | Findings tree, Comments-API threads, a read-only Decision Deck webview, and running the skill from a command. | A reviewer can do a whole review in VS Code. |
| **3. Judgement forcing (1 week)** | Blind-first reveal, rationale capture, decision log export to the PR, dismiss persistence by fingerprint, re-review diffing. | Logs show humans choosing before seeing the AI's answer. |
| **4. Depth (ongoing)** | Design-critic and security-scout agents, Mermaid pathways, decision tour, ADR export, critical-path triggers configured per repo (`.pr-brief.yaml`), optional MCP for tickets. | Metrics in section F are improving. |

### F. Measuring whether it improves human judgement

Don't measure satisfaction or "comments resolved". Those reward compliance. Measure judgement directly:

1. **Seeded-defect catch rate.** Periodically inject a known, realistic flaw into a real or replayed PR, the classic seeded-fault experiment. Compare human catch rates with and without the tool, and with blind-first on or off. This is the strongest single signal.
2. **Decision override and disagreement rate.** The share of cards where the human's pre-reveal choice differs from the AI's lean, and how often humans change their choice after the reveal. Near-0% disagreement plus frequent post-reveal flips suggests rubber-stamping. A healthy rate of independent disagreement is a good sign.
3. **Rationale quality.** Spot-grade a sample of human rationales: does it cite a consequence, or say "LGTM"? Track median rationale length and time per card. Very short times on high-stakes cards are a warning.
4. **"Understanding" comment share.** Using the Bacchelli & Bird taxonomy (as Zhong et al. did), classify human PR comments before and after rollout. The goal is for "why" and knowledge-transfer comments to *increase*.
5. **Outcome metrics (lagging).** Reverts and hotfixes within 14 days of merge, defects traced to merged PRs, and how many back-and-forth Claude-only rounds happen before merge.
6. **Comprehension probe.** Following Anthropic's RCT method, occasionally ask the approver 2–3 questions about the PR they just approved (e.g., "what happens on a 429?"). Compare scores for tool-reviewed and non-tool PRs.
7. **Card precision and recall on the golden set**, re-run whenever prompts change, as a regression test for the skill itself.

## Recommendations

1. **Build it, starting with the skill and the golden set.** Don't start with the extension. The skill is where quality lives, and the golden set tells you if it works.
2. **Fork the Anthropic code-review plugin's pattern for the machine layer:** parallel specialists, a 0–100 confidence score, a threshold of 80, full-SHA links. Add PR-Agent's coverage footer and ticket-compliance (intent) check, and CodeRabbit's effort score and dependency-ordered cohorts.
3. **Make blind-first and rationale capture non-negotiable.** They are the product. Everything else is a feature.
4. **Make the tool structurally unable to approve.** Never wire it to auto-approve, even for "low effort" PRs.
5. **Isolate the verifier.** Fresh context, refute-only instructions, no access to the author's justifications, and a loud failure if it can't run.
6. **Treat metaphors as a garnish, not the meal.** Always pair them with the literal technical statement and an "analogy breaks when" line.
7. **Use a lightweight Kiro-shaped spec with a short constitution, reviewed by hand.** Skip BMAD and Tessl.
8. **Pilot with 2–3 willing reviewers for 4 weeks.** Track seeded-defect catch rates and disagreement rates, then decide whether to make it the team default.

## Caveats

- Several figures are vendor claims (Graphite's under-5% negative-comment rate, Copilot's 71% actionable, Qodo's benchmark positioning). Some come from competitors' comparison pages (Greptile's critical-risk list via Macroscope). Treat them as directional.
- For the 385-participant automation-bias experiment (ACM, doi 10.1145/3808165), I saw only the abstract. The Clancy and Halasz & Moran analogy findings came through secondary summaries. Check the primary papers before quoting them internally.
- Sources disagree on whether the Anthropic code-review plugin runs 4 or 5 agents. Read the command file you install.
- Zhong et al. (2026) and Bernstein & Sibia (2026) are recent preprints. Zhong et al. studied public open-source projects, and the authors warn their results may not generalise to proprietary codebases.
- Claude Code, Agent SDK and skill frontmatter options change quickly. Field names such as `context: fork`, `--json-schema` and `outputFormat` were correct in the sources consulted, but check them against the docs bundled with your installed version.
- No tool fixes a culture problem by itself. Treat this as a forcing function alongside a team norm: "the approver owns the decisions on the cards."