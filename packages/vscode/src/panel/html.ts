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
  return `<li class="choice"><strong>${esc(c.choice)}</strong> over ${esc(c.alternative)}. <em>Trade-off:</em> ${esc(c.tradeoff)}
    <div class="rationale ${c.rationale.source}"><span class="source">${esc(c.rationale.label)}:</span> ${esc(c.rationale.text)}${quote}</div></li>`;
}

export function cardHtml(c: CardView): string {
  const options = c.options
    .map(
      (o) => `<label class="option"><input type="radio" name="opt-${esc(c.id)}" value="${o.index}" ${c.committed?.option === o.index ? "checked" : ""}>
      ${esc(o.summary)}${o.isCurrent ? ' <span class="current">current code</span>' : ""}
      <span class="procon">${o.pros.map((p) => `+ ${esc(p)}`).join(" ")} ${o.cons.map((x) => `− ${esc(x)}`).join(" ")} · reversibility: ${esc(o.reversibility)}</span></label>`,
    )
    .join("");
  let rec = "";
  if (c.recommendation.kind === "hidden") rec = `<div class="rec hidden">${esc(c.recommendation.note)}</div>`;
  else if (c.recommendation.kind === "unavailable") rec = `<div class="rec unavailable">Claude's recommendation is not available yet (recommendations stage: ${esc(c.recommendation.stage)}).</div>`;
  else rec = `<div class="rec shown"><strong>Claude leans toward:</strong> ${esc(c.options[c.recommendation.option]?.summary ?? String(c.recommendation.option))} (confidence ${c.recommendation.confidence})<p>${esc(c.recommendation.reasoning)}</p><p><em>What would change Claude's mind:</em> ${esc(c.recommendation.whatWouldChangeMyMind)}</p></div>`;
  const committed = c.state === "committed" || c.state === "revealed";
  const action = committed
    ? `<button class="change" data-card="${esc(c.id)}">Change my answer</button>${c.state === "committed" ? ` <button class="reveal" data-card="${esc(c.id)}">Show Claude's view</button>` : ""}`
    : `<button class="commit" data-card="${esc(c.id)}" disabled>Commit</button>`;
  return `<section class="card ${c.stakes} ${c.state}" id="card-${esc(c.id)}" data-card="${esc(c.id)}" data-stakes="${c.stakes}">
  <header><span class="stakes">${c.stakes === "high" ? "High stakes" : "Low stakes"}</span> ${c.categories.map((x) => `<span class="cat">${esc(x)}</span>`).join("")}${c.state === "stale" ? ' <span class="stale">The card changed since you answered; please answer again.</span>' : ""}</header>
  <h3>${esc(c.question)}</h3>
  ${c.choice ? `<div class="about-choice">About the choice: ${esc(c.choice.choice)}</div>` : ""}
  <p><strong>Why it matters:</strong> ${esc(c.whyItMatters)}</p>
  <p><strong>What the code does:</strong> ${esc(c.plainTechnical)}</p>
  ${c.metaphor ? `<p class="metaphor"><strong>Like:</strong> ${esc(c.metaphor.text)} <em>Where this breaks down:</em> ${esc(c.metaphor.breaksDownWhen)}</p>` : ""}
  ${c.flags.length ? `<ul class="flags">${c.flags.map((f) => `<li>Unconfirmed: ${esc(f.claim)}: ${esc(f.note)}</li>`).join("")}</ul>` : ""}
  <div class="code">${anchorLinks(c.anchors)} <button class="terminal" data-card="${esc(c.id)}">Open Claude in a terminal</button></div>
  <fieldset ${committed ? "disabled" : ""}>${options}</fieldset>
  ${c.stakes === "high" ? `<textarea class="rationale" data-card="${esc(c.id)}" placeholder="Your reasoning, in your own words" ${committed ? "disabled" : ""}>${esc(c.committed?.rationale ?? "")}</textarea>` : ""}
  <div class="actions">${action} <span class="check" data-card="${esc(c.id)}"></span></div>
  ${rec}
  <div class="qa">${c.qa.map((q) => `<div class="q">Q: ${esc(q.question)}</div><div class="a">${esc(q.answer)}</div>`).join("")}
    <input class="ask" data-card="${esc(c.id)}" placeholder="Ask Claude about this card"><button class="ask-btn" data-card="${esc(c.id)}">Ask</button></div>
</section>`;
}

