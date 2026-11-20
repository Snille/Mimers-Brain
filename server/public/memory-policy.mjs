// The Memory policy card on the Settings page: the rules this instance gives
// every client, in two texts. The server side is memory-policy.mjs; the full
// listener alone reads and changes it through /api/memory-policy.

import { t } from "./i18n.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let host = null;
let current = null;

function field(name, rows) {
  const custom = current.custom[name];
  return `
    <h4>${esc(t(`memoryPolicy.${name}Title`))}
      <span class="sub">· ${esc(t(custom ? "memoryPolicy.custom" : "memoryPolicy.default"))}</span></h4>
    <p class="sub">${esc(t(`memoryPolicy.${name}Description`))}</p>
    <textarea id="policy-${name}" rows="${rows}" maxlength="${current.limits[name]}">${esc(current[name])}</textarea>
    <div class="sub" id="policy-${name}-count"></div>`;
}

function draw(status = "") {
  host.innerHTML = `
    <div class="card models-card">
      <h3>${esc(t("memoryPolicy.title"))}</h3>
      <p class="sub">${esc(t("memoryPolicy.description"))}</p>
      <p class="sub">${esc(t("memoryPolicy.placeholder", { placeholder: current.placeholder }))}</p>
      ${field("full", 16)}
      ${field("short", 7)}
      <div class="actions model-actions">
        <button class="small" id="policy-save">${esc(t("memoryPolicy.save"))}</button>
        <button class="ghost small" id="policy-reset">${esc(t("memoryPolicy.reset"))}</button>
        <span class="sub" id="policy-status">${esc(status)}</span>
      </div>
    </div>`;

  for (const name of ["full", "short"]) {
    const area = host.querySelector(`#policy-${name}`);
    const count = host.querySelector(`#policy-${name}-count`);
    const update = () => { count.textContent = `${area.value.trim().length} / ${current.limits[name]}`; };
    area.oninput = update;
    update();
  }

  const save = async (patch, done) => {
    try {
      const r = await fetch("/api/memory-policy", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      current = d;
      draw(t(done));
    } catch (error) {
      host.querySelector("#policy-status").textContent = error.message;
    }
  };
  host.querySelector("#policy-save").onclick = () => save({
    full: host.querySelector("#policy-full").value,
    short: host.querySelector("#policy-short").value,
  }, "memoryPolicy.saved");
  host.querySelector("#policy-reset").onclick = () => {
    if (confirm(t("memoryPolicy.resetConfirm"))) save({ full: "", short: "" }, "memoryPolicy.restored");
  };
}

export async function renderMemoryPolicy(el) {
  host = el;
  try {
    const r = await fetch("/api/memory-policy");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    current = await r.json();
    draw();
  } catch (error) {
    host.innerHTML = `<div class="card"><p class="sub">${esc(t("memoryPolicy.fetchError"))} ${esc(error.message)}</p></div>`;
  }
}
