import { stageProgress } from "../progress.ts";
import type { CardView, ChoiceView, PanelModel, Placeholder } from "./model.ts";

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const isPlaceholder = (x: unknown): x is Placeholder => !!x && typeof x === "object" && (x as Placeholder).placeholder === true;

function stagePlaceholder(p: Placeholder): string {
  const text = p.status === "failed" ? `The ${p.stage} stage failed: ${p.error ?? "unknown error"}` : p.status === "running" ? `The ${p.stage} stage is running${p.detail ? ` (${p.detail})` : ""}…` : `The ${p.stage} stage has not run yet.`;
  return `<div class="placeholder ${p.status}" data-stage="${esc(p.stage)}">${esc(text)}</div>`;
}

function anchorLinks(anchors: { file: string; start_line?: number; end_line?: number }[]): string {
  return anchors
    .map((a) => `<a href="#" class="anchor" data-anchor='${esc(JSON.stringify(a))}'>${esc(a.file)}${a.start_line ? `:${a.start_line}` : ""}</a>`)
    .join(" ");
}

function choiceHtml(c: ChoiceView): string {
  const quote = c.rationale.quote ? ` <q>${esc(c.rationale.quote)}</q>` : "";
  return `<li class="choice"><div class="choice-head"><strong>${esc(c.choice)}</strong> <span class="over">over</span> ${esc(c.alternative)}.</div>
    <div class="tradeoff"><em>Trade-off:</em> ${esc(c.tradeoff)}</div>
    <div class="rationale ${c.rationale.source}"><span class="source">${esc(c.rationale.label)}:</span> ${esc(c.rationale.text)}${quote}</div></li>`;
}

export function cardHtml(c: CardView): string {
  const options = c.options
    .map(
      (o) => `<label class="option"><input type="radio" name="opt-${esc(c.id)}" value="${o.index}" ${c.committed?.option === o.index ? "checked" : ""}>
      <span class="opt-body"><span class="opt-summary">${esc(o.summary)}${o.isCurrent ? ' <span class="current">current code</span>' : ""}</span>
      <span class="procon">${o.pros.map((p) => `<span class="pro">+ ${esc(p)}</span>`).join(" ")} ${o.cons.map((x) => `<span class="con">− ${esc(x)}</span>`).join(" ")} <span class="rev">reversibility: ${esc(o.reversibility)}</span></span></span></label>`,
    )
    .join("");
  let rec = "";
  if (c.recommendation.kind === "hidden") rec = `<div class="rec pending">${esc(c.recommendation.note)}</div>`;
  else if (c.recommendation.kind === "unavailable") rec = `<div class="rec unavailable">Claude's recommendation is not available yet (recommendations stage: ${esc(c.recommendation.stage)}).</div>`;
  else rec = `<div class="rec shown"><div class="rec-lean"><strong>Claude leans toward:</strong> ${esc(c.options[c.recommendation.option]?.summary ?? String(c.recommendation.option))} <span class="confidence">(confidence ${c.recommendation.confidence})</span></div><p>${esc(c.recommendation.reasoning)}</p><p><em>What would change Claude's mind:</em> ${esc(c.recommendation.whatWouldChangeMyMind)}</p></div>`;
  const committed = c.state === "committed" || c.state === "revealed";
  const action = committed
    ? `<button class="change" data-card="${esc(c.id)}">Change my answer</button>${c.state === "committed" ? ` <button class="reveal" data-card="${esc(c.id)}">Show Claude's view</button>` : ""}`
    : `<button class="commit" data-card="${esc(c.id)}" disabled>Commit</button>`;
  return `<section class="card ${c.stakes} ${c.state}" id="card-${esc(c.id)}" data-card="${esc(c.id)}" data-stakes="${c.stakes}">
  <header><span class="stakes">${c.stakes === "high" ? "High stakes" : "Low stakes"}</span> ${c.categories.map((x) => `<span class="cat">${esc(x)}</span>`).join("")}${c.state === "stale" ? ' <span class="stale">The card changed since you answered; please answer again.</span>' : ""}</header>
  <h3>${esc(c.question)}</h3>
  ${c.choice ? `<div class="about-choice">About the choice: ${esc(c.choice.choice)}</div>` : ""}
  <p class="field"><strong>Why it matters:</strong> ${esc(c.whyItMatters)}</p>
  <p class="field"><strong>What the code does:</strong> ${esc(c.plainTechnical)}</p>
  ${c.metaphor ? `<p class="metaphor"><strong>Like:</strong> ${esc(c.metaphor.text)} <em>Where this breaks down:</em> ${esc(c.metaphor.breaksDownWhen)}</p>` : ""}
  ${c.flags.length ? `<ul class="flags">${c.flags.map((f) => `<li>Unconfirmed: ${esc(f.claim)}: ${esc(f.note)}</li>`).join("")}</ul>` : ""}
  <div class="code">${anchorLinks(c.anchors)} <button class="terminal" data-card="${esc(c.id)}">Open Claude in a terminal</button></div>
  <fieldset ${committed ? "disabled" : ""}><legend>Your answer</legend>${options}</fieldset>
  ${c.stakes === "high" ? `<textarea class="rationale" data-card="${esc(c.id)}" aria-label="Your reasoning" placeholder="Your reasoning, in your own words" ${committed ? "disabled" : ""}>${esc(c.committed?.rationale ?? "")}</textarea>` : ""}
  <div class="actions">${action} <span class="check" data-card="${esc(c.id)}" role="status"></span></div>
  ${rec}
  <div class="qa">${c.qa.map((q) => `<div class="q">Q: ${esc(q.question)}</div><div class="a">${esc(q.answer)}</div>`).join("")}
    <div class="ask-row"><input class="ask" data-card="${esc(c.id)}" aria-label="Ask Claude about this card" placeholder="Ask Claude about this card"><button class="ask-btn" data-card="${esc(c.id)}">Ask</button></div></div>
</section>`;
}

