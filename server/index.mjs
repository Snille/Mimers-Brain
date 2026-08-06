// Mimers Brain - entry point.
//
// Two listeners, deliberately:
//
//   PORT_FULL (default 8790)  open + vault.  LAN only. Never proxy this one.
//   PORT_OPEN (default 8791)  open only.     This is what Nginx Proxy Manager
//                                            forwards brain.example.net to.
//
// The tier set is a property of the listener, not of the request. There is no
// header, parameter or path that lets a caller on the open port reach a vault
// row - the tools on that port are constructed without the capability.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual, createHash } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./mcp.mjs";
import * as db from "./lib.mjs";
import { startMqtt, stopMqtt, mqttStatus, publishNow, publishSoon } from "./mqtt.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, "public");
const VERSION = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")).version;

const PORT_FULL = Number(process.env.PORT_FULL || 8790);
const PORT_OPEN = Number(process.env.PORT_OPEN || 8791);
const ACCESS_KEY = process.env.MCP_ACCESS_KEY || "";
const OPEN_KEY = process.env.MCP_OPEN_KEY || "";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function sameSecret(given, expected) {
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function keyOk(req) {
  if (!ACCESS_KEY) return true;
  const given = (req.headers.authorization || "").replace(/^Bearer\s+/i, "")
    || req.headers["x-access-key"] || "";
  return sameSecret(given, ACCESS_KEY);
}

// Some clients cannot send a header at all. Claude Desktop's connector dialog
// takes a URL and nothing else, so a key that is not in the URL cannot be given
// to it. Hence this second key, and it is deliberately a *different* one: a
// credential in a URL ends up in the client's stored config and in every proxy
// access log, which is a downgrade the main key should not have to accept. This
// one is only ever honoured by the open listener, so what a leak costs is open
// tier - readable to anyone who can log in to the web UI anyway - and it can be
// rotated without touching a single existing client.
function openKeyOk(url) {
  if (!OPEN_KEY) return false;
  return sameSecret(url.searchParams.get("key"), OPEN_KEY);
}

// Browser session. MCP clients send a bearer token, but a browser cannot - so
// the UI trades the access key for an HttpOnly cookie once. Derived from the
// key rather than stored, so there is no session table to keep.
const SESSION_VALUE = ACCESS_KEY
  ? createHash("sha256").update(`${ACCESS_KEY}|valv-session`).digest("hex")
  : "";

function cookieOk(req) {
  if (!ACCESS_KEY) return true;
  const raw = req.headers.cookie || "";
  const m = raw.match(/(?:^|;\s*)valv_session=([a-f0-9]{64})/);
  return Boolean(m) && sameSecret(m[1], SESSION_VALUE);
}

// On the open listener nginx has already run the request past Authelia and set
// Remote-User. Trusting that header is safe *here* and only here: this listener
// cannot reach vault rows at all, so the worst it grants is open-tier data that
// anyone on the LAN could read from 8790 anyway. Never do this on the full one.
function authOk(req, allowAuthelia) {
  if (keyOk(req) || cookieOk(req)) return true;
  return Boolean(allowAuthelia && req.headers["remote-user"]);
}

// Trades the access key for a browser cookie, so the UI works without one.
async function handleLogin(req, res) {
  const { key } = await body(req);
  if (ACCESS_KEY && !sameSecret(key, ACCESS_KEY))
    return json(res, 401, { error: "Wrong key" });
  res.setHeader(
    "Set-Cookie",
    `valv_session=${SESSION_VALUE}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
  );
  return json(res, 200, { ok: true });
}

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

// Which of the four ways in the caller actually used. Recorded with each call so
// the statistics can distinguish an MCP client from someone in the web UI.
function authMode(req, url, { allowAuthelia, allowUrlKey }) {
  if (!ACCESS_KEY) return "none";
  if (keyOk(req)) return "bearer";
  if (cookieOk(req)) return "cookie";
  if (allowUrlKey && openKeyOk(url)) return "url-key";
  if (allowAuthelia && req.headers["remote-user"]) return "authelia";
  return "none";
}

// --- who is calling ----------------------------------------------------------
//
// MCP hands over `clientInfo` in the initialize handshake and never again. This
// server is stateless - a fresh transport per HTTP request - so by the time a
// tools/call arrives, that name is gone. Hence this small cache: remember what
// initialize said, keyed by source address plus user agent, and reuse it for the
// calls that follow.
//
// Worth being honest about what this can and cannot know: it identifies the
// *client application* (Claude Code, Codex, a ChatGPT connector), never the
// model answering inside it. A model name is simply not on the wire.
const seen = new Map();
const SEEN_TTL = 24 * 60 * 60 * 1000;

function identity(req) {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim()
    || req.socket.remoteAddress || "";
  return `${ip}|${req.headers["user-agent"] || ""}`;
}

function rememberClient(req, info) {
  if (!info?.name) return;
  if (seen.size > 500) seen.clear();
  seen.set(identity(req), { name: info.name, version: info.version || null, at: Date.now() });
}

function clientOf(req) {
  const hit = seen.get(identity(req));
  if (hit && Date.now() - hit.at < SEEN_TTL) return hit;
  // Nothing remembered: fall back to the user agent's product token, which at
  // least separates one kind of caller from another. "unknown" is the honest
  // answer for a client that sends neither.
  const ua = String(req.headers["user-agent"] || "").trim();
  const product = ua.split(/[\s/]/)[0];
  return { name: product || "unknown", version: null };
}

// The one message we care about in an MCP request body.
function initializeInfo(parsed) {
  for (const msg of Array.isArray(parsed) ? parsed : [parsed])
    if (msg?.method === "initialize") return msg.params?.clientInfo || {};
  return null;
}

// --- learning our own LAN address --------------------------------------------
//
// The Connect page wants to name the LAN address even when you are reading it
// through the proxy, and the open listener has no way to work that out: asking
// the OS returns Docker's bridge address (172.x), and so does the socket, since
// the port is NAT'd. Both would print an address that works for nobody.
//
// The Host header on the LAN listener, though, cannot be wrong in the way that
// matters - it is the address a browser just successfully reached us on. So the
// address is learned from real visits rather than configured, and kept in the
// database so it survives a restart. LAN_URL still overrides it, for the case
// where you would rather it printed a hostname.
let lanSeen = null;

async function loadLearnedLan() {
  lanSeen = await db.getSetting("lan_url").catch(() => null);
}

function learnLan(req) {
  const host = String(req.headers.host || "");
  // A Host of "localhost:8790" is true but useless to hand to another machine,
  // and anything malformed is not worth storing at all.
  if (!/^[A-Za-z0-9._-]+(:\d+)?$/.test(host)) return;
  if (/^(localhost|127\.|\[?::1)/i.test(host)) return;
  const url = `http://${host}`;
  if (url === lanSeen) return;
  lanSeen = url;
  db.setSetting("lan_url", url).catch((e) => console.error("lan_url:", e.message));
}

// --- connection guide --------------------------------------------------------
//
// Everything the "Connect" page needs, filled in from this instance rather than
// from a document that drifts. The key rule is the interesting part: the vault
// key is only ever handed to the LAN listener. Reaching the UI through the proxy
// means Authelia let you in, but showing MCP_ACCESS_KEY there would push the one
// credential that unlocks the vault out through the proxy and into a browser
// cache, every time the page is opened. MCP_OPEN_KEY has no such problem - it is
// designed to travel in URLs and it can only ever reach open knowledge.
function connectInfo(req, { tiers, allowUrlKey }) {
  const full = tiers.includes("vault");
  const host = req.headers.host || `localhost:${PORT_FULL}`;

  // On the LAN listener the address in the browser bar *is* the LAN address.
  // Elsewhere: an explicit override if given, otherwise whatever the LAN
  // listener last learned about itself.
  const lanUrl = full
    ? `http://${host}`
    : (process.env.LAN_URL || "").replace(/\/+$/, "") || lanSeen || "";
  const publicUrl = (process.env.PUBLIC_URL
    || (process.env.CITATION_BASE_URL || "").replace(/\/thoughts\/?$/, "")
    || (full ? "" : `https://${host}`)).replace(/\/+$/, "");

  return {
    version: VERSION,
    listener: full ? "full" : "open",
    lanUrl: lanUrl || null,
    publicUrl: publicUrl || null,
    hasAccessKey: Boolean(ACCESS_KEY),
    hasOpenKey: Boolean(OPEN_KEY),
    urlKeyAccepted: Boolean(allowUrlKey && OPEN_KEY),
    // null means "exists, but not from here" - the UI shows <KEY> and how to
    // fetch it instead of pretending the key is unset.
    accessKey: full ? ACCESS_KEY || null : null,
    openKey: OPEN_KEY || null,
    tools: [
      { name: "search_thoughts", what: "Search by meaning. The important one." },
      { name: "list_thoughts", what: "Recent memories, filtered by type, topic, person, time" },
      { name: "capture_thought", what: "Save a new memory" },
      { name: "thought_stats", what: "Totals, types, topics, people" },
      { name: "search", what: "Search, in the shape ChatGPT and Gemini expect" },
      { name: "fetch", what: "Fetch one memory by id" },
      ...(full ? [{ name: "delete_thought", what: "LAN listener only" }] : []),
    ],
  };
}

function makeListener(tiers, { serveUi, allowAuthelia = false, allowUrlKey = false }) {
  const label = tiers.includes("vault") ? "full" : "open";

  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;

    // The web UI counts as a client too, so "who reads and writes this" has an
    // answer that includes you. Only deliberate actions are logged - searching,
    // creating, editing, deleting - not the list and stats calls the page makes
    // on every keystroke, which would bury everything else.
    //
    // A cookie or a forward-auth header means a browser really is on the other
    // end; a bearer token on /api means a script is. Calling both "web-ui" would
    // file every curl and every backup job under a person sitting at the page.
    const note = (tool, action, extra = {}) => {
      const auth = authMode(req, url, { allowAuthelia, allowUrlKey });
      const browser = auth === "cookie" || auth === "authelia";
      const who = browser ? { name: "web-ui", version: VERSION } : clientOf(req);
      db.logUsage({
        tool, action, listener: label, auth,
        client: who.name, clientVersion: who.version, ...extra,
      });
    };

    // Only the vault listener teaches us this, and only for real page loads:
    // /healthz is hit by monitoring using whatever address is convenient.
    if (tiers.includes("vault") && path !== "/healthz") learnLan(req);

    try {
      if (path === "/healthz") return json(res, 200, { ok: true, tier: label });

      // --- MCP (stateless: fresh server + transport per request) ------------
      if (path === "/mcp") {
        // The URL key is accepted here and nowhere else. /api keeps the header
        // and the cookie, since the UI has no trouble sending either.
        if (!keyOk(req) && !(allowUrlKey && openKeyOk(url)))
          return json(res, 401, { error: "Invalid key" });

        // The body is read here rather than by the transport, so the initialize
        // handshake can be inspected for clientInfo. It is handed on as an
        // already-parsed object - the transport takes one for exactly this
        // reason, since a stream can only be consumed once.
        let parsed;
        if (req.method === "POST") {
          try {
            parsed = await body(req);
          } catch {
            return json(res, 400, {
              jsonrpc: "2.0", id: null,
              error: { code: -32700, message: "Parse error" },
            });
          }
          const info = initializeInfo(parsed);
          if (info) {
            rememberClient(req, info);
            db.logUsage({
              tool: "initialize", action: "connect", listener: label,
              client: info.name || "unknown", clientVersion: info.version || null,
              auth: authMode(req, url, { allowAuthelia, allowUrlKey }),
            });
          }
        }

        const who = clientOf(req);
        const server = buildServer(tiers, {
          listener: label,
          client: who.name,
          clientVersion: who.version,
          auth: authMode(req, url, { allowAuthelia, allowUrlKey }),
        });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => { transport.close(); server.close(); });
        await server.connect(transport);
        return transport.handleRequest(req, res, parsed);
      }

      // --- REST for the dashboard ------------------------------------------
      if (path.startsWith("/api/")) {
        // Public: the UI needs this before it can be authenticated.
        if (path === "/api/config")
          return json(res, 200, {
            tier: label,
            version: VERSION,
            vault: tiers.includes("vault"),
            authed: authOk(req, allowAuthelia),
            needsKey: Boolean(ACCESS_KEY) && !allowAuthelia,
          });

        if (path === "/api/login" && req.method === "POST")
          return handleLogin(req, res);

        if (!authOk(req, allowAuthelia)) return json(res, 401, { error: "Not signed in" });
        if (path === "/api/stats") return json(res, 200, await db.stats(tiers));

        if (path === "/api/connect")
          return json(res, 200, connectInfo(req, { tiers, allowUrlKey }));

        if (path === "/api/usage")
          return json(res, 200, await db.usageStats(tiers, {
            days: Math.min(Number(url.searchParams.get("days")) || 60, 400),
          }));

        if (path === "/api/mqtt" && req.method === "GET")
          return json(res, 200, mqttStatus());

        if (path === "/api/mqtt/publish" && req.method === "POST")
          return json(res, 200, { published: await publishNow(), ...mqttStatus() });

        if (path === "/api/thoughts" && req.method === "GET") {
          const q = url.searchParams.get("q");
          const rows = q
            ? await db.textSearch(tiers, q)
            : await db.listThoughts(tiers, {
                limit: Number(url.searchParams.get("limit")) || 100,
                type: url.searchParams.get("type") || undefined,
                topic: url.searchParams.get("topic") || undefined,
                person: url.searchParams.get("person") || undefined,
              });
          return json(res, 200, rows);
        }

        if (path === "/api/thoughts" && req.method === "POST") {
          const { content, tier, metadata } = await body(req);
          if (!content?.trim()) return json(res, 400, { error: "Empty memory" });
          const saved = await db.captureThought(tiers, content.trim(), { tier, metadata });
          note("ui.capture", "write", { tier: saved.tier, results: 1 });
          publishSoon();
          return json(res, 200, saved);
        }

        if (path === "/api/search" && req.method === "POST") {
          const { query, limit, threshold } = await body(req);
          if (!query?.trim()) return json(res, 400, { error: "Empty search" });
          const rows = await db.searchThoughts(tiers, query.trim(), { limit, threshold });
          note("ui.search", "read", { results: rows.length });
          return json(res, 200, rows);
        }

        const m = path.match(/^\/api\/thoughts\/([0-9a-f-]{36})$/i);
        if (m && req.method === "PATCH") {
          const row = await db.updateThought(tiers, m[1], await body(req));
          note("ui.edit", "write", { tier: row.tier, results: 1 });
          publishSoon();
          return json(res, 200, row);
        }
        if (m && req.method === "DELETE") {
          const gone = await db.deleteThought(tiers, m[1]);
          note("ui.delete", "delete", { results: 1 });
          publishSoon();
          return json(res, 200, gone);
        }

        return json(res, 404, { error: "Unknown endpoint" });
      }

      // --- static UI (full listener only) -----------------------------------
      if (!serveUi) return json(res, 404, { error: "Not found" });
      const file = path === "/" ? "index.html" : path.replace(/^\/+/, "");
      const full = join(PUBLIC, file);
      if (!full.startsWith(PUBLIC)) return json(res, 403, { error: "Denied" });
      const data = await readFile(full);
      res.writeHead(200, { "Content-Type": MIME[extname(full)] || "application/octet-stream" });
      res.end(data);
    } catch (err) {
      if (err.code === "ENOENT") return json(res, 404, { error: "Not found" });
      console.error(`[${label}]`, err);
      json(res, 500, { error: String(err.message || err) });
    }
  });
}

