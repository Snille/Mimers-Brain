// Database access and embeddings.
//
// Every query takes an explicit `tiers` array. It is always derived from the
// listener the request arrived on - never from a header, a parameter or
// anything else the caller can influence.

import pg from "pg";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  CANONICAL_TOPICS,
  MEMORY_KINDS,
  SMART_INGEST_THRESHOLD,
  ageNote,
  applyReview,
  embeddingText,
  inheritsConfirmedTrust,
  normaliseMeta,
} from "./memory-model.mjs";
import { fallbackAtoms, normalisePreviewCandidates } from "./smart-ingest.mjs";
import { semanticAxes } from "./semantic.mjs";
import { refuseSecrets } from "./secret-gate.mjs";
import * as ai from "./ai.mjs";

export { normaliseMeta } from "./memory-model.mjs";

export const OPEN = ["open"];
export const ALL = ["open", "vault"];

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 8,
});

// --- who is writing -----------------------------------------------------------
//
// The change log is written by a trigger, so it also catches what never passes
// through this file: a psql session, a one-off script, a loop with the wrong
// filter. A trigger cannot see the HTTP request, though, so the writer's name
// travels as a transaction-local setting. Each request runs inside runAs(), and
// every write here goes through transaction(), which hands the name to Postgres before
// the first statement. Anything that writes without it is logged as
// "sql:<role>" - which is exactly the honest answer for a direct SQL session.
const actorStore = new AsyncLocalStorage();

export function runAs(actor, work) {
  return actorStore.run(String(actor || "unknown").trim().slice(0, 80) || "unknown", work);
}

export const currentActor = () => actorStore.getStore() || "server";