export function renderPanel(m: PanelModel, nonce: string, cspSource: string): string {
  const strip = m.stages.map((s) => `<span class="stage ${s.status}" title="${esc(s.error ?? s.detail ?? s.status)}">${esc(s.name)} ${s.status === "complete" ? "✓" : s.status === "failed" ? "✗" : s.status === "running" ? "…" : "·"}</span>`).join("");
  // @spec EXT-VIEW-013
  // @spec EXT-POST-004
  const postButton = `<button class="post" data-action="post">Post review comment (${m.answered.done} of ${m.answered.total} decided)</button>`;
  // @spec EXT-POST-007
  const preview = `<section class="comment-preview" aria-label="Review comment preview"><h2>Review comment preview</h2><p class="preview-note">What Post review comment would post right now. You can still edit it before posting.</p><div id="comment-preview"></div></section>`;
  const progress = `<div class="progress"><div class="progress-bar" style="width:${stageProgress(m.stages).percent}%"></div></div><button class="log-link" data-action="show-log">Show log</button>`;
  const intent = isPlaceholder(m.intent)
    ? stagePlaceholder(m.intent)
    : `<div class="intent"><p><strong>Claims to:</strong> ${esc(m.intent.stated || "(no stated intent)")}</p><p><strong>Actually does:</strong> ${esc(m.intent.observed)}</p>${m.intent.mismatches.length ? `<ul class="mismatch">${m.intent.mismatches.map((x) => `<li>${esc(x.kind)}: ${esc(x.statement)}</li>`).join("")}</ul>` : ""}</div>`;
  const choices = isPlaceholder(m.choices) ? stagePlaceholder(m.choices) : `<h2>Choices this change made</h2><ul class="choices">${m.choices.map(choiceHtml).join("")}</ul>`;
  const settled = m.settled.length ? `<h3>Already settled</h3><ul class="settled">${m.settled.map((s) => `<li>${esc(s.decision)}: settled by ${esc(s.fixedBy)}</li>`).join("")}</ul>` : "";
  const steps = isPlaceholder(m.steps)
    ? stagePlaceholder(m.steps)
    : m.steps.map((s, i) => `<section class="step" id="step-${esc(s.id)}"><h2>${i + 1}. ${esc(s.title)}</h2><p>${esc(s.explanation)}</p><div class="code">${anchorLinks(s.anchors)}</div>${s.cards.map(cardHtml).join("")}</section>`).join("");
  const deck = isPlaceholder(m.deck)
    ? stagePlaceholder(m.deck)
    : `${m.deckNotices.map((n) => `<div class="notice">${esc(n)}</div>`).join("")}${m.deck.length ? m.deck.map(cardHtml).join("") : `<p class="none">${esc(m.noDecisionsSummary ?? "No decisions need you on this change.")}</p>`}`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(m.title)}</title><style>${STYLE}</style></head>
