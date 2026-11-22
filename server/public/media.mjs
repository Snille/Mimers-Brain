// Media on the Memories page and the Media sources card on the Settings page.
//
// A memory stores pointers only (see normaliseMedia in memory-model.mjs). The
// pictures come through the brain, /api/media/<source>/<type>/<id>/thumbnail,
// which holds the source's key; a click opens the item on its own server.
// Searching a source is a full-listener action, so the open listener shows the
// media, can remove it and can add a plain link, but has no picker.

import { t } from "./i18n.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function api(path, opts) {
  const r = await fetch(path, opts);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

const ICON = { person: "👤", album: "🖼", asset: "📷", link: "🔗" };
const WEB_PATH = { person: "people", album: "albums", asset: "photos" };

let known = { sources: [], scopes: [], canStoreKeys: false };
let loading = null;

export function loadSources({ force = false } = {}) {
  if (force || !loading) {
    loading = api("/api/media/sources")
      .then((d) => { known = d; return d; })
      .catch(() => known);
  }
  return loading;
}

export const sources = () => known.sources || [];
const sourceOf = (id) => sources().find((s) => s.id === id);

export const thumbUrl = (r) =>
  `/api/media/${encodeURIComponent(r.source)}/${r.type}/${encodeURIComponent(r.id)}/thumbnail`;

function webUrl(r) {
  const s = sourceOf(r.source);
  return s ? `${s.webUrl}/${WEB_PATH[r.type]}/${encodeURIComponent(r.id)}` : null;
}

const label = (r) => `${ICON[r.type] || ""} ${r.type === "link" ? r.title || r.url : r.title || r.id}`;

function item(r) {
  if (r.type === "link")
    return `<a class="media-item media-link" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">
      <span>${esc(label(r))}</span></a>`;
  const s = sourceOf(r.source);
  if (!s)
    return `<span class="media-item missing" title="${esc(t("media.unknownSource", { source: r.source }))}">
      <span>${esc(label(r))}</span></span>`;
  return `<a class="media-item" href="${esc(webUrl(r))}" target="_blank" rel="noopener noreferrer"
      title="${esc(`${t(`media.type.${r.type}`)} · ${s.name}`)}">
      <img loading="lazy" alt="" src="${esc(thumbUrl(r))}" /><span>${esc(label(r))}</span></a>`;
}

// The row under a memory's text. A picture that will not load (deleted on the
// server, a key without person.read) leaves its name and link in place.
export function mediaStrip(refs) {
  if (!Array.isArray(refs) || !refs.length) return "";
  return `<div class="media-strip">${refs.map(item).join("")}</div>`;
}

export function wireStrip(el) {
  for (const img of el.querySelectorAll(".media-strip img")) img.onerror = () => img.remove();
}

// --- the editor ----------------------------------------------------------------

// The media section of a memory being edited. Changes stay in the draft until
// the memory is saved, like every other field of the form.
export function mediaEditor(refs, { full = false } = {}) {
  let list = Array.isArray(refs) ? refs.map((r) => ({ ...r })) : [];
  const wrap = document.createElement("div");
  wrap.className = "media-editor";

  const keyOf = (r) => (r.type === "link" ? `link|${r.url}` : `${r.source}|${r.type}|${r.id}`);
  const has = (r) => list.some((x) => keyOf(x) === keyOf(r));
  const toggle = (r) => {
    list = has(r) ? list.filter((x) => keyOf(x) !== keyOf(r)) : [...list, r];
    draw();
    return has(r);
  };

  function draw(error = "") {
    const canPick = full && sources().length > 0;
    wrap.innerHTML = `
      <div class="edit-label">${esc(t("media.title"))}</div>
      <div class="media-edit-list">${list.length ? list.map((r, i) => `
        <span class="media-chip">${r.type !== "link" && sourceOf(r.source)
          ? `<img alt="" src="${esc(thumbUrl(r))}" />` : ""}<span>${esc(label(r))}</span>
          <button type="button" class="ghost small" data-remove="${i}" title="${esc(t("media.remove"))}">✕</button></span>`).join("")
        : `<span class="sub">${esc(t("media.none"))}</span>`}</div>
      <div class="media-add">
        ${canPick ? `<button type="button" class="ghost small" data-pick>${esc(t("media.pick"))}</button>` : ""}
        <input type="url" class="m-url" placeholder="https://…" />
        <input type="text" class="m-title" placeholder="${esc(t("media.linkTitle"))}" />
        <button type="button" class="ghost small" data-link>${esc(t("media.addLink"))}</button>
      </div>
      ${error ? `<div class="sub media-error">${esc(error)}</div>` : ""}`;
    for (const img of wrap.querySelectorAll(".media-chip img")) img.onerror = () => img.remove();
    for (const b of wrap.querySelectorAll("[data-remove]")) {
      b.onclick = () => { list.splice(Number(b.dataset.remove), 1); draw(); };
    }
    wrap.querySelector("[data-link]").onclick = () => {
      const url = wrap.querySelector(".m-url").value.trim();
      const title = wrap.querySelector(".m-title").value.trim();
      if (!/^https?:\/\/[^\s/]+/i.test(url)) return draw(t("media.badLink"));
      if (!has({ type: "link", url })) list.push({ type: "link", url, ...(title ? { title } : {}) });
      draw();
    };
    const pick = wrap.querySelector("[data-pick]");
    if (pick) pick.onclick = () => openPicker({ has, toggle });
  }
  draw();
  return { el: wrap, value: () => list };
}

