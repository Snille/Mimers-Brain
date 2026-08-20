// Statistics v2: health and usefulness first, raw activity second. Everything
// here is aggregate data. Recall queries, answers and memory content never enter
// either statistics endpoint.

import { currentLanguage, formatDate, formatDateTime, t } from "./i18n.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtDate = (d) => formatDate(d);
const fmtWhen = (d) => formatDateTime(d);
const DAYS = 60;
const MONTHS = 12;
const EMPTY = {
  calls: 0, reads: 0, writes: 0, deletes: 0, count: 0,
  active: 0, inactive: 0, reported: 0, unreported: 0, used: 0, unused: 0,
};
const key = (v) => String(v).slice(0, 10);

let root = null;

function denseDays(rows, days) {
  const have = new Map(rows.map((r) => [key(r.bucket), r]));
  const now = new Date();
  const base = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Array.from({ length: days }, (_, index) => {
    const d = new Date(base - (days - 1 - index) * 86400000).toISOString().slice(0, 10);
    return have.get(d) || { ...EMPTY, bucket: d };
  });
}

function denseMonths(rows, months) {
  const have = new Map(rows.map((r) => [key(r.bucket).slice(0, 7), r]));
  const now = new Date();
  return Array.from({ length: months }, (_, index) => {
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth() - (months - 1 - index), 1));
    const month = d.toISOString().slice(0, 7);
    return have.get(month) || { ...EMPTY, bucket: `${month}-01` };
  });
}

function fmtPercent(value) {
  return value == null ? "–" : `${Number(value).toLocaleString(currentLanguage(), { maximumFractionDigits: 1 })}%`;
}

function fmtAge(value) {
  if (!value) return t("common.none");
  const hours = Math.max(0, (Date.now() - new Date(value).getTime()) / 3600000);
  if (hours < 24) return t("stats.age.hours", { count: Math.max(1, Math.floor(hours)) });
  const days = Math.floor(hours / 24);
  if (days < 31) return t(days === 1 ? "stats.age.day" : "stats.age.days", { count: days });
  const months = Math.floor(days / 30);
  return t(months === 1 ? "stats.age.month" : "stats.age.months", { count: months });
}

function kpi(label, value, sub = "", tone = "") {
  return `<div class="kpi ${tone}"><div class="kpi-v">${esc(value)}</div>
    <div class="kpi-l">${esc(label)}</div>
    ${sub ? `<div class="kpi-s">${esc(sub)}</div>` : ""}</div>`;
}

function sectionHead(title, description) {
  return `<div class="stats-section-head"><h2>${esc(title)}</h2><p class="sub">${esc(description)}</p></div>`;
}

function translatedValue(value) {
  const path = `stats.values.${value}`;
  const translated = t(path);
  return translated === path ? String(value).replaceAll("_", " ") : translated;
}

function breakdown(title, values, preferred = []) {
  const source = values || {};
  const keys = [...new Set([...preferred, ...Object.keys(source)])];
  const rows = keys.map((name) => [name, Number(source[name] || 0)])
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...rows.map(([, count]) => count));
  return `<div class="card"><h3>${esc(title)}</h3>${rows.length ? rows.map(([name, count]) => `
    <div class="breakdown-row">
      <div class="breakdown-label"><span>${esc(translatedValue(name))}</span><b>${count}</b></div>
      <div class="breakdown-meter"><i style="width:${Math.max(2, count / max * 100)}%"></i></div>
    </div>`).join("") : `<div class="empty">${esc(t("stats.noData"))}</div>`}</div>`;
}

