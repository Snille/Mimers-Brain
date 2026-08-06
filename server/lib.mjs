// Database access and embeddings.
//
// Every query takes an explicit `tiers` array. It is always derived from the
// listener the request arrived on - never from a header, a parameter or
// anything else the caller can influence.

import pg from "pg";
import { createHash } from "node:crypto";

export const OPEN = ["open"];
export const ALL = ["open", "vault"];

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 8,
});

const EMBED_URL = process.env.EMBED_URL || "https://openrouter.ai/api/v1/embeddings";
const EMBED_MODEL = process.env.EMBED_MODEL || "openai/text-embedding-3-small";
const EMBED_KEY = process.env.OPENROUTER_API_KEY || "";
const META_URL = process.env.META_URL || "https://openrouter.ai/api/v1/chat/completions";
const META_MODEL = process.env.META_MODEL || "openai/gpt-4o-mini";

// OpenRouter attributes spend by these two headers and lists the request as
// "Unknown" without them. Harmless to send to any other OpenAI-compatible API.
const APP_NAME = process.env.APP_NAME || "Mimers Brain";
const APP_URL = process.env.APP_URL || "https://github.com/Snille/Mimers-Brain";

function aiHeaders() {
  return {
    Authorization: `Bearer ${EMBED_KEY}`,
    "Content-Type": "application/json",
    "HTTP-Referer": APP_URL,
    "X-Title": APP_NAME,
  };
}

export function fingerprint(content) {
  return createHash("sha256")
    .update(content.replace(/\s+/g, " ").trim().toLowerCase(), "utf8")
    .digest("hex");
}