// --- the picker ----------------------------------------------------------------

function openPicker({ has, toggle }) {
  const dlg = document.createElement("dialog");
  dlg.className = "media-dlg";
  const types = ["person", "album", "asset"];
  dlg.innerHTML = `
    <h3 style="margin:0 0 8px">${esc(t("media.picker.title"))}</h3>
    <div class="media-picker-form">
      <label>${esc(t("media.picker.source"))}<select class="p-source">${sources().map((s) =>
        `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("")}</select></label>
      <label>${esc(t("media.picker.type"))}<select class="p-type">${types.map((x) =>
        `<option value="${x}">${esc(t(`media.type.${x}`))}</option>`).join("")}</select></label>
      <label class="grow">${esc(t("media.picker.search"))}<input type="search" class="p-q"
        placeholder="${esc(t("media.picker.placeholder"))}" /></label>
      <button type="button" class="p-go">${esc(t("media.picker.search"))}</button>
    </div>
    <div class="media-results"></div>
    <div style="display:flex; justify-content:flex-end; margin-top:14px">
      <button type="button" class="p-done">${esc(t("media.picker.done"))}</button>
    </div>`;
  document.body.append(dlg);
  const results = dlg.querySelector(".media-results");
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.querySelector(".p-done").onclick = close;
  dlg.addEventListener("cancel", (e) => { e.preventDefault(); close(); });

  let run = 0;
  async function search() {
    const mine = ++run;
    const source = dlg.querySelector(".p-source").value;
    const type = dlg.querySelector(".p-type").value;
    const q = dlg.querySelector(".p-q").value.trim();
    results.innerHTML = `<div class="sub">${esc(t("media.picker.loading"))}</div>`;
    try {
      const rows = await api(`/api/media/${encodeURIComponent(source)}/search?type=${type}&q=${encodeURIComponent(q)}`);
      if (mine !== run) return;
      if (!rows.length) { results.innerHTML = `<div class="sub">${esc(t("media.picker.empty"))}</div>`; return; }
      results.innerHTML = rows.map((r, i) => {
        const ref = { source, type: r.type, id: r.id, title: r.title };
        return `<button type="button" class="media-result${has(ref) ? " on" : ""}" data-i="${i}" title="${esc(r.title)}">
          <img loading="lazy" alt="" src="${esc(thumbUrl(ref))}" />
          <span>${esc(r.video ? `🎬 ${r.title}` : r.title)}${r.count != null ? ` <span class="sub">(${r.count})</span>` : ""}</span></button>`;
      }).join("");
      for (const b of results.querySelectorAll(".media-result")) {
        const r = rows[Number(b.dataset.i)];
        b.querySelector("img").onerror = (e) => e.target.remove();
        b.onclick = () => b.classList.toggle("on", toggle({ source, type: r.type, id: r.id, title: r.title }));
      }
    } catch (error) {
      if (mine === run) results.innerHTML = `<div class="err">${esc(error.message)}</div>`;
    }
  }
  dlg.querySelector(".p-go").onclick = search;
  dlg.querySelector(".p-q").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); search(); } };
  dlg.querySelector(".p-type").onchange = search;
  dlg.querySelector(".p-source").onchange = search;
  dlg.showModal();
  dlg.querySelector(".p-q").focus();
  search();
}

// --- Settings: the Media sources card ----------------------------------------

export async function renderMediaSources(el) {
  let editing = null;
  let status = "";

  async function draw() {
    let d;
    try {
      d = await loadSources({ force: true });
      if (!d.scopes) throw new Error("HTTP");
    } catch (error) {
      el.innerHTML = `<div class="card"><p class="sub">${esc(t("media.sources.fetchError"))} ${esc(error.message)}</p></div>`;
      return;
    }
    const current = editing && editing !== "new" ? d.sources.find((s) => s.id === editing) : null;
    el.innerHTML = `
      <div class="card models-card">
        <h3>${esc(t("media.sources.title"))}</h3>
        <p class="sub">${esc(t("media.sources.description"))}</p>
        <p class="sub">${esc(t("media.sources.scopes", { scopes: d.scopes.join(", ") }))}</p>
        ${d.canStoreKeys ? "" : `<p class="err">${esc(t("media.sources.noSeal"))}</p>`}
        ${d.sources.length ? `<table class="grid"><tbody>${d.sources.map((s) => `
          <tr>
            <td><b>${esc(s.name)}</b> <span class="tag">${esc(s.kind)}</span><div class="sub"><code>${esc(s.id)}</code></div></td>
            <td><code>${esc(s.url)}</code>${s.webUrl !== s.url ? `<div class="sub">${esc(s.webUrl)}</div>` : ""}</td>
            <td>${s.keyUnreadable ? `<span class="tag vault">${esc(t("media.sources.keyUnreadable"))}</span>`
              : s.hasKey ? `<span class="tag">${esc(t("media.sources.keyStored"))}</span>` : ""}</td>
            <td style="white-space:nowrap">
              <button class="ghost small" data-edit="${esc(s.id)}">${esc(t("media.sources.edit"))}</button>
              <button class="ghost small danger" data-delete="${esc(s.id)}">${esc(t("media.sources.delete"))}</button></td>
          </tr>`).join("")}</tbody></table>` : `<p class="sub">${esc(t("media.sources.none"))}</p>`}
        ${editing ? `
          <div class="media-source-form">
            <label>${esc(t("media.sources.name"))}<input type="text" class="s-name" maxlength="40" value="${esc(current?.name || "Immich")}" /></label>
            <label>${esc(t("media.sources.url"))}<input type="url" class="s-url" placeholder="http://10.0.0.25:2283" value="${esc(current?.url || "")}" /></label>
            <label>${esc(t("media.sources.webUrl"))}<input type="url" class="s-web" placeholder="https://photos.example.com"
              value="${esc(current && current.webUrl !== current.url ? current.webUrl : "")}" />
              <span class="sub">${esc(t("media.sources.webUrlHint"))}</span></label>
            <label>${esc(t("media.sources.key"))}<input type="password" class="s-key" autocomplete="off"
              placeholder="${esc(current ? t("media.sources.keyKeep") : "")}" />
              <span class="sub">${esc(t("media.sources.keyNote"))}</span></label>
          </div>
          <div class="actions model-actions">
            <button class="small s-save">${esc(t("media.sources.save"))}</button>
            <button class="ghost small s-cancel">${esc(t("media.sources.cancel"))}</button>
            <span class="sub s-status">${esc(status)}</span>
          </div>` : `
          <div class="actions model-actions">
            ${d.canStoreKeys ? `<button class="small s-add">${esc(t("media.sources.add"))}</button>` : ""}
            <span class="sub s-status">${esc(status)}</span>
          </div>`}
      </div>`;

    el.querySelector(".s-add")?.addEventListener("click", () => { editing = "new"; status = ""; draw(); });
    el.querySelector(".s-cancel")?.addEventListener("click", () => { editing = null; status = ""; draw(); });
    for (const b of el.querySelectorAll("[data-edit]"))
      b.onclick = () => { editing = b.dataset.edit; status = ""; draw(); };
    for (const b of el.querySelectorAll("[data-delete]")) {
      b.onclick = async () => {
        const s = d.sources.find((x) => x.id === b.dataset.delete);
        if (!confirm(t("media.sources.deleteConfirm", { name: s?.name || b.dataset.delete }))) return;
        try {
          await api(`/api/media/sources/${encodeURIComponent(b.dataset.delete)}`, { method: "DELETE" });
          status = "";
        } catch (error) { status = error.message; }
        draw();
      };
    }
    const save = el.querySelector(".s-save");
    if (save) {
      save.onclick = async () => {
        save.disabled = true;
        save.textContent = t("media.sources.saving");
        const payload = {
          ...(current ? { id: current.id } : {}),
          kind: "immich",
          name: el.querySelector(".s-name").value,
          url: el.querySelector(".s-url").value,
          web_url: el.querySelector(".s-web").value,
          key: el.querySelector(".s-key").value,
        };
        try {
          const out = await api("/api/media/sources", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
          });
          editing = null;
          status = out.warnings?.length
            ? t("media.sources.missing", { scopes: out.warnings.join(", ") }) : t("media.sources.saved");
          draw();
        } catch (error) {
          save.disabled = false;
          save.textContent = t("media.sources.save");
          el.querySelector(".s-status").textContent = error.message;
        }
      };
    }
  }
  await draw();
}