// Stacked bars only compare disjoint categories: read/write/delete, current vs
// inactive records, reported vs unreported traces, and used vs unused results.
function chart(rows, { keys, colors, labels, height = 130 }) {
  const totals = rows.map((r) => keys.reduce((sum, name) => sum + Number(r[name] || 0), 0));
  if (!rows.length || !totals.some(Boolean))
    return `<div class="empty">${esc(t("stats.chart.noActivity"))}</div>`;

  const width = rows.length * 14;
  const max = Math.max(1, ...totals);
  const barWidth = width / rows.length;
  const bars = rows.map((row, index) => {
    const x = index * barWidth;
    let y = height;
    const segments = keys.map((name, colorIndex) => {
      const value = Number(row[name] || 0);
      if (!value) return "";
      const segmentHeight = value / max * (height - 4);
      y -= segmentHeight;
      return `<rect x="${x + barWidth * .15}" y="${y}" width="${barWidth * .7}" height="${segmentHeight}" fill="${colors[colorIndex]}" />`;
    }).join("");
    const detail = keys.map((name, i) => `${labels[i]} ${Number(row[name] || 0)}`).join(", ");
    return `<g><title>${esc(fmtDate(row.bucket))}: ${esc(detail)}</title>${segments}</g>`;
  }).join("");

  return `<svg class="chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img">
      <line x1="0" y1="${height - .5}" x2="${width}" y2="${height - .5}" stroke="var(--line)" stroke-width="1" vector-effect="non-scaling-stroke" />
      ${bars}
    </svg>
    <div class="chart-axis sub">
      <span>${esc(fmtDate(rows[0]?.bucket))}</span>
      <span class="legend">${keys.map((name, i) =>
        `<i style="background:${colors[i]}"></i>${esc(labels[i])}`).join("")}</span>
      <span>${esc(t("stats.chart.max", { count: max }))}</span>
      <span>${esc(fmtDate(rows.at(-1)?.bucket))}</span>
    </div>`;
}

function mqttCard(mqtt) {
  if (!mqtt.configured) return `<div class="card"><h3>${esc(t("stats.mqtt.title"))}</h3>
    <p class="sub">${t("stats.mqtt.notConfigured")}</p></div>`;
  const dot = mqtt.connected ? "ok" : "danger";
  return `<div class="card">
    <div class="snip-head" style="margin-bottom:10px">
      <h3 style="margin:0">${esc(t("stats.mqtt.title"))}</h3>
      <button class="ghost small" id="mqtt-now">${esc(t("stats.mqtt.publishNow"))}</button>
    </div>
    <table class="grid">
      <tr><td>${esc(t("stats.mqtt.status"))}</td><td><span class="dot ${dot}"></span>${esc(t(mqtt.connected ? "stats.mqtt.connected" : "stats.mqtt.disconnected"))}</td></tr>
      <tr><td>${esc(t("stats.mqtt.broker"))}</td><td><code>${esc(mqtt.broker)}</code></td></tr>
      <tr><td>${esc(t("stats.mqtt.topicPrefix"))}</td><td><code>${esc(mqtt.prefix)}</code> → <code>${esc(mqtt.prefix)}/state</code>, <code>${esc(mqtt.prefix)}/status</code></td></tr>
      <tr><td>${esc(t("stats.mqtt.interval"))}</td><td>${esc(t("stats.mqtt.seconds", { count: mqtt.intervalS }))}</td></tr>
      <tr><td>${esc(t("stats.mqtt.lastPublish"))}</td><td>${esc(fmtWhen(mqtt.lastPublish))}</td></tr>
      <tr><td>${esc(t("stats.mqtt.discoverySent"))}</td><td>${esc(t(mqtt.discoverySent ? "stats.mqtt.yes" : "stats.mqtt.no"))}</td></tr>
      ${mqtt.lastError ? `<tr><td>${esc(t("stats.mqtt.lastError"))}</td><td class="bad">${esc(mqtt.lastError)}</td></tr>` : ""}
    </table><p class="sub" id="mqtt-msg"></p></div>`;
}

function recallClientTable(recall) {
  if (!recall.byClient.length) return `<div class="empty">${esc(t("stats.recall.empty"))}</div>`;
  return `<table class="grid"><tr>
    <th>${esc(t("stats.recall.client"))}</th><th>${esc(t("stats.recall.searches"))}</th>
    <th>${esc(t("stats.recall.receipts"))}</th><th>${esc(t("stats.recall.coverage"))}</th>
    <th>${esc(t("stats.recall.used"))}</th><th>${esc(t("stats.recall.useRate"))}</th>
    <th>${esc(t("stats.recall.overdue"))}</th><th>${esc(t("stats.recall.last"))}</th></tr>
    ${recall.byClient.map((client) => `<tr>
      <td><b>${esc(client.client)}</b>${client.version ? ` <span class="sub">${esc(client.version)}</span>` : ""}</td>
      <td>${client.searches}</td><td>${client.reports}</td><td>${esc(fmtPercent(client.reportingPercent))}</td>
      <td>${client.used}/${client.reportedReturned}</td><td>${esc(fmtPercent(client.usePercent))}</td>
      <td class="${client.overdue ? "bad" : "sub"}">${client.overdue}</td><td class="sub">${esc(fmtWhen(client.last))}</td>
    </tr>`).join("")}</table>`;
}