<body><header class="top"><div class="title-row"><h1>${esc(m.title)}</h1>${postButton}</div><div class="strip">${strip}${progress}</div>${m.effort ? `<div class="effort">Effort ${m.effort.score}/5 (~${m.effort.minutes} min)</div>` : ""}</header>
${m.banner ? `<div class="banner">${esc(m.banner)}</div>` : ""}
<nav><button class="tab active" data-tab="briefing">Briefing</button><button class="tab" data-tab="decisions">Decisions${isPlaceholder(m.deck) ? "" : ` (${m.deck.length})`}</button></nav>
<main><div class="tabpane" id="tab-briefing">${intent}${choices}${settled}${steps}</div><div class="tabpane hidden" id="tab-decisions">${deck}${preview}</div></main>
<script nonce="${nonce}">${CLIENT}</script></body></html>`;
}

// Colours come only from VS Code theme tokens. Neutral borders and surfaces are mixed from the
// theme's own foreground and background, because many themes leave panel.border / widget.border
// unset or equal to the background; a mix of the two always shows in the theme's own hue.
// High-contrast themes drop the tints and use contrastBorder, as VS Code's own UI does.
const STYLE = `
:root{
  --d-fg:var(--vscode-foreground);
  --d-bg:var(--vscode-editor-background);
  --d-muted:var(--vscode-descriptionForeground);
  --d-link:var(--vscode-textLink-foreground);
  --d-link-active:var(--vscode-textLink-activeForeground,var(--vscode-textLink-foreground));
  --d-focus:var(--vscode-focusBorder);
  --d-border:color-mix(in srgb,var(--d-fg) 16%,var(--d-bg));
  --d-border-strong:color-mix(in srgb,var(--d-fg) 32%,var(--d-bg));
  --d-surface:color-mix(in srgb,var(--d-fg) 4%,var(--d-bg));
  --d-surface-2:color-mix(in srgb,var(--d-fg) 8%,var(--d-bg));
  --d-ok:var(--vscode-testing-iconPassed,var(--vscode-charts-green));
  --d-err:var(--vscode-editorError-foreground,var(--vscode-errorForeground));
  --d-warn:var(--vscode-editorWarning-foreground,var(--vscode-charts-yellow));
  --d-info:var(--vscode-editorInfo-foreground,var(--vscode-charts-blue));
  --d-mono:var(--vscode-editor-font-family,ui-monospace,monospace);
  --d-size:var(--vscode-font-size,13px);
  --d-small:calc(var(--d-size) * .9);
  --d-radius:6px;
  --d-prose:76ch;
  --d-tint:12%;
}
body.vscode-high-contrast,body.vscode-high-contrast-light{
  --d-border:var(--vscode-contrastBorder);
  --d-border-strong:var(--vscode-contrastBorder);
  --d-surface:transparent;
  --d-surface-2:transparent;
  --d-tint:0%;
}
*,*::before,*::after{box-sizing:border-box}
body{font-family:var(--vscode-font-family);font-size:var(--d-size);font-weight:var(--vscode-font-weight,normal);line-height:1.55;color:var(--d-fg);background:var(--d-bg);margin:0;padding:0 20px 48px;max-width:880px}
p,li{max-width:var(--d-prose)}
p{margin:.5em 0}
ul{padding-left:1.4em;margin:.5em 0}
li{margin:.3em 0}
strong{font-weight:600}
h1,h2,h3{line-height:1.3;font-weight:600;color:var(--vscode-editor-foreground,var(--d-fg))}
h1{font-size:1.45em;margin:0 0 6px}
h2{font-size:1.2em;margin:1.8em 0 .6em;padding-bottom:.3em;border-bottom:1px solid var(--d-border)}
h3{font-size:1.05em;margin:.6em 0 .5em}
q{font-style:italic}
a{color:var(--d-link);text-decoration:none}
a:hover{color:var(--d-link-active);text-decoration:underline}
:focus-visible{outline:1px solid var(--d-focus);outline-offset:2px}
body.vscode-high-contrast :focus-visible,body.vscode-high-contrast-light :focus-visible{outline-color:var(--vscode-contrastActiveBorder,var(--d-focus))}
.hidden{display:none}

