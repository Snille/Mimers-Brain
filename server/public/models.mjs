// The Models card on the Connect page: which provider and model each job uses.
//
// Only on the full listener - the server refuses /api/ai elsewhere, because
// these choices decide where vault text is sent. Keys never pass through here;
// a provider without a key in .env is listed but cannot be chosen.

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

const ROLES = ["embedding", "metadata", "contradiction"];
let host = null;
let state = null;
let editing = null;
let poll = null;
const modelCache = new Map();

// Embedding models have no output tokens, so "$0 out" would only be noise.
const price = (m) => (!m || m.price_in == null ? ""
  : m.price_out ? t("models.price", { input: m.price_in.toFixed(3), output: m.price_out.toFixed(3) })
    : t("models.priceIn", { input: m.price_in.toFixed(3) }));

async function modelsFor(provider, kind) {
  const key = `${provider}|${kind}`;
  if (!modelCache.has(key)) {
    modelCache.set(key, api(`/api/ai/models?provider=${encodeURIComponent(provider)}&kind=${kind}`)
      .catch(() => []));
  }
  return modelCache.get(key);
}

function providerLabel(id) {
  return state.providers.find((p) => p.id === id)?.label || id;
}

function roleRow(name) {
  const r = state.roles[name];
  const busy = name === "embedding" && state.migration;
  return `
    <tr>
      <td><b>${esc(t(`models.role.${name}`))}</b><div class="sub">${esc(t(`models.roleHint.${name}`))}</div></td>
      <td><code>${esc(providerLabel(r.provider))}</code> · <code>${esc(r.model)}</code>
        ${name === "embedding" && r.dimensions ? `<span class="sub"> · ${esc(t("models.dimensions", { n: r.dimensions }))}</span>` : ""}
        <span class="tag">${esc(t(`models.source.${r.source}`))}</span></td>
      <td>${busy ? "" : `<button class="ghost small" data-edit="${name}">${esc(t("models.change"))}</button>`}</td>
    </tr>
    ${editing === name ? `<tr><td colspan="3" id="model-editor"></td></tr>` : ""}`;
}

function migrationPanel() {
  const m = state.migration;
  if (!m) return "";
  const p = m.progress || { done: 0, total: 0 };
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  const failed = (m.failed || []).length;
  return `
    <div class="model-migration">
      <h4>${esc(t("models.migration.title", { model: m.model }))}</h4>
      <div class="sub">${esc(t(`models.migration.status.${m.status}`))}${m.error ? ` — ${esc(m.error)}` : ""}</div>
      <div class="model-bar"><span style="width:${pct}%"></span></div>
      <div class="sub">${esc(t("models.migration.progress", { done: p.done, total: p.total }))}${
        failed ? ` · ${esc(t("models.migration.failed", { n: failed }))}` : ""}</div>
      ${m.status === "ready" ? `
        <p class="sub">${esc(t("models.migration.compareHint"))}</p>
        <div class="model-compare-form">
          <input id="compare-query" placeholder="${esc(t("models.migration.comparePlaceholder"))}" />
          <button class="ghost small" id="compare-run">${esc(t("models.migration.compare"))}</button>
        </div>
        <div id="compare-result" class="model-compare"></div>` : ""}
      <div class="actions model-actions">
        ${m.status === "ready" ? `<button id="reembed-switch">${esc(t("models.migration.switch"))}</button>` : ""}
        ${m.status === "failed" ? `<button class="ghost" id="reembed-resume">${esc(t("models.migration.resume"))}</button>` : ""}
        <button class="ghost danger" id="reembed-cancel">${esc(t("models.migration.cancel"))}</button>
      </div>
    </div>`;
}

function draw() {
  host.innerHTML = `
    <div class="card models-card">
      <h3>${esc(t("models.title"))}</h3>
      <p class="sub">${esc(t("models.description"))}</p>
      <table class="grid">
        <tr><th>${esc(t("models.job"))}</th><th>${esc(t("models.inUse"))}</th><th></th></tr>
        ${ROLES.map(roleRow).join("")}
      </table>
      ${migrationPanel()}
      <p class="sub">${esc(t("models.thresholds"))}</p>
    </div>`;

  for (const b of host.querySelectorAll("[data-edit]"))
    b.onclick = () => { editing = editing === b.dataset.edit ? null : b.dataset.edit; draw(); };
  if (editing) drawEditor(editing);
  wireMigration();
}