// Boot ------------------------------------------------------------------------

await db.pool.query("SELECT 1");
console.log("Database connected.");

// init.sql only ever runs on an empty volume, so this is what gives an existing
// brain the tables a new version needs.
await db.ensureSchema();
await loadLearnedLan();

const listeners = [
  makeListener(db.ALL, { serveUi: true }).listen(PORT_FULL, () =>
    console.log(`FULL (open + vault, LAN only)  -> http://0.0.0.0:${PORT_FULL}  [/mcp, /api, UI]`)),

  makeListener(db.OPEN, { serveUi: true, allowAuthelia: true, allowUrlKey: true }).listen(PORT_OPEN, () =>
    console.log(`OPEN (proxy to this one)       -> http://0.0.0.0:${PORT_OPEN}  [/mcp, /api]`)),
];

startMqtt();

// Once a day, and once at boot. The usage log is small - a few hundred bytes a
// call - but it is the one table that grows without anyone deciding to add to it.
const prune = () => db.pruneUsage()
  .then((n) => n && console.log(`Pruned ${n} usage rows past retention.`))
  .catch((e) => console.error("prune:", e.message));
prune();
setInterval(prune, 24 * 60 * 60 * 1000).unref();

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    // Say offline deliberately rather than letting the will fire on a timeout,
    // so a restart shows as a short blip in HA instead of a stuck "online".
    await stopMqtt().catch(() => {});
    for (const l of listeners) l.close();
    await db.pool.end().catch(() => {});
    process.exit(0);
  });
}

if (!ACCESS_KEY) console.log("WARNING: MCP_ACCESS_KEY is empty - no key required.");
if (OPEN_KEY) console.log("MCP_OPEN_KEY set - open listener also accepts /mcp?key=");
if (OPEN_KEY && OPEN_KEY === ACCESS_KEY)
  console.log("WARNING: MCP_OPEN_KEY equals MCP_ACCESS_KEY - the vault key is now in URLs and logs.");
if (!process.env.OPENROUTER_API_KEY)
  console.log("WARNING: OPENROUTER_API_KEY missing - no embeddings, semantic search disabled.");
