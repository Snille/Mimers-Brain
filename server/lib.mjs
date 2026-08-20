// Database access and embeddings.
//
// Every query takes an explicit `tiers` array. It is always derived from the
// listener the request arrived on - never from a header, a parameter or
// anything else the caller can influence.

import pg from "pg";
import { createHash } from "node:crypto";
import {
  CANONICAL_TOPICS,
  MEMORY_KINDS,
  SMART_INGEST_THRESHOLD,
  applyReview,
  embeddingText,
  inheritsConfirmedTrust,
  normaliseMeta,
} from "./memory-model.mjs";
import { fallbackAtoms, normalisePreviewCandidates } from "./smart-ingest.mjs";

export { normaliseMeta } from "./memory-model.mjs";

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

export function searchTerms(query) {
  const stop = new Set(["hur", "jag", "man", "kan", "vilka", "saker", "vad", "att", "och", "med", "the", "how", "do", "does", "to", "is"]);
  return [...new Set(String(query).toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 2 && !stop.has(word))
    .map((word) => word.replace(/(?:ar|er|a)$/u, ""))
    .filter((word) => word.length > 2))];
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

// The model invents a project name whenever it cannot see the ones already in
// use, and a stray name is invisible to every project filter. "topics" has a
// closed vocabulary that protects it; "project" is free-form by design, because
// a genuinely new project must be able to name itself. Showing the names that
// already exist makes a new one a decision rather than an accident. Cached: this
// runs on the save path, and the set of projects changes far more slowly.
const KNOWN_PROJECTS_TTL_MS = 5 * 60 * 1000;
const KNOWN_PROJECTS_LIMIT = 80;
let knownProjectsCache = { at: 0, names: [] };

export async function knownProjects() {
  if (Date.now() - knownProjectsCache.at < KNOWN_PROJECTS_TTL_MS) return knownProjectsCache.names;
  try {
    const { rows } = await pool.query(
      `SELECT metadata->>'project' AS project, count(*) AS n
         FROM thoughts
        WHERE coalesce(metadata->>'project', '') <> ''
        GROUP BY 1
        ORDER BY n DESC, project
        LIMIT $1`,
      [KNOWN_PROJECTS_LIMIT],
    );
    knownProjectsCache = { at: Date.now(), names: rows.map((row) => row.project) };
  } catch {
    // A failed lookup must never block a save; the prompt then simply omits the list.
    knownProjectsCache = { at: Date.now(), names: [] };
  }
  return knownProjectsCache.names;
}

// "other" was one of twenty-six equal options, so the model reached for it
// whenever it hesitated - 158 of 290 memories carried it, 98 of them with
// nothing else, which makes a memory invisible to a topic filter. Offering the
// real subjects first and naming "other" as the last resort states what the
// closed vocabulary alone cannot: that it is a fallback, not a choice. The
// second sentence covers the other half of the mess, "other" added beside a
// value that already fits.
export function topicRule() {
  const subjects = CANONICAL_TOPICS.filter((topic) => topic !== "other");
  return `- "topics": 1-3 values chosen only from: ${subjects.join(", ")}\n` +
    `  Use "other" only when not one of those values applies to the text, and never\n` +
    `  beside a value that does apply.\n`;
}

// project is the one facet with no closed vocabulary, so the rule carries its own
// guard rails: reuse what exists, and never reach for a topic word - which is
// where a memory landed under the project "docker" on 2026-08-19.
export function projectRule(existing) {
  const line = `- "project": one lower-kebab-case owning project, or empty\n`;
  if (!existing.length) return line;
  return line +
    `  Reuse an existing project name when the text belongs to one of these: ${existing.join(", ")}\n` +
    `  Invent a new name only when none of them owns the text. A topic word such as ` +
    `${CANONICAL_TOPICS.slice(0, 6).join(", ")} names a subject, never a project.\n`;
}

// The model proposes metadata, but memory-model.mjs owns the vocabulary and
// validation. Free-form output is never written directly.
export async function extractMetadata(text) {
  if (!EMBED_KEY) return { topics: ["mimers-brain"], kind: "fact", type: "observation" };
  const existingProjects = await knownProjects();
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
            `Extract long-term-memory metadata as JSON. Return only these keys:\n` +
            `- "title": a factual title for THIS text, at most 180 characters\n` +
            `- "summary": the current conclusion of THIS text, at most 500 characters\n` +
            `- "kind": one of ${MEMORY_KINDS.join(", ")}\n` +
            `- "task_status": "pending" or "done", only when kind is task\n` +
            projectRule(existingProjects) +
            `- "people": named human beings only, and only names written in the text.\n` +
            `  Tools, services, apps, accounts, companies and devices are NOT people;\n` +
            `  Luba/Sleipner is a robot mower. Never derive a name from surrounding prose.\n` +
            `- "systems": software, services, tools, machines, devices and named robots\n` +
            topicRule() +
            `- "verified_at": YYYY-MM-DD when the text states a verification date, or empty\n` +
            `Do not invent facts. lifecycle is always set by the server.\n\n` +
            text,
        }],
      }),
    });
    if (!r.ok) throw new Error(String(r.status));
    return JSON.parse((await r.json()).choices[0].message.content);
  } catch {
    return { topics: ["mimers-brain"], kind: "fact", type: "observation" };
  }
}

async function extractAtoms(text) {
  if (!EMBED_KEY) return fallbackAtoms(text).map((content) => ({ content }));
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
            `Split this source into durable, standalone, atomic long-term memories. ` +
            `Return JSON {"memories":[{"content":"..."}]}. Keep decisions, facts, procedures, ` +
            `preferences, lessons and concrete future tasks. Omit greetings, transcript noise, ` +
            `tentative reasoning, repetitions, raw secrets and anything without lasting value. ` +
            `Do not invent information. Maximum 30 memories, each below 1800 characters.\n\n${text}`,
        }],
      }),
    });
    if (!r.ok) throw new Error(String(r.status));
    const parsed = JSON.parse((await r.json()).choices[0].message.content);
    return normalisePreviewCandidates(parsed.memories);
  } catch {
    return fallbackAtoms(text).map((content) => ({ content }));
  }
}

const COLS = "id, content, metadata, tier, created_at, updated_at";