export async function transaction(work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('mimers.actor', $1, true)", [currentActor()]);
    const out = await work(client);
    await client.query("COMMIT");
    return out;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
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

// A vector the column cannot hold is no vector at all. It happens in one narrow
// window: a save that asked the old model just before a switch, and wrote just
// after it. Saved unembedded, the row is picked up by fillMissingEmbeddings().
export async function embed(text) {
  if (!ai.roleReady("embedding")) return null;
  const [vector] = await ai.embedInputs(text);
  const { dimensions } = ai.role("embedding");
  return Array.isArray(vector) && (!dimensions || vector.length === dimensions) ? vector : null;
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
  return `- "topics": 1-3 values chosen only from: ${topicSubjects().join(", ")}\n` +
    `  Use "other" only when not one of those values applies to the text, and never\n` +
    `  beside a value that does apply.\n`;
}

function topicSubjects() {
  return CANONICAL_TOPICS.filter((topic) => topic !== "other");
}

// The rule above sits at the top of the prompt, which holds while the text is
// short. Before replacements gained the same atomic-ingest guard as capture, a
// 4500-character body could reach extraction whole. Two such Swedish memories
// about Mimers Brain itself came back as topics ["other"] on 2026-08-20 with
// project correctly set to "mimers-brain", so the subject was never in doubt -
// the closed list had simply scrolled thousands of characters out of reach by
// the time the answer was written. Repeating the list and the last-resort
// sentence after the text remains useful defence in depth for direct extraction
// callers and legacy content.
export function topicReminder() {
  return `Choose "topics" only from this list: ${topicSubjects().join(", ")}\n` +
    `"other" is the last resort: use it only when no value on that list applies to\n` +
    `the text above, and never beside a value that does apply. When "project" names\n` +
    `a subject that is on the list, that subject belongs in "topics".\n`;
}

// project is the one facet with no closed vocabulary, so the rule carries its own
// guard rails: reuse what exists, and never reach for a topic word - which is
// where a memory landed under the project "docker" on 2026-08-19.
export function projectRule(existing) {
  const line = `- "project": one lower-kebab-case owning project, or empty\n`;
  const reuse = existing.length
    ? `  Reuse an existing project name when the text belongs to one of these: ${existing.join(", ")}\n` +
      `  Invent a new name only when none of them owns the text. A topic word such as ` +
      `${CANONICAL_TOPICS.slice(0, 6).join(", ")} names a subject, never a project.\n`
    : "";
  return line + reuse +
    `  The project is the repository or service the memory is about, never the client, harness, ` +
    `assistant or test tool that happened to perform the work. Prefer an explicit repository name ` +
    `or the project folder in a path from the text; leave project empty when ownership is unclear.\n`;
}

// The model proposes metadata, but memory-model.mjs owns the vocabulary and
// validation. Free-form output is never written directly.
export async function extractMetadata(text) {
  if (!ai.roleReady("metadata")) return { topics: ["mimers-brain"], kind: "fact", type: "observation" };
  const existingProjects = await knownProjects();
  try {
    return await ai.chatJson(ai.role("metadata"),
            `Extract long-term-memory metadata as JSON. Return only these keys:\n` +
            // The language rule and "never the opening words" are the two that
            // matter: without them the model answered Swedish text in English
            // and often returned the first 180 or 500 characters cut mid-word.
            `Write "title" and "summary" in the SAME LANGUAGE as the text (Swedish text gets Swedish metadata).\n` +
            `- "title": a short descriptive name for THIS text, at most 100 characters. Name the subject;\n` +
            `  never copy or cut off the opening words of the text.\n` +
            `- "summary": the current conclusion of THIS text in one to three complete sentences, at most\n` +
            `  400 characters. Keep the key names, numbers and rules; never copy or cut off the text.\n` +
            `- "kind": one of ${MEMORY_KINDS.join(", ")}\n` +
            `  fact = stable current fact; reference = stable lookup information; procedure = reusable steps;\n` +
            `  decision = an explicit choice; lesson = a reusable conclusion; incident = an observed failure;\n` +
            `  task = only an explicitly unfinished action with a concrete next step; idea = uncommitted future possibility;\n` +
            `  preference = what a person wants; profile = stable information about a person.\n` +
            `  Completed work, a status report, release notes, test results and session history are never tasks.\n` +
            `- "task_status": "pending" or "done", only when kind is task\n` +
            projectRule(existingProjects) +
            `- "people": named human beings only, and only names written in the text.\n` +
            `  Tools, services, apps, accounts, companies and devices are NOT people;\n` +
            `  Luba/Sleipner is a robot mower. Never derive a name from surrounding prose.\n` +
            `- "systems": software, services, tools, machines, devices and named robots\n` +
            topicRule() +
            `- "verified_at": YYYY-MM-DD when the text states a verification date, or empty\n` +
            `Do not invent facts. lifecycle is always set by the server.\n\n` +
            `<<<TEXT\n${text}\nTEXT>>>\n\n` +
            topicReminder());
  } catch {
    return { topics: ["mimers-brain"], kind: "fact", type: "observation" };
  }
}

async function extractAtoms(text) {
  if (!ai.roleReady("metadata")) return fallbackAtoms(text).map((content) => ({ content }));
  try {
    const parsed = await ai.chatJson(ai.role("metadata"),
            `Split this source into durable, standalone, atomic long-term memories. ` +
            `Return JSON {"memories":[{"content":"..."}]}. Keep decisions, facts, procedures, ` +
            `preferences, lessons and concrete future tasks. Omit greetings, transcript noise, ` +
            `tentative reasoning, repetitions, raw secrets and anything without lasting value. ` +
            `Do not invent information. Maximum 30 memories, each below 1800 characters.\n\n${text}`);
    return normalisePreviewCandidates(parsed.memories);
  } catch {
    return fallbackAtoms(text).map((content) => ({ content }));
  }
}

const COLS = "id, content, metadata, tier, created_at, updated_at";

// What the session digest contains, as one condition, so the digest, the
// Thoughts filter and its count can never disagree. See memoryDigest().
const DIGEST_SQL = `coalesce(metadata->>'lifecycle', 'current') = 'current'
        AND coalesce(metadata->>'review_status', 'confirmed') = 'confirmed'
        AND coalesce(metadata->>'can_use_as_instruction', 'true') = 'true'
        AND (metadata->>'pinned' = 'true'
             OR (metadata->>'kind' IN ('preference', 'profile') AND coalesce(metadata->>'pinned', '') <> 'false'))`;

export async function listThoughts(tiers, {
  limit = 10, type, kind, lifecycle = "current", taskStatus, task_status, project,
  topic, person, system, days, digest,
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
  if (digest) sql += ` AND ${DIGEST_SQL}`;
  sql += ` ORDER BY created_at DESC LIMIT $${args.push(Math.min(limit, 200))}`;
  return (await pool.query(sql, args)).rows;
}

// 0.3, not OB1's 0.5: measured against Swedish paraphrases, an identical
// sentence scores 1.00, shared keywords ~0.79, and a loose rewording with no
// words in common ~0.43. A 0.5 default silently drops that last case, which is
// exactly the kind of recall the brain exists for.
// What the recall receipts say about each memory: how often it was returned
// and then used, and how often returned and passed over. Counted since the
// memory was last reviewed, so confirming a memory on the Review page gives it
// a clean slate.
const RECEIPTS_CTE = `receipts AS (
       SELECT r.thought_id,
              count(*) FILTER (WHERE r.used) AS used,
              count(*) FILTER (WHERE NOT r.used) AS ignored
         FROM (SELECT unnest(used_ids) AS thought_id, true AS used, created_at FROM recall_traces
               UNION ALL
               SELECT unnest(ignored_ids), false, created_at FROM recall_traces) r
         JOIN thoughts t ON t.id = r.thought_id
        WHERE r.created_at > CASE WHEN t.metadata->>'reviewed_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                                  THEN (t.metadata->>'reviewed_at')::timestamptz ELSE '-infinity' END
        GROUP BY r.thought_id
     ),
     receipt_rate AS (
       SELECT coalesce(sum(used)::double precision / nullif(sum(used + ignored), 0), 0.25) AS rate FROM receipts
     )`;

// A nudge from those receipts, never a verdict: at most about +-0.04 against a
// semantic score that spans 0.3-1.0. The rate is pulled towards the average
// across all memories (two imagined receipts at that rate), so one lucky use
// proves little, and the nudge only reaches full strength after ten receipts.
// Centred on the average, not on 50%: most results are passed over (about
// three in four, on 2026-10-13) simply because a search returns five and one
// answers the question.
const USEFULNESS_SQL = `CASE WHEN receipts.thought_id IS NULL THEN 0 ELSE
              0.06 * ((receipts.used + 2 * (SELECT rate FROM receipt_rate)) / (receipts.used + receipts.ignored + 2)
                      - (SELECT rate FROM receipt_rate))
                   * least(1, (receipts.used + receipts.ignored) / 10.0) END`;

// Returned again and again, used never: likely noise for every query that
// finds it. These go to the Review page, not out of search - a reader decides.
export async function rarelyUseful(tiers, { minimum = 8, limit = 50 } = {}) {
  const { rows } = await pool.query(
    `WITH ${RECEIPTS_CTE}
     SELECT ${COLS.split(", ").map((c) => `thoughts.${c}`).join(", ")},
            receipts.used::int, receipts.ignored::int
       FROM thoughts JOIN receipts ON receipts.thought_id = thoughts.id
      WHERE thoughts.tier = ANY($1) AND receipts.used = 0 AND receipts.ignored >= $2
        AND coalesce(thoughts.metadata->>'lifecycle', 'current') = 'current'
      ORDER BY receipts.ignored DESC, thoughts.created_at DESC LIMIT $3`,
    [tiers, minimum, limit],
  );
  return rows;
}

// The weights of the ranking below. Named so that the recall evaluation
// (scripts/eval-recall.mjs) can try a variant against the live memories
// before anything is changed here; a change to a default belongs with the
// numbers that justified it.
//
// semantic 0.80 and title 0.15 since 0.13.1 (were 0.65 and 0.30): on 44
// answerable questions, 8 of them from real sessions, the right memory came
// first 80% of the time instead of 68%, with hit@5 unchanged at 98%.
export const RANK_WEIGHTS = Object.freeze({
  semantic: 0.80, title: 0.15, lexical: 0.05, titlePhrase: 0.15,
  confirmed: 0.06, pending: -0.02, evidenceOnly: -0.03, stale: -0.05,
  instruction: 0.02, usefulness: 1,
});

export function rankWeights(overrides = {}) {
  const out = { ...RANK_WEIGHTS };
  for (const [key, value] of Object.entries(overrides || {})) {
    if (!(key in RANK_WEIGHTS)) throw new Error(`Unknown rank weight: ${key}`);
    if (!Number.isFinite(Number(value))) throw new Error(`Rank weight ${key} must be a number`);
    out[key] = Number(value);
  }
  return out;
}

export async function searchThoughts(tiers, query, {
  limit = 10, threshold = 0.3, kind, lifecycle = "current", taskStatus, project,
  vector: given, weights,
} = {}) {
  // A generic semantic query for "what remains" otherwise ranks incident
  // reports that contain those words above the actual pending tasks. Treat this
  // common intent as a structured filter unless the caller chose one itself.
  if (!kind && !taskStatus && /\b(?:todo|pending|återstår|kvar att göra|göra senare|follow[- ]?up)\b/i.test(query)) {
    kind = "task";
    taskStatus = "pending";
  }
  const vector = given || await embed(query);
  if (!vector) throw new Error("Semantic search needs a configured embedding model");
  const terms = searchTerms(query);
  const args = [JSON.stringify(vector), query, tiers, threshold, terms, JSON.stringify(rankWeights(weights))];
  const w = (key) => `($6::jsonb->>'${key}')::float8`;
  let filters = `tier = ANY($3) AND coalesce(metadata->>'review_status', 'confirmed') <> 'rejected'`;
  if (lifecycle && lifecycle !== "all")
    filters += ` AND coalesce(metadata->>'lifecycle', 'current') = $${args.push(lifecycle)}`;
  if (kind) filters += ` AND metadata->>'kind' = $${args.push(kind)}`;
  if (taskStatus) filters += ` AND metadata->>'task_status' = $${args.push(taskStatus)}`;
  if (project) filters += ` AND metadata->>'project' = $${args.push(project)}`;
  const limitArg = args.push(Math.min(Number(limit) || 10, 100));
  const { rows } = await pool.query(
    `WITH ${RECEIPTS_CTE},
     ranked AS (
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
                 WHERE lower(coalesce(metadata->>'title', '')) LIKE '%' || term || '%') AS title_score,
              ${USEFULNESS_SQL} AS usefulness
         FROM thoughts LEFT JOIN receipts ON receipts.thought_id = thoughts.id
        WHERE ${filters}
     )
     SELECT *, semantic_score AS similarity,
            semantic_score * ${w("semantic")} + least(title_score, 1) * ${w("title")} +
            least(lexical_score, 1) * ${w("lexical")} +
            CASE WHEN coalesce(metadata->>'title', '') ILIKE '%' || $2 || '%' THEN ${w("titlePhrase")} ELSE 0 END +
            CASE coalesce(metadata->>'review_status', 'confirmed')
              WHEN 'confirmed' THEN ${w("confirmed")} WHEN 'pending' THEN ${w("pending")}
              WHEN 'evidence_only' THEN ${w("evidenceOnly")} WHEN 'stale' THEN ${w("stale")} ELSE 0 END +
            CASE WHEN coalesce(metadata->>'can_use_as_instruction', 'true') = 'true' THEN ${w("instruction")} ELSE 0 END +
            usefulness * ${w("usefulness")}
            AS rank_score
       FROM ranked
      WHERE semantic_score > $4 OR lexical_score > 0
      ORDER BY rank_score DESC, created_at DESC
      LIMIT $${limitArg}`,
    args,
  );
  return rows;
}

// --- live recall --------------------------------------------------------------
//
// The read side of a Claude Code hook (tools/hooks/mimer-recall.py): every prompt
// the user sends is searched once, and only clear hits come back. "Clear" is a
// semantic floor rather than the 0.3 search uses, because nobody asked this
// question - a weak hit here is noise in front of every answer, not recall.
//
// No recall trace is created. The model did not search, so it owes no receipt;
// a trace it was never told about would only sit in the statistics as overdue.
// The prompt itself is never stored, like every other query. It does reach the
// embedder, so a prompt with a credential pasted into it is not searched at all.
export const HINT_FLOOR = Number(process.env.RECALL_HINT_FLOOR || 0.5);
const HINT_MAX = 3;
const HINT_PROMPT_CHARS = 2000;

export async function recallHint(tiers, prompt, { exclude = [], floor = HINT_FLOOR } = {}) {
  const text = String(prompt || "").trim().slice(0, HINT_PROMPT_CHARS);
  if (text.length < 12) return { hits: [], skipped: "short" };
  try { refuseSecrets(text); } catch { return { hits: [], skipped: "secret" }; }
  if (!ai.roleReady("embedding")) return { hits: [], skipped: "no embedding model configured" };
  const skip = new Set((Array.isArray(exclude) ? exclude : []).map(String));
  const rows = await searchThoughts(tiers, text, { limit: 8, threshold: floor });
  const hits = rows
    .filter((row) => row.semantic_score >= floor && !skip.has(row.id))
    .slice(0, HINT_MAX)
    .map((row) => {
      const m = row.metadata || {};
      return {
        id: row.id,
        title: m.title || row.content.replace(/\s+/g, " ").slice(0, 100),
        summary: m.summary || row.content.replace(/\s+/g, " ").slice(0, 300),
        kind: m.kind || null,
        project: m.project || null,
        tier: row.tier,
        similarity: Number(row.semantic_score.toFixed(3)),
        evidence_only: m.can_use_as_instruction === false,
        age: ageNote(m, row.created_at) || null,
      };
    });
  return { hits };
}

export async function textSearch(tiers, q, {
  limit = 100, lifecycle = "current", kind, taskStatus, project, topic, person, system, digest,
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
  if (digest) sql += ` AND ${DIGEST_SQL}`;
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
  await transaction(async (client) => {
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
    // A pinned rule that gets corrected stays pinned. The digest still only
    // shows the replacement once it is confirmed, so an agent's rewrite of a
    // pinned memory cannot reach the digest until the reader confirms it.
    await client.query(
      `UPDATE thoughts SET metadata = jsonb_set(metadata, '{pinned}', 'true'::jsonb, true)
        WHERE id = $1 AND EXISTS (
          SELECT 1 FROM thoughts old WHERE old.id = ANY($2::uuid[]) AND old.metadata->>'pinned' = 'true')`,
      [replacementId, ids],
    );
  });
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
  sourceRefs = [], artifactRefs = [], client = "", title = "",
} = {}) {
  if (!tiers.includes(tier))
    throw new Error(`This endpoint may not write to tier "${tier}"`);
  // Before the metadata model and the embedder: a refused secret must not
  // leave the house either.
  refuseSecrets(content, metadata, sourceRefs, artifactRefs);

  const auto = metadata ? null : await extractMetadata(content);
  // A caller-chosen title replaces only the extracted one. It is not a trust
  // field, and normaliseMeta still holds it to describesContent(), so a title
  // that names another memory falls back to a derived one like any other.
  const chosenTitle = String(title || "").trim();
  const proposed = {
    ...(auto || {}), ...(metadata || {}), ...(chosenTitle ? { title: chosenTitle } : {}),
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
  //
  // `pinned` puts a memory in the digest every session reads first, so it is
  // the reader's choice on the Thoughts page, never an agent's. An agent able
  // to pin would be able to put words in front of every model that connects.
  for (const field of [
    "provenance", "review_status", "can_use_as_instruction", "can_use_as_evidence",
    "requires_user_confirmation", "reviewed_at", "reviewed_by", "captured_by", "pinned",
  ]) delete proposed[field];
  const meta = normaliseMeta(
    proposed,
    content,
    { origin, userConfirmed },
  );
  const capturedBy = String(client || "").trim().slice(0, 80);
  if (capturedBy) meta.captured_by = capturedBy;
  const vector = await embed(embeddingText(content, meta)).catch(() => null);

  const id = await transaction(async (client) => {
    const { rows } = await client.query(
      `SELECT upsert_thought($1, $2::jsonb, $3) AS result`,
      [content, JSON.stringify({ metadata: meta }), tier],
    );
    const saved = rows[0].result.id;
    if (vector)
      await client.query(`UPDATE thoughts SET embedding = $1::vector WHERE id = $2`,
        [JSON.stringify(vector), saved]);
    return saved;
  });

  return { id, tier, metadata: meta, embedded: Boolean(vector) };
}

export async function reviewThought(tiers, id, action, { actor = "user", note = "" } = {}) {
  const existing = await getThought(tiers, id);
  if (!existing) throw new Error("Not found");
  const metadata = applyReview(existing.metadata, action, { actor, content: existing.content });
  return transaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE thoughts SET metadata = $2::jsonb WHERE id = $1 AND tier = ANY($3) RETURNING ${COLS}`,
      [id, JSON.stringify(metadata), tiers],
    );
    await client.query(
      `INSERT INTO memory_review_events (thought_id, action, actor, detail)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [id, action, actor, JSON.stringify(note ? { note: String(note).slice(0, 500) } : {})],
    );
    return rows[0];
  });
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
  refuseSecrets(text, metadata);
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
  // All of it up front: the archived source is written first, so a secret
  // found in the third atom would otherwise leave the source and two atoms
  // behind.
  refuseSecrets(source, atoms);

  // The verbatim source is navigable history, not a current memory and not
  // embedded. A null fingerprint deliberately allows the same source to be
  // imported again without mutating a current exact-match memory.
  const sourceMeta = normaliseMeta({
    title: `Ingest source ${new Date().toISOString().slice(0, 10)}`,
    summary: `Archived source for ${atoms.length} reviewed atomic memories.`,
    kind: "reference", lifecycle: "archived", source_refs: [],
  }, source, { origin, userConfirmed: origin === "user" || user_confirmed });
  const sourceRow = await transaction((client) => client.query(
    `INSERT INTO thoughts (content, metadata, tier, content_fingerprint)
     VALUES ($1, $2::jsonb, $3, NULL) RETURNING id`,
    [source, JSON.stringify(sourceMeta), tier],
  ));
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
            a.created_at AS left_created_at,
            b.id AS right_id, b.content AS right_content, b.metadata AS right_metadata, b.tier AS right_tier,
            b.created_at AS right_created_at,
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
  if (merged_content) refuseSecrets(merged_content);
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

// --- contradictions ------------------------------------------------------------
//
// The audit checks the shape of each memory on its own, and the duplicate list
// finds two memories that say the same thing. Neither notices two memories that
// say *different* things about the same subject - an old port number next to a
// new one, a rule and its reversal. Every pair alike enough to share a subject
// is a candidate, the closest first, and that includes the duplicate band: the
// clearest contradiction on a test brain, the same server on port 8790 in one
// memory and 8795 in the other, scored 0.87. A model reads each pair once and
// says whether both can be true now. A verdict is kept until either memory
// changes, so a pair is never paid for twice.
export const CONTRADICTION_FLOOR = 0.6;

// Not the metadata model by default. On the live brain gpt-4o-mini called 14 of
// its first 20 pairs contradictions, nearly all of them wrong: two prefixes that
// route to two services, two machines with two paths. With a stricter prompt it
// still flagged 9 of 16 false pairs. Qwen3-235B and DeepSeek V3.2, both open
// weights, flagged none of them and caught all three planted conflicts; Qwen is
// the cheaper of the two. The role lives in ai.mjs and can be changed on the
// Models card; a verdict remembers the model that gave it.
export const contradictionModel = () => ai.role("contradiction").model;

async function contradictionPairs(tiers, { limit = 20 } = {}) {
  const { rows } = await pool.query(
    `WITH candidates AS (
       SELECT ${COLS}, embedding FROM thoughts
        WHERE tier = ANY($1) AND embedding IS NOT NULL
          AND coalesce(metadata->>'lifecycle', 'current') = 'current'
          AND coalesce(metadata->>'review_status', 'confirmed') <> 'rejected'
        ORDER BY updated_at DESC LIMIT 750
     )
     SELECT a.id AS left_id, a.content AS left_content, a.metadata AS left_metadata,
            b.id AS right_id, b.content AS right_content, b.metadata AS right_metadata,
            1 - (a.embedding <=> b.embedding) AS similarity
       FROM candidates a JOIN candidates b ON a.id::text < b.id::text
      WHERE 1 - (a.embedding <=> b.embedding) >= $2
        AND NOT EXISTS (
          SELECT 1 FROM contradiction_checks c
           WHERE c.left_id = a.id AND c.right_id = b.id
             AND c.checked_at >= greatest(a.updated_at, b.updated_at)
             -- a verdict from an earlier model is checked again; the reader's is not
             AND c.model IN ($4, 'user'))
        AND NOT EXISTS (
          SELECT 1 FROM thought_relations r
           WHERE (r.from_id = a.id AND r.to_id = b.id) OR (r.from_id = b.id AND r.to_id = a.id))
      ORDER BY similarity DESC LIMIT $3`,
    [tiers, CONTRADICTION_FLOOR, Math.min(Number(limit) || 20, 100), contradictionModel()],
  );
  return rows;
}

// The instructions come after the two texts, for the same reason topicReminder()
// exists: placed first, the model answered Swedish memories in English and
// called them "Memory A" and "Memory B", which means nothing to the person
// reading the Review page. The bar is deliberately high - same item, same
// property, two values - because a false alarm on that page costs the reader
// more than a missed contradiction does.
export function contradictionPrompt(left, right) {
  return `You check a personal long-term memory for contradictions. Two memories follow.\n\n` +
    `<<<FIRST\n${left}\nFIRST>>>\n\n<<<SECOND\n${right}\nSECOND>>>\n\n` +
    `Answer "conflict" only when both memories make a claim about the SAME item and the SAME\n` +
    `property, and the two claims cannot both be true at the same time: two different values for\n` +
    `one setting, port, path, address, count or date, or one says a thing is so and the other that\n` +
    `it is not. A difference in tone, scope or emphasis is not a conflict.\n` +
    `These are always "consistent": the memories are about different items (two prefixes, two\n` +
    `devices, two settings); one memory has information the other lacks; one is more general and\n` +
    `the other a special case; a past event and a current rule; two rules that can both be followed.\n` +
    `When in doubt, answer "consistent".\n` +
    `Return JSON {"verdict":"conflict"|"consistent","reason":"..."}. "reason" is empty when\n` +
    `consistent. Otherwise it is one sentence that a person reads next to both texts: write it in\n` +
    `the language the memories are written in (Swedish memories get a Swedish sentence), and name\n` +
    `the item and both values, for example "Det ena säger port 8790, det andra port 8795". Never\n` +
    `write "first", "second", "memory A" or "memory B".`;
}

async function judgeContradiction(left, right) {
  const parsed = await ai.chatJson(ai.role("contradiction"), contradictionPrompt(left, right), { temperature: 0 });
  const verdict = parsed.verdict === "conflict" ? "conflict" : "consistent";
  return { verdict, reason: verdict === "conflict" ? String(parsed.reason || "").slice(0, 500) : "" };
}

// Checks up to `limit` unchecked pairs. One failed call stops the run rather
// than recording a guess: an unchecked pair is simply picked up next time.
export async function checkContradictions(tiers, { limit = 20 } = {}) {
  if (!ai.roleReady("contradiction")) return { checked: 0, conflicts: 0, skipped: "no contradiction model configured" };
  const pairs = await contradictionPairs(tiers, { limit });
  let checked = 0;
  let conflicts = 0;
  for (const pair of pairs) {
    const { verdict, reason } = await judgeContradiction(pair.left_content, pair.right_content);
    await pool.query(
      `INSERT INTO contradiction_checks (left_id, right_id, verdict, reason, model)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (left_id, right_id) DO UPDATE
         SET verdict = EXCLUDED.verdict, reason = EXCLUDED.reason,
             model = EXCLUDED.model, checked_at = now()`,
      [pair.left_id, pair.right_id, verdict, reason || null, contradictionModel()],
    );
    checked += 1;
    if (verdict === "conflict") conflicts += 1;
  }
  return { checked, conflicts, remaining: pairs.length === limit };
}

// Open conflicts between two memories that are both still current. Superseding
// or merging one side takes the pair off the list without anything else to do.
export async function contradictions(tiers, { limit = 50 } = {}) {
  const { rows } = await pool.query(
    `SELECT c.left_id, a.content AS left_content, a.metadata AS left_metadata, a.tier AS left_tier,
            a.created_at AS left_created_at,
            c.right_id, b.content AS right_content, b.metadata AS right_metadata, b.tier AS right_tier,
            b.created_at AS right_created_at,
            c.reason, c.checked_at
       FROM contradiction_checks c
       JOIN thoughts a ON a.id = c.left_id
       JOIN thoughts b ON b.id = c.right_id
      WHERE c.verdict = 'conflict' AND a.tier = ANY($1) AND b.tier = ANY($1)
        AND coalesce(a.metadata->>'lifecycle', 'current') = 'current'
        AND coalesce(b.metadata->>'lifecycle', 'current') = 'current'
        AND c.checked_at >= greatest(a.updated_at, b.updated_at)
        AND c.model = $3
      ORDER BY c.checked_at DESC LIMIT $2`,
    [tiers, Math.min(Number(limit) || 50, 200), contradictionModel()],
  );
  return rows;
}

// "Not a contradiction" from the reader. Kept until either memory changes, at
// which point the pair is checked again - the text it was judged on is gone.
// Filed under the model "user", so a later change of model does not overrule it.
export async function dismissContradiction(tiers, { left_id, right_id } = {}) {
  const left = await getThought(tiers, left_id);
  const right = await getThought(tiers, right_id);
  if (!left || !right) throw new Error("Contradiction pair not found");
  const [a, b] = [left.id, right.id].sort();
  const { rowCount } = await pool.query(
    `UPDATE contradiction_checks SET verdict = 'dismissed', model = 'user', checked_at = now()
      WHERE left_id = $1 AND right_id = $2`,
    [a, b],
  );
  if (!rowCount) throw new Error("Contradiction pair not found");
  return { left_id: a, right_id: b, verdict: "dismissed" };
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
  refuseSecrets(typeof content === "string" ? content : "", metadata || {});

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

  const { rows } = await transaction((client) => client.query(
    `UPDATE thoughts SET ${sets.join(", ")} WHERE id = $1 RETURNING ${COLS}`, args));
  return rows[0];
}

export async function deleteThought(tiers, id) {
  const { rowCount } = await transaction((client) => client.query(
    `DELETE FROM thoughts WHERE id = $1 AND tier = ANY($2)`, [id, tiers]));
  if (!rowCount) throw new Error("Not found");
  return { deleted: id };
}

// --- change log ----------------------------------------------------------------
//
// thought_changes is filled by triggers (see ensureSchema), so these functions
// only read it and act on it. A row keeps the fields as they were *before* the
// change, which is what makes "restore this version" and "undo that delete"
// possible without a database restore. Visibility follows the tier the row
// carries: a change that ever touched the vault is filed as vault.

// How long the text of a deleted memory stays restorable. Afterwards the log
// keeps that the delete happened, by whom and when, but no longer the words.
// A memory removed on purpose should not live on in its own history forever.
export const DELETED_SNAPSHOT_DAYS = Number(process.env.CHANGE_LOG_DELETED_DAYS || 30);

const CHANGE_COLS = "id, thought_id, tier, at, action, actor, fields, before";

export async function thoughtChanges(tiers, thoughtId, { limit = 50 } = {}) {
  const { rows } = await pool.query(
    `SELECT ${CHANGE_COLS} FROM thought_changes
      WHERE thought_id = $1 AND tier = ANY($2)
      ORDER BY at DESC, id DESC LIMIT $3`,
    [thoughtId, tiers, Math.min(Number(limit) || 50, 200)],
  );
  return rows;
}

// Deletes that can still be undone: the text is still in the log and nothing
// has taken the id back since.
export async function deletedThoughts(tiers, { limit = 50 } = {}) {
  const { rows } = await pool.query(
    `SELECT ${CHANGE_COLS} FROM thought_changes c
      WHERE c.action = 'delete' AND c.before IS NOT NULL AND c.tier = ANY($1)
        AND NOT EXISTS (SELECT 1 FROM thoughts t WHERE t.id = c.thought_id)
      ORDER BY c.at DESC LIMIT $2`,
    [tiers, Math.min(Number(limit) || 50, 200)],
  );
  return rows;
}

// Put a memory back the way one change log row found it. For a delete the row
// comes back under its own id, with the relations whose other end still exists;
// for an edit the changed fields are written back over the current row. Both
// go through the ordinary write paths, so the restore is itself logged.
export async function restoreChange(tiers, changeId) {
  const { rows } = await pool.query(
    `SELECT ${CHANGE_COLS} FROM thought_changes WHERE id = $1 AND tier = ANY($2)`,
    [changeId, tiers],
  );
  const change = rows[0];
  if (!change) throw new Error("Change not found");
  const before = change.before || {};

  if (change.action === "update") {
    if (!Object.keys(before).length) throw new Error("This change kept nothing to restore");
    const current = await getThought(tiers, change.thought_id);
    if (!current) throw new Error("The memory no longer exists; restore its deletion first");
    return updateThought(tiers, change.thought_id, {
      ...("content" in before ? { content: before.content } : {}),
      ...("metadata" in before ? { metadata: before.metadata } : {}),
      ...("tier" in before ? { tier: before.tier } : {}),
    });
  }

  if (change.action !== "delete") throw new Error(`A ${change.action} cannot be restored`);
  if (!before.content) throw new Error("The text of this memory is no longer kept");
  if (!tiers.includes(before.tier)) throw new Error("Change not found");
  if (await getThought(ALL, change.thought_id)) throw new Error("That memory already exists");
  refuseSecrets(before.content, before.metadata || {});

  const print = fingerprint(before.content);
  const { rows: clash } = await pool.query(
    `SELECT id FROM thoughts WHERE content_fingerprint = $1`, [print]);
  if (clash[0]) throw new Error(`The same text is already saved as ${clash[0].id}`);

  const vector = await embed(embeddingText(before.content, before.metadata || {})).catch(() => null);
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO thoughts (id, content, metadata, tier, content_fingerprint, embedding, created_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6::vector, coalesce($7::timestamptz, now()))`,
      [change.thought_id, before.content, JSON.stringify(before.metadata || {}), before.tier,
        // An archived ingest source is stored without a fingerprint on purpose.
        before.metadata?.lifecycle === "archived" ? null : print,
        vector ? JSON.stringify(vector) : null, before.created_at || null],
    );
    await client.query(
      `INSERT INTO thought_relations (from_id, to_id, relation, created_at)
       SELECT r.from_id, r.to_id, r.relation, coalesce(r.created_at, now())
         FROM jsonb_to_recordset($1::jsonb) AS r(from_id uuid, to_id uuid, relation text, created_at timestamptz)
        WHERE EXISTS (SELECT 1 FROM thoughts t WHERE t.id = r.from_id)
          AND EXISTS (SELECT 1 FROM thoughts t WHERE t.id = r.to_id)
       ON CONFLICT DO NOTHING`,
      [JSON.stringify(before.relations || [])],
    );
  });
  return getThought(tiers, change.thought_id);
}

// "Forget now" for one deleted memory: the record of the delete stays, every
// kept copy of its text goes. For a memory removed because of what it said,
// waiting out the retention window is the wrong default.
export async function forgetDeleted(tiers, thoughtId) {
  if (await getThought(ALL, thoughtId)) throw new Error("Only a deleted memory can be forgotten");
  const { rowCount } = await pool.query(
    `UPDATE thought_changes SET before = NULL
      WHERE thought_id = $1 AND tier = ANY($2) AND before IS NOT NULL`,
    [thoughtId, tiers],
  );
  return { thought_id: thoughtId, forgotten: rowCount };
}

// The other half of DELETED_SNAPSHOT_DAYS. Clears the kept text of every change
// to a memory that was deleted longer ago than that - its edits as well as the
// delete itself, since an old version holds the same words.
export async function pruneDeletedSnapshots(days = DELETED_SNAPSHOT_DAYS) {
  if (!Number(days)) return 0;
  const { rowCount } = await pool.query(
    `UPDATE thought_changes c SET before = NULL
      WHERE c.before IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM thoughts t WHERE t.id = c.thought_id)
        AND EXISTS (SELECT 1 FROM thought_changes d
                     WHERE d.thought_id = c.thought_id AND d.action = 'delete'
                       AND d.at < now() - ($1 || ' days')::interval)`,
    [String(days)],
  );
  return rowCount;
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
  await pool.query(UPDATED_AT_SQL);
  await pool.query(CHANGE_LOG_SQL);
  await pool.query(CONTRADICTION_SQL);
}

// A new embedding is not a new version of the memory. Duplicate decisions and
// contradiction verdicts hold until updated_at moves, so bumping it for a
// vector would void every one of them the day the embedding model changes.
// An UPDATE that sets updated_at itself still gets its own value.
export const UPDATED_AT_SQL = `
    CREATE OR REPLACE FUNCTION update_updated_at() RETURNS trigger AS $$
    BEGIN
        IF NEW.content IS DISTINCT FROM OLD.content OR NEW.metadata IS DISTINCT FROM OLD.metadata
           OR NEW.tier IS DISTINCT FROM OLD.tier THEN
            NEW.updated_at = now();
        END IF;
        RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
`;

// Kept word for word in db/init.sql as well; test/change-log-schema.test.mjs
// fails when the two drift apart.
export const CHANGE_LOG_SQL = `
    CREATE TABLE IF NOT EXISTS thought_changes (
        id         bigserial PRIMARY KEY,
        thought_id uuid NOT NULL,
        tier       text NOT NULL CHECK (tier IN ('open', 'vault')),
        at         timestamptz NOT NULL DEFAULT now(),
        action     text NOT NULL CHECK (action IN ('create', 'update', 'delete')),
        actor      text NOT NULL,
        fields     text[] NOT NULL DEFAULT '{}',
        before     jsonb
    );
    CREATE INDEX IF NOT EXISTS thought_changes_thought_idx ON thought_changes (thought_id, at DESC);
    CREATE INDEX IF NOT EXISTS thought_changes_at_idx ON thought_changes (at DESC);

    CREATE OR REPLACE FUNCTION log_thought_change() RETURNS trigger AS $$
    DECLARE
        v_actor  text := coalesce(nullif(current_setting('mimers.actor', true), ''), 'sql:' || current_user);
        v_fields text[] := '{}';
        v_before jsonb := '{}'::jsonb;
    BEGIN
        IF TG_OP = 'INSERT' THEN
            INSERT INTO thought_changes (thought_id, tier, action, actor, fields)
            VALUES (NEW.id, NEW.tier, 'create', v_actor, ARRAY['content', 'metadata', 'tier']);
            RETURN NEW;
        END IF;

        IF TG_OP = 'DELETE' THEN
            INSERT INTO thought_changes (thought_id, tier, action, actor, fields, before)
            VALUES (OLD.id, OLD.tier, 'delete', v_actor, ARRAY['content', 'metadata', 'tier'],
                    jsonb_build_object(
                        'content', OLD.content, 'metadata', OLD.metadata, 'tier', OLD.tier,
                        'created_at', OLD.created_at,
                        'relations', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                                        'from_id', r.from_id, 'to_id', r.to_id,
                                        'relation', r.relation, 'created_at', r.created_at)), '[]'::jsonb)
                                        FROM thought_relations r
                                       WHERE r.from_id = OLD.id OR r.to_id = OLD.id)));
            RETURN OLD;
        END IF;

        -- A new embedding or a touched updated_at is not a change anyone reads.
        IF OLD.content IS DISTINCT FROM NEW.content THEN
            v_fields := v_fields || 'content'::text;
            v_before := v_before || jsonb_build_object('content', OLD.content);
        END IF;
        IF OLD.metadata IS DISTINCT FROM NEW.metadata THEN
            v_fields := v_fields || 'metadata'::text;
            v_before := v_before || jsonb_build_object('metadata', OLD.metadata);
        END IF;
        IF OLD.tier IS DISTINCT FROM NEW.tier THEN
            v_fields := v_fields || 'tier'::text;
            v_before := v_before || jsonb_build_object('tier', OLD.tier);
        END IF;
        IF cardinality(v_fields) = 0 THEN RETURN NEW; END IF;

        INSERT INTO thought_changes (thought_id, tier, action, actor, fields, before)
        VALUES (NEW.id, CASE WHEN 'vault' IN (OLD.tier, NEW.tier) THEN 'vault' ELSE 'open' END,
                'update', v_actor, v_fields, v_before);
        RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    -- BEFORE DELETE, so the relations are still there to be copied: the
    -- cascade removes them before any AFTER trigger would run.
    DROP TRIGGER IF EXISTS thoughts_change_log ON thoughts;
    CREATE TRIGGER thoughts_change_log AFTER INSERT OR UPDATE ON thoughts
        FOR EACH ROW EXECUTE FUNCTION log_thought_change();
    DROP TRIGGER IF EXISTS thoughts_delete_log ON thoughts;
    CREATE TRIGGER thoughts_delete_log BEFORE DELETE ON thoughts
        FOR EACH ROW EXECUTE FUNCTION log_thought_change();
