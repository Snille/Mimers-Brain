// Theme and accent colour: applying them to the page, and the Appearance card on
// the Settings page. The setting lives on the server (appearance.mjs there) and
// comes with /api/config. A copy in localStorage lets the next page load start
// in the right colours before that request returns; see the script in <head>.

import { t } from "./i18n.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const CACHE_KEY = "appearance";
export const DEFAULT = Object.freeze({ theme: "dark", accent: "#95c200" });
// Erik's green first; the old blue is kept for anyone who liked it.
const SWATCHES = ["#95c200", "#4aa3c7", "#8b7cf6", "#e0a030", "#e05d8a", "#3fb6a8"];

// Black or white text on the accent, whichever reads better.
export function onAccent(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.18 ? "#0e1011" : "#ffffff";
}

export function apply(a = DEFAULT) {
  const root = document.documentElement;
  if (a.theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", a.theme === "light" ? "light" : "dark");
  const on = onAccent(a.accent);
  root.style.setProperty("--accent", a.accent);
  root.style.setProperty("--on-accent", on);
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ theme: a.theme, accent: a.accent, on })); } catch { /* unavailable */ }
}

let current = { ...DEFAULT };
let host = null;

function draw(status = "") {
  const theme = (value) => `<label class="choice"><input type="radio" name="theme" value="${value}"${
    current.theme === value ? " checked" : ""} /> ${esc(t(`appearance.theme.${value}`))}</label>`;
  host.innerHTML = `
    <div class="card models-card">
      <h3>${esc(t("appearance.title"))}</h3>
      <p class="sub">${esc(t("appearance.description"))}</p>
      <h4>${esc(t("appearance.themeTitle"))}</h4>
      <div class="choices">${theme("dark")}${theme("light")}${theme("system")}</div>
      <h4>${esc(t("appearance.accentTitle"))}</h4>
      <div class="swatches">
        ${SWATCHES.map((c) => `<button class="swatch${c === current.accent ? " on" : ""}" data-accent="${c}"
          style="background:${c}" title="${c}" aria-label="${c}"></button>`).join("")}
        <label class="sub">${esc(t("appearance.custom"))}
          <input type="color" id="accent-custom" value="${esc(current.accent)}" /></label>
        <code>${esc(current.accent)}</code>
      </div>
      <div class="actions model-actions">
        <button class="ghost small" id="appearance-reset">${esc(t("appearance.reset"))}</button>
        <span class="sub" id="appearance-status">${esc(status)}</span>
      </div>
    </div>`;

  // Applied at once, saved for everyone right after.
  const save = async (patch) => {
    // An empty value means the default, on the server and here.
    current = { ...current, ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v || DEFAULT[k]])) };
    apply(current);
    try {
      const r = await fetch("/api/appearance", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      current = d;
      apply(current);
      draw(t("appearance.saved"));
    } catch (error) { draw(error.message); }
  };
  for (const input of host.querySelectorAll("input[name=theme]")) input.onchange = () => save({ theme: input.value });
  for (const b of host.querySelectorAll("[data-accent]")) b.onclick = () => save({ accent: b.dataset.accent });
  const custom = host.querySelector("#accent-custom");
  custom.oninput = () => apply({ ...current, accent: custom.value });
  custom.onchange = () => save({ accent: custom.value });
  host.querySelector("#appearance-reset").onclick = () => save({ theme: "", accent: "" });
}

export async function renderAppearance(el) {
  host = el;
  const cfg = await fetch("/api/config").then((r) => r.json()).catch(() => ({}));
  current = cfg.appearance || { ...DEFAULT };
  draw();
}
