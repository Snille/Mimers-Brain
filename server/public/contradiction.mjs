// The contradiction measurement on the Settings page: one or two models put to
// the nightly check's own question over a case set with known answers. See
// contradiction-eval.mjs. Only on the full listener, like the Models card.
//
// The first version listed every case, 44 of 56 without an answer, and left the
// reader to look memories up by id and edit the file by hand. Now the page shows
// only the cases that need a person - a wrong answer, or no answer where the
// models disagree or one sees a conflict - with both texts and the buttons to
// answer them.

import { t } from "./i18n.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function api(path, opts) {
  const r = await fetch(path, opts);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}
const post = (path, payload) => api(path, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload || {}),
});

let host = null;
let state = null;
let providers = [];
let onChange = null;
let poll = null;
let open = null;
// The second model, kept while the page is open so a rerun needs no retyping.
let other = { provider: "openrouter", model: "" };

const ofTotal = (n, total) => t("contradiction.ofTotal", { n, total });
const seconds = (ms) => (ms / 1000).toFixed(1);
const verdict = (v) => esc(t(`contradiction.verdict.${v}`));

// A case needs a person when a model got its answer wrong, or when it has no
// answer and the models disagree or one of them sees a conflict. Unanswered
// cases every model calls consistent are left alone.
export function needsLook(c) {
  if (c.expect) return c.verdicts.some((v) => v !== c.expect);
  return new Set(c.verdicts).size > 1 || c.verdicts.includes("conflict");
}

function summary(m) {
  return t("contradiction.summary", {
    caught: m.caught, conflicts: m.conflicts, alarms: m.falseAlarms, consistent: m.consistent,
  });
}

function resultPanel(e) {
  if (!e) return `<p class="sub">${esc(t("contradiction.notMeasured"))}</p>`;
  if (e.status === "running") {
    const p = e.progress || { done: 0, total: 0 };
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    return `<div class="sub">${esc(t("contradiction.running"))}</div>
      <div class="model-bar"><span style="width:${pct}%"></span></div>
      <div class="sub">${esc(t("contradiction.progress", { done: p.done, total: p.total }))}</div>`;
  }
  if (e.status === "failed") return `<div class="sub warn">${esc(t("contradiction.failed", { error: e.error || "" }))}</div>`;
  const r = e.result;
  const current = state.current;
  const rows = r.models.map((m) => {
    const inUse = m.provider === current.provider && m.model === current.model;
    return `<tr>
      <td><code>${esc(m.model)}</code>${inUse ? ` <span class="tag">${esc(t("contradiction.inUse"))}</span>` : ""}
        <div class="sub">${esc(summary(m))}</div></td>
      <td><b>${esc(ofTotal(m.caught, m.conflicts))}</b></td>
      <td><b>${esc(ofTotal(m.falseAlarms, m.consistent))}</b></td>
      <td>${m.errors}</td>
      <td>${esc(seconds(m.ms))} s</td>
      <td>${inUse ? "" : `<button class="ghost small" data-use="${esc(m.provider)}|${esc(m.model)}">${esc(t("contradiction.use"))}</button>`}</td>
    </tr>`;
  }).join("");

  const look = r.cases.filter(needsLook);
  const quiet = r.cases.filter((c) => !c.expect && !needsLook(c)).length;
  const caseRow = (c) => `
    <tr>
      <td><code>${esc(c.id)}</code></td>
      <td>${c.expect ? verdict(c.expect) : `<span class="sub">${esc(t("contradiction.unlabelled"))}</span>`}</td>
      ${c.verdicts.map((v) => `<td>${!c.expect || v === c.expect ? verdict(v) : `<b class="warn">${verdict(v)}</b>`}</td>`).join("")}
      <td><button class="ghost small" data-open="${esc(c.id)}">${esc(t(open === c.id ? "contradiction.hide" : "contradiction.show"))}</button></td>
    </tr>
    ${open === c.id ? `<tr><td colspan="${3 + c.verdicts.length}" id="case-detail"><div class="sub">${esc(t("connect.loading"))}</div></td></tr>` : ""}`;

  return `
    <div class="sub">${esc(t("contradiction.measured", { when: new Date(e.finished_at).toLocaleString() }))}</div>
    ${r.warnings.length ? `<div class="sub warn">${esc(t("contradiction.warnings", { n: r.warnings.length, skipped: r.skipped }))}</div>` : ""}
    <table class="grid">
      <tr><th>${esc(t("models.model"))}</th><th>${esc(t("contradiction.caught"))}</th><th>${esc(t("contradiction.falseAlarms"))}</th>
        <th>${esc(t("contradiction.errors"))}</th><th>${esc(t("contradiction.time"))}</th><th></th></tr>
      ${rows}
    </table>
    <h4>${esc(t("contradiction.casesTitle", { n: look.length }))}</h4>
    ${look.length ? `
      <p class="sub">${esc(t("contradiction.casesHint"))}</p>
      <table class="grid">
        <tr><th>${esc(t("contradiction.case"))}</th><th>${esc(t("contradiction.expected"))}</th>
          ${r.models.map((m) => `<th><code>${esc(m.model)}</code></th>`).join("")}<th></th></tr>
        ${look.map(caseRow).join("")}
      </table>` : `<p class="sub">${esc(t("contradiction.allRight"))}</p>`}
    ${quiet ? `<p class="sub">${esc(t("contradiction.quiet", { n: quiet }))}</p>` : ""}`;
}