export async function listThoughts(tiers, {
  limit = 10, type, kind, lifecycle = "current", taskStatus, task_status, project,
  topic, person, system, days,
} = {}) {
  taskStatus ||= task_status;
  const args = [tiers];
  let sql = `SELECT ${COLS} FROM thoughts WHERE tier = ANY($1)`;
  if (type) sql += ` AND metadata @> $${args.push(JSON.stringify({ type }))}::jsonb`;
  if (kind) sql += ` AND metadata @> $${args.push(JSON.stringify({ kind }))}::jsonb`;
  if (lifecycle && lifecycle !== "all")
    sql += ` AND coalesce(metadata->>'lifecycle', 'current') = $${args.push(lifecycle)}`;
  if (taskStatus) sql += ` AND metadata->>'task_status' = $${args.push(taskStatus)}`;
  if (project) sql += ` AND metadata->>'project' = $${args.push(project)}`;
  if (topic) sql += ` AND metadata @> $${args.push(JSON.stringify({ topics: [topic] }))}::jsonb`;
  if (person) sql += ` AND metadata @> $${args.push(JSON.stringify({ people: [person] }))}::jsonb`;
  if (system) sql += ` AND metadata @> $${args.push(JSON.stringify({ systems: [system] }))}::jsonb`;
  if (days) sql += ` AND created_at > now() - ($${args.push(String(days))} || ' days')::interval`;
  sql += ` ORDER BY created_at DESC LIMIT $${args.push(Math.min(limit, 200))}`;
  return (await pool.query(sql, args)).rows;
}

// 0.3, not OB1's 0.5: measured against Swedish paraphrases, an identical
// sentence scores 1.00, shared keywords ~0.79, and a loose rewording with no
// words in common ~0.43. A 0.5 default silently drops that last case, which is
// exactly the kind of recall the brain exists for.
export async function searchThoughts(tiers, query, {
  limit = 10, threshold = 0.3, kind, lifecycle = "current", taskStatus, project,
} = {}) {
  // A generic semantic query for "what remains" otherwise ranks incident
  // reports that contain those words above the actual pending tasks. Treat this
  // common intent as a structured filter unless the caller chose one itself.
  if (!kind && !taskStatus && /\b(?:todo|pending|återstår|kvar att göra|göra senare|follow[- ]?up)\b/i.test(query)) {
    kind = "task";
    taskStatus = "pending";
  }
  const vector = await embed(query);
  if (!vector) throw new Error("Semantic search needs OPENROUTER_API_KEY");
  const terms = searchTerms(query);
  const args = [JSON.stringify(vector), query, tiers, threshold, terms];
  let filters = `tier = ANY($3) AND coalesce(metadata->>'review_status', 'confirmed') <> 'rejected'`;
  if (lifecycle && lifecycle !== "all")
    filters += ` AND coalesce(metadata->>'lifecycle', 'current') = $${args.push(lifecycle)}`;
  if (kind) filters += ` AND metadata->>'kind' = $${args.push(kind)}`;
  if (taskStatus) filters += ` AND metadata->>'task_status' = $${args.push(taskStatus)}`;
  if (project) filters += ` AND metadata->>'project' = $${args.push(project)}`;
  const limitArg = args.push(Math.min(Number(limit) || 10, 100));
  const { rows } = await pool.query(
    `WITH ranked AS (
       SELECT ${COLS},
              coalesce(1 - (embedding <=> $1::vector), 0) AS semantic_score,
              ts_rank_cd(
                setweight(to_tsvector('simple', coalesce(metadata->>'title', '')), 'A') ||
                setweight(to_tsvector('simple', coalesce(metadata->>'summary', '')), 'B') ||
                setweight(to_tsvector('simple', content), 'C'),
                websearch_to_tsquery('simple', $2)
              ) AS lexical_score
              ,(SELECT count(*)::double precision / greatest(cardinality($5::text[]), 1)
                  FROM unnest($5::text[]) AS term
                 WHERE lower(coalesce(metadata->>'title', '')) LIKE '%' || term || '%') AS title_score
         FROM thoughts
        WHERE ${filters}
     )
     SELECT *, semantic_score AS similarity,
            semantic_score * 0.65 + least(title_score, 1) * 0.30 + least(lexical_score, 1) * 0.05 +
            CASE WHEN coalesce(metadata->>'title', '') ILIKE '%' || $2 || '%' THEN 0.15 ELSE 0 END +
            CASE coalesce(metadata->>'review_status', 'confirmed')
              WHEN 'confirmed' THEN 0.06 WHEN 'pending' THEN -0.02
              WHEN 'evidence_only' THEN -0.03 WHEN 'stale' THEN -0.05 ELSE 0 END +
            CASE WHEN coalesce(metadata->>'can_use_as_instruction', 'true') = 'true' THEN 0.02 ELSE 0 END
            AS rank_score
       FROM ranked
      WHERE semantic_score > $4 OR lexical_score > 0
      ORDER BY rank_score DESC, created_at DESC
      LIMIT $${limitArg}`,
    args,
  );
  return rows;
}

export async function textSearch(tiers, q, {
  limit = 100, lifecycle = "current", kind, taskStatus, project, topic, person, system,
} = {}) {
  const args = [tiers, `%${q}%`];
  let sql = `SELECT ${COLS} FROM thoughts
    WHERE tier = ANY($1)
      AND (content ILIKE $2 OR metadata->>'title' ILIKE $2 OR metadata->>'summary' ILIKE $2)`;
  if (lifecycle && lifecycle !== "all")
    sql += ` AND coalesce(metadata->>'lifecycle', 'current') = $${args.push(lifecycle)}`;
  if (kind) sql += ` AND metadata->>'kind' = $${args.push(kind)}`;
  if (taskStatus) sql += ` AND metadata->>'task_status' = $${args.push(taskStatus)}`;
  if (project) sql += ` AND metadata->>'project' = $${args.push(project)}`;
  if (topic) sql += ` AND metadata @> $${args.push(JSON.stringify({ topics: [topic] }))}::jsonb`;
  if (person) sql += ` AND metadata @> $${args.push(JSON.stringify({ people: [person] }))}::jsonb`;
  if (system) sql += ` AND metadata @> $${args.push(JSON.stringify({ systems: [system] }))}::jsonb`;
  sql += ` ORDER BY created_at DESC LIMIT $${args.push(Math.min(limit, 500))}`;
  const { rows } = await pool.query(sql, args);
  return rows;
}

export async function getThought(tiers, id) {
  const { rows } = await pool.query(
    `SELECT ${COLS} FROM thoughts WHERE id = $1 AND tier = ANY($2)`,
    [id, tiers],
  );
  return rows[0] || null;
}

