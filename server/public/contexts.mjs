// Contexts on the Memories page and the Contexts card on the Settings page.
// The rules are in server/contexts.mjs: a memory is in a context when the
// reader puts it there, or when it is a standing memory of one of the
// context's projects, and either way it leaves the base start pack.

import { t } from "./i18n.mjs";
import { attachProjectPicker } from "./projects.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function api(path, opts) {
  const r = await fetch(path, opts);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

let known = [];
let loading = null;

export function loadContexts({ force = false } = {}) {
  if (force || !loading) {
    loading = api("/api/contexts").then((d) => { known = Array.isArray(d) ? d : []; return known; })
      .catch(() => known);
  }
  return loading;
}

const confirmed = () => known.filter((c) => c.status === "confirmed");

// For the sidebar, which filters by id and shows the name.
export const contextName = (id) => `🧭 ${known.find((c) => c.id === id)?.name || id}`;

// The contexts a memory is in, by name or by project. `standing` says whether
// it would be in the start pack at all; only then does a project count.
export function contextsOf(m, { standing = false } = {}) {
  const named = Array.isArray(m.contexts) ? m.contexts : [];
  return confirmed().filter((c) => named.includes(c.id)
    || (standing && m.project && (c.projects || []).includes(m.project)));
}

// What each context's start pack holds, from /api/stats: { id: { fits: [ids],
// omitted } }. Set before the cards are drawn, so a tag can say whether the
// memory is one a model gets with that context.
let packs = null;
export const setContextPacks = (value) => { packs = value && typeof value === "object" ? value : null; };

// Why a memory of a context is in its start pack or not: "in", "unused" (not
// current, not confirmed, or evidence only) or "full" (no room left).
function packState(c, id, usable) {
  const fits = packs?.[c.id]?.fits;
  if (!Array.isArray(fits)) return "";
  if (fits.includes(id)) return "in";
  return usable ? "full" : "unused";
}

export function contextTags(list, id = "", usable = true) {
  return list.map((c) => {
    const state = packState(c, id, usable);
    const hint = t(state ? `contexts.tagHint_${state}` : "contexts.tagHint", { name: c.name });
    const mark = state === "in" ? " 📌" : state ? ` · ${t(`contexts.tag_${state}`)}` : "";
    return `<span class="tag context${state && state !== "in" ? " out" : ""}" title="${esc(hint)}">🧭 ${esc(c.name)}${esc(mark)}</span>`;
  }).join("");
}

// The editor's checkboxes. An id that names no confirmed context is kept as it
// is, so a context that is deleted and made again finds its memories.
export function contextEditor(m) {
  const wrap = document.createElement("div");
  wrap.className = "context-editor";
  const named = Array.isArray(m.contexts) ? m.contexts : [];
  const list = confirmed();
  wrap.innerHTML = `
    <div class="edit-label">${esc(t("contexts.editorTitle"))}</div>
    ${list.length ? `<div class="context-boxes">${list.map((c) => `
      <label class="context-box" title="${esc(c.description)}"><input type="checkbox" value="${esc(c.id)}"${named.includes(c.id) ? " checked" : ""} /> ${esc(c.name)}</label>`).join("")}</div>
      <div class="sub">${esc(t("contexts.editorHint"))}</div>`
      : `<div class="sub">${esc(t("contexts.editorNone"))}</div>`}`;
  const hidden = named.filter((id) => !list.some((c) => c.id === id));
  return {
    el: wrap,
    value: () => [...hidden, ...[...wrap.querySelectorAll("input:checked")].map((i) => i.value)],
  };
}

// --- Settings: the Contexts card ------------------------------------------------