/* Header: title, stage strip, effort */
.top{position:sticky;top:0;z-index:2;background:var(--d-bg);padding:14px 0 10px;border-bottom:1px solid var(--d-border)}
.strip{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:4px}
.stage{display:inline-flex;align-items:center;gap:4px;font-size:var(--d-small);line-height:1.6;padding:0 8px;border-radius:999px;border:1px solid var(--d-border);color:var(--d-muted);background:var(--d-surface);white-space:nowrap}
.stage.complete{color:var(--d-fg);border-color:color-mix(in srgb,var(--d-ok) 55%,var(--d-bg))}
.stage.running{color:var(--d-fg);border-color:var(--d-info);background:color-mix(in srgb,var(--d-info) var(--d-tint),var(--d-bg))}
.stage.failed{color:var(--d-err);border-color:var(--d-err);background:color-mix(in srgb,var(--d-err) var(--d-tint),var(--d-bg));font-weight:600}
.progress{position:relative;width:100%;height:2px;margin-top:8px;overflow:hidden;border-radius:1px;background:var(--d-border)}
.progress-bar{height:100%;background:var(--vscode-progressBar-background,var(--d-focus));transition:width .3s ease}
.title-row{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}.title-row h1{margin-bottom:6px}
button.post{flex:none;color:var(--vscode-button-foreground);background:var(--vscode-button-background)}
button.post:hover:not(:disabled){background:var(--vscode-button-hoverBackground)}
.comment-preview{margin:32px 0 24px;padding-top:16px;border-top:1px solid var(--d-border)}
.comment-preview .preview-note{margin:0 0 12px;font-size:var(--d-small);color:var(--d-muted)}
#comment-preview{max-width:880px;padding:12px 16px;border:1px solid var(--d-border);border-radius:6px;background:var(--d-bg)}
#comment-preview:empty::before{content:"Rendering…";color:var(--d-muted)}
#comment-preview details{margin:6px 0;padding:2px 0}
#comment-preview details details{margin-left:16px}
#comment-preview summary{cursor:pointer}
#comment-preview table{border-collapse:collapse;margin:8px 0}
#comment-preview th,#comment-preview td{border:1px solid var(--d-border);padding:3px 10px}
#comment-preview blockquote{margin:8px 0;padding:4px 12px;border-left:3px solid var(--vscode-editorWarning-foreground,var(--d-border))}
#comment-preview hr{border:none;border-top:1px solid var(--d-border);margin:16px 0}
.log-link{font:inherit;font-size:var(--d-small);background:none;border:none;padding:0 2px;color:var(--d-link);cursor:pointer}
.log-link:hover{color:var(--d-link-active);text-decoration:underline}
.effort{margin-top:6px;font-size:var(--d-small);color:var(--d-muted)}

/* Banners and notices */
.banner,.notice{max-width:var(--d-prose);margin:12px 0;padding:8px 12px;border:1px solid var(--d-border);border-left:3px solid var(--d-warn);border-radius:var(--d-radius);background:color-mix(in srgb,var(--d-warn) var(--d-tint),var(--d-bg))}

/* Tabs */
nav{display:flex;gap:4px;margin:14px 0 4px;border-bottom:1px solid var(--d-border)}
.tab{font:inherit;background:none;border:none;border-bottom:2px solid transparent;margin-bottom:-1px;color:var(--vscode-panelTitle-inactiveForeground,var(--d-muted));padding:6px 12px;cursor:pointer}
.tab:hover{color:var(--d-fg)}
.tab.active{color:var(--vscode-panelTitle-activeForeground,var(--d-fg));border-bottom-color:var(--vscode-panelTitle-activeBorder,var(--d-focus));font-weight:600}