export async function thoughtRelations(tiers, id) {
  const visible = await getThought(tiers, id);
  if (!visible) throw new Error("Not found");
  const { rows } = await pool.query(
    `SELECT r.from_id, r.to_id, r.relation, r.created_at,
            CASE WHEN r.from_id = $1 THEN r.to_id ELSE r.from_id END AS other_id,
            CASE WHEN r.from_id = $1 THEN 'outgoing' ELSE 'incoming' END AS direction
       FROM thought_relations r
       JOIN thoughts other ON other.id = CASE WHEN r.from_id = $1 THEN r.to_id ELSE r.from_id END
      WHERE (r.from_id = $1 OR r.to_id = $1) AND other.tier = ANY($2)
      ORDER BY r.created_at`,
    [id, tiers],
  );
  return rows;
}

export async function validateSupersession(tiers, oldIds, replacementTier) {
  const ids = [...new Set((oldIds || []).map(String))];
  if (!ids.length) throw new Error("At least one old memory id is required");
  const { rows } = await pool.query(
    `SELECT id, tier FROM thoughts WHERE id = ANY($1::uuid[]) AND tier = ANY($2)`,
    [ids, tiers],
  );
  if (rows.length !== ids.length) throw new Error("One or more old memories were not found");
  if (rows.some((row) => row.tier === "vault") && replacementTier !== "vault")
    throw new Error("A vault memory may only be superseded by another vault memory");
  return ids;
}

// Whether a replacement for these memories may be treated as user-confirmed.
// See inheritsConfirmedTrust: a rewrite must not promote a pending memory.
export async function supersessionTrust(tiers, oldIds) {
  const ids = [...new Set((Array.isArray(oldIds) ? oldIds : []).map(String))];
  if (!ids.length) return false;
  const { rows } = await pool.query(
    `SELECT metadata FROM thoughts WHERE id = ANY($1::uuid[]) AND tier = ANY($2)`,
    [ids, tiers],
  );
  if (rows.length !== ids.length) return false;
  return inheritsConfirmedTrust(rows.map((row) => row.metadata));
}

export async function linkSupersession(tiers, replacementId, oldIds) {
  const replacement = await getThought(tiers, replacementId);
  if (!replacement) throw new Error("Replacement memory not found");
  const ids = await validateSupersession(tiers, oldIds, replacement.tier);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO thought_relations (from_id, to_id, relation)
       SELECT $1::uuid, old_id, 'supersedes'
         FROM unnest($2::uuid[]) old_id
       ON CONFLICT DO NOTHING`,
      [replacementId, ids],
    );
    await client.query(
      `UPDATE thoughts
          SET metadata = jsonb_set(
                jsonb_set(metadata, '{lifecycle}', '"superseded"'::jsonb, true),
                '{superseded_by}', to_jsonb($1::text), true)
        WHERE id = ANY($2::uuid[])`,
      [replacementId, ids],
    );
    await client.query(
      `UPDATE thoughts
          SET metadata = jsonb_set(metadata, '{supersedes}', to_jsonb($2::text[]), true)
        WHERE id = $1`,
      [replacementId, ids],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { replacement_id: replacementId, superseded_ids: ids };
}

export async function linkRelations(tiers, fromId, toIds, relation = "related_to") {
  const allowed = ["related_to", "derived_from", "conflicts_with", "merged_into", "source_of"];
  if (!allowed.includes(relation)) throw new Error(`Unsupported relation "${relation}"`);
  const from = await getThought(tiers, fromId);
  if (!from) throw new Error("Source memory not found");
  const ids = [...new Set((toIds || []).map(String))].filter((id) => id !== fromId);
  if (!ids.length) return { from_id: fromId, to_ids: [], relation };
  const { rows } = await pool.query(
    `SELECT id FROM thoughts WHERE id = ANY($1::uuid[]) AND tier = ANY($2)`, [ids, tiers]);
  if (rows.length !== ids.length) throw new Error("One or more related memories were not found");
  await pool.query(
    `INSERT INTO thought_relations (from_id, to_id, relation)
     SELECT $1::uuid, x, $3 FROM unnest($2::uuid[]) x ON CONFLICT DO NOTHING`,
    [fromId, ids, relation],
  );
  return { from_id: fromId, to_ids: ids, relation };
}

export async function captureThought(tiers, content, {
  tier = "open", metadata, origin = "agent", userConfirmed = false,
  sourceRefs = [], artifactRefs = [], client = "",
} = {}) {
  if (!tiers.includes(tier))
    throw new Error(`This endpoint may not write to tier "${tier}"`);

  const auto = metadata ? null : await extractMetadata(content);
  const proposed = {
    ...(auto || {}), ...(metadata || {}),
    lifecycle: metadata?.lifecycle || "current", source: "mimers-brain", origin,
    source_refs: [...new Set([...(metadata?.source_refs || []), ...sourceRefs])],
    artifact_refs: [...new Set([...(metadata?.artifact_refs || []), ...artifactRefs])],
  };
  // Trust is assigned by the authenticated route, never by model-extracted or
  // caller-supplied metadata. Otherwise an extractor could accidentally promote
  // its own inference to a user instruction by returning extra JSON keys.
  //
  // `captured_by` is on the same footing: it answers "which agent wrote this",
  // so it has to come from the authenticated handshake rather than from
  // whatever the caller typed. `origin: agent` alone is not enough when several
  // harnesses write to the same brain at once.
  for (const field of [
    "provenance", "review_status", "can_use_as_instruction", "can_use_as_evidence",
    "requires_user_confirmation", "reviewed_at", "reviewed_by", "captured_by",
  ]) delete proposed[field];
  const meta = normaliseMeta(
    proposed,
    content,
    { origin, userConfirmed },
  );
  const capturedBy = String(client || "").trim().slice(0, 80);
  if (capturedBy) meta.captured_by = capturedBy;
  const vector = await embed(embeddingText(content, meta)).catch(() => null);

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

export async function reviewThought(tiers, id, action, { actor = "user", note = "" } = {}) {
  const existing = await getThought(tiers, id);
  if (!existing) throw new Error("Not found");
  const metadata = applyReview(existing.metadata, action, { actor });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `UPDATE thoughts SET metadata = $2::jsonb WHERE id = $1 AND tier = ANY($3) RETURNING ${COLS}`,
      [id, JSON.stringify(metadata), tiers],
    );
    await client.query(
      `INSERT INTO memory_review_events (thought_id, action, actor, detail)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [id, action, actor, JSON.stringify(note ? { note: String(note).slice(0, 500) } : {})],
    );
    await client.query("COMMIT");
    return rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function reviewQueue(tiers, { limit = 100 } = {}) {
  const { rows } = await pool.query(
    `SELECT ${COLS} FROM thoughts
      WHERE tier = ANY($1)
        AND (coalesce(metadata->>'review_status', 'confirmed') IN ('pending', 'stale')
             OR (metadata->>'review_status' = 'evidence_only' AND NOT metadata ? 'reviewed_at'))
        AND coalesce(metadata->>'lifecycle', 'current') = 'current'
      ORDER BY CASE metadata->>'review_status' WHEN 'pending' THEN 0 WHEN 'stale' THEN 1 ELSE 2 END,
               created_at DESC LIMIT $2`,
    [tiers, Math.min(Number(limit) || 100, 500)],
  );
  return rows;
}

