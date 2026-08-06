// The "Statistics" view. Charts are hand-rolled SVG on purpose: the whole UI is
// one dependency-free page served off the box itself, and a bar chart is not
// worth breaking that for.
//
// Note what the numbers can honestly say. MCP tells the server which *client
// application* is calling - Claude Code, Codex, a ChatGPT connector - and never
// which model is answering inside it. "Top client" therefore means the app, not
// the model. Through the proxy the page only ever counts traffic that arrived on
// the open listener, so it cannot reveal that vault traffic exists.

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const fmtDate = (d) => new Date(d).toLocaleDateString("sv-SE");
const fmtWhen = (d) => (d ? new Date(d).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" }) : "–");

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
    return '<div class="empty">Ingen aktivitet i perioden.</div>';

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
      <span>max ${max}</span>
      <span>${esc(fmtDate(last))}</span>
    </div>`;
}

function mqttCard(m) {
  if (!m.configured) return `
    <div class="card">
      <h3>MQTT till Home Assistant</h3>
      <p class="sub">Inte konfigurerat. Sätt <code>MQTT_URL</code> (och vid behov
      <code>MQTT_USERNAME</code> / <code>MQTT_PASSWORD</code>) i <code>.env</code>
      på servern och starta om, så börjar hjärnan publicera sina livstecken och
      räknare. Se README för vilka sensorer som dyker upp i HA.</p>
    </div>`;

  const dot = m.connected ? "ok" : "danger";
  return `
    <div class="card">
      <div class="snip-head" style="margin-bottom:10px">
        <h3 style="margin:0">MQTT till Home Assistant</h3>
        <button class="ghost small" id="mqtt-now">Publicera nu</button>
      </div>
      <table class="grid">
        <tr><td>Status</td><td><span class="dot ${dot}"></span>${m.connected ? "ansluten" : "inte ansluten"}</td></tr>
        <tr><td>Broker</td><td><code>${esc(m.broker)}</code></td></tr>
        <tr><td>Topic-prefix</td><td><code>${esc(m.prefix)}</code> → <code>${esc(m.prefix)}/state</code>, <code>${esc(m.prefix)}/status</code></td></tr>
        <tr><td>Intervall</td><td>${esc(m.intervalS)} s</td></tr>
        <tr><td>Senaste publicering</td><td>${esc(fmtWhen(m.lastPublish))}</td></tr>
        <tr><td>Discovery skickad</td><td>${m.discoverySent ? "ja" : "nej"}</td></tr>
        ${m.lastError ? `<tr><td>Senaste fel</td><td class="bad">${esc(m.lastError)}</td></tr>` : ""}
      </table>
      <p class="sub" id="mqtt-msg"></p>
    </div>`;
}

export async function render(el) {
  root = el;
  root.innerHTML = '<div class="empty">Räknar …</div>';

  const [u, m] = await Promise.all([
    fetch("/api/usage").then((r) => r.json()),
    fetch("/api/mqtt").then((r) => r.json()).catch(() => ({ configured: false })),
  ]);

  const clients = u.byClient;
  const busiest = clients[0];

  root.innerHTML = `
    <div class="kpis">
      ${kpi("minnen totalt", u.memories.total)}
      ${kpi("nya i år", u.memories.year, `${u.memories.month} den här månaden`)}
      ${kpi("nya i dag", u.memories.today, `${u.memories.week} den här veckan`)}
      ${kpi("anrop i dag", u.calls.today, `${u.calls.week} den här veckan`)}
      ${kpi("anrop i år", u.calls.year, `${u.calls.total} totalt`)}
      ${kpi("flitigaste klienten", busiest ? busiest.client : "–", busiest ? `${busiest.calls} anrop` : "")}
    </div>

    <div class="card">
      <h3>Anrop per dag <span class="sub">senaste ${DAYS} dagarna</span></h3>
      ${chart(denseDays(u.daily, DAYS), {
        keys: ["reads", "writes", "deletes"],
        colors: ["var(--accent)", "var(--ok)", "var(--danger)"],
        labels: ["läsningar", "skrivningar", "raderingar"],
      })}
    </div>

    <div class="card">
      <h3>Nya minnen per dag <span class="sub">senaste ${DAYS} dagarna</span></h3>
      ${chart(denseDays(u.memoryDaily, DAYS), { keys: ["count"], colors: ["var(--warn)"], labels: ["minnen"] })}
    </div>

    <div class="card">
      <h3>Per månad <span class="sub">senaste ${MONTHS} månaderna</span></h3>
      <div class="two">
        <div>
          <div class="sub" style="margin-bottom:6px">Anrop</div>
          ${chart(denseMonths(u.monthly, MONTHS), {
            keys: ["reads", "writes", "deletes"],
            colors: ["var(--accent)", "var(--ok)", "var(--danger)"],
            labels: ["läsningar", "skrivningar", "raderingar"],
            height: 90,
          })}
        </div>
        <div>
          <div class="sub" style="margin-bottom:6px">Nya minnen</div>
          ${chart(denseMonths(u.memoryMonthly, MONTHS), { keys: ["count"], colors: ["var(--warn)"], labels: ["minnen"], height: 90 })}
        </div>
      </div>
    </div>

    <div class="card">
      <h3>Vilka klienter läser och skriver</h3>
      <p class="sub">MCP uppger <i>klientappen</i>, aldrig vilken modell som svarar
      inuti den — den uppgiften finns helt enkelt inte på tråden. Saknar en klient
      namn i handskakningen används dess user agent i stället.</p>
      ${clients.length ? `<table class="grid">
        <tr><th>Klient</th><th>Anrop</th><th>Läser</th><th>Skriver</th><th>Raderar</th><th>Fel</th><th>Senast</th></tr>
        ${clients.map((c) => `<tr>
          <td><b>${esc(c.client)}</b>${c.version ? ` <span class="sub">${esc(c.version)}</span>` : ""}</td>
          <td>${c.calls}</td><td>${c.reads}</td><td>${c.writes}</td><td>${c.deletes}</td>
          <td class="${c.errors ? "bad" : "sub"}">${c.errors}</td>
          <td class="sub">${esc(fmtWhen(c.last))}</td>
        </tr>`).join("")}
      </table>` : '<div class="empty">Ingen trafik loggad än.</div>'}
    </div>

    <div class="card">
      <h3>Per verktyg</h3>
      ${u.byTool.length ? `<table class="grid">
        <tr><th>Verktyg</th><th>Anrop</th><th>Snitt</th></tr>
        ${u.byTool.map((t) => `<tr><td><code>${esc(t.tool)}</code></td><td>${t.calls}</td>
          <td class="sub">${t.avg_ms == null ? "–" : `${t.avg_ms} ms`}</td></tr>`).join("")}
      </table>` : '<div class="empty">Ingen trafik loggad än.</div>'}
    </div>

    ${mqttCard(m)}

    <p class="sub">Tidszon för dygns- och månadsbrytet: <code>${esc(u.tz)}</code>.
    Användningsloggen sparas i ${u.retentionDays} dagar och innehåller aldrig
    sökfrågor eller innehåll — bara vem som anropade vad, och hur det gick.</p>`;

  const now = root.querySelector("#mqtt-now");
  if (now) now.onclick = async () => {
    now.disabled = true;
    const r = await fetch("/api/mqtt/publish", { method: "POST" }).then((x) => x.json()).catch(() => ({}));
    root.querySelector("#mqtt-msg").textContent = r.published
      ? `Publicerat ${fmtWhen(r.lastPublish)}.`
      : "Kunde inte publicera — brokern är inte ansluten.";
    now.disabled = false;
  };
}