export async function render(element) {
  root = element;
  root.innerHTML = `<div class="empty">${esc(t("stats.counting"))}</div>`;
  const [usage, mqtt] = await Promise.all([
    fetch("/api/usage").then((response) => response.json()),
    fetch("/api/mqtt").then((response) => response.json()).catch(() => ({ configured: false })),
  ]);
  const health = usage.memoryHealth;
  const recall = usage.recall;
  const busiest = usage.byClient[0];
  const pendingTone = health.pendingReview ? "attention" : "good";
  const embeddingTone = health.unembedded || health.incomplete ? "attention" : "good";
  const overdueTone = recall.overdue ? "danger" : "good";

  root.innerHTML = `
  <section class="stats-section">
    ${sectionHead(t("stats.sections.health.title"), t("stats.sections.health.description"))}
    <div class="kpis">
      ${kpi(t("stats.kpi.activeMemories"), health.active,
        t("stats.kpi.recordsTotal", { count: health.records }), "good")}
      ${kpi(t("stats.kpi.pendingReview"), health.pendingReview,
        health.oldestPending ? t("stats.kpi.oldestPending", { age: fmtAge(health.oldestPending) }) : t("stats.kpi.queueClear"), pendingTone)}
      ${kpi(t("stats.kpi.unembedded"), health.unembedded,
        t("stats.kpi.incomplete", { count: health.incomplete }), embeddingTone)}
      ${kpi(t("stats.kpi.receiptCoverage"), fmtPercent(recall.reportingPercent),
        t("stats.kpi.receiptsOfSearches", { reports: recall.reports, searches: recall.searches }), recall.overdue ? "attention" : "good")}
      ${kpi(t("stats.kpi.useRate"), fmtPercent(recall.usePercent),
        t("stats.kpi.usedOfReturned", { used: recall.used, returned: recall.reportedReturned }))}
      ${kpi(t("stats.kpi.overdueReceipts"), recall.overdue,
        recall.overdue ? t("stats.kpi.needsClientAttention") : t("stats.kpi.noneOverdue"), overdueTone)}
    </div>

    <div class="three">
      ${breakdown(t("stats.breakdowns.reviewStatus"), health.reviewStatuses,
        ["confirmed", "pending", "evidence_only", "restricted", "stale", "rejected"])}
      ${breakdown(t("stats.breakdowns.lifecycle"), health.lifecycles,
        ["current", "superseded", "archived"])}
      <div class="card"><h3>${esc(t("stats.health.auditTitle"))}</h3><table class="grid">
        <tr><td>${esc(t("stats.health.archivedSources"))}</td><td><b>${health.archivedSources}</b></td></tr>
        <tr><td>${esc(t("stats.health.reviewsWeek"))}</td><td><b>${health.reviewsWeek}</b></td></tr>
        <tr><td>${esc(t("stats.health.reviewsTotal"))}</td><td><b>${health.reviewsTotal}</b></td></tr>
        <tr><td>${esc(t("stats.health.duplicateDecisions"))}</td><td><b>${health.duplicateDecisions}</b></td></tr>
        <tr><td>${esc(t("stats.health.superseded"))}</td><td><b>${health.superseded}</b></td></tr>
      </table></div>
    </div>
    <div class="three">
      ${breakdown(t("stats.breakdowns.origin"), health.origins)}
      ${breakdown(t("stats.breakdowns.provenance"), health.provenance)}
      ${breakdown(t("stats.breakdowns.kind"), health.kinds)}
    </div>
    ${Object.keys(health.projects || {}).length ? breakdown(t("stats.breakdowns.project"), health.projects) : ""}
  </section>

  <section class="stats-section">
    ${sectionHead(t("stats.sections.recall.title"), t("stats.sections.recall.description"))}
    <div class="two">
      <div class="card"><h3>${esc(t("stats.chart.receiptsPerDay"))} <span class="sub">${esc(t("stats.chart.lastDays", { count: DAYS }))}</span></h3>
        ${chart(denseDays(recall.daily, DAYS), {
          keys: ["reported", "unreported"], colors: ["var(--ok)", "var(--warn)"],
          labels: [t("stats.chart.reported"), t("stats.chart.unreported")],
        })}</div>
      <div class="card"><h3>${esc(t("stats.chart.reportedResultsPerDay"))} <span class="sub">${esc(t("stats.chart.lastDays", { count: DAYS }))}</span></h3>
        ${chart(denseDays(recall.daily, DAYS), {
          keys: ["used", "unused"], colors: ["var(--accent)", "var(--panel-2)"],
          labels: [t("stats.chart.used"), t("stats.chart.unused")],
        })}</div>
    </div>
    <div class="card"><h3>${esc(t("stats.recall.clientsTitle"))}</h3>
      <p class="sub">${esc(t("stats.recall.clientsDescription"))}</p>${recallClientTable(recall)}</div>
    <p class="sub stats-note">${esc(recall.first
      ? t("stats.recall.since", { date: fmtDate(recall.first) })
      : t("stats.recall.noData"))}</p>
  </section>

  <section class="stats-section">
    ${sectionHead(t("stats.sections.activity.title"), t("stats.sections.activity.description"))}
    <div class="kpis">
      ${kpi(t("stats.kpi.callsToday"), usage.calls.today, t("stats.kpi.thisWeek", { count: usage.calls.week }))}
      ${kpi(t("stats.kpi.callsThisYear"), usage.calls.year, t("stats.kpi.callsTotal", { count: usage.calls.total }))}
      ${kpi(t("stats.kpi.busiestClient"), busiest ? busiest.client : t("common.none"),
        busiest ? t("stats.kpi.calls", { count: busiest.calls }) : "")}
    </div>
    <div class="card"><h3>${esc(t("stats.chart.callsPerDay"))} <span class="sub">${esc(t("stats.chart.lastDays", { count: DAYS }))}</span></h3>
      ${chart(denseDays(usage.daily, DAYS), {
        keys: ["reads", "writes", "deletes"],
        colors: ["var(--accent)", "var(--ok)", "var(--danger)"],
        labels: [t("stats.chart.reads"), t("stats.chart.writes"), t("stats.chart.deletes")],
      })}</div>
    <div class="card"><h3>${esc(t("stats.chart.createdRecordsPerDay"))} <span class="sub">${esc(t("stats.chart.lastDays", { count: DAYS }))}</span></h3>
      ${chart(denseDays(usage.memoryDaily, DAYS), {
        keys: ["active", "inactive"], colors: ["var(--accent)", "var(--muted)"],
        labels: [t("stats.chart.activeRecords"), t("stats.chart.inactiveRecords")],
      })}</div>
    <div class="card"><h3>${esc(t("stats.chart.perMonth"))} <span class="sub">${esc(t("stats.chart.lastMonths", { count: MONTHS }))}</span></h3>
      <div class="two"><div><div class="sub" style="margin-bottom:6px">${esc(t("stats.chart.calls"))}</div>
        ${chart(denseMonths(usage.monthly, MONTHS), {
          keys: ["reads", "writes", "deletes"], colors: ["var(--accent)", "var(--ok)", "var(--danger)"],
          labels: [t("stats.chart.reads"), t("stats.chart.writes"), t("stats.chart.deletes")], height: 90,
        })}</div><div><div class="sub" style="margin-bottom:6px">${esc(t("stats.chart.createdRecords"))}</div>
        ${chart(denseMonths(usage.memoryMonthly, MONTHS), {
          keys: ["active", "inactive"], colors: ["var(--accent)", "var(--muted)"],
          labels: [t("stats.chart.activeRecords"), t("stats.chart.inactiveRecords")], height: 90,
        })}</div></div></div>

    <div class="card"><h3>${esc(t("stats.clients.title"))}</h3><p class="sub">${t("stats.clients.description")}</p>
      ${usage.byClient.length ? `<table class="grid"><tr>
        <th>${esc(t("stats.clients.client"))}</th><th>${esc(t("stats.clients.calls"))}</th><th>${esc(t("stats.clients.reads"))}</th>
        <th>${esc(t("stats.clients.writes"))}</th><th>${esc(t("stats.clients.deletes"))}</th><th>${esc(t("stats.clients.errors"))}</th><th>${esc(t("stats.clients.last"))}</th></tr>
        ${usage.byClient.map((client) => `<tr><td><b>${esc(client.client)}</b>${client.version ? ` <span class="sub">${esc(client.version)}</span>` : ""}</td>
          <td>${client.calls}</td><td>${client.reads}</td><td>${client.writes}</td><td>${client.deletes}</td>
          <td class="${client.errors ? "bad" : "sub"}">${client.errors}</td><td class="sub">${esc(fmtWhen(client.last))}</td></tr>`).join("")}
      </table>` : `<div class="empty">${esc(t("stats.clients.empty"))}</div>`}</div>

    <div class="card"><h3>${esc(t("stats.tools.title"))}</h3>
      ${usage.byTool.length ? `<table class="grid"><tr>
        <th>${esc(t("stats.tools.tool"))}</th><th>${esc(t("stats.tools.calls"))}</th><th>${esc(t("stats.tools.errors"))}</th>
        <th>${esc(t("stats.tools.average"))}</th><th>${esc(t("stats.tools.p95"))}</th></tr>
        ${usage.byTool.map((tool) => `<tr><td><code>${esc(tool.tool)}</code></td><td>${tool.calls}</td>
          <td class="${tool.errors ? "bad" : "sub"}">${tool.errors}</td>
          <td class="sub">${tool.avg_ms == null ? "–" : `${tool.avg_ms} ms`}</td>
          <td class="sub">${tool.p95_ms == null ? "–" : `${tool.p95_ms} ms`}</td></tr>`).join("")}</table>`
        : `<div class="empty">${esc(t("stats.clients.empty"))}</div>`}</div>
  </section>

  <section class="stats-section">
    ${sectionHead(t("stats.sections.operations.title"), t("stats.sections.operations.description"))}
    ${mqttCard(mqtt)}
    <p class="sub">${t("stats.footer", { timezone: esc(usage.tz), days: usage.retentionDays })}</p>
    <p class="sub"><label>${esc(t("stats.retention.label"))}
      <select id="retention">${(usage.retentionChoices || [usage.retentionDays]).map((days) =>
        `<option value="${days}"${days === usage.retentionDays ? " selected" : ""}>${
          esc(days ? t("stats.retention.days", { days }) : t("stats.retention.forever"))}</option>`).join("")}</select>
    </label> <span id="retention-msg"></span></p>
  </section>`;

  const retention = root.querySelector("#retention");
  if (retention) retention.onchange = async () => {
    const message = root.querySelector("#retention-msg");
    retention.disabled = true;
    message.textContent = t("common.loading");
    try {
      const result = await fetch("/api/usage/retention", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: Number(retention.value) }),
      }).then((response) => response.json());
      if (result.error) throw new Error(result.error);
      // Re-rendered rather than patched, because the footer sentence, the
      // charts and the receipt counts all move when rows are pruned.
      await render(root);
    } catch (error) {
      message.textContent = error.message;
      retention.disabled = false;
    }
  };

  const publish = root.querySelector("#mqtt-now");
  if (publish) publish.onclick = async () => {
    publish.disabled = true;
    const result = await fetch("/api/mqtt/publish", { method: "POST" }).then((response) => response.json()).catch(() => ({}));
    root.querySelector("#mqtt-msg").textContent = result.published
      ? t("stats.mqtt.published", { when: fmtWhen(result.lastPublish) })
      : t("stats.mqtt.publishFailed");
    publish.disabled = false;
  };
}