export async function previewIngest(content, { metadata = {}, origin = "user" } = {}) {
  const text = String(content || "").trim();
  if (!text) throw new Error("Empty source text");
  const extracted = text.length < SMART_INGEST_THRESHOLD
    ? [{ content: text }]
    : await extractAtoms(text);
  const sharedMetadata = { ...metadata };
  delete sharedMetadata.title;
  delete sharedMetadata.summary;
  const candidates = normalisePreviewCandidates(extracted).map((item) => ({
    content: item.content,
    metadata: normaliseMeta({ ...sharedMetadata, ...item.metadata }, item.content, {
      origin, userConfirmed: origin === "user",
    }),
  }));
  return { source_length: text.length, threshold: SMART_INGEST_THRESHOLD, candidates };
}

export async function applyIngest(tiers, {
  source_content, candidates, tier = "open", origin = "user", user_confirmed = false,
  client = "",
} = {}) {
  if (!tiers.includes(tier)) throw new Error(`This endpoint may not write to tier "${tier}"`);
  const source = String(source_content || "").trim();
  if (!source) throw new Error("source_content is required");
  const atoms = normalisePreviewCandidates(candidates);

  // The verbatim source is navigable history, not a current memory and not
  // embedded. A null fingerprint deliberately allows the same source to be
  // imported again without mutating a current exact-match memory.
  const sourceMeta = normaliseMeta({
    title: `Ingest source ${new Date().toISOString().slice(0, 10)}`,
    summary: `Archived source for ${atoms.length} reviewed atomic memories.`,
    kind: "reference", lifecycle: "archived", source_refs: [],
  }, source, { origin, userConfirmed: origin === "user" || user_confirmed });
  const sourceRow = await pool.query(
    `INSERT INTO thoughts (content, metadata, tier, content_fingerprint)
     VALUES ($1, $2::jsonb, $3, NULL) RETURNING id`,
    [source, JSON.stringify(sourceMeta), tier],
  );
  const sourceId = sourceRow.rows[0].id;
  const saved = [];
  for (const atom of atoms) {
    const metadata = {
      ...(atom.metadata || {}),
      source_refs: [...new Set([...(atom.metadata?.source_refs || []), `memory:${sourceId}`])],
    };
    const row = await captureThought(tiers, atom.content, {
      tier, metadata, origin, userConfirmed: origin === "user" || user_confirmed, client,
    });
    await linkRelations(tiers, row.id, [sourceId], "derived_from");
    saved.push(row);
  }
  return { source_id: sourceId, count: saved.length, memories: saved };
}

export async function duplicateCandidates(tiers, { threshold = 0.86, limit = 50 } = {}) {
  const { rows } = await pool.query(
    `WITH candidates AS (
       SELECT ${COLS}, embedding FROM thoughts
        WHERE tier = ANY($1) AND embedding IS NOT NULL
          AND coalesce(metadata->>'lifecycle', 'current') = 'current'
          AND coalesce(metadata->>'review_status', 'confirmed') <> 'rejected'
        ORDER BY updated_at DESC LIMIT 750
     )
     SELECT a.id AS left_id, a.content AS left_content, a.metadata AS left_metadata, a.tier AS left_tier,
            b.id AS right_id, b.content AS right_content, b.metadata AS right_metadata, b.tier AS right_tier,
            1 - (a.embedding <=> b.embedding) AS similarity
       FROM candidates a JOIN candidates b ON a.id::text < b.id::text
      WHERE 1 - (a.embedding <=> b.embedding) >= $2
        AND NOT EXISTS (
          SELECT 1 FROM duplicate_resolutions d
           WHERE d.left_id = a.id AND d.right_id = b.id
             AND d.resolved_at >= greatest(a.updated_at, b.updated_at))
      ORDER BY similarity DESC LIMIT $3`,
    [tiers, Number(threshold) || 0.86, Math.min(Number(limit) || 50, 200)],
  );
  return rows;
}

export async function resolveDuplicate(tiers, {
  left_id, right_id, action, canonical_id, merged_content, actor = "user",
} = {}) {
  const left = await getThought(tiers, left_id);
  const right = await getThought(tiers, right_id);
  if (!left || !right || left.id === right.id) throw new Error("Duplicate pair not found");
  const pair = [left.id, right.id].sort();
  if (!["keep_both", "related", "supersede", "merge"].includes(action))
    throw new Error(`Unknown duplicate action "${action}"`);
  if (canonical_id && ![left.id, right.id].includes(canonical_id))
    throw new Error("canonical_id must be one of the duplicate pair ids");
  let result = { action };
  if (action === "related") result = await linkRelations(tiers, canonical_id || left.id,
    [canonical_id === left.id ? right.id : left.id], "related_to");
  if (action === "supersede") {
    const keep = canonical_id === right.id ? right.id : left.id;
    result = await linkSupersession(tiers, keep, [keep === left.id ? right.id : left.id]);
  }
  if (action === "merge") {
    if (!String(merged_content || "").trim()) throw new Error("merged_content is required");
    const tier = left.tier === "vault" || right.tier === "vault" ? "vault" : "open";
    const merged = await captureThought(tiers, String(merged_content).trim(), {
      tier, origin: "user", userConfirmed: true,
    });
    const oldIds = [left.id, right.id].filter((id) => id !== merged.id);
    result = oldIds.length
      ? { ...merged, ...(await linkSupersession(tiers, merged.id, oldIds)) }
      : merged;
  }
  await pool.query(
    `INSERT INTO duplicate_resolutions (left_id, right_id, resolution, actor, result)
     VALUES ($1,$2,$3,$4,$5::jsonb)
     ON CONFLICT (left_id, right_id) DO UPDATE
       SET resolution = EXCLUDED.resolution, actor = EXCLUDED.actor,
           result = EXCLUDED.result, resolved_at = now()`,
    [pair[0], pair[1], action, actor, JSON.stringify(result)],
  );
  return result;
}

export async function createRecallTrace(tiers, rows, ctx = {}) {
  const listener = tiers.includes("vault") ? "full" : "open";
  const ids = rows.map((row) => row.id);
  const { rows: made } = await pool.query(
    `INSERT INTO recall_traces (listener, client, client_version, result_ids)
     VALUES ($1,$2,$3,$4::uuid[]) RETURNING id`,
    [listener, ctx.client || "unknown", ctx.clientVersion || null, ids],
  );
  return made[0].id;
}

