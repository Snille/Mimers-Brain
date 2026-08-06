// The "Statistics" view. Charts are hand-rolled SVG on purpose: the whole UI is
// one dependency-free page served off the box itself, and a bar chart is not
// worth breaking that for.
//
// Note what the numbers can honestly say. MCP tells the server which *client
// application* is calling - Claude Code, Codex, a ChatGPT connector - and never
// which model is answering inside it. "Top client" therefore means the app, not
// the model. Through the proxy the page only ever counts traffic that arrived on
// the open listener, so it cannot reveal that vault traffic exists.

import { formatDate, formatDateTime, t } from "./i18n.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const fmtDate = (d) => formatDate(d);
const fmtWhen = (d) => formatDateTime(d);

let root = null;

// The API only returns buckets that had activity, which is right for the wire
// and wrong for a chart: two bars a month apart would end up side by side, and a
// single quiet day would stretch one bar across the whole card. So the series is
// made dense here - a quiet day is a gap you can see, not a day that vanished.
const DAYS = 60;
const MONTHS = 12;
const EMPTY = { calls: 0, reads: 0, writes: 0, deletes: 0, count: 0 };
const key = (v) => String(v).slice(0, 10);

function denseDays(rows, days) {
  const have = new Map(rows.map((r) => [key(r.bucket), r]));
  const now = new Date();
  const base = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(base - i * 86400000).toISOString().slice(0, 10);
    out.push(have.get(d) || { ...EMPTY, bucket: d });
  }
  return out;
}

function denseMonths(rows, months) {
  const have = new Map(rows.map((r) => [key(r.bucket).slice(0, 7), r]));
  const now = new Date();
  const out = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth() - i, 1));
    const m = d.toISOString().slice(0, 7);
    out.push(have.get(m) || { ...EMPTY, bucket: `${m}-01` });
  }
  return out;
}

function kpi(label, value, sub = "") {
  return `<div class="kpi"><div class="kpi-v">${esc(value)}</div>
    <div class="kpi-l">${esc(label)}</div>
    ${sub ? `<div class="kpi-s">${esc(sub)}</div>` : ""}</div>`;
}

// Stacked bars, reads at the bottom and writes on top. Fixed viewBox with
// preserveAspectRatio off, so it stretches to whatever width the card has
// without any resize handling.
function chart(rows, { keys, colors, labels, height = 130 }) {
  const totals = rows.map((r) => keys.reduce((s, k) => s + (r[k] || 0), 0));
  if (!rows.length || !totals.some(Boolean))
    return `<div class="empty">${esc(t("stats.chart.noActivity"))}</div>`;

  const w = rows.length * 14;
  const max = Math.max(1, ...totals);
  const bw = w / rows.length;

  const bars = rows.map((r, i) => {
    const x = i * bw;
    let y = height;
    const segs = keys.map((k, ki) => {
      const v = r[k] || 0;
      if (!v) return "";
      const h = (v / max) * (height - 4);
      y -= h;
      return `<rect x="${x + bw * 0.15}" y="${y}" width="${bw * 0.7}" height="${h}" fill="${colors[ki]}" />`;
    }).join("");
    const total = keys.reduce((s, k) => s + (r[k] || 0), 0);
    return `<g><title>${esc(fmtDate(r.bucket))}: ${keys.map((k, ki) => `${labels[ki]} ${r[k] || 0}`).join(", ")}${keys.length > 1 ? ` (${total})` : ""}</title>${segs}</g>`;
  }).join("");

  const first = rows[0]?.bucket;
  const last = rows.at(-1)?.bucket;
  return `
    <svg class="chart" viewBox="0 0 ${w} ${height}" preserveAspectRatio="none" role="img">
      <line x1="0" y1="${height - 0.5}" x2="${w}" y2="${height - 0.5}" stroke="var(--line)" stroke-width="1" vector-effect="non-scaling-stroke" />
      ${bars}
    </svg>
    <div class="chart-axis sub">
      <span>${esc(fmtDate(first))}</span>
      <span class="legend">${keys.map((k, i) =>
        `<i style="background:${colors[i]}"></i>${esc(labels[i])}`).join("")}</span>
      <span>${esc(t("stats.chart.max", { count: max }))}</span>
      <span>${esc(fmtDate(last))}</span>
    </div>`;
}

