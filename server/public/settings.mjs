// The "Settings" view: what this instance runs with - providers, models, the
// re-embedding, the similarity floors and the measurements behind them. It
// used to sit at the bottom of Connect, which is about setting up clients.
//
// Only the full listener can change any of it; see /api/ai in index.mjs. The
// header hides the button on the open listener, and this page says so too in
// case someone arrives by its address.

import { renderContradiction } from "./contradiction.mjs";
import { t } from "./i18n.mjs";
import { renderModels } from "./models.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export async function render(el) {
  const cfg = await fetch("/api/config").then((r) => r.json()).catch(() => ({}));
  if (!cfg.vault) {
    el.innerHTML = `<div class="empty">${esc(t("settings.fullOnly"))}</div>`;
    return;
  }
  el.innerHTML = `<div id="models-host"></div><div id="contradiction-host"></div>`;
  const models = el.querySelector("#models-host");
  await Promise.all([
    renderModels(models),
    renderContradiction(el.querySelector("#contradiction-host"), () => renderModels(models)),
  ]);
}
