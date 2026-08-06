// The "Connect" view: every client's setup, filled in with this instance's own
// addresses and keys instead of the placeholders a document is stuck with.
//
// Keys are masked until asked for, and the vault key is simply not sent here
// when the page is served through the proxy - see connectInfo() in index.mjs.

import { t } from "./i18n.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let cfg = null;
let reveal = false;
let root = null;

const MASK = "••••••••••••••••";

// Two forms of every snippet: what is shown, and what the copy button puts on
// the clipboard. Only the shown one is masked - copying a row of bullets would
// be a joke that stops being funny the second time.
function keys() {
  const access = cfg.accessKey || "<MCP_ACCESS_KEY>";
  const open = cfg.openKey || "<MCP_OPEN_KEY>";
  return {
    accessReal: access,
    openReal: open,
    access: cfg.accessKey && !reveal ? MASK : access,
    open: cfg.openKey && !reveal ? MASK : open,
  };
}

function block(title, snippet, { lang = "", note = "" } = {}) {
  const k = keys();
  const shown = snippet(k.access, k.open);
  const real = snippet(k.accessReal, k.openReal);
  return `
    <div class="snip">
      <div class="snip-head">
        <span>${esc(title)}</span>
        <button class="ghost small copy" data-copy="${esc(real)}">${esc(t("common.copy"))}</button>
      </div>
      <pre class="${esc(lang)}"><code>${esc(shown)}</code></pre>
      ${note ? `<div class="sub snip-note">${note}</div>` : ""}
    </div>`;
}

function addresses() {
  const lan = cfg.lanUrl;
  const pub = cfg.publicUrl;
  const listener = t(cfg.listener === "full"
    ? "connect.addresses.fullListener"
    : "connect.addresses.openListener");
  return `
    <div class="card">
      <h3>${esc(t("connect.addresses.title"))}</h3>
      <p class="sub">${t("connect.addresses.description")}</p>
      <table class="grid">
        <tr><th>${esc(t("connect.addresses.address"))}</th><th>${esc(t("connect.addresses.content"))}</th><th>${esc(t("connect.addresses.when"))}</th></tr>
        <tr>
          <td>${lan
            ? `<code>${esc(lan)}/mcp</code>`
            : `<span class="sub">${esc(t("connect.addresses.unknownLan"))}</span>`}</td>
          <td><span class="tag vault">${esc(t("connect.addresses.openAndVault"))}</span></td>
          <td>${esc(t("connect.addresses.lanWhen"))}</td>
        </tr>
        <tr>
          <td>${pub ? `<code>${esc(pub)}/mcp</code>` : `<span class="sub">${esc(t("connect.addresses.noPublic"))}</span>`}</td>
          <td><span class="tag">${esc(t("connect.addresses.openOnly"))}</span></td>
          <td>${esc(t("connect.addresses.publicWhen"))}</td>
        </tr>
      </table>
      <p class="sub">${t("connect.addresses.viewing", { listener: esc(listener), version: esc(cfg.version) })}</p>
    </div>`;
}

function keyCard() {
  const k = keys();
  const vaultKeyHere = Boolean(cfg.accessKey);
  return `
    <div class="card">
      <div class="snip-head" style="margin-bottom:10px">
        <h3 style="margin:0">${esc(t("connect.keyCard.title"))}</h3>
        <button class="ghost small" id="reveal">${esc(t(reveal ? "common.hide" : "common.show"))} ${esc(t("common.keys"))}</button>
      </div>
      <table class="grid">
        <tr><th>${esc(t("connect.keyCard.key"))}</th><th>${esc(t("connect.keyCard.value"))}</th><th>${esc(t("connect.keyCard.opens"))}</th></tr>
        <tr>
          <td><code>MCP_ACCESS_KEY</code></td>
          <td>${vaultKeyHere
            ? `<code class="keyval">${esc(k.access)}</code> <button class="ghost small copy" data-copy="${esc(k.accessReal)}">${esc(t("common.copy"))}</button>`
            : `<span class="sub">${esc(t("connect.keyCard.notShown"))}</span>`}</td>
          <td>${esc(t("connect.keyCard.everything"))}</td>
        </tr>
        <tr>
          <td><code>MCP_OPEN_KEY</code></td>
          <td>${cfg.hasOpenKey
            ? `<code class="keyval">${esc(k.open)}</code> <button class="ghost small copy" data-copy="${esc(k.openReal)}">${esc(t("common.copy"))}</button>`
            : `<span class="sub">${t("connect.keyCard.notSet")}</span>`}</td>
          <td>${t("connect.keyCard.openUrlOnly")}</td>
        </tr>
      </table>
      ${vaultKeyHere ? "" : `
        <p class="sub">${t("connect.keyCard.remoteWarning")}</p>
        ${block(t("connect.keyCard.retrieve"), () =>
          `ssh valv 'grep ^MCP_ACCESS_KEY= ~/mimers-brain/.env | cut -d= -f2'`)}`}
    </div>`;
}