function mqttCard(m) {
  if (!m.configured) return `
    <div class="card">
      <h3>${esc(t("stats.mqtt.title"))}</h3>
      <p class="sub">${t("stats.mqtt.notConfigured")}</p>
    </div>`;

  const dot = m.connected ? "ok" : "danger";
  return `
    <div class="card">
      <div class="snip-head" style="margin-bottom:10px">
        <h3 style="margin:0">${esc(t("stats.mqtt.title"))}</h3>
        <button class="ghost small" id="mqtt-now">${esc(t("stats.mqtt.publishNow"))}</button>
      </div>
      <table class="grid">
        <tr><td>${esc(t("stats.mqtt.status"))}</td><td><span class="dot ${dot}"></span>${esc(t(m.connected ? "stats.mqtt.connected" : "stats.mqtt.disconnected"))}</td></tr>
        <tr><td>${esc(t("stats.mqtt.broker"))}</td><td><code>${esc(m.broker)}</code></td></tr>
        <tr><td>${esc(t("stats.mqtt.topicPrefix"))}</td><td><code>${esc(m.prefix)}</code> → <code>${esc(m.prefix)}/state</code>, <code>${esc(m.prefix)}/status</code></td></tr>
        <tr><td>${esc(t("stats.mqtt.interval"))}</td><td>${esc(t("stats.mqtt.seconds", { count: m.intervalS }))}</td></tr>
        <tr><td>${esc(t("stats.mqtt.lastPublish"))}</td><td>${esc(fmtWhen(m.lastPublish))}</td></tr>
        <tr><td>${esc(t("stats.mqtt.discoverySent"))}</td><td>${esc(t(m.discoverySent ? "stats.mqtt.yes" : "stats.mqtt.no"))}</td></tr>
        ${m.lastError ? `<tr><td>${esc(t("stats.mqtt.lastError"))}</td><td class="bad">${esc(m.lastError)}</td></tr>` : ""}
      </table>
      <p class="sub" id="mqtt-msg"></p>
    </div>`;
}