function drawEditor(name) {
  const el = host.querySelector("#model-editor");
  const r = state.roles[name];
  const kind = name === "embedding" ? "embedding" : "chat";
  el.innerHTML = `
    <div class="model-editor">
      <label>${esc(t("models.provider"))}
        <select id="model-provider">${state.providers.map((p) => `<option value="${esc(p.id)}"${
          p.id === r.provider ? " selected" : ""}${p.configured ? "" : " disabled"}>${esc(p.label)}${
          p.configured ? "" : ` — ${esc(t("models.needs", { key: p.keyName }))}`}</option>`).join("")}</select></label>
      <label>${esc(t("models.model"))}
        <input id="model-id" list="model-list" value="${esc(r.model)}" autocomplete="off" />
        <datalist id="model-list"></datalist></label>
      <div class="sub" id="model-price"></div>
      ${name === "embedding" ? `<p class="sub">${esc(t("models.embeddingWarning"))}</p>` : ""}
      <div class="actions model-actions">
        <button class="ghost" id="model-test">${esc(t("models.test"))}</button>
        <button id="model-save">${esc(t(name === "embedding" ? "models.startReembed" : "models.save"))}</button>
        <span class="sub" id="model-result"></span>
      </div>
    </div>`;

  const providerSel = el.querySelector("#model-provider");
  const modelInput = el.querySelector("#model-id");
  const result = el.querySelector("#model-result");
  let list = [];
  const showPrice = () => {
    el.querySelector("#model-price").textContent = price(list.find((m) => m.id === modelInput.value.trim()));
  };
  const load = async () => {
    list = await modelsFor(providerSel.value, kind);
    el.querySelector("#model-list").innerHTML = list.map((m) =>
      `<option value="${esc(m.id)}">${esc(price(m))}</option>`).join("");
    showPrice();
  };
  providerSel.onchange = load;
  modelInput.oninput = showPrice;
  load();

  const choice = () => ({ role: name, provider: providerSel.value, model: modelInput.value.trim() });
  el.querySelector("#model-test").onclick = async () => {
    result.textContent = t("models.testing");
    try {
      const out = await post("/api/ai/test", choice());
      result.textContent = out.ok
        ? t(out.dimensions ? "models.testOkEmbedding" : "models.testOk", { ms: out.ms, n: out.dimensions })
        : t("models.testFailed", { error: out.error });
    } catch (error) { result.textContent = error.message; }
  };
  el.querySelector("#model-save").onclick = async () => {
    const pick = choice();
    if (name === "embedding" && !confirm(t("models.reembedConfirm", { model: pick.model }))) return;
    result.textContent = t("models.saving");
    try {
      if (name === "embedding") await post("/api/ai/reembed", pick);
      else await post("/api/ai/role", pick);
      editing = null;
      await refresh();
    } catch (error) { result.textContent = error.message; }
  };
}

function wireMigration() {
  const m = state.migration;
  clearTimeout(poll);
  if (m?.status === "running") poll = setTimeout(refresh, 2000);
  if (!m) return;

  const run = host.querySelector("#compare-run");
  if (run) run.onclick = async () => {
    const out = host.querySelector("#compare-result");
    out.textContent = t("models.testing");
    try {
      const r = await post("/api/ai/reembed/compare", { query: host.querySelector("#compare-query").value });
      const column = (title, rows) => `<div><b>${esc(title)}</b><ol>${rows.map((row) =>
        `<li>${esc(row.title || row.id)} <span class="sub">${(row.similarity * 100).toFixed(0)}%</span></li>`).join("")}</ol></div>`;
      out.innerHTML = column(t("models.migration.now"), r.current) + column(t("models.migration.after"), r.next);
    } catch (error) { out.textContent = error.message; }
  };
  const act = (id, path, question) => {
    const b = host.querySelector(id);
    if (b) b.onclick = async () => {
      if (question && !confirm(question)) return;
      b.disabled = true;
      try { await post(path, path.endsWith("/reembed") ? { provider: m.provider, model: m.model } : {}); await refresh(); }
      catch (error) { b.disabled = false; alert(error.message); }
    };
  };
  act("#reembed-switch", "/api/ai/reembed/switch", t("models.migration.switchConfirm", { model: m.model }));
  act("#reembed-cancel", "/api/ai/reembed/cancel", t("models.migration.cancelConfirm"));
  act("#reembed-resume", "/api/ai/reembed");
}

async function refresh() {
  // The page moved on; stop polling a card nobody can see.
  if (!host?.isConnected) { clearTimeout(poll); return; }
  try {
    state = await api("/api/ai");
    draw();
  } catch (error) {
    host.innerHTML = `<div class="card"><div class="err">${esc(error.message)}</div></div>`;
  }
}

export async function renderModels(el) {
  host = el;
  await refresh();
}
