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
const META_MODEL = process.env.META_MODEL || "openai/gpt-4o-mini";

export function fingerprint(content) {
  return createHash("sha256")
    .update(content.replace(/\s+/g, " ").trim().toLowerCase(), "utf8")
    .digest("hex");
}

export async function embed(text) {
  if (!EMBED_KEY) return null;
  const r = await fetch(EMBED_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${EMBED_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!r.ok) throw new Error(`Embedding failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).data[0].embedding;
}

// Mirrors OB1's metadata extraction so thoughts look the same in both systems.
export async function extractMetadata(text) {
  if (!EMBED_KEY) return { topics: ["uncategorized"], type: "observation" };
  try {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${EMBED_KEY}`, "Content-Type": "application/json" },
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

  const meta = { ...(auto || {}), ...(metadata || {}), source: "mimers-valv" };
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
  if (metadata) sets.push(`metadata = $${args.push(JSON.stringify(metadata))}::jsonb`);
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