export async function render(el) {
  root = el;
  root.innerHTML = `<div class="empty">${esc(t("stats.counting"))}</div>`;

  const [u, m] = await Promise.all([
    fetch("/api/usage").then((r) => r.json()),
    fetch("/api/mqtt").then((r) => r.json()).catch(() => ({ configured: false })),
  ]);

  const clients = u.byClient;
  const busiest = clients[0];

  root.innerHTML = `
    <div class="kpis">
      ${kpi(t("stats.kpi.memoriesTotal"), u.memories.total)}
      ${kpi(t("stats.kpi.newThisYear"), u.memories.year, t("stats.kpi.thisMonth", { count: u.memories.month }))}
      ${kpi(t("stats.kpi.newToday"), u.memories.today, t("stats.kpi.thisWeek", { count: u.memories.week }))}
      ${kpi(t("stats.kpi.callsToday"), u.calls.today, t("stats.kpi.thisWeek", { count: u.calls.week }))}
      ${kpi(t("stats.kpi.callsThisYear"), u.calls.year, t("stats.kpi.callsTotal", { count: u.calls.total }))}
      ${kpi(t("stats.kpi.busiestClient"), busiest ? busiest.client : t("common.none"), busiest ? t("stats.kpi.calls", { count: busiest.calls }) : "")}
    </div>

    <div class="card">
      <h3>${esc(t("stats.chart.callsPerDay"))} <span class="sub">${esc(t("stats.chart.lastDays", { count: DAYS }))}</span></h3>
      ${chart(denseDays(u.daily, DAYS), {
        keys: ["reads", "writes", "deletes"],
        colors: ["var(--accent)", "var(--ok)", "var(--danger)"],
        labels: [t("stats.chart.reads"), t("stats.chart.writes"), t("stats.chart.deletes")],
      })}
    </div>

    <div class="card">
      <h3>${esc(t("stats.chart.newMemoriesPerDay"))} <span class="sub">${esc(t("stats.chart.lastDays", { count: DAYS }))}</span></h3>
      ${chart(denseDays(u.memoryDaily, DAYS), { keys: ["count"], colors: ["var(--warn)"], labels: [t("stats.chart.memories")] })}
    </div>

    <div class="card">
      <h3>${esc(t("stats.chart.perMonth"))} <span class="sub">${esc(t("stats.chart.lastMonths", { count: MONTHS }))}</span></h3>
      <div class="two">
        <div>
          <div class="sub" style="margin-bottom:6px">${esc(t("stats.chart.calls"))}</div>
          ${chart(denseMonths(u.monthly, MONTHS), {
            keys: ["reads", "writes", "deletes"],
            colors: ["var(--accent)", "var(--ok)", "var(--danger)"],
            labels: [t("stats.chart.reads"), t("stats.chart.writes"), t("stats.chart.deletes")],
            height: 90,
          })}
        </div>
        <div>
          <div class="sub" style="margin-bottom:6px">${esc(t("stats.chart.newMemories"))}</div>
          ${chart(denseMonths(u.memoryMonthly, MONTHS), { keys: ["count"], colors: ["var(--warn)"], labels: [t("stats.chart.memories")], height: 90 })}
        </div>
      </div>
    </div>

    <div class="card">
      <h3>${esc(t("stats.clients.title"))}</h3>
      <p class="sub">${t("stats.clients.description")}</p>
      ${clients.length ? `<table class="grid">
        <tr><th>${esc(t("stats.clients.client"))}</th><th>${esc(t("stats.clients.calls"))}</th><th>${esc(t("stats.clients.reads"))}</th><th>${esc(t("stats.clients.writes"))}</th><th>${esc(t("stats.clients.deletes"))}</th><th>${esc(t("stats.clients.errors"))}</th><th>${esc(t("stats.clients.last"))}</th></tr>
        ${clients.map((c) => `<tr>
          <td><b>${esc(c.client)}</b>${c.version ? ` <span class="sub">${esc(c.version)}</span>` : ""}</td>
          <td>${c.calls}</td><td>${c.reads}</td><td>${c.writes}</td><td>${c.deletes}</td>
          <td class="${c.errors ? "bad" : "sub"}">${c.errors}</td>
          <td class="sub">${esc(fmtWhen(c.last))}</td>
        </tr>`).join("")}
      </table>` : `<div class="empty">${esc(t("stats.clients.empty"))}</div>`}
    </div>

    <div class="card">
      <h3>${esc(t("stats.tools.title"))}</h3>
      ${u.byTool.length ? `<table class="grid">
        <tr><th>${esc(t("stats.tools.tool"))}</th><th>${esc(t("stats.tools.calls"))}</th><th>${esc(t("stats.tools.average"))}</th></tr>
        ${u.byTool.map((t) => `<tr><td><code>${esc(t.tool)}</code></td><td>${t.calls}</td>
          <td class="sub">${t.avg_ms == null ? "–" : `${t.avg_ms} ms`}</td></tr>`).join("")}
      </table>` : `<div class="empty">${esc(t("stats.clients.empty"))}</div>`}
    </div>

    ${mqttCard(m)}

    <p class="sub">${t("stats.footer", { timezone: esc(u.tz), days: u.retentionDays })}</p>`;

  const now = root.querySelector("#mqtt-now");
  if (now) now.onclick = async () => {
    now.disabled = true;
    const r = await fetch("/api/mqtt/publish", { method: "POST" }).then((x) => x.json()).catch(() => ({}));
    root.querySelector("#mqtt-msg").textContent = r.published
      ? t("stats.mqtt.published", { when: fmtWhen(r.lastPublish) })
      : t("stats.mqtt.publishFailed");
    now.disabled = false;
  };
}