export async function renderContexts(el) {
  let editing = null;
  let status = "";

  async function draw() {
    let list;
    try {
      list = await loadContexts({ force: true });
    } catch (error) {
      el.innerHTML = `<div class="card"><p class="sub">${esc(t("contexts.fetchError"))} ${esc(error.message)}</p></div>`;
      return;
    }
    const current = editing && editing !== "new" ? list.find((c) => c.id === editing) : null;
    const form = editing ? `
      <div class="context-form">
        <label>${esc(t("contexts.name"))}<input type="text" class="c-name" maxlength="40" value="${esc(current?.name || "")}" /></label>
        <label>${esc(t("contexts.projects"))}<input type="text" class="c-projects" value="${esc((current?.projects || []).join(", "))}" placeholder="spectrogon" />
          <span class="sub">${esc(t("contexts.projectsHint"))}</span></label>
        <label class="wide">${esc(t("contexts.description"))}<input type="text" class="c-description" maxlength="200" value="${esc(current?.description || "")}" />
          <span class="sub">${esc(t("contexts.descriptionHint"))}</span></label>
        <label class="wide">${esc(t("contexts.instruction"))}<textarea class="c-instruction" rows="4" maxlength="1200">${esc(current?.instruction || "")}</textarea>
          <span class="sub">${esc(t("contexts.instructionHint"))}</span></label>
      </div>
      <div class="actions model-actions">
        <button class="small c-save">${esc(t("contexts.save"))}</button>
        <button class="ghost small c-cancel">${esc(t("contexts.cancel"))}</button>
        <span class="sub c-status">${esc(status)}</span>
      </div>` : `
      <div class="actions model-actions">
        <button class="small c-add">${esc(t("contexts.add"))}</button>
        <span class="sub c-status">${esc(status)}</span>
      </div>`;
    el.innerHTML = `
      <div class="card models-card">
        <h3>${esc(t("contexts.title"))}</h3>
        <p class="sub">${esc(t("contexts.description_card"))}</p>
        ${list.length ? `<table class="grid"><tbody>${list.map((c) => `
          <tr>
            <td><b>🧭 ${esc(c.name)}</b>${c.status === "proposed"
              ? ` <span class="tag vault">${esc(t("contexts.proposed", { by: c.created_by || "agent" }))}</span>` : ""}
              <div class="sub"><code>${esc(c.id)}</code>${c.projects?.length ? ` · 📁 ${esc(c.projects.join(", "))}` : ""}</div></td>
            <td>${esc(c.description)}${c.instruction ? `<div class="sub context-instruction">${esc(c.instruction)}</div>` : ""}</td>
            <td style="white-space:nowrap">${c.status === "confirmed" ? esc(t("contexts.memories", { n: c.memories ?? 0 })) : ""}</td>
            <td style="white-space:nowrap">
              ${c.status === "proposed" ? `<button class="small" data-confirm="${esc(c.id)}">${esc(t("contexts.confirm"))}</button>` : ""}
              <button class="ghost small" data-edit="${esc(c.id)}">${esc(t("contexts.edit"))}</button>
              <button class="ghost small danger" data-delete="${esc(c.id)}">${esc(t("contexts.delete"))}</button></td>
          </tr>`).join("")}</tbody></table>` : `<p class="sub">${esc(t("contexts.none"))}</p>`}
        ${form}
      </div>`;

    const projectsInput = el.querySelector(".c-projects");
    if (projectsInput) attachProjectPicker(projectsInput, { multiple: true });
    el.querySelector(".c-add")?.addEventListener("click", () => { editing = "new"; status = ""; draw(); });
    el.querySelector(".c-cancel")?.addEventListener("click", () => { editing = null; status = ""; draw(); });
    for (const b of el.querySelectorAll("[data-edit]"))
      b.onclick = () => { editing = b.dataset.edit; status = ""; draw(); };
    for (const b of el.querySelectorAll("[data-confirm]")) {
      b.onclick = async () => {
        try { await api(`/api/contexts/${encodeURIComponent(b.dataset.confirm)}/confirm`, { method: "POST" }); status = t("contexts.confirmed"); }
        catch (error) { status = error.message; }
        draw();
      };
    }
    for (const b of el.querySelectorAll("[data-delete]")) {
      b.onclick = async () => {
        const c = list.find((x) => x.id === b.dataset.delete);
        if (!confirm(t("contexts.deleteConfirm", { name: c?.name || b.dataset.delete }))) return;
        try { await api(`/api/contexts/${encodeURIComponent(b.dataset.delete)}`, { method: "DELETE" }); status = ""; }
        catch (error) { status = error.message; }
        draw();
      };
    }
    const save = el.querySelector(".c-save");
    if (save) {
      save.onclick = async () => {
        save.disabled = true;
        try {
          await api("/api/contexts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...(current ? { id: current.id } : {}),
              name: el.querySelector(".c-name").value,
              projects: el.querySelector(".c-projects").value,
              description: el.querySelector(".c-description").value,
              instruction: el.querySelector(".c-instruction").value,
            }),
          });
          editing = null;
          status = t("contexts.saved");
          draw();
        } catch (error) {
          save.disabled = false;
          el.querySelector(".c-status").textContent = error.message;
        }
      };
    }
  }
  await draw();
}