/* Stage placeholders */
.placeholder{max-width:var(--d-prose);margin:12px 0;padding:10px 12px;border:1px dashed var(--d-border-strong);border-radius:var(--d-radius);color:var(--d-muted);font-style:italic}
.placeholder.running{border-style:solid;border-color:var(--d-info);font-style:normal}
.placeholder.failed{border-style:solid;border-color:var(--d-err);color:var(--d-err);font-style:normal}

/* Briefing */
.intent{margin:16px 0;padding:12px 14px;border:1px solid var(--d-border);border-radius:var(--d-radius);background:var(--d-surface)}
.intent p{margin:.3em 0}
.mismatch{margin-top:8px;color:var(--d-warn)}
.mismatch li{color:var(--d-fg)}
.choices{list-style:none;padding:0}
.choice{margin:10px 0;padding:10px 14px;border:1px solid var(--d-border);border-radius:var(--d-radius);background:var(--d-surface)}
.choice-head .over{color:var(--d-muted)}
.tradeoff{margin-top:2px}
.tradeoff em,.metaphor em,.rec em{font-style:normal;font-weight:600;color:var(--d-muted)}
.choice .rationale{margin-top:8px;padding:2px 0 2px 10px;border-left:3px solid var(--d-border-strong)}
.choice .rationale .source{font-weight:600}
.choice .rationale.stated{border-left-style:solid;border-left-color:var(--d-ok)}
.choice .rationale.inferred{border-left-style:dashed;border-left-color:var(--d-info)}
.choice .rationale.inferred .source{font-style:italic}
.choice .rationale.none{border-left-style:dotted;color:var(--d-muted)}
.choice .rationale.none .source{font-style:italic;color:var(--d-warn)}
.settled{color:var(--d-muted)}
.step{margin-top:8px}
.step > p{margin:.4em 0 .8em}
.none{color:var(--d-muted);font-style:italic}

/* Code anchors */
.code{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin:10px 0}
a.anchor{font-family:var(--d-mono);font-size:var(--d-small);padding:1px 6px;border-radius:4px;background:var(--vscode-textCodeBlock-background,var(--d-surface-2));border:1px solid var(--d-border)}
a.anchor:hover{text-decoration:none;border-color:var(--d-link)}

/* Cards */
.card{margin:16px 0;padding:14px 16px;border:1px solid var(--d-border);border-left:3px solid var(--d-border-strong);border-radius:var(--d-radius);background:var(--d-surface)}
.card.high{border-left-color:var(--d-err)}
.card.stale{border-color:var(--d-warn)}
.card > header{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.card h3{font-size:1.1em;margin:.5em 0 .4em}
.stakes,.cat,.current{display:inline-block;font-size:var(--d-small);line-height:1.5;padding:0 8px;border-radius:999px;white-space:nowrap}
.stakes{font-weight:600;border:1px solid var(--d-border-strong)}
.card.high .stakes{color:var(--d-fg);border-color:var(--d-err);background:color-mix(in srgb,var(--d-err) var(--d-tint),var(--d-bg))}
.cat{color:var(--d-muted);border:1px solid var(--d-border)}
.current{color:var(--vscode-badge-foreground);background:var(--vscode-badge-background);border:1px solid var(--vscode-contrastBorder,transparent);margin-left:4px}
.stale{color:var(--d-warn);font-size:var(--d-small);font-weight:600}
.about-choice{font-size:var(--d-small);color:var(--d-muted);margin-bottom:6px}
.field strong,.metaphor strong{color:var(--d-muted);font-weight:600}
.metaphor{padding-left:10px;border-left:2px solid var(--d-border)}
.flags{list-style:none;padding:8px 12px;border-radius:4px;border:1px solid var(--d-warn);background:color-mix(in srgb,var(--d-warn) var(--d-tint),var(--d-bg))}
.flags li{margin:.15em 0}

/* Options */
fieldset{border:none;margin:12px 0 0;padding:0;min-width:0}
legend{padding:0;margin-bottom:6px;font-size:var(--d-small);font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--d-muted)}
.option{display:flex;gap:10px;align-items:flex-start;margin:6px 0;padding:8px 12px;border:1px solid var(--d-border);border-radius:var(--d-radius);cursor:pointer}
.option:hover{background:var(--vscode-list-hoverBackground,var(--d-surface-2))}
.option:has(input:checked){border-color:var(--d-focus);background:color-mix(in srgb,var(--d-focus) var(--d-tint),transparent)}
body.vscode-high-contrast .option:has(input:checked),body.vscode-high-contrast-light .option:has(input:checked){outline:1px solid var(--vscode-contrastActiveBorder,var(--d-focus))}
fieldset:disabled .option{cursor:default;opacity:.85}
fieldset:disabled .option:hover{background:transparent}
.option input{margin:.3em 0 0;flex:none;accent-color:var(--vscode-checkbox-selectBackground,var(--d-focus))}
.opt-body{display:flex;flex-direction:column;gap:2px;min-width:0}
.procon{display:flex;flex-wrap:wrap;gap:2px 12px;font-size:var(--d-small);color:var(--d-muted)}
.pro{color:var(--d-fg)}
.rev{font-style:italic}