function clientCards() {
  const lan = cfg.lanUrl || "http://<LAN-IP>:8790";
  const pub = cfg.publicUrl || t("connect.addresses.publicPlaceholder");
  const cards = [];

  cards.push(`
    <div class="card">
      <h3>${esc(t("connect.claudeCode.title"))}</h3>
      <p class="sub">${t("connect.claudeCode.description")}</p>
      ${block(t("connect.claudeCode.vault"), (a) =>
        `claude mcp add --transport http mimers-brain ${lan}/mcp --header "Authorization: Bearer ${a}"`)}
      ${block(t("connect.claudeCode.open"), (a) =>
        `claude mcp add --transport http mimers-brain-remote ${pub}/mcp --header "Authorization: Bearer ${a}"`)}
      ${block(t("connect.claudeCode.json"), (a) => JSON.stringify({
        "mimers-brain": { type: "http", url: `${lan}/mcp`, headers: { Authorization: `Bearer ${a}` } },
        "mimers-brain-remote": { type: "http", url: `${pub}/mcp`, headers: { Authorization: `Bearer ${a}` } },
      }, null, 2), { lang: "json" })}
    </div>`);

  cards.push(`
    <div class="card">
      <h3>${esc(t("connect.codex.title"))}</h3>
      <p class="sub">${t("connect.codex.description")}</p>
      ${block(t("connect.codex.environment"), () =>
        `codex mcp add mimers-brain --url ${lan}/mcp --bearer-token-env-var MIMERS_VALV_KEY`,
        { note: t("connect.codex.note") })}
    </div>`);

  if (cfg.hasOpenKey) cards.push(`
    <div class="card">
      <h3>${esc(t("connect.claudeDesktop.title"))}</h3>
      <p class="sub">${t("connect.claudeDesktop.description")}</p>
      ${block(t("connect.claudeDesktop.settings"), (a, o) => `${pub}/mcp?key=${o}`,
        { note: t("connect.claudeDesktop.oauthNote") })}
      ${block(t("connect.claudeDesktop.checkProxy"), () =>
        `curl -s -o /dev/null -w '%{http_code}\\n' ${pub}/.well-known/oauth-authorization-server`,
        { note: t("connect.claudeDesktop.responseNote") })}
    </div>`);

  cards.push(`
    <div class="card">
      <h3>${esc(t("connect.openWebui.title"))}</h3>
      <p class="sub">${t("connect.openWebui.description")}</p>
      ${block(t("connect.openWebui.config"), (a) => JSON.stringify({
        mcpServers: {
          "mimers-brain": {
            type: "streamable-http",
            url: `${pub}/mcp`,
            headers: { Authorization: `Bearer ${a}` },
          },
        },
      }, null, 2), { lang: "json" })}
      ${block(t("connect.openWebui.start"), () => `uvx mcpo --port 8000 --config config.json`,
        { note: t("connect.openWebui.note") })}
    </div>`);

  cards.push(`
    <div class="card">
      <h3>${esc(t("connect.otherClients.title"))}</h3>
      <p class="sub">${t("connect.otherClients.description")}</p>
      ${block(t("connect.otherClients.address"), () => `${pub}/mcp`)}
      ${block(t("connect.otherClients.header"), (a) => `Authorization: Bearer ${a}`)}
    </div>`);

  cards.push(`
    <div class="card">
      <h3>${esc(t("connect.remoteVault.title"))}</h3>
      <p class="sub">${t("connect.remoteVault.description")}</p>
      ${block(t("connect.remoteVault.config"), (a) => JSON.stringify({
        mcpServers: {
          "mimers-brain": {
            command: "npx",
            args: ["-y", "mcp-remote", `${lan}/mcp`, "--header", `Authorization: Bearer ${a}`],
          },
        },
      }, null, 2), { lang: "json" })}
    </div>`);

  cards.push(`
    <div class="card">
      <h3>${esc(t("connect.verify.title"))}</h3>
      ${block(t("connect.verify.listTools"), (a) =>
        `curl -s -X POST ${pub}/mcp -H "Authorization: Bearer ${a}" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'`,
        { note: t("connect.verify.note", { count: cfg.tools.length }) })}
      <table class="grid" style="margin-top:12px">
        <tr><th>${esc(t("connect.verify.tool"))}</th><th>${esc(t("connect.verify.purpose"))}</th></tr>
        ${cfg.tools.map((tool) => {
          const key = `connect.toolDescriptions.${tool.name}`;
          const description = t(key);
          return `<tr><td><code>${esc(tool.name)}</code></td><td class="sub">${esc(description === key ? tool.what : description)}</td></tr>`;
        }).join("")}
      </table>
    </div>`);

  return cards.join("");
}

function draw() {
  root.innerHTML = addresses() + keyCard() + clientCards();

  root.querySelector("#reveal").onclick = () => { reveal = !reveal; draw(); };

  for (const b of root.querySelectorAll(".copy")) {
    b.onclick = async () => {
      const was = b.textContent;
      b.textContent = (await copy(b.dataset.copy)) ? t("common.copied") : t("common.copyManual");
      setTimeout(() => { b.textContent = was; }, 1400);
    };
  }
}

// The LAN listener is plain http, which is not a secure context - so
// navigator.clipboard does not exist there at all, and the whole point of this
// page is the LAN listener. The deprecated execCommand path is the one that
// actually runs at home.
async function copy(value) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export async function render(el) {
  root = el;
  root.innerHTML = `<div class="empty">${esc(t("connect.loading"))}</div>`;
  const r = await fetch("/api/connect");
  if (!r.ok) {
    root.innerHTML = `<div class="err">${esc(t("connect.fetchError"))}</div>`;
    return;
  }
  cfg = await r.json();
  draw();
}
