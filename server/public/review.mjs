import { formatDate, t as tr } from "./i18n.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>\"]/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function api(path, opts) {
  const response = await fetch(path, opts);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

const post = (path, payload) => api(path, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

function memorySummary(row, prefix = "") {
  const meta = row[`${prefix}metadata`] || row.metadata || {};
  const content = row[`${prefix}content`] || row.content || "";
  return `<div class="review-memory">
    <b>${esc(meta.title || content.slice(0, 120))}</b>
    <div class="summary">${esc(meta.summary || content.slice(0, 400))}</div>
    <div class="sub">${esc(meta.origin || "legacy")} · ${esc(meta.provenance || "imported")} · ${esc(meta.review_status || "confirmed")}${
      meta.captured_by ? ` · ${esc(tr("review.capturedBy", { client: meta.captured_by }))}` : ""}</div>
  </div>`;
}

// The receipt log grows by one row per search and is read newest-first, so how
// far back it reaches is a reading choice. The choice is remembered per browser
// rather than stored on the server: it changes nothing about the data.
const RECALL_LIMITS = [10, 25, 50, 100, 200];
const storedLimit = Number(localStorage.getItem("recall-limit"));
let recallLimit = RECALL_LIMITS.includes(storedLimit) ? storedLimit : 25;

export async function render(root) {
  root.innerHTML = `<div class="empty">${esc(tr("common.loading"))}</div>`;
  let data;
  try { data = await api(`/api/review?recalls=${recallLimit}`); }
  catch (error) { root.innerHTML = `<div class="err">${esc(error.message)}</div>`; return; }

  root.innerHTML = `
    <section class="review-section">
      <h2>${esc(tr("review.pending.title"))} <span class="tag">${data.pending.length}</span></h2>
      <p class="sub">${esc(tr("review.pending.description"))}</p>
      <div id="review-pending"></div>
    </section>
    <section class="review-section">
      <h2>${esc(tr("review.duplicates.title"))} <span class="tag">${data.duplicates.length}</span></h2>
      <p class="sub">${esc(tr("review.duplicates.description"))}</p>
      <div id="review-duplicates"></div>
    </section>
    <section class="review-section">
      <h2>${esc(tr("review.recalls.title"))}</h2>
      <p class="sub">${esc(tr("review.recalls.description"))}
        <label>${esc(tr("review.recalls.show"))}
          <select id="recall-limit">${RECALL_LIMITS.map((limit) =>
            `<option value="${limit}"${limit === recallLimit ? " selected" : ""}>${limit}</option>`).join("")}</select>
        </label></p>
      <div id="review-recalls"></div>
    </section>`;

  const pending = root.querySelector("#review-pending");
  pending.innerHTML = data.pending.length ? "" : `<div class="empty">${esc(tr("review.empty"))}</div>`;
  for (const row of data.pending) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `${memorySummary(row)}<div class="actions review-actions">
      ${["confirm", "evidence_only", "restrict", "stale", "reject"].map((action) =>
        `<button class="${action === "reject" ? "ghost danger" : "ghost"}" data-action="${action}">${esc(tr(`review.actions.${action}`))}</button>`).join("")}
    </div>`;
    for (const button of card.querySelectorAll("button")) button.onclick = async () => {
      button.disabled = true;
      try {
        await post(`/api/thoughts/${row.id}/review`, { action: button.dataset.action });
        await render(root);
      } catch (error) { button.disabled = false; alert(error.message); }
    };
    pending.appendChild(card);
  }

  const duplicates = root.querySelector("#review-duplicates");
  duplicates.innerHTML = data.duplicates.length ? "" : `<div class="empty">${esc(tr("review.empty"))}</div>`;
  for (const pair of data.duplicates) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<div class="meta"><span class="tag sim">${(pair.similarity * 100).toFixed(1)}%</span></div>
      <div class="duplicate-grid">${memorySummary(pair, "left_")}${memorySummary(pair, "right_")}</div>
      <div class="actions review-actions">
        <button class="ghost" data-action="keep_both">${esc(tr("review.actions.keep_both"))}</button>
        <button class="ghost" data-action="related">${esc(tr("review.actions.related"))}</button>
        <button class="ghost" data-action="left">${esc(tr("review.actions.keep_left"))}</button>
        <button class="ghost" data-action="right">${esc(tr("review.actions.keep_right"))}</button>
        <button class="ghost" data-action="merge">${esc(tr("review.actions.merge"))}</button>
      </div>`;
    for (const button of card.querySelectorAll("button")) button.onclick = async () => {
      let action = button.dataset.action;
      const payload = { left_id: pair.left_id, right_id: pair.right_id };
      if (action === "left" || action === "right") {
        payload.action = "supersede";
        payload.canonical_id = action === "left" ? pair.left_id : pair.right_id;
      } else if (action === "merge") {
        const initial = `${pair.left_content}\n\n${pair.right_content}`;
        const merged = prompt(tr("review.mergePrompt"), initial);
        if (!merged) return;
        payload.action = "merge";
        payload.merged_content = merged;
      } else payload.action = action;
      button.disabled = true;
      try { await post("/api/duplicates/resolve", payload); await render(root); }
      catch (error) { button.disabled = false; alert(error.message); }
    };
    duplicates.appendChild(card);
  }

  const limitPicker = root.querySelector("#recall-limit");
  if (limitPicker) limitPicker.onchange = async () => {
    recallLimit = Number(limitPicker.value);
    localStorage.setItem("recall-limit", String(recallLimit));
    await render(root);
  };

  const recalls = root.querySelector("#review-recalls");
  recalls.innerHTML = data.recalls.length ? `<table><thead><tr>
    <th>${esc(tr("review.recalls.when"))}</th><th>${esc(tr("review.recalls.client"))}</th>
    <th>${esc(tr("review.recalls.returned"))}</th><th>${esc(tr("review.recalls.used"))}</th>
    <th>${esc(tr("review.recalls.status"))}</th></tr></thead><tbody>${data.recalls.map((trace) => `<tr>
      <td>${esc(formatDate(trace.created_at))}</td><td>${esc(trace.client)}</td>
      <td>${trace.result_ids.length}</td><td>${trace.used_ids.length}</td>
      <td>${esc(trace.reported_at ? tr("review.recalls.reported") : tr("review.recalls.awaiting"))}</td>
    </tr>`).join("")}</tbody></table>` : `<div class="empty">${esc(tr("review.empty"))}</div>`;
}