export async function embed(text) {
  if (!EMBED_KEY) return null;
  const r = await fetch(EMBED_URL, {
    method: "POST",
    headers: aiHeaders(),
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!r.ok) throw new Error(`Embedding failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).data[0].embedding;
}

// Mirrors OB1's metadata extraction so thoughts look the same in both systems.
export async function extractMetadata(text) {
  if (!EMBED_KEY) return { topics: ["uncategorized"], type: "observation" };
  try {
    const r = await fetch(META_URL, {
      method: "POST",
      headers: aiHeaders(),
      body: JSON.stringify({
        model: META_MODEL,
        response_format: { type: "json_object" },
        messages: [{
          role: "user",
          content:
            `Extract metadata as JSON with keys:\n` +
            `- "people": array of people mentioned (empty if none)\n` +
            `- "topics": array of 1-3 short topic tags (always at least one)\n` +
            `- "type": one of "observation", "task", "idea", "reference", "person_note"\n\n` +
            text,
        }],
      }),
    });
    if (!r.ok) throw new Error(String(r.status));
    return JSON.parse((await r.json()).choices[0].message.content);
  } catch {
    return { topics: ["uncategorized"], type: "observation" };
  }
}

// The extractor is free-form, so it happily produces both "Home Automation" and
// "home automation" for the same idea. Left alone they become two facets that
// filter separately, and a stats object with case-colliding keys that some JSON
// parsers (PowerShell's among them) refuse outright, silently returning a raw
// string instead. Topics are lowercased; people only get trimmed and deduped,
// because they are proper nouns and "erik" in the sidebar would look wrong.
//
// Applied on every write - capture and update both - so hand-edited tags in the
// UI cannot reintroduce the collision.
export function normaliseMeta(meta) {
  const out = { ...meta };
  const dedupe = (list, lower) => {
    const seen = new Set();
    const kept = [];
    for (const raw of Array.isArray(list) ? list : []) {
      const s = String(raw).replace(/\s+/g, " ").trim();
      if (!s) continue;
      const key = s.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(lower ? key : s);
    }
    return kept;
  };
  if ("topics" in out) out.topics = dedupe(out.topics, true);
  if ("people" in out) out.people = dedupe(out.people, false);
  return out;
}

const COLS = "id, content, metadata, tier, created_at, updated_at";

export async function listThoughts(tiers, { limit = 10, type, topic, person, days } = {}) {
  const args = [tiers];
  let sql = `SELECT ${COLS} FROM thoughts WHERE tier = ANY($1)`;
  if (type) sql += ` AND metadata @> $${args.push(JSON.stringify({ type }))}::jsonb`;
  if (topic) sql += ` AND metadata @> $${args.push(JSON.stringify({ topics: [topic] }))}::jsonb`;
  if (person) sql += ` AND metadata @> $${args.push(JSON.stringify({ people: [person] }))}::jsonb`;
  if (days) sql += ` AND created_at > now() - ($${args.push(String(days))} || ' days')::interval`;
  sql += ` ORDER BY created_at DESC LIMIT $${args.push(Math.min(limit, 200))}`;
  return (await pool.query(sql, args)).rows;
}

// 0.3, not OB1's 0.5: measured against Swedish paraphrases, an identical
// sentence scores 1.00, shared keywords ~0.79, and a loose rewording with no
// words in common ~0.43. A 0.5 default silently drops that last case, which is
// exactly the kind of recall the brain exists for.
export async function searchThoughts(tiers, query, { limit = 10, threshold = 0.3 } = {}) {
  const vector = await embed(query);
  if (!vector) throw new Error("Semantic search needs OPENROUTER_API_KEY");
  const { rows } = await pool.query(
    `SELECT * FROM match_thoughts($1::vector, $2, $3, '{}'::jsonb, $4)`,
    [JSON.stringify(vector), threshold, limit, tiers],
  );
  return rows;
}

export async function textSearch(tiers, q, limit = 100) {
  const { rows } = await pool.query(
    `SELECT ${COLS} FROM thoughts WHERE tier = ANY($1) AND content ILIKE $2
     ORDER BY created_at DESC LIMIT $3`,
    [tiers, `%${q}%`, Math.min(limit, 500)],
  );
  return rows;
}

export async function getThought(tiers, id) {
  const { rows } = await pool.query(
    `SELECT ${COLS} FROM thoughts WHERE id = $1 AND tier = ANY($2)`,
    [id, tiers],
  );
  return rows[0] || null;
}

export async function captureThought(tiers, content, { tier = "open", metadata } = {}) {
  if (!tiers.includes(tier))
    throw new Error(`This endpoint may not write to tier "${tier}"`);

  const [vector, auto] = await Promise.all([
    embed(content).catch(() => null),
    metadata ? Promise.resolve(null) : extractMetadata(content),
  ]);

  const meta = normaliseMeta({ ...(auto || {}), ...(metadata || {}), source: "mimers-brain" });

  const { rows } = await pool.query(
    `SELECT upsert_thought($1, $2::jsonb, $3) AS result`,
    [content, JSON.stringify({ metadata: meta }), tier],
  );
  const { id } = rows[0].result;

  if (vector)
    await pool.query(`UPDATE thoughts SET embedding = $1::vector WHERE id = $2`,
      [JSON.stringify(vector), id]);

  return { id, tier, metadata: meta, embedded: Boolean(vector) };
}

export async function updateThought(tiers, id, { content, metadata, tier }) {
  const existing = await getThought(tiers, id);
  if (!existing) throw new Error("Not found");
  if (tier && !tiers.includes(tier))
    throw new Error(`This endpoint may not move rows to tier "${tier}"`);

  const sets = [];
  const args = [id];
  if (typeof content === "string") {
    sets.push(`content = $${args.push(content)}`);
    sets.push(`content_fingerprint = $${args.push(fingerprint(content))}`);
    const vector = await embed(content).catch(() => null);
    if (vector) sets.push(`embedding = $${args.push(JSON.stringify(vector))}::vector`);
  }
  // Replaces the whole object, so callers must send back the keys they want to
  // keep. The UI merges against what it already has for exactly this reason.
  if (metadata)
    sets.push(`metadata = $${args.push(JSON.stringify(normaliseMeta(metadata)))}::jsonb`);
  if (tier) sets.push(`tier = $${args.push(tier)}`);
  if (!sets.length) throw new Error("Nothing to update");

  const { rows } = await pool.query(
    `UPDATE thoughts SET ${sets.join(", ")} WHERE id = $1 RETURNING ${COLS}`, args);
  return rows[0];
}

export async function deleteThought(tiers, id) {
  const { rowCount } = await pool.query(
    `DELETE FROM thoughts WHERE id = $1 AND tier = ANY($2)`, [id, tiers]);
  if (!rowCount) throw new Error("Not found");
  return { deleted: id };
}

// --- usage log ---------------------------------------------------------------
//
// db/init.sql only ever runs on an empty volume, so a running instance would
// never see a table added later. Every statement here is therefore idempotent
// and runs on each boot - that is what upgrades an existing brain in place.
export async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_events (
        id             bigserial PRIMARY KEY,
        at             timestamptz NOT NULL DEFAULT now(),
        tool           text NOT NULL,
        action         text NOT NULL,
        listener       text NOT NULL CHECK (listener IN ('full', 'open')),
        client         text NOT NULL,
        client_version text,
        auth           text,
        tier           text,
        results        integer,
        ok             boolean NOT NULL DEFAULT true,
        ms             integer
    );
    CREATE INDEX IF NOT EXISTS usage_events_at_idx     ON usage_events (at DESC);
    CREATE INDEX IF NOT EXISTS usage_events_client_idx ON usage_events (client, at DESC);

    CREATE TABLE IF NOT EXISTS app_settings (
        key        text PRIMARY KEY,
        value      text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export async function getSetting(key) {
  const { rows } = await pool.query(`SELECT value FROM app_settings WHERE key = $1`, [key]);
  return rows[0]?.value ?? null;
}

export async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value],
  );
}

// Buckets are cut in local time, not UTC. Left alone, "today" would roll over at
// 01:00 or 02:00 Swedish time and a late-evening memory would land on tomorrow -
// which looks like a bug in the chart long before anyone suspects the timezone.
const TZ = process.env.STATS_TZ || "Europe/Stockholm";
const RETENTION_DAYS = Number(process.env.USAGE_RETENTION_DAYS || 730);

// Fire-and-forget: a statistics row must never be able to fail a real call, and
// must never delay one either. Note what is *not* passed in - no query text, no
// content, no results. See the table comment in db/init.sql.
export function logUsage(ev = {}) {
  if (!ev.tool || !ev.listener) return;
  pool
    .query(
      `INSERT INTO usage_events
         (tool, action, listener, client, client_version, auth, tier, results, ok, ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        ev.tool,
        ev.action || "read",
        ev.listener,
        ev.client || "unknown",
        ev.clientVersion || null,
        ev.auth || null,
        ev.tier || null,
        ev.results ?? null,
        ev.ok !== false,
        ev.ms ?? null,
      ],
    )
    .catch((e) => console.error("usage log:", e.message));
}

export async function pruneUsage() {
  const { rowCount } = await pool.query(
    `DELETE FROM usage_events WHERE at < now() - ($1 || ' days')::interval`,
    [String(RETENTION_DAYS)],
  );
  return rowCount;
}

// The open listener passes ['open'] and therefore sees only what happened on the
// open listener. Same reasoning as everywhere else in here: no caller-supplied
// value decides scope, and the public dashboard cannot show that vault traffic
// exists - which would leak the split that the whole design rests on.
export function listenersFor(tiers) {
  return tiers.includes("vault") ? ["full", "open"] : ["open"];
}

const BUCKET = { day: "day", month: "month", year: "year" };

async function usageSeries(listeners, unit, span) {
  const { rows } = await pool.query(
    `SELECT date_trunc($2, at AT TIME ZONE $4)::date AS bucket,
            count(*)                                        AS calls,
            count(*) FILTER (WHERE action = 'read')         AS reads,
            count(*) FILTER (WHERE action = 'write')         AS writes,
            count(*) FILTER (WHERE action = 'delete')        AS deletes
       FROM usage_events
      WHERE listener = ANY($1)
        AND at > now() - ($3 || ' days')::interval
      GROUP BY 1 ORDER BY 1`,
    [listeners, BUCKET[unit], String(span), TZ],
  );
  return rows.map((r) => ({
    bucket: r.bucket,
    calls: Number(r.calls),
    reads: Number(r.reads),
    writes: Number(r.writes),
    deletes: Number(r.deletes),
  }));
}

async function memorySeries(tiers, unit, span) {
  const { rows } = await pool.query(
    `SELECT date_trunc($2, created_at AT TIME ZONE $4)::date AS bucket, count(*) AS count
       FROM thoughts
      WHERE tier = ANY($1)
        AND created_at > now() - ($3 || ' days')::interval
      GROUP BY 1 ORDER BY 1`,
    [tiers, BUCKET[unit], String(span), TZ],
  );
  return rows.map((r) => ({ bucket: r.bucket, count: Number(r.count) }));
}

// Counts since the start of the current local day / week / month / year, plus
// all time. date_trunc on the local wall clock and back again, so "this month"
// means what the calendar on the wall says.
async function windowCounts(sql, args, column) {
  const { rows } = await pool.query(
    `SELECT
       count(*) FILTER (WHERE ${column} >= date_trunc('day',   now() AT TIME ZONE $${args.length + 1}) AT TIME ZONE $${args.length + 1}) AS today,
       count(*) FILTER (WHERE ${column} >= date_trunc('week',  now() AT TIME ZONE $${args.length + 1}) AT TIME ZONE $${args.length + 1}) AS week,
       count(*) FILTER (WHERE ${column} >= date_trunc('month', now() AT TIME ZONE $${args.length + 1}) AT TIME ZONE $${args.length + 1}) AS month,
       count(*) FILTER (WHERE ${column} >= date_trunc('year',  now() AT TIME ZONE $${args.length + 1}) AT TIME ZONE $${args.length + 1}) AS year,
       count(*) AS total
     FROM ${sql}`,
    [...args, TZ],
  );
  const r = rows[0];
  return {
    today: Number(r.today), week: Number(r.week), month: Number(r.month),
    year: Number(r.year), total: Number(r.total),
  };
}

export async function usageStats(tiers, { days = 60, months = 24 } = {}) {
  const listeners = listenersFor(tiers);

  const [daily, monthly, yearly, memDaily, memMonthly, calls, memories, byClient, byTool, byAction] =
    await Promise.all([
      usageSeries(listeners, "day", days),
      usageSeries(listeners, "month", months * 31),
      usageSeries(listeners, "year", 3650),
      memorySeries(tiers, "day", days),
      memorySeries(tiers, "month", months * 31),
      windowCounts("usage_events WHERE listener = ANY($1)", [listeners], "at"),
      windowCounts("thoughts WHERE tier = ANY($1)", [tiers], "created_at"),
      pool.query(
        `SELECT client,
                max(client_version)                       AS version,
                count(*)                                  AS calls,
                count(*) FILTER (WHERE action = 'read')   AS reads,
                count(*) FILTER (WHERE action = 'write')  AS writes,
                count(*) FILTER (WHERE action = 'delete') AS deletes,
                count(*) FILTER (WHERE NOT ok)            AS errors,
                min(at) AS first, max(at) AS last
           FROM usage_events WHERE listener = ANY($1)
          GROUP BY client ORDER BY calls DESC LIMIT 25`,
        [listeners],
      ),
      pool.query(
        `SELECT tool, count(*) AS calls, round(avg(ms)) AS avg_ms
           FROM usage_events WHERE listener = ANY($1)
          GROUP BY tool ORDER BY calls DESC`,
        [listeners],
      ),
      pool.query(
        `SELECT action, count(*) AS calls FROM usage_events
          WHERE listener = ANY($1) GROUP BY action`,
        [listeners],
      ),
    ]);

  const num = (rows, ...keys) =>
    rows.map((r) => { for (const k of keys) r[k] = r[k] == null ? null : Number(r[k]); return r; });

  return {
    tz: TZ,
    retentionDays: RETENTION_DAYS,
    calls,
    memories,
    daily, monthly, yearly,
    memoryDaily: memDaily,
    memoryMonthly: memMonthly,
    byClient: num(byClient.rows, "calls", "reads", "writes", "deletes", "errors"),
    byTool: num(byTool.rows, "calls", "avg_ms"),
    byAction: Object.fromEntries(byAction.rows.map((r) => [r.action, Number(r.calls)])),
  };
}

// The compact set that goes to MQTT every minute. Kept to a single round trip -
// this runs on a timer forever, so it has no business being the expensive query.
export async function liveCounters(tiers = ALL) {
  const listeners = listenersFor(tiers);
  const { rows } = await pool.query(
    `WITH d AS (SELECT date_trunc('day',   now() AT TIME ZONE $3) AT TIME ZONE $3 AS v),
          w AS (SELECT date_trunc('week',  now() AT TIME ZONE $3) AT TIME ZONE $3 AS v),
          m AS (SELECT date_trunc('month', now() AT TIME ZONE $3) AT TIME ZONE $3 AS v),
          y AS (SELECT date_trunc('year',  now() AT TIME ZONE $3) AT TIME ZONE $3 AS v)
     SELECT
       (SELECT count(*) FROM thoughts WHERE tier = ANY($1))                        AS mem_total,
       (SELECT count(*) FROM thoughts WHERE tier = 'open')                         AS mem_open,
       (SELECT count(*) FROM thoughts WHERE tier = 'vault')                        AS mem_vault,
       (SELECT count(*) FROM thoughts WHERE tier = ANY($1) AND embedding IS NULL)  AS mem_unembedded,
       (SELECT count(*) FROM thoughts WHERE tier = ANY($1) AND created_at >= (SELECT v FROM d)) AS mem_today,
       (SELECT count(*) FROM thoughts WHERE tier = ANY($1) AND created_at >= (SELECT v FROM w)) AS mem_week,
       (SELECT count(*) FROM thoughts WHERE tier = ANY($1) AND created_at >= (SELECT v FROM m)) AS mem_month,
       (SELECT count(*) FROM thoughts WHERE tier = ANY($1) AND created_at >= (SELECT v FROM y)) AS mem_year,
       (SELECT max(created_at) FROM thoughts WHERE tier = ANY($1))                 AS mem_last,
       (SELECT count(*) FROM usage_events WHERE listener = ANY($2) AND at >= (SELECT v FROM d)) AS calls_today,
       (SELECT count(*) FROM usage_events WHERE listener = ANY($2) AND at >= (SELECT v FROM w)) AS calls_week,
       (SELECT count(*) FROM usage_events WHERE listener = ANY($2) AND at >= (SELECT v FROM m)) AS calls_month,
       (SELECT count(*) FROM usage_events WHERE listener = ANY($2) AND at >= (SELECT v FROM y)) AS calls_year,
       (SELECT count(*) FROM usage_events WHERE listener = ANY($2)) AS calls_total,
       (SELECT count(*) FROM usage_events WHERE listener = ANY($2) AND action = 'read'  AND at >= (SELECT v FROM d)) AS reads_today,
       (SELECT count(*) FROM usage_events WHERE listener = ANY($2) AND action = 'write' AND at >= (SELECT v FROM d)) AS writes_today,
       (SELECT count(DISTINCT client) FROM usage_events WHERE listener = ANY($2) AND at >= (SELECT v FROM w)) AS clients_week,
       (SELECT client FROM usage_events WHERE listener = ANY($2) AND at >= (SELECT v FROM w)
         GROUP BY client ORDER BY count(*) DESC LIMIT 1) AS top_client,
       (SELECT max(at) FROM usage_events WHERE listener = ANY($2)) AS last_call`,
    [tiers, listeners, TZ],
  );
  const r = rows[0];
  const n = (v) => Number(v || 0);
  return {
    memories_total: n(r.mem_total),
    memories_open: n(r.mem_open),
    memories_vault: n(r.mem_vault),
    memories_unembedded: n(r.mem_unembedded),
    memories_today: n(r.mem_today),
    memories_week: n(r.mem_week),
    memories_month: n(r.mem_month),
    memories_year: n(r.mem_year),
    last_memory: r.mem_last ? new Date(r.mem_last).toISOString() : null,
    calls_today: n(r.calls_today),
    calls_week: n(r.calls_week),
    calls_month: n(r.calls_month),
    calls_year: n(r.calls_year),
    calls_total: n(r.calls_total),
    reads_today: n(r.reads_today),
    writes_today: n(r.writes_today),
    clients_week: n(r.clients_week),
    top_client: r.top_client || "none",
    last_call: r.last_call ? new Date(r.last_call).toISOString() : null,
  };
}

export async function stats(tiers) {
  const { rows } = await pool.query(
    `SELECT metadata, tier, created_at FROM thoughts WHERE tier = ANY($1)`, [tiers]);
  const types = {}, topics = {}, people = {}, byTier = {};
  for (const r of rows) {
    const m = r.metadata || {};
    byTier[r.tier] = (byTier[r.tier] || 0) + 1;
    if (m.type) types[m.type] = (types[m.type] || 0) + 1;
    for (const t of Array.isArray(m.topics) ? m.topics : []) topics[t] = (topics[t] || 0) + 1;
    for (const p of Array.isArray(m.people) ? m.people : []) people[p] = (people[p] || 0) + 1;
  }
  const dates = rows.map((r) => r.created_at).filter(Boolean).sort();
  return { total: rows.length, byTier, types, topics, people,
           first: dates[0] || null, last: dates.at(-1) || null };
}