function draw() {
  const c = state.cases;
  const running = state.evaluation?.status === "running";
  host.innerHTML = `
    <div class="card models-card">
      <h3>${esc(t("contradiction.title"))}</h3>
      <p class="sub">${esc(t("contradiction.description"))}</p>
      <p class="sub">${esc(t("contradiction.when"))}</p>
      <p class="sub">${esc(c ? t("contradiction.cases", c) : t("contradiction.noCases"))}</p>
      <input type="file" id="cases-file" accept=".json,application/json" hidden />
      <div class="actions model-actions">
        <button class="ghost small" id="cases-upload">${esc(t(c ? "contradiction.replaceCases" : "contradiction.uploadCases"))}</button>
        ${c ? `<button class="ghost small" id="cases-download">${esc(t("contradiction.downloadCases"))}</button>
          <button class="ghost small danger" id="cases-clear">${esc(t("contradiction.clearCases"))}</button>` : ""}
      </div>
      ${c ? `
        <div class="model-editor">
          <div class="sub">${esc(t("contradiction.first", { model: state.current.model }))}</div>
          <label>${esc(t("contradiction.second"))}
            <select id="other-provider">${providers.filter((p) => p.configured).map((p) => `<option value="${esc(p.id)}"${
              p.id === other.provider ? " selected" : ""}>${esc(p.label)}</option>`).join("")}</select></label>
          <label>${esc(t("models.model"))}
            <input id="other-model" value="${esc(other.model)}" placeholder="${esc(t("contradiction.secondPlaceholder"))}" autocomplete="off" /></label>
          <div class="actions model-actions">
            ${running ? "" : `<button class="small" id="cases-measure">${esc(t("contradiction.measure"))}</button>`}
            <span class="sub" id="cases-status"></span>
          </div>
        </div>
        ${resultPanel(state.evaluation)}` : ""}
    </div>`;
  wire();
}

