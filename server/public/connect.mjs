// The "Connect" view: every client's setup, filled in with this instance's own
// addresses and keys instead of the placeholders a document is stuck with.
//
// Keys are masked until asked for, and the vault key is simply not sent here
// when the page is served through the proxy - see connectInfo() in index.mjs.

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
        <button class="ghost small copy" data-copy="${esc(real)}">Kopiera</button>
      </div>
      <pre class="${esc(lang)}"><code>${esc(shown)}</code></pre>
      ${note ? `<div class="sub snip-note">${note}</div>` : ""}
    </div>`;
}

function addresses() {
  const lan = cfg.lanUrl;
  const pub = cfg.publicUrl;
  return `
    <div class="card">
      <h3>De två adresserna</h3>
      <p class="sub">Det här är det enda som egentligen spelar roll. Valvet — nycklar,
      lösenord, tokens — serveras bara av den första. Det är inte en inställning
      som går att slå på för den andra: MCP-servern på den öppna porten är byggd
      helt utan förmågan att nå de raderna.</p>
      <table class="grid">
        <tr><th>Adress</th><th>Innehåll</th><th>När</th></tr>
        <tr>
          <td>${lan
            ? `<code>${esc(lan)}/mcp</code>`
            : '<span class="sub">inte känd än — öppna den här sidan en gång på hemnätet, så lär sig servern sin egen adress</span>'}</td>
          <td><span class="tag vault">öppen + valv</span></td>
          <td>på hemnätet eller via VPN</td>
        </tr>
        <tr>
          <td>${pub ? `<code>${esc(pub)}/mcp</code>` : '<span class="sub">ingen publik adress konfigurerad</span>'}</td>
          <td><span class="tag">endast öppen</span></td>
          <td>allt annat, och alla andra modeller</td>
        </tr>
      </table>
      <p class="sub">Du tittar just nu på <b>${cfg.listener === "full" ? "LAN-lyssnaren" : "den öppna lyssnaren"}</b>
      (Mimers Brain ${esc(cfg.version)}).</p>
    </div>`;
}

function keyCard() {
  const k = keys();
  const vaultKeyHere = Boolean(cfg.accessKey);
  return `
    <div class="card">
      <div class="snip-head" style="margin-bottom:10px">
        <h3 style="margin:0">Nycklar</h3>
        <button class="ghost small" id="reveal">${reveal ? "Dölj" : "Visa"} nycklar</button>
      </div>
      <table class="grid">
        <tr><th>Nyckel</th><th>Värde</th><th>Vad den öppnar</th></tr>
        <tr>
          <td><code>MCP_ACCESS_KEY</code></td>
          <td>${vaultKeyHere
            ? `<code class="keyval">${esc(k.access)}</code> <button class="ghost small copy" data-copy="${esc(k.accessReal)}">Kopiera</button>`
            : '<span class="sub">visas inte här</span>'}</td>
          <td>allt, inklusive valvet</td>
        </tr>
        <tr>
          <td><code>MCP_OPEN_KEY</code></td>
          <td>${cfg.hasOpenKey
            ? `<code class="keyval">${esc(k.open)}</code> <button class="ghost small copy" data-copy="${esc(k.openReal)}">Kopiera</button>`
            : '<span class="sub">inte satt — <code>/mcp?key=</code> är avstängt</span>'}</td>
          <td>endast öppen nivå, och bara som <code>?key=</code></td>
        </tr>
      </table>
      ${vaultKeyHere ? "" : `
        <p class="sub">Valvnyckeln visas bara på LAN-adressen. Att skicka ut den
        genom proxyn hade lagt den enda credential som låser upp valvet i
        webbläsarens cache varje gång sidan öppnas. Hämta den på servern:</p>
        ${block("Hämta valvnyckeln", () =>
          `ssh valv 'grep ^MCP_ACCESS_KEY= ~/mimers-brain/.env | cut -d= -f2'`)}`}
    </div>`;
}

function clientCards() {
  const lan = cfg.lanUrl || "http://<LAN-IP>:8790";
  const pub = cfg.publicUrl || "https://<publik-adress>";
  const cards = [];

  cards.push(`
    <div class="card">
      <h3>Claude Code</h3>
      <p class="sub">Registrera gärna <b>båda</b> adresserna som två poster. Minnet
      fungerar då även när laptopen är utanför hemnätet — bara öppen nivå, men
      bättre än ingenting. Ändringen slår igenom i nästa session.</p>
      ${block("Valvet, på hemnätet", (a) =>
        `claude mcp add --transport http mimers-brain ${lan}/mcp --header "Authorization: Bearer ${a}"`)}
      ${block("Öppen nivå, överallt", (a) =>
        `claude mcp add --transport http mimers-brain-remote ${pub}/mcp --header "Authorization: Bearer ${a}"`)}
      ${block("Eller direkt i ~/.claude.json, under mcpServers", (a) => JSON.stringify({
        "mimers-brain": { type: "http", url: `${lan}/mcp`, headers: { Authorization: `Bearer ${a}` } },
        "mimers-brain-remote": { type: "http", url: `${pub}/mcp`, headers: { Authorization: `Bearer ${a}` } },
      }, null, 2), { lang: "json" })}
    </div>`);

  cards.push(`
    <div class="card">
      <h3>VS Code (Codex)</h3>
      <p class="sub">Editorn öppnar anslutningen från din egen maskin, så LAN-adressen
      fungerar och du får hela valvet. Vilken modell som svarar spelar ingen roll
      för <i>åtkomsten</i> — men det spelar roll för <i>innehållet</i>: varje
      valvrad ett verktyg returnerar hamnar i kontexten och skickas vidare till
      modelleverantören i nästa tur. Peka på den publika adressen i stället så
      uppstår aldrig frågan.</p>
      ${block("Nyckeln stannar utanför configfilen", () =>
        `codex mcp add mimers-brain --url ${lan}/mcp --bearer-token-env-var MIMERS_VALV_KEY`,
        { note: "Sätt <code>MIMERS_VALV_KEY</code> som användarvariabel och starta om editorn, annars ärver inte extension-värden den. <code>codex</code>-binären ligger inne i tillägget, inte på PATH." })}
    </div>`);

  if (cfg.hasOpenKey) cards.push(`
    <div class="card">
      <h3>Claude Desktop — chattsidan (connector)</h3>
      <p class="sub">Dialogen tar bara en URL, inget headerfält. Därför rider nyckeln
      i URL:en, och därför är det en <b>annan</b> nyckel: en credential i en URL
      sparas i klientens config och skrivs till proxyns loggar. Den här når bara
      öppen nivå och kan bytas utan att röra någon annan klient.</p>
      ${block("Settings → Connectors → lägg till egen", (a, o) => `${pub}/mcp?key=${o}`,
        { note: "Ligger det en autentiserare framför måste <code>/.well-known/oauth-*</code> svara <b>404</b>, inte 302 till inloggningssidan — annars tror klienten att det finns en OAuth-server och misslyckas med <i>couldn't register with the sign-in service</i> innan URL-nyckeln ens hinner användas." })}
      ${block("Kontrollera att proxyn svarar rätt", () =>
        `curl -s -o /dev/null -w '%{http_code}\\n' ${pub}/.well-known/oauth-authorization-server`,
        { note: "404 är rätt svar." })}
    </div>`);

  cards.push(`
    <div class="card">
      <h3>Open WebUI</h3>
      <p class="sub">Open WebUI pratar OpenAPI-verktygsservrar. Den beprövade vägen är
      <code>mcpo</code>, som lägger en OpenAPI-fasad framför MCP-servern. Kör den
      på maskinen där Open WebUI står och peka gränssnittet dit.</p>
      ${block("config.json till mcpo", (a) => JSON.stringify({
        mcpServers: {
          "mimers-brain": {
            type: "streamable-http",
            url: `${pub}/mcp`,
            headers: { Authorization: `Bearer ${a}` },
          },
        },
      }, null, 2), { lang: "json" })}
      ${block("Starta fasaden", () => `uvx mcpo --port 8000 --config config.json`,
        { note: "Lägg sedan till <code>http://&lt;host&gt;:8000/mimers-brain</code> under <i>Settings → Tools</i> i Open WebUI. Nyare versioner kan ta MCP-servrar direkt — kolla din version innan du sätter upp mcpo i onödan." })}
    </div>`);

  cards.push(`
    <div class="card">
      <h3>ChatGPT, Gemini och andra</h3>
      <p class="sub">Samma princip överallt: en MCP-server över HTTP med bearer-token.
      Verktygen <code>search</code> och <code>fetch</code> finns just för klienter
      som förväntar sig den enklare sök-och-hämta-modellen i stället för de
      namngivna verktygen. Använd <b>aldrig</b> LAN-adressen här — den är inte
      nåbar utifrån, och om den någonsin blev det vore valvet exponerat för
      tredjepart.</p>
      ${block("Adress att ange", () => `${pub}/mcp`)}
      ${block("Header", (a) => `Authorization: Bearer ${a}`)}
    </div>`);

  cards.push(`
    <div class="card">
      <h3>Vill du ha valvet i en klient som bara når https?</h3>
      <p class="sub">Öppna inte porten. <code>mcp-remote</code> kör som stdio-server på
      din egen maskin, når därför LAN-adressen över vanlig http, och sätter
      headern själv.</p>
      ${block("claude_desktop_config.json", (a) => JSON.stringify({
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
      <h3>Kontrollera att det gick vägen</h3>
      ${block("Lista verktygen", (a) =>
        `curl -s -X POST ${pub}/mcp -H "Authorization: Bearer ${a}" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'`,
        { note: `${cfg.tools.length} verktyg i svaret betyder att allt fungerar. <b>401</b> betyder fel nyckel. <b>302</b> mot autentiseraren betyder att proxyn skickar <code>/mcp</code> genom forward auth, vilket den inte får.` })}
      <table class="grid" style="margin-top:12px">
        <tr><th>Verktyg</th><th>Vad det gör</th></tr>
        ${cfg.tools.map((t) => `<tr><td><code>${esc(t.name)}</code></td><td class="sub">${esc(t.what)}</td></tr>`).join("")}
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
      b.textContent = (await copy(b.dataset.copy)) ? "Kopierat" : "Markera och kopiera";
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
  root.innerHTML = '<div class="empty">Hämtar …</div>';
  const r = await fetch("/api/connect");
  if (!r.ok) {
    root.innerHTML = '<div class="err">Kunde inte hämta anslutningsuppgifterna.</div>';
    return;
  }
  cfg = await r.json();
  draw();
}