/* Inputs and buttons */
textarea,input:not([type=radio]){font:inherit;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--d-border-strong));border-radius:2px;padding:5px 8px}
textarea::placeholder,input::placeholder{color:var(--vscode-input-placeholderForeground)}
textarea:focus,input:focus{outline:1px solid var(--d-focus);outline-offset:-1px;border-color:var(--d-focus)}
textarea:disabled,input:disabled{opacity:.7}
textarea.rationale{display:block;width:100%;max-width:var(--d-prose);min-height:64px;margin-top:10px;resize:vertical;line-height:1.5}
button{font:inherit;line-height:1.4;padding:4px 12px;border-radius:2px;border:1px solid var(--vscode-button-border,transparent);cursor:pointer;color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}
button:hover:not(:disabled){background:var(--vscode-button-secondaryHoverBackground)}
button:disabled{opacity:.5;cursor:not-allowed}
button.commit{color:var(--vscode-button-foreground);background:var(--vscode-button-background)}
button.commit:hover:not(:disabled){background:var(--vscode-button-hoverBackground)}
button.terminal{font-size:var(--d-small);padding:1px 8px;margin-left:auto}
.actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:12px}
.check{font-size:var(--d-small);color:var(--d-muted)}
.check:not(:empty)::before{content:"ⓘ ";color:var(--d-info)}

/* Recommendation */
.rec{max-width:var(--d-prose);margin-top:14px;padding:10px 12px;border-radius:var(--d-radius);border:1px solid var(--d-border);background:var(--vscode-textBlockQuote-background,var(--d-surface-2))}
.rec.pending,.rec.unavailable{color:var(--d-muted);font-style:italic;border-style:dashed;background:transparent}
.rec.shown{border-left:3px solid var(--d-link)}
.rec p{margin:.4em 0 0}
.confidence{color:var(--d-muted)}

