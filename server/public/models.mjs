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

// --- providers ----------------------------------------------------------------
//
// Addresses and keys. A key field is write-only: the page learns whether a key
// exists and where it came from, never the key itself, and an empty field on
// save means "keep what is there".

let editingProvider = null;

function providerStatus(p) {
  if (p.keyUnreadable) return t("models.providers.unreadable");
  if (!p.configured) return t("models.providers.missing");
  const from = p.keySource || p.urlSource;
  return from ? t(`models.providers.from.${from}`) : t("models.providers.ready");
}

function providerRow(p) {
  const canEdit = p.editable?.length;
  return `
    <tr>
      <td><b>${esc(p.label)}</b>${p.base ? `<div class="sub"><code>${esc(p.base)}</code></div>` : ""}</td>
      <td><span class="tag${p.configured ? "" : " vault"}">${esc(providerStatus(p))}</span></td>
      <td>${canEdit ? `<button class="ghost small" data-provider="${esc(p.id)}">${esc(t("models.change"))}</button>` : ""}</td>
    </tr>
    ${editingProvider === p.id ? `<tr><td colspan="3" id="provider-editor"></td></tr>` : ""}`;
}

function drawProviderEditor(p) {
  const el = host.querySelector("#provider-editor");
  const has = (field) => p.editable.includes(field);
  const keyHint = p.keySource === "settings" ? t("models.providers.keySaved")
    : p.keySource === "environment" ? t("models.providers.keyFromEnv") : t("models.providers.keyPaste");
  const stored = p.keySource === "settings" || p.urlSource === "settings";
  el.innerHTML = `
    <div class="model-editor">
      ${has("url") ? `<label>${esc(t("models.providers.url"))}
        <input id="provider-url" value="${esc(p.urlSource === "settings" ? p.base : "")}" placeholder="${esc(
          p.id === "ollama" ? "http://192.0.2.50:11434" : "https://example.net/v1")}" /></label>` : ""}
      ${has("name") ? `<label>${esc(t("models.providers.name"))}
        <input id="provider-name" value="${esc(p.label)}" /></label>` : ""}
      ${has("key") ? `<label>${esc(t("models.providers.key"))}
        <input id="provider-key" type="password" autocomplete="new-password" placeholder="${esc(keyHint)}"${
          state.canStoreKeys ? "" : " disabled"} /></label>
        <div class="sub">${esc(state.canStoreKeys ? t("models.providers.keyNote") : t("models.providers.noSettingsKey"))}</div>` : ""}
      <div class="actions model-actions">
        <button id="provider-save">${esc(t("models.save"))}</button>
        ${stored ? `<button class="ghost danger" id="provider-clear">${esc(t("models.providers.clear"))}</button>` : ""}
        <span class="sub" id="provider-result"></span>
      </div>
    </div>`;

  const result = el.querySelector("#provider-result");
  const send = async (payload) => {
    result.textContent = t("models.providers.checking");
    try {
      await post("/api/ai/provider", { id: p.id, ...payload });
      editingProvider = null;
      modelCache.clear();
      await refresh();
    } catch (error) { result.textContent = error.message; }
  };
  el.querySelector("#provider-save").onclick = () => send({
    ...(has("url") ? { url: el.querySelector("#provider-url").value } : {}),
    ...(has("name") ? { name: el.querySelector("#provider-name").value } : {}),
    ...(has("key") && state.canStoreKeys ? { key: el.querySelector("#provider-key").value } : {}),
  });
  const clear = el.querySelector("#provider-clear");
  if (clear) clear.onclick = () => {
    if (confirm(t("models.providers.clearConfirm"))) send({ clear: ["url", "name", "key"] });
  };
}

function draw() {
  host.innerHTML = `
    <div class="card models-card">
      <h3>${esc(t("models.title"))}</h3>
      <p class="sub">${esc(t("models.description"))}</p>
      <h4>${esc(t("models.providers.title"))}</h4>
      <table class="grid">
        <tr><th>${esc(t("models.provider"))}</th><th>${esc(t("models.providers.status"))}</th><th></th></tr>
        ${state.providers.filter((p) => p.editable?.length || p.configured).map(providerRow).join("")}
      </table>
      <h4>${esc(t("models.rolesTitle"))}</h4>
      <table class="grid">
        <tr><th>${esc(t("models.job"))}</th><th>${esc(t("models.inUse"))}</th><th></th></tr>
        ${ROLES.map(roleRow).join("")}
      </table>
      ${migrationPanel()}
      <p class="sub">${esc(t("models.thresholds"))}</p>
    </div>`;

  for (const b of host.querySelectorAll("[data-edit]"))
    b.onclick = () => { editing = editing === b.dataset.edit ? null : b.dataset.edit; draw(); };
  for (const b of host.querySelectorAll("[data-provider]"))
    b.onclick = () => { editingProvider = editingProvider === b.dataset.provider ? null : b.dataset.provider; draw(); };
  if (editing) drawEditor(editing);
  const openProvider = state.providers.find((p) => p.id === editingProvider);
  if (openProvider) drawProviderEditor(openProvider);
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
          p.configured ? "" : ` — ${esc(t("models.needs"))}`}</option>`).join("")}</select></label>
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