`;

export const CONTRADICTION_SQL = `
    CREATE TABLE IF NOT EXISTS contradiction_checks (
        left_id    uuid NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
        right_id   uuid NOT NULL REFERENCES thoughts(id) ON DELETE CASCADE,
        verdict    text NOT NULL CHECK (verdict IN ('conflict', 'consistent', 'dismissed')),
        reason     text,
        model      text,
        checked_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (left_id, right_id),
        CHECK (left_id::text < right_id::text)
    );
`;

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

// What a shorter retention would cost, asked before anything is deleted. The
// pruning itself is irreversible - telemetry is not in the backup path the way
// memories are - so the page states the number of rows first and lets the reader
// change their mind.
export async function countBeyondRetention(days) {
  const value = Number(days);
  if (!value) return 0;
  const { rows } = await pool.query(
    `SELECT (SELECT count(*) FROM usage_events WHERE at < now() - ($1 || ' days')::interval)
          + (SELECT count(*) FROM recall_traces WHERE created_at < now() - ($1 || ' days')::interval)
       AS count`,
    [String(value)],
  );
  return Number(rows[0].count);
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
       -- People and systems are grouped by lower case, and the most common
       -- spelling names the group. Grouping on the raw value counts "Docker"
       -- and "docker" as two systems: the page shows both, every total is split
       -- between them, and the JSON cannot even be parsed by a client whose
       -- objects are case-insensitive. Topics and projects need none of this -
       -- topics come from a closed lower-case vocabulary, and a project is a
       -- single string written once.
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
       -- Only usable memories count as unembedded. An archived ingest source is
       -- deliberately never embedded, and a rejected or superseded row is not
       -- searched, so none of them is a fault worth degrading the status over.
       (SELECT count(*) FROM thoughts WHERE tier = ANY($1) AND embedding IS NULL
          AND coalesce(metadata->>'lifecycle', 'current') = 'current'
          AND coalesce(metadata->>'review_status', 'confirmed') <> 'rejected') AS mem_unembedded,
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
       -- A trace whose harness crashed stays unreported for good, so an
       -- all-time count could only ever grow and the status would never
       -- recover. A rolling day keeps a missing receipt visible long enough to
       -- act on without turning last month's crash into a permanent CHECK.
       (SELECT count(*) FROM recall_traces WHERE listener = ANY($2)
          AND created_at < now() - interval '10 minutes'
          AND created_at >= now() - interval '24 hours'
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
       (SELECT count(*) FROM base WHERE ${DIGEST_SQL}) AS digest,
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
          FROM (SELECT mode() WITHIN GROUP (ORDER BY person) AS person, count(*) AS c
                  FROM (SELECT metadata->'people' AS arr FROM base
                         WHERE jsonb_typeof(metadata->'people') = 'array') s,
                       jsonb_array_elements_text(s.arr) AS person
                 GROUP BY lower(person)) x) AS people,
       (SELECT jsonb_object_agg(system, c)
          FROM (SELECT mode() WITHIN GROUP (ORDER BY system) AS system, count(*) AS c
                  FROM (SELECT metadata->'systems' AS arr FROM base
                         WHERE jsonb_typeof(metadata->'systems') = 'array') s,
                       jsonb_array_elements_text(s.arr) AS system
                 GROUP BY lower(system)) x) AS systems`,
    [tiers],
  );
  const r = rows[0];
  const digest = await memoryDigest(tiers);
  return {
    total: Number(r.total),
    digest: Number(r.digest || 0),
    digestOmitted: digest.omitted,
    digestLimit: DIGEST_LIMIT,
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

// The brain on the statistics page. Memories connect through shared metadata
// (kind, task status, project, topics, people, systems) and through meaning.
// The metadata pairs are built in the browser from the arrays sent here, so the
// reader can switch a kind of connection off without another round trip; only
// the meaning pairs and each memory's place need the embeddings, so only they
// are computed here. Only
// current memories take part: a superseded row is history, and every
// `supersedes` edge would otherwise give its replacement a connection it did
// not earn.
//
// 0.60 is measured, not chosen: on 2026-10-13 the 287 current memories gave
// 5105 pairs at 0.50 (everything touches everything), 1025 at 0.60 and 166 at
// 0.70 (most memories alone).
export const GRAPH_THRESHOLD = 0.6;
const GRAPH_NODES = 600;
const GRAPH_EDGES = 4000;

const graphList = (value) => Array.isArray(value)
  ? value.filter((item) => typeof item === "string" && item.trim()) : [];

export async function memoryGraph(tiers, { threshold = GRAPH_THRESHOLD } = {}) {
  const { rows: nodes } = await pool.query(
    `SELECT id, tier,
            coalesce(nullif(metadata->>'title', ''), left(content, 90)) AS title,
            coalesce(nullif(metadata->>'kind', ''), metadata->>'type', 'unknown') AS kind,
            metadata->>'project' AS project, metadata->>'task_status' AS task_status,
            metadata->'topics' AS topics, metadata->'people' AS people, metadata->'systems' AS systems,
            embedding::text AS vector
       FROM thoughts
      WHERE tier = ANY($1)
        AND coalesce(metadata->>'lifecycle', 'current') = 'current'
        AND coalesce(metadata->>'review_status', 'confirmed') <> 'rejected'
      ORDER BY updated_at DESC LIMIT ${GRAPH_NODES}`,
    [tiers],
  );
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const ids = nodes.map((node) => node.id);
  const { rows: similar } = await pool.query(
    `WITH n AS (SELECT id, embedding FROM thoughts WHERE id = ANY($1::uuid[]) AND embedding IS NOT NULL)
     SELECT a.id AS a, b.id AS b, 1 - (a.embedding <=> b.embedding) AS s
       FROM n a JOIN n b ON a.id::text < b.id::text
      WHERE 1 - (a.embedding <=> b.embedding) >= $2
      ORDER BY s DESC LIMIT ${GRAPH_EDGES}`,
    [ids, Number(threshold) || GRAPH_THRESHOLD],
  );
  const { rows: related } = await pool.query(
    `SELECT from_id AS a, to_id AS b FROM thought_relations
      WHERE from_id = ANY($1::uuid[]) AND to_id = ANY($1::uuid[])`,
    [ids],
  );

  // Where each memory sits in the brain follows its meaning. A memory still
  // waiting for its embedding gets no place and is laid out by its connections.
  const embedded = nodes.filter((node) => node.vector);
  const places = new Map(semanticAxes(embedded.map((node) => JSON.parse(node.vector)))
    .map((place, i) => [embedded[i].id, place]));

  const edges = new Map();
  for (const row of similar)
    edges.set([index.get(row.a), index.get(row.b)].sort((x, y) => x - y).join(), Number(row.s));
  for (const row of related)
    edges.set([index.get(row.a), index.get(row.b)].sort((x, y) => x - y).join(), 1);
  return {
    threshold: Number(threshold) || GRAPH_THRESHOLD,
    nodes: nodes.map((node) => ({
      id: node.id, tier: node.tier, title: node.title, kind: node.kind,
      project: node.project || null, task_status: node.task_status || null,
      // Free-form metadata: a hand-edited row whose topics is not an array
      // must not break the page.
      topics: graphList(node.topics), people: graphList(node.people), systems: graphList(node.systems),
      place: places.get(node.id) || null,
    })),
    // [from, to, strength]: indices into nodes, so the payload stays small.
    edges: [...edges].map(([pair, s]) => [...pair.split(",").map(Number), Math.round(s * 100) / 100]),
  };
}

// The digest: what every session should know before it asks anything. Search
// only finds what a model thinks to look for, and only Claude Code reads a
// CLAUDE.md; DeepSeek, an OmniRoute model or a phone app start knowing
// nothing. One call at session start gives them all the same footing.
//
// Only confirmed memories that may be used as instructions, so nothing an
// agent wrote and nobody checked is put in front of every model. Pinned
// memories first (the reader pins them on the Thoughts page), then every
// confirmed preference and profile memory the reader has not taken out
// (`pinned: false`). Short memories go in whole; a long one goes in as its
// summary with its id, to fetch when needed.
//
// The digest is read by every model in every session, so its size is a budget
// shared by everything in it: past a point, more standing rules make each one
// weigh less. What does not fit is counted and named rather than dropped in
// silence - the model is told to search for it, and the Thoughts page shows the
// overflow so the reader can decide what to unpin. (Borrowed from ai-memory,
// whose profile is held to a fixed size for the same reason.)
export const DIGEST_LIMIT = 15;
export const DIGEST_WHOLE = 700;
export const DIGEST_BUDGET = 9000;

export async function memoryDigest(tiers, { limit = DIGEST_LIMIT } = {}) {
  const { rows } = await pool.query(
    `SELECT ${COLS}, count(*) OVER () AS qualifying FROM thoughts
      WHERE tier = ANY($1) AND ${DIGEST_SQL}
      ORDER BY (metadata->>'pinned' = 'true') DESC NULLS LAST,
               CASE metadata->>'kind' WHEN 'preference' THEN 0 WHEN 'profile' THEN 1 ELSE 2 END,
               updated_at DESC
      LIMIT 50`,
    [tiers],
  );
  const cap = Math.min(Number(limit) || DIGEST_LIMIT, 50);
  let budget = DIGEST_BUDGET;
  const items = [];
  for (const row of rows) {
    const m = row.metadata || {};
    const whole = row.content.length <= DIGEST_WHOLE;
    const text = whole ? row.content : (m.summary || row.content.slice(0, DIGEST_WHOLE));
    if (items.length >= cap || (items.length && text.length > budget)) break;
    budget -= text.length;
    items.push({
      id: row.id, tier: row.tier, kind: m.kind || null, pinned: m.pinned === true,
      title: m.title || null, text, complete: whole,
    });
  }
  const left = rows.slice(items.length);
  return {
    count: items.length,
    items,
    omitted: Number(rows[0]?.qualifying || 0) - items.length,
    omitted_items: left.map((row) => ({ id: row.id, title: row.metadata?.title || null })),
  };
}