async function drawDetail() {
  const el = host.querySelector("#case-detail");
  if (!el) return;
  try {
    const d = await api(`/api/ai/contradiction/case?id=${encodeURIComponent(open)}`);
    const side = (s, label) => `<div class="case-side"><b>${esc(label)}</b>${s.title ? ` · ${esc(s.title)}` : ""}${
      s.memory ? ` <code class="sub">${esc(s.memory)}</code>` : ` <span class="tag">${esc(t("contradiction.ownText"))}</span>`}
      <div class="case-text">${s.missing ? `<span class="warn">${esc(t("contradiction.missing"))}</span>` : esc(s.text)}</div></div>`;
    const button = (value, label) => `<button class="${d.expect === value ? "small" : "ghost small"}" data-label="${value}">${esc(label)}</button>`;
    el.innerHTML = `
      ${d.note ? `<p class="sub">${esc(d.note)}</p>` : ""}
      <div class="duplicate-grid">${side(d.left, t("contradiction.first1"))}${side(d.right, t("contradiction.second2"))}</div>
      <p class="sub">${esc(t("contradiction.question"))}</p>
      <div class="actions model-actions">
        ${button("conflict", t("contradiction.verdict.conflict"))}
        ${button("consistent", t("contradiction.verdict.consistent"))}
        ${d.expect ? `<button class="ghost small" data-label="">${esc(t("contradiction.unanswer"))}</button>` : ""}
      </div>`;
    for (const b of el.querySelectorAll("[data-label]")) b.onclick = async () => {
      try {
        state = await post("/api/ai/contradiction/label", { id: open, expect: b.dataset.label });
        open = null;
        draw();
      } catch (error) { el.insertAdjacentHTML("beforeend", `<div class="err">${esc(error.message)}</div>`); }
    };
  } catch (error) { el.innerHTML = `<div class="err">${esc(error.message)}</div>`; }
}

function wire() {
  const status = host.querySelector("#cases-status");
  const say = (error) => { if (status) status.textContent = error.message; else alert(error.message); };
  const on = (id, fn) => { const b = host.querySelector(id); if (b) b.onclick = fn; };
  const keep = () => {
    const p = host.querySelector("#other-provider");
    const m = host.querySelector("#other-model");
    if (p && m) other = { provider: p.value, model: m.value.trim() };
  };

  // The set is read in the browser and sent as text; the file never leaves this page.
  const file = host.querySelector("#cases-file");
  on("#cases-upload", () => file.click());
  file.onchange = async () => {
    const chosen = file.files[0];
    if (!chosen) return;
    try { state = await post("/api/ai/contradiction/cases", { text: await chosen.text() }); draw(); } catch (error) { say(error); }
  };
  // Answers given here live in the brain; this saves them back to a file.
  on("#cases-download", async () => {
    try {
      const data = await api("/api/ai/contradiction/cases");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2) + "\n"], { type: "application/json" }));
      a.download = "contradiction-cases.local.json";
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (error) { say(error); }
  });
  on("#cases-clear", async () => {
    if (!confirm(t("contradiction.clearConfirm"))) return;
    try { state = await post("/api/ai/contradiction/cases", { clear: true }); draw(); } catch (error) { say(error); }
  });
  on("#cases-measure", async () => {
    keep();
    const models = [state.current, ...(other.model ? [other] : [])];
    try { await post("/api/ai/contradiction/evaluate", { models }); open = null; await refresh(); } catch (error) { say(error); }
  });
  for (const b of host.querySelectorAll("[data-open]")) b.onclick = () => {
    keep();
    open = open === b.dataset.open ? null : b.dataset.open;
    draw();
  };
  for (const b of host.querySelectorAll("[data-use]")) b.onclick = async () => {
    const [provider, model] = b.dataset.use.split("|");
    if (!confirm(t("contradiction.useConfirm", { model }))) return;
    try {
      await post("/api/ai/role", { role: "contradiction", provider, model });
      await refresh();
      onChange?.();
    } catch (error) { say(error); }
  };
  if (open) drawDetail();

  clearTimeout(poll);
  if (state.evaluation?.status === "running") poll = setTimeout(() => { keep(); refresh(); }, 2000);
}

async function refresh() {
  if (!host?.isConnected) { clearTimeout(poll); return; }
  try {
    const [settings, ai] = await Promise.all([api("/api/ai/contradiction"), api("/api/ai")]);
    state = settings;
    providers = ai.providers;
    draw();
  } catch (error) {
    host.innerHTML = `<div class="card"><div class="err">${esc(error.message)}</div></div>`;
  }
}

// `changed` runs when this card changes the model in use, so the Models card
// can show it.
export async function renderContradiction(el, changed) {
  host = el;
  onChange = changed;
  await refresh();
}