export function renderPanel(m: PanelModel, nonce: string, cspSource: string): string {
  const strip = m.stages.map((s) => `<span class="stage ${s.status}" title="${esc(s.error ?? s.detail ?? s.status)}">${esc(s.name)} ${s.status === "complete" ? "✓" : s.status === "failed" ? "✗" : s.status === "running" ? "…" : "·"}</span>`).join("");
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
<body><header class="top"><h1>${esc(m.title)}</h1><div class="strip">${strip}</div>${m.effort ? `<div class="effort">Effort ${m.effort.score}/5 (~${m.effort.minutes} min)</div>` : ""}</header>
${m.banner ? `<div class="banner">${esc(m.banner)}</div>` : ""}
<nav><button class="tab active" data-tab="briefing">Briefing</button><button class="tab" data-tab="decisions">Decisions${isPlaceholder(m.deck) ? "" : ` (${m.deck.length})`}</button></nav>
<main><div class="tabpane" id="tab-briefing">${intent}${choices}${settled}${steps}</div><div class="tabpane hidden" id="tab-decisions">${deck}</div></main>
<script nonce="${nonce}">${CLIENT}</script></body></html>`;
}

const STYLE = `body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:0 16px 32px;max-width:900px}
.top{position:sticky;top:0;background:var(--vscode-editor-background);padding:8px 0;border-bottom:1px solid var(--vscode-panel-border)}
.strip .stage{margin-right:10px;font-size:12px}.stage.failed{color:var(--vscode-errorForeground)}.stage.running{color:var(--vscode-charts-yellow)}
.banner,.notice{border-left:3px solid var(--vscode-charts-orange);padding:6px 10px;margin:8px 0;background:var(--vscode-textBlockQuote-background)}
nav{margin:10px 0}.tab{background:none;border:none;color:var(--vscode-foreground);padding:4px 10px;cursor:pointer}.tab.active{border-bottom:2px solid var(--vscode-focusBorder)}
.hidden{display:none}.placeholder{opacity:.8;font-style:italic;padding:8px}.placeholder.failed{color:var(--vscode-errorForeground)}
.card{border:1px solid var(--vscode-panel-border);border-radius:6px;padding:10px 14px;margin:12px 0}.card.high{border-left:4px solid var(--vscode-charts-red)}
.stakes,.cat,.current{font-size:11px;padding:1px 6px;border-radius:8px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);margin-right:4px}
.option{display:block;margin:4px 0}.procon{display:block;font-size:11px;opacity:.75;margin-left:22px}
textarea.rationale{width:100%;min-height:48px;margin-top:6px}.rec{margin-top:8px;padding:8px;border-radius:4px;background:var(--vscode-textBlockQuote-background)}
.rationale.inferred .source,.rationale.none .source{font-style:italic}.rationale.stated .source{font-weight:bold}.stale{color:var(--vscode-charts-orange)}
.qa .q{font-weight:bold;margin-top:6px}.qa input{width:75%;margin-top:6px}.flags{color:var(--vscode-charts-orange)}a.anchor{margin-right:8px}`;

const CLIENT = `const vscode=acquireVsCodeApi();
const send=(m)=>vscode.postMessage(m);
document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>{document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x===t));document.querySelectorAll('.tabpane').forEach(p=>p.classList.toggle('hidden',p.id!=='tab-'+t.dataset.tab));vscode.setState({tab:t.dataset.tab});});
const st=vscode.getState();if(st&&st.tab){const t=document.querySelector('.tab[data-tab="'+st.tab+'"]');t&&t.click();}
function chosen(card){const r=document.querySelector('input[name="opt-'+card+'"]:checked');return r?Number(r.value):undefined;}
function rationale(card){const t=document.querySelector('textarea.rationale[data-card="'+card+'"]');return t?t.value:'';}
function check(card){send({type:'check',cardId:card,option:chosen(card),rationale:rationale(card)});}
document.querySelectorAll('.card').forEach(c=>{const id=c.dataset.card;c.querySelectorAll('input[type=radio]').forEach(r=>r.onchange=()=>check(id));const t=c.querySelector('textarea.rationale');t&&(t.oninput=()=>check(id));});
document.querySelectorAll('button.commit').forEach(b=>b.onclick=()=>send({type:'commit',cardId:b.dataset.card,option:chosen(b.dataset.card),rationale:rationale(b.dataset.card)}));
document.querySelectorAll('button.reveal').forEach(b=>b.onclick=()=>send({type:'reveal',cardId:b.dataset.card}));
document.querySelectorAll('button.change').forEach(b=>b.onclick=()=>{const fs=document.querySelector('#card-'+b.dataset.card+' fieldset');if(fs.disabled){fs.disabled=false;b.textContent='Save changed answer';return;}send({type:'change',cardId:b.dataset.card,option:chosen(b.dataset.card)});});
document.querySelectorAll('button.ask-btn').forEach(b=>b.onclick=()=>{const i=document.querySelector('input.ask[data-card="'+b.dataset.card+'"]');if(i.value.trim()){send({type:'ask',cardId:b.dataset.card,question:i.value});b.disabled=true;b.textContent='Asking…';}});
document.querySelectorAll('button.terminal').forEach(b=>b.onclick=()=>send({type:'terminal',cardId:b.dataset.card}));
document.querySelectorAll('a.anchor').forEach(a=>a.onclick=(e)=>{e.preventDefault();send({type:'openAnchor',anchor:JSON.parse(a.dataset.anchor)});});
window.addEventListener('message',e=>{const m=e.data;if(m.type==='checkResult'){const b=document.querySelector('button.commit[data-card="'+m.cardId+'"]');if(b)b.disabled=!m.ok;const s=document.querySelector('.check[data-card="'+m.cardId+'"]');if(s)s.textContent=m.ok?'':m.reason;}
if(m.type==='error'){const d=document.createElement('div');d.className='notice';d.textContent=m.message;document.body.prepend(d);}});`;