export async function reportRecallUsage(tiers, traceId, { used_ids = [], ignored_ids = [] } = {}) {
  const listeners = listenersFor(tiers);
  const used = [...new Set(used_ids.map(String))];
  const ignored = [...new Set(ignored_ids.map(String))].filter((id) => !used.includes(id));
  const { rows } = await pool.query(
    `UPDATE recall_traces
        SET used_ids = $2::uuid[], ignored_ids = $3::uuid[], reported_at = now()
      WHERE id = $1 AND listener = ANY($4)
        AND $2::uuid[] <@ result_ids AND $3::uuid[] <@ result_ids
      RETURNING id, result_ids, used_ids, ignored_ids, reported_at`,
    [traceId, used, ignored, listeners],
  );
  if (!rows[0]) throw new Error("Recall trace not found or contains ids not returned by that search");
  return rows[0];
}

export async function recallTraces(tiers, { limit = 100 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, created_at, listener, client, client_version, result_ids,
            used_ids, ignored_ids, reported_at
       FROM recall_traces WHERE listener = ANY($1)
      ORDER BY created_at DESC LIMIT $2`,
    [listenersFor(tiers), Math.min(Number(limit) || 100, 500)],
  );
  return rows;
}

export async function updateThought(tiers, id, { content, metadata, tier }) {
  const existing = await getThought(tiers, id);
  if (!existing) throw new Error("Not found");
  if (tier && !tiers.includes(tier))
    throw new Error(`This endpoint may not move rows to tier "${tier}"`);

  const sets = [];
  const args = [id];
  const nextContent = typeof content === "string" ? content : existing.content;
  const nextMeta = metadata
    ? normaliseMeta(metadata, nextContent)
    : normaliseMeta(existing.metadata, nextContent);
  if (typeof content === "string") {
    sets.push(`content = $${args.push(content)}`);
    sets.push(`content_fingerprint = $${args.push(fingerprint(content))}`);
  }
  // Replaces the whole object, so callers must send back the keys they want to
  // keep. The UI merges against what it already has for exactly this reason.
  if (metadata) sets.push(`metadata = $${args.push(JSON.stringify(nextMeta))}::jsonb`);
  if (typeof content === "string" || metadata) {
    const vector = await embed(embeddingText(nextContent, nextMeta)).catch(() => null);
    if (vector) sets.push(`embedding = $${args.push(JSON.stringify(vector))}::vector`);
  }
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
    CREATE TABLE IF NOT EXISTS thought_relations (
        from_id    uuid NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
        to_id      uuid NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
        relation   text NOT NULL CHECK (relation IN (
          'supersedes', 'related_to', 'derived_from', 'conflicts_with', 'merged_into', 'source_of'
        )),
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (from_id, to_id, relation),
        CHECK (from_id <> to_id)
    );
    CREATE INDEX IF NOT EXISTS thought_relations_to_idx
        ON thought_relations (to_id, relation);

    ALTER TABLE thought_relations DROP CONSTRAINT IF EXISTS thought_relations_relation_check;
    ALTER TABLE thought_relations ADD CONSTRAINT thought_relations_relation_check
      CHECK (relation IN (
        'supersedes', 'related_to', 'derived_from', 'conflicts_with', 'merged_into', 'source_of'
      ));

    CREATE TABLE IF NOT EXISTS memory_review_events (
        id          bigserial PRIMARY KEY,
        thought_id  uuid NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
        reviewed_at timestamptz NOT NULL DEFAULT now(),
        action      text NOT NULL,
        actor       text NOT NULL DEFAULT 'user',
        detail      jsonb NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE TABLE IF NOT EXISTS duplicate_resolutions (
        left_id     uuid NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
        right_id    uuid NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
        resolution  text NOT NULL,
        actor       text NOT NULL DEFAULT 'user',
        result      jsonb NOT NULL DEFAULT '{}'::jsonb,
        resolved_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (left_id, right_id),
        CHECK (left_id::text < right_id::text)
    );

    CREATE TABLE IF NOT EXISTS recall_traces (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        created_at     timestamptz NOT NULL DEFAULT now(),
        listener       text NOT NULL CHECK (listener IN ('full', 'open')),
        client         text NOT NULL,
        client_version text,
        result_ids     uuid[] NOT NULL DEFAULT '{}',
        used_ids       uuid[] NOT NULL DEFAULT '{}',
        ignored_ids    uuid[] NOT NULL DEFAULT '{}',
        reported_at    timestamptz
    );
    CREATE INDEX IF NOT EXISTS recall_traces_created_idx ON recall_traces (created_at DESC);

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

// How long telemetry is kept is an operational choice, not a deployment
// constant, so it lives in app_settings and the Statistics page can change it
// without an edit to .env and a restart. The env value is the fallback for a
// brain that has never been asked. 0 means "keep everything" - a deliberate
// choice too, and the only value that makes pruning do nothing at all.
export const RETENTION_CHOICES = [0, 30, 90, 180, 365, 730, 1825];

export async function getRetentionDays() {
  const stored = Number(await getSetting("usage_retention_days").catch(() => null));
  if (Number.isFinite(stored) && RETENTION_CHOICES.includes(stored)) return stored;
  return RETENTION_DAYS;
}

export async function setRetentionDays(days) {
  const value = Number(days);
  if (!RETENTION_CHOICES.includes(value))
    throw new Error(`Retention must be one of ${RETENTION_CHOICES.join(", ")} days`);
  await setSetting("usage_retention_days", String(value));
  return value;
}

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
  const days = await getRetentionDays();
  if (!days) return 0;
  const { rows } = await pool.query(
    `WITH usage AS (
       DELETE FROM usage_events WHERE at < now() - ($1 || ' days')::interval RETURNING 1
     ), traces AS (
       DELETE FROM recall_traces WHERE created_at < now() - ($1 || ' days')::interval RETURNING 1
     )
     SELECT (SELECT count(*) FROM usage) + (SELECT count(*) FROM traces) AS count`,
    [String(days)],
  );
  return Number(rows[0].count);
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
    `SELECT date_trunc($2, created_at AT TIME ZONE $4)::date AS bucket,
            count(*) AS count,
            count(*) FILTER (WHERE coalesce(metadata->>'lifecycle', 'current') = 'current'
                               AND coalesce(metadata->>'review_status', 'confirmed') <> 'rejected') AS active,
            count(*) FILTER (WHERE coalesce(metadata->>'lifecycle', 'current') <> 'current'
                                OR coalesce(metadata->>'review_status', 'confirmed') = 'rejected') AS inactive
       FROM thoughts
      WHERE tier = ANY($1)
        AND created_at > now() - ($3 || ' days')::interval
      GROUP BY 1 ORDER BY 1`,
    [tiers, BUCKET[unit], String(span), TZ],
  );
  return rows.map((r) => ({
    bucket: r.bucket,
    count: Number(r.count),
    active: Number(r.active),
    inactive: Number(r.inactive),
  }));
}

async function memoryHealth(tiers) {
  const { rows } = await pool.query(
    `WITH base AS (
       SELECT id, metadata, embedding, created_at
         FROM thoughts WHERE tier = ANY($1)
     ), normalised AS (
       SELECT *,
              coalesce(nullif(metadata->>'lifecycle', ''), 'current') AS lifecycle,
              coalesce(nullif(metadata->>'review_status', ''), 'confirmed') AS review_status,
              coalesce(nullif(metadata->>'origin', ''), 'legacy') AS origin,
              coalesce(nullif(metadata->>'provenance', ''), 'imported') AS provenance,
              coalesce(nullif(metadata->>'kind', ''), nullif(metadata->>'type', ''), 'unknown') AS kind,
              nullif(metadata->>'project', '') AS project,
              CASE
                WHEN metadata->>'review_status' = 'evidence_only'
                 AND metadata->>'can_use_as_evidence' = 'false'
                  THEN 'restricted'
                ELSE coalesce(nullif(metadata->>'review_status', ''), 'confirmed')
              END AS review_bucket
         FROM base
     ), active AS (
       SELECT * FROM normalised WHERE lifecycle = 'current' AND review_status <> 'rejected'
     ), pending AS (
       SELECT * FROM normalised
        WHERE lifecycle = 'current'
          AND (review_status IN ('pending', 'stale')
               OR (review_status = 'evidence_only' AND NOT metadata ? 'reviewed_at'))
     )
     SELECT
       (SELECT count(*) FROM normalised) AS records,
       (SELECT count(*) FROM active) AS active,
       (SELECT count(*) FROM normalised WHERE lifecycle <> 'current' OR review_status = 'rejected') AS inactive,
       (SELECT count(*) FROM normalised WHERE lifecycle = 'archived') AS archived,
       (SELECT count(*) FROM normalised WHERE lifecycle = 'superseded') AS superseded,
       (SELECT count(*) FROM pending) AS pending_review,
       (SELECT min(created_at) FROM pending) AS oldest_pending,
       (SELECT count(*) FROM active WHERE embedding IS NULL) AS unembedded,
       (SELECT count(*) FROM active
         WHERE coalesce(metadata->>'title', '') = ''
            OR coalesce(metadata->>'summary', '') = ''
            OR coalesce(metadata->>'kind', '') = ''
            OR coalesce(metadata->>'origin', '') = ''
            OR coalesce(metadata->>'provenance', '') = ''
            OR coalesce(metadata->>'review_status', '') = '') AS incomplete,
       (SELECT count(DISTINCT n.id) FROM normalised n
         WHERE n.lifecycle = 'archived' AND EXISTS (
           SELECT 1 FROM thought_relations r
            WHERE r.to_id = n.id AND r.relation = 'derived_from')) AS archived_sources,
       (SELECT count(*) FROM memory_review_events e JOIN thoughts t ON t.id = e.thought_id
         WHERE t.tier = ANY($1)) AS reviews_total,
       (SELECT count(*) FROM memory_review_events e JOIN thoughts t ON t.id = e.thought_id
         WHERE t.tier = ANY($1)
           AND e.reviewed_at >= date_trunc('week', now() AT TIME ZONE $2) AT TIME ZONE $2) AS reviews_week,
       (SELECT count(*) FROM duplicate_resolutions d
          JOIN thoughts l ON l.id = d.left_id JOIN thoughts r ON r.id = d.right_id
         WHERE l.tier = ANY($1) AND r.tier = ANY($1)) AS duplicate_decisions,
       (SELECT jsonb_object_agg(review_bucket, c) FROM (
          SELECT review_bucket, count(*) AS c FROM normalised GROUP BY review_bucket
        ) x) AS review_statuses,
       (SELECT jsonb_object_agg(lifecycle, c) FROM (
          SELECT lifecycle, count(*) AS c FROM normalised GROUP BY lifecycle
        ) x) AS lifecycles,
       (SELECT jsonb_object_agg(origin, c) FROM (
          SELECT origin, count(*) AS c FROM normalised GROUP BY origin
        ) x) AS origins,
       (SELECT jsonb_object_agg(provenance, c) FROM (
          SELECT provenance, count(*) AS c FROM normalised GROUP BY provenance
        ) x) AS provenance,
       (SELECT jsonb_object_agg(kind, c) FROM (
          SELECT kind, count(*) AS c FROM normalised GROUP BY kind
        ) x) AS kinds,
       (SELECT jsonb_object_agg(project, c) FROM (
          SELECT project, count(*) AS c FROM normalised WHERE project IS NOT NULL GROUP BY project
        ) x) AS projects`,
    [tiers, TZ],
  );
  const r = rows[0];
  return {
    records: Number(r.records),
    active: Number(r.active),
    inactive: Number(r.inactive),
    archived: Number(r.archived),
    superseded: Number(r.superseded),
    pendingReview: Number(r.pending_review),
    oldestPending: r.oldest_pending || null,
    unembedded: Number(r.unembedded),
    incomplete: Number(r.incomplete),
    archivedSources: Number(r.archived_sources),
    reviewsTotal: Number(r.reviews_total),
    reviewsWeek: Number(r.reviews_week),
    duplicateDecisions: Number(r.duplicate_decisions),
    reviewStatuses: r.review_statuses || {},
    lifecycles: r.lifecycles || {},
    origins: r.origins || {},
    provenance: r.provenance || {},
    kinds: r.kinds || {},
    projects: r.projects || {},
  };
}

async function recallStats(listeners, days) {
  const [summary, daily, clients] = await Promise.all([
    pool.query(
      `WITH scoped AS (SELECT * FROM recall_traces WHERE listener = ANY($1))
       SELECT
         count(*) AS searches,
         count(*) FILTER (WHERE reported_at IS NOT NULL) AS reports,
         count(*) FILTER (WHERE reported_at IS NULL AND created_at < now() - interval '10 minutes') AS overdue,
         coalesce(sum(cardinality(result_ids)), 0) AS returned,
         coalesce(sum(cardinality(result_ids)) FILTER (WHERE reported_at IS NOT NULL), 0) AS reported_returned,
         coalesce(sum(cardinality(used_ids)), 0) AS used,
         coalesce(sum(cardinality(ignored_ids)), 0) AS ignored,
         min(created_at) AS first,
         max(created_at) AS last,
         count(*) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2) AS today_searches,
         count(*) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2
                           AND reported_at IS NOT NULL) AS today_reports,
         count(*) FILTER (WHERE created_at >= date_trunc('week', now() AT TIME ZONE $2) AT TIME ZONE $2) AS week_searches,
         count(*) FILTER (WHERE created_at >= date_trunc('week', now() AT TIME ZONE $2) AT TIME ZONE $2
                           AND reported_at IS NOT NULL) AS week_reports
       FROM scoped`,
      [listeners, TZ],
    ),
    pool.query(
      `SELECT date_trunc('day', created_at AT TIME ZONE $3)::date AS bucket,
              count(*) FILTER (WHERE reported_at IS NOT NULL) AS reported,
              count(*) FILTER (WHERE reported_at IS NULL) AS unreported,
              coalesce(sum(cardinality(used_ids)), 0) AS used,
              greatest(coalesce(sum(cardinality(result_ids)) FILTER (WHERE reported_at IS NOT NULL), 0)
                       - coalesce(sum(cardinality(used_ids)), 0), 0) AS unused
         FROM recall_traces
        WHERE listener = ANY($1) AND created_at > now() - ($2 || ' days')::interval
        GROUP BY 1 ORDER BY 1`,
      [listeners, String(days), TZ],
    ),
    pool.query(
      `SELECT client, max(client_version) AS version,
              count(*) AS searches,
              count(*) FILTER (WHERE reported_at IS NOT NULL) AS reports,
              count(*) FILTER (WHERE reported_at IS NULL AND created_at < now() - interval '10 minutes') AS overdue,
              coalesce(sum(cardinality(result_ids)) FILTER (WHERE reported_at IS NOT NULL), 0) AS reported_returned,
              coalesce(sum(cardinality(used_ids)), 0) AS used,
              max(created_at) AS last
         FROM recall_traces WHERE listener = ANY($1)
        GROUP BY client ORDER BY searches DESC LIMIT 25`,
      [listeners],
    ),
  ]);
  const r = summary.rows[0];
  const searches = Number(r.searches);
  const reports = Number(r.reports);
  const reportedReturned = Number(r.reported_returned);
  const used = Number(r.used);
  const percent = (part, whole) => whole ? Math.round(part * 1000 / whole) / 10 : null;
  return {
    searches,
    reports,
    overdue: Number(r.overdue),
    returned: Number(r.returned),
    reportedReturned,
    used,
    ignored: Number(r.ignored),
    reportingPercent: percent(reports, searches),
    usePercent: percent(used, reportedReturned),
    first: r.first || null,
    last: r.last || null,
    today: { searches: Number(r.today_searches), reports: Number(r.today_reports) },
    week: { searches: Number(r.week_searches), reports: Number(r.week_reports) },
    daily: daily.rows.map((row) => ({
      bucket: row.bucket,
      reported: Number(row.reported),
      unreported: Number(row.unreported),
      used: Number(row.used),
      unused: Number(row.unused),
    })),
    byClient: clients.rows.map((row) => ({
      client: row.client,
      version: row.version,
      searches: Number(row.searches),
      reports: Number(row.reports),
      overdue: Number(row.overdue),
      reportedReturned: Number(row.reported_returned),
      used: Number(row.used),
      reportingPercent: percent(Number(row.reports), Number(row.searches)),
      usePercent: percent(Number(row.used), Number(row.reported_returned)),
      last: row.last,
    })),
  };
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

  const [daily, monthly, yearly, memDaily, memMonthly, calls, memories, health, recall, byClient, byTool, byAction] =
    await Promise.all([
      usageSeries(listeners, "day", days),
      usageSeries(listeners, "month", months * 31),
      usageSeries(listeners, "year", 3650),
      memorySeries(tiers, "day", days),
      memorySeries(tiers, "month", months * 31),
      windowCounts("usage_events WHERE listener = ANY($1)", [listeners], "at"),
      windowCounts("thoughts WHERE tier = ANY($1)", [tiers], "created_at"),
      memoryHealth(tiers),
      recallStats(listeners, days),
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
        `SELECT tool, count(*) AS calls,
                count(*) FILTER (WHERE NOT ok) AS errors,
                round(avg(ms)) AS avg_ms,
                (percentile_cont(0.95) WITHIN GROUP (ORDER BY ms))::integer AS p95_ms
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
    retentionDays: await getRetentionDays(),
    retentionChoices: RETENTION_CHOICES,
    calls,
    memories,
    memoryHealth: health,
    recall,
    daily, monthly, yearly,
    memoryDaily: memDaily,
    memoryMonthly: memMonthly,
    byClient: num(byClient.rows, "calls", "reads", "writes", "deletes", "errors"),
    byTool: num(byTool.rows, "calls", "errors", "avg_ms", "p95_ms"),
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
       (SELECT count(*) FROM thoughts WHERE tier = ANY($1)
          AND coalesce(metadata->>'lifecycle', 'current') = 'current'
          AND (coalesce(metadata->>'review_status', 'confirmed') IN ('pending', 'stale')
               OR (metadata->>'review_status' = 'evidence_only' AND NOT metadata ? 'reviewed_at'))) AS mem_pending_review,
       (SELECT count(*) FROM thoughts WHERE tier = ANY($1)
          AND coalesce(metadata->>'lifecycle', 'current') = 'current'
          AND metadata->>'review_status' = 'evidence_only') AS mem_evidence_only,
       (SELECT count(*) FROM thoughts WHERE tier = ANY($1)
          AND coalesce(metadata->>'lifecycle', 'current') = 'current'
          AND metadata->>'review_status' = 'stale') AS mem_stale,
       (SELECT count(*) FROM thoughts WHERE tier = ANY($1) AND created_at >= (SELECT v FROM d)) AS mem_today,
       (SELECT count(*) FROM thoughts WHERE tier = ANY($1) AND created_at >= (SELECT v FROM w)) AS mem_week,
       (SELECT count(*) FROM thoughts WHERE tier = ANY($1) AND created_at >= (SELECT v FROM m)) AS mem_month,
       (SELECT count(*) FROM thoughts WHERE tier = ANY($1) AND created_at >= (SELECT v FROM y)) AS mem_year,
       (SELECT max(created_at) FROM thoughts WHERE tier = ANY($1))                 AS mem_last,
       (SELECT count(*) FROM recall_traces WHERE listener = ANY($2)
          AND created_at >= (SELECT v FROM d)) AS recall_searches_today,
       (SELECT count(*) FROM recall_traces WHERE listener = ANY($2)
          AND created_at >= (SELECT v FROM d) AND reported_at IS NOT NULL) AS recall_reports_today,
       (SELECT coalesce(sum(cardinality(result_ids)), 0) FROM recall_traces
          WHERE listener = ANY($2) AND created_at >= (SELECT v FROM d)) AS recall_returned_today,
       (SELECT coalesce(sum(cardinality(result_ids)), 0) FROM recall_traces
          WHERE listener = ANY($2) AND created_at >= (SELECT v FROM d)
            AND reported_at IS NOT NULL) AS recall_reported_returned_today,
       (SELECT coalesce(sum(cardinality(used_ids)), 0) FROM recall_traces
          WHERE listener = ANY($2) AND created_at >= (SELECT v FROM d)) AS recall_used_today,
       (SELECT count(*) FROM recall_traces WHERE listener = ANY($2)
          AND created_at < now() - interval '10 minutes'
          AND reported_at IS NULL) AS recall_unreported,
       (SELECT max(created_at) FROM recall_traces WHERE listener = ANY($2)) AS recall_last,
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
    memories_pending_review: n(r.mem_pending_review),
    memories_evidence_only: n(r.mem_evidence_only),
    memories_stale: n(r.mem_stale),
    memories_today: n(r.mem_today),
    memories_week: n(r.mem_week),
    memories_month: n(r.mem_month),
    memories_year: n(r.mem_year),
    last_memory: r.mem_last ? new Date(r.mem_last).toISOString() : null,
    recall_searches_today: n(r.recall_searches_today),
    recall_reports_today: n(r.recall_reports_today),
    recall_memories_returned_today: n(r.recall_returned_today),
    recall_memories_used_today: n(r.recall_used_today),
    recall_unreported: n(r.recall_unreported),
    recall_reporting_percent_today: n(r.recall_searches_today)
      ? Math.round(n(r.recall_reports_today) * 1000 / n(r.recall_searches_today)) / 10 : null,
    recall_use_percent_today: n(r.recall_reported_returned_today)
      ? Math.round(n(r.recall_used_today) * 1000 / n(r.recall_reported_returned_today)) / 10 : null,
    last_recall: r.recall_last ? new Date(r.recall_last).toISOString() : null,
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

