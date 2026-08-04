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

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, "public");

const PORT_FULL = Number(process.env.PORT_FULL || 8790);
const PORT_OPEN = Number(process.env.PORT_OPEN || 8791);
const ACCESS_KEY = process.env.MCP_ACCESS_KEY || "";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
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

function makeListener(tiers, { serveUi, allowAuthelia = false }) {
  const label = tiers.includes("vault") ? "full" : "open";

  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;

    try {
      if (path === "/healthz") return json(res, 200, { ok: true, tier: label });

      // --- MCP (stateless: fresh server + transport per request) ------------
      if (path === "/mcp") {
        if (!keyOk(req)) return json(res, 401, { error: "Invalid key" });
        const server = buildServer(tiers);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => { transport.close(); server.close(); });
        await server.connect(transport);
        return transport.handleRequest(req, res);
      }

      // --- REST for the dashboard ------------------------------------------
      if (path.startsWith("/api/")) {
        // Public: the UI needs this before it can be authenticated.
        if (path === "/api/config")
          return json(res, 200, {
            tier: label,
            vault: tiers.includes("vault"),
            authed: authOk(req, allowAuthelia),
            needsKey: Boolean(ACCESS_KEY) && !allowAuthelia,
          });

        if (path === "/api/login" && req.method === "POST")
          return handleLogin(req, res);

        if (!authOk(req, allowAuthelia)) return json(res, 401, { error: "Not signed in" });
        if (path === "/api/stats") return json(res, 200, await db.stats(tiers));

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
          return json(res, 200, await db.captureThought(tiers, content.trim(), { tier, metadata }));
        }

        if (path === "/api/search" && req.method === "POST") {
          const { query, limit, threshold } = await body(req);
          if (!query?.trim()) return json(res, 400, { error: "Empty search" });
          return json(res, 200, await db.searchThoughts(tiers, query.trim(), { limit, threshold }));
        }

        const m = path.match(/^\/api\/thoughts\/([0-9a-f-]{36})$/i);
        if (m && req.method === "PATCH")
          return json(res, 200, await db.updateThought(tiers, m[1], await body(req)));
        if (m && req.method === "DELETE")
          return json(res, 200, await db.deleteThought(tiers, m[1]));

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

makeListener(db.ALL, { serveUi: true }).listen(PORT_FULL, () =>
  console.log(`FULL (open + vault, LAN only)  -> http://0.0.0.0:${PORT_FULL}  [/mcp, /api, UI]`));

makeListener(db.OPEN, { serveUi: true, allowAuthelia: true }).listen(PORT_OPEN, () =>
  console.log(`OPEN (proxy to this one)       -> http://0.0.0.0:${PORT_OPEN}  [/mcp, /api]`));

if (!ACCESS_KEY) console.log("WARNING: MCP_ACCESS_KEY is empty - no key required.");
if (!process.env.OPENROUTER_API_KEY)
  console.log("WARNING: OPENROUTER_API_KEY missing - no embeddings, semantic search disabled.");