/* Questions */
.qa{margin-top:14px;padding-top:10px;border-top:1px solid var(--d-border)}
.qa .q{font-weight:600;margin-top:8px}
.qa .a{max-width:var(--d-prose);margin:2px 0 8px;padding-left:10px;border-left:2px solid var(--d-border)}
.ask-row{display:flex;gap:6px;max-width:var(--d-prose);margin-top:6px}
.ask-row input{flex:1;min-width:0}
`;

// @spec EXT-VIEW-016, EXT-VIEW-013, EXT-POST-004, EXT-POST-007
export const CLIENT = `const vscode=acquireVsCodeApi();
const send=(m)=>vscode.postMessage(m);
const view=Object.assign({tab:'briefing'},vscode.getState()||{});view.scroll=view.scroll||{};view.drafts=view.drafts||{};
const save=()=>vscode.setState(view);
const scroller=()=>document.scrollingElement||document.documentElement;
function draft(key,value){if(value===undefined||value==='')delete view.drafts[key];else view.drafts[key]=value;save();}
function showTab(name){const t=document.querySelector('.tab[data-tab="'+name+'"]');if(!t)return false;document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x===t));document.querySelectorAll('.tabpane').forEach(p=>p.classList.toggle('hidden',p.id!=='tab-'+name));view.tab=name;return true;}
document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>{view.scroll[view.tab]=scroller().scrollTop;showTab(t.dataset.tab);scroller().scrollTop=view.scroll[view.tab]||0;save();});
window.addEventListener('scroll',()=>{view.scroll[view.tab]=scroller().scrollTop;save();});
function chosen(card){const r=document.querySelector('input[name="opt-'+card+'"]:checked');return r?Number(r.value):undefined;}
function rationale(card){const t=document.querySelector('textarea.rationale[data-card="'+card+'"]');return t?t.value:'';}
function check(card){send({type:'check',cardId:card,option:chosen(card),rationale:rationale(card)});}
function mirror(sel,src){document.querySelectorAll(sel).forEach(x=>{if(x!==src)x.value=src.value;});}
document.querySelectorAll('.card').forEach(c=>{const id=c.dataset.card;
c.querySelectorAll('input[type=radio]').forEach(r=>r.onchange=()=>{draft('o:'+id,r.value);check(id);});
const t=c.querySelector('textarea.rationale');t&&(t.oninput=()=>{mirror('textarea.rationale[data-card="'+id+'"]',t);draft('r:'+id,t.value);check(id);});
const q=c.querySelector('input.ask');q&&(q.oninput=()=>{mirror('input.ask[data-card="'+id+'"]',q);draft('q:'+id,q.value);});});
document.querySelectorAll('button.commit').forEach(b=>b.onclick=()=>{const id=b.dataset.card;send({type:'commit',cardId:id,option:chosen(id),rationale:rationale(id)});draft('o:'+id);draft('r:'+id);});
document.querySelectorAll('button.reveal').forEach(b=>b.onclick=()=>send({type:'reveal',cardId:b.dataset.card}));
document.querySelectorAll('button.change').forEach(b=>b.onclick=()=>{const fs=document.querySelector('#card-'+b.dataset.card+' fieldset');if(fs.disabled){fs.disabled=false;b.textContent='Save changed answer';return;}send({type:'change',cardId:b.dataset.card,option:chosen(b.dataset.card)});});
document.querySelectorAll('button.ask-btn').forEach(b=>b.onclick=()=>{const i=document.querySelector('input.ask[data-card="'+b.dataset.card+'"]');if(i.value.trim()){send({type:'ask',cardId:b.dataset.card,question:i.value});draft('q:'+b.dataset.card);b.disabled=true;b.textContent='Asking…';}});
document.querySelectorAll('button.terminal').forEach(b=>b.onclick=()=>send({type:'terminal',cardId:b.dataset.card}));
document.querySelectorAll('a.anchor').forEach(a=>a.onclick=(e)=>{e.preventDefault();send({type:'openAnchor',anchor:JSON.parse(a.dataset.anchor)});});
document.querySelectorAll('[data-action="show-log"]').forEach(b=>b.onclick=()=>send({type:'showLog'}));
document.querySelectorAll('[data-action="post"]').forEach(b=>b.onclick=()=>send({type:'post'}));
document.querySelectorAll('.card').forEach(c=>{const id=c.dataset.card;let restored=false;
const fs=c.querySelector('fieldset');const o=view.drafts['o:'+id];
if(o!==undefined&&fs&&!fs.disabled){const r=c.querySelector('input[type=radio][value="'+o+'"]');if(r){r.checked=true;restored=true;}}
const t=c.querySelector('textarea.rationale');const rv=view.drafts['r:'+id];
if(rv!==undefined&&t&&!t.disabled&&!t.value){t.value=rv;restored=true;}
const q=c.querySelector('input.ask');const qv=view.drafts['q:'+id];if(qv!==undefined&&q&&!q.value)q.value=qv;
if(restored)check(id);});
showTab(view.tab)||showTab('briefing');scroller().scrollTop=view.scroll[view.tab]||0;save();
window.addEventListener('message',e=>{const m=e.data;if(m.type==='checkResult'){const b=document.querySelector('button.commit[data-card="'+m.cardId+'"]');if(b)b.disabled=!m.ok;const s=document.querySelector('.check[data-card="'+m.cardId+'"]');if(s)s.textContent=m.ok?'':m.reason;}
if(m.type==='preview'){const el=document.getElementById('comment-preview');if(el)el.innerHTML=m.html;}
if(m.type==='error'){const d=document.createElement('div');d.className='notice';d.textContent=m.message;document.body.prepend(d);}});
send({type:'ready'});`;