// Counted in SQL rather than by reading the table into Node. This used to fetch
// every row's metadata and tally it in a loop, which is fine at a few dozen
// memories and not at a few thousand: the sidebar is refreshed on every search
// keystroke, so its cost is paid constantly.
//
// Measured at 20 000 memories: the old shape spent ~43 ms in Postgres and ~590 ms
// end to end. Almost all of the difference was the driver decoding 20 000 JSONB
// values into JS objects. Postgres does the same counting in ~53 ms, so the win
// is not that SQL counts faster - it is that the answer is one row instead of
// twenty thousand.
//
// The jsonb_typeof guards are the old Array.isArray() checks: metadata is
// free-form, and one hand-edited row whose topics is not an array must not be
// able to fail the whole call.
export async function stats(tiers) {
  const { rows } = await pool.query(
    `WITH base AS (SELECT metadata, tier, created_at FROM thoughts WHERE tier = ANY($1))
     SELECT
       (SELECT count(*)        FROM base) AS total,
       (SELECT min(created_at) FROM base) AS first,
       (SELECT max(created_at) FROM base) AS last,
       (SELECT jsonb_object_agg(tier, c)
          FROM (SELECT tier, count(*) AS c FROM base GROUP BY tier) x) AS by_tier,
       (SELECT jsonb_object_agg(type, c)
          FROM (SELECT metadata->>'type' AS type, count(*) AS c FROM base
                 WHERE coalesce(metadata->>'type', '') <> ''
                 GROUP BY 1) x) AS types,
       (SELECT jsonb_object_agg(kind, c)
          FROM (SELECT coalesce(nullif(metadata->>'kind', ''), metadata->>'type', 'unknown') AS kind,
                       count(*) AS c FROM base GROUP BY 1) x) AS kinds,
       (SELECT jsonb_object_agg(lifecycle, c)
          FROM (SELECT coalesce(nullif(metadata->>'lifecycle', ''), 'current') AS lifecycle,
                       count(*) AS c FROM base GROUP BY 1) x) AS lifecycles,
       (SELECT jsonb_object_agg(task_status, c)
          FROM (SELECT metadata->>'task_status' AS task_status, count(*) AS c FROM base
                 WHERE coalesce(metadata->>'task_status', '') <> '' GROUP BY 1) x) AS task_statuses,
       (SELECT jsonb_object_agg(project, c)
          FROM (SELECT metadata->>'project' AS project, count(*) AS c FROM base
                 WHERE coalesce(metadata->>'project', '') <> '' GROUP BY 1) x) AS projects,
       (SELECT jsonb_object_agg(topic, c)
          FROM (SELECT topic, count(*) AS c
                  FROM (SELECT metadata->'topics' AS arr FROM base
                         WHERE jsonb_typeof(metadata->'topics') = 'array') s,
                       jsonb_array_elements_text(s.arr) AS topic
                 GROUP BY 1) x) AS topics,
       (SELECT jsonb_object_agg(person, c)
          FROM (SELECT person, count(*) AS c
                  FROM (SELECT metadata->'people' AS arr FROM base
                         WHERE jsonb_typeof(metadata->'people') = 'array') s,
                       jsonb_array_elements_text(s.arr) AS person
                 GROUP BY 1) x) AS people,
       (SELECT jsonb_object_agg(system, c)
          FROM (SELECT system, count(*) AS c
                  FROM (SELECT metadata->'systems' AS arr FROM base
                         WHERE jsonb_typeof(metadata->'systems') = 'array') s,
                       jsonb_array_elements_text(s.arr) AS system
                 GROUP BY 1) x) AS systems`,
    [tiers],
  );
  const r = rows[0];
  return {
    total: Number(r.total),
    byTier: r.by_tier || {},
    types: r.types || {},
    kinds: r.kinds || {},
    lifecycles: r.lifecycles || {},
    taskStatuses: r.task_statuses || {},
    projects: r.projects || {},
    topics: r.topics || {},
    people: r.people || {},
    systems: r.systems || {},
    // min/max, not a sort. The old code sorted Date objects with the default
    // comparator, which compares them as strings - so it ordered by weekday name
    // and these two came out wrong. Nothing reads them yet, which is why it was
    // never noticed.
    first: r.first || null,
    last: r.last || null,
  };
}
