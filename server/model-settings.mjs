// Choosing models from the web UI, and changing the embedding model safely.
//
// The metadata and contradiction models can be swapped at once: they only
// shape what is written from now on. The embedding model cannot. Every stored
// vector belongs to the model that made it, and a search vector from another
// model compares against them as noise - often in a different number of
// dimensions, too. So a new embedding model is filled into a second column,
// embedding_next, in the background while search keeps using the old one. Only
// when every row has a new vector, and the reader has compared a few searches
// on both, does one transaction drop the old column and rename the new one.
//
// A new vector is not a new version of the memory, so none of this touches
// updated_at (see UPDATED_AT_SQL in lib.mjs) or the change log: duplicate
// decisions and contradiction verdicts survive a change of embedding model.

import * as ai from "./ai.mjs";
import { embed, getSetting, pool, setSetting, transaction } from "./lib.mjs";
import { embeddingText } from "./memory-model.mjs";
import { dropNextThresholds, promoteNextThresholds } from "./recall-settings.mjs";
import * as box from "./secret-box.mjs";

const ROLES_KEY = "ai_roles";
const PROVIDERS_KEY = "ai_providers";
const MIGRATION_KEY = "embedding_migration";
const BATCH = 32;
// pgvector's HNSW index takes at most 2000 dimensions. Above that the column
// goes unindexed, which a brain of a few thousand rows does not notice.
const HNSW_MAX = 2000;

const ELIGIBLE = `(embedding IS NOT NULL OR coalesce(metadata->>'lifecycle', 'current') = 'current')`;

async function readJson(key) {
  try { return JSON.parse(await getSetting(key)) || null; } catch { return null; }
}

export async function columnDimensions(column) {
  const { rows } = await pool.query(
    `SELECT atttypmod FROM pg_attribute
      WHERE attrelid = 'thoughts'::regclass AND attname = $1 AND NOT attisdropped`, [column]);
  return rows[0] && rows[0].atttypmod > 0 ? rows[0].atttypmod : null;
}

// At boot and after every change. The dimensions come from the column itself,
// since that is the one thing a stored setting could get wrong.
export async function loadModelSettings() {
  ai.applyStored(await readJson(ROLES_KEY), { dimensions: await columnDimensions("embedding") });
  const stored = (await readJson(PROVIDERS_KEY)) || {};
  ai.applyStoredProviders(Object.fromEntries(Object.entries(stored).map(([id, entry]) => {
    const key = entry.key ? box.open(entry.key) : null;
    return [id, { url: entry.url, name: entry.name, key: key || undefined, keyUnreadable: Boolean(entry.key && !key) }];
  })));
}

// What the card may know about a provider. Whether a key exists and where it
// came from - never the key, not even its last characters.
const publicProvider = ({ id, label, base, configured, keyName, editable, keySource, urlSource, keyUnreadable }) =>
  ({ id, label, base, configured, keyName, editable: Object.keys(editable || {}), keySource, urlSource, keyUnreadable });

export async function modelSettings() {
  const migration = await readJson(MIGRATION_KEY);
  return {
    canStoreKeys: box.canSeal(),
    providers: ai.providers().map(publicProvider),
    roles: Object.fromEntries(ai.ROLES.map((name) => {
      const { provider, model, dimensions, source } = ai.role(name);
      return [name, { provider, model, ...(name === "embedding" ? { dimensions } : {}), source }];
    })),
    migration: migration && { ...migration, progress: await migrationProgress() },
  };
}

// A provider's address, name or key from the card. The key is sealed before it
// is stored, and nothing is stored until a real call with the new values has
// listed the provider's models - a typo is caught here, not at the next save.
// `clear` lists fields to drop, which brings back whatever .env says.
export async function saveProvider(id, { url, name, key, clear = [] } = {}) {
  const editable = ai.EDITABLE[id];
  if (!editable) throw Object.assign(new Error(`Provider "${id}" cannot be changed here`), { status: 400 });
  const stored = (await readJson(PROVIDERS_KEY)) || {};
  const entry = { ...(stored[id] || {}) };
  for (const field of Array.isArray(clear) ? clear : []) delete entry[field];

  if (editable.url && typeof url === "string") {
    const value = url.trim();
    if (value && !/^https?:\/\/[^\s/]+/i.test(value))
      throw Object.assign(new Error("The address must start with http:// or https://"), { status: 400 });
    if (value) entry.url = value; else delete entry.url;
  }
  if (editable.name && typeof name === "string") {
    const value = name.trim().slice(0, 40);
    if (value) entry.name = value; else delete entry.name;
  }
  const newKey = editable.key && typeof key === "string" ? key.trim() : "";
  if (newKey) entry.key = box.seal(newKey);

  const candidate = ai.providerWith(id, {
    url: entry.url, name: entry.name,
    key: newKey || (entry.key ? box.open(entry.key) : undefined) || undefined,
  });
  if (candidate.configured) {
    try {
      await ai.listModelsFor(candidate, "chat");
    } catch (error) {
      throw Object.assign(new Error(`${candidate.label} did not answer: ${error.message}`), { status: 400 });
    }
  }

  if (Object.keys(entry).length) stored[id] = entry; else delete stored[id];
  await setSetting(PROVIDERS_KEY, JSON.stringify(stored));
  await loadModelSettings();
  return publicProvider(ai.provider(id));
}

// The two chat roles. The embedding role only changes through switchEmbedding().
export async function saveRole(name, { provider, model } = {}) {
  if (!["metadata", "contradiction"].includes(name))
    throw Object.assign(new Error(`The ${name} model is changed by re-embedding`), { status: 400 });
  const p = ai.provider(provider);
  if (!p?.configured) throw Object.assign(new Error(`Provider "${provider}" is not configured`), { status: 400 });
  const id = String(model || "").trim();
  if (!id) throw Object.assign(new Error("A model is required"), { status: 400 });
  const roles = (await readJson(ROLES_KEY)) || {};
  roles[name] = { provider, model: id };
  await setSetting(ROLES_KEY, JSON.stringify(roles));
  await loadModelSettings();
  return ai.role(name);
}

// --- re-embedding --------------------------------------------------------------

let worker = null;
let stopRequested = false;

async function migrationProgress() {
  if (!(await columnDimensions("embedding_next"))) return null;
  const { rows } = await pool.query(
    `SELECT count(*) FILTER (WHERE ${ELIGIBLE}) AS total,
            count(*) FILTER (WHERE ${ELIGIBLE} AND embedding_next IS NOT NULL) AS done
       FROM thoughts`);
  return { total: Number(rows[0].total), done: Number(rows[0].done) };
}

async function saveMigration(state) {
  await setSetting(MIGRATION_KEY, JSON.stringify(state));
  return state;
}

export async function startReembed({ provider, model } = {}) {
  if (worker) throw Object.assign(new Error("A re-embedding is already running"), { status: 409 });
  const cfg = { provider, model: String(model || "").trim() };
  const current = ai.role("embedding");
  if (cfg.provider === current.provider && cfg.model === current.model)
    throw Object.assign(new Error("That model is already in use"), { status: 400 });

  const existing = await readJson(MIGRATION_KEY);
  const sameTarget = existing && existing.provider === cfg.provider && existing.model === cfg.model
    && (await columnDimensions("embedding_next")) === existing.dimensions;

  let dimensions = existing?.dimensions;
  if (!sameTarget) {
    // A real call first: it proves the model works and tells the column size.
    ({ dimensions } = await ai.testRole("embedding", cfg));
    await transaction(async (client) => {
      await client.query(`DROP TRIGGER IF EXISTS thoughts_embedding_next_reset ON thoughts`);
      await client.query(`ALTER TABLE thoughts DROP COLUMN IF EXISTS embedding_next`);
      await client.query(`ALTER TABLE thoughts ADD COLUMN embedding_next vector(${Number(dimensions)})`);
      // An edit during the run makes the new vector stale; clearing it puts the
      // row back in the worker's queue.
      await client.query(`
        CREATE OR REPLACE FUNCTION reset_embedding_next() RETURNS trigger AS $$
        BEGIN
            IF NEW.content IS DISTINCT FROM OLD.content OR NEW.metadata IS DISTINCT FROM OLD.metadata THEN
                NEW.embedding_next := NULL;
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql`);
      await client.query(`CREATE TRIGGER thoughts_embedding_next_reset BEFORE UPDATE ON thoughts
        FOR EACH ROW EXECUTE FUNCTION reset_embedding_next()`);
    });
  }
  const state = await saveMigration({
    provider: cfg.provider, model: cfg.model, dimensions,
    status: "running", started_at: existing && sameTarget ? existing.started_at : new Date().toISOString(),
    failed: [], error: null,
  });
  runWorker(state);
  return state;
}

// Picks up a run the last restart interrupted.
export async function resumeReembed() {
  const state = await readJson(MIGRATION_KEY);
  if (state?.status === "running" && (await columnDimensions("embedding_next"))) runWorker(state);
}

function runWorker(state) {
  stopRequested = false;
  worker = fillNext(state)
    .then(() => saveMigration({ ...state, status: stopRequested ? state.status : "ready",
      finished_at: new Date().toISOString() }))
    .catch((error) => saveMigration({ ...state, status: "failed", error: String(error.message || error).slice(0, 300) }))
    .finally(() => { worker = null; });
  return worker;
}

export const waitForWorker = () => worker || Promise.resolve();

// Embeds every eligible row that has no new vector yet, until none is left.
// A batch the API refuses is retried row by row, and a row that fails on its
// own is set aside rather than retried forever; the card reports how many.
async function fillNext(state) {
  const cfg = { provider: state.provider, model: state.model };
  const failed = new Set(state.failed || []);
  while (!stopRequested) {
    const { rows } = await pool.query(
      `SELECT id, content, metadata FROM thoughts
        WHERE embedding_next IS NULL AND ${ELIGIBLE} AND NOT (id = ANY($1::uuid[]))
        ORDER BY id LIMIT ${BATCH}`, [[...failed]]);
    if (!rows.length) break;
    let vectors;
    try {
      vectors = await ai.embedInputs(rows.map((row) => embeddingText(row.content, row.metadata)), cfg);
    } catch {
      vectors = [];
      for (const row of rows) {
        const [vector] = await ai.embedInputs(embeddingText(row.content, row.metadata), cfg).catch(() => [null]);
        vectors.push(vector);
      }
      // Every row refused is an outage or a wrong model, not thirty-two bad
      // memories: stop, and let Start resume once it works again.
      if (vectors.every((vector) => !vector)) throw new Error("The model refused every row in a batch");
    }
    for (const [i, row] of rows.entries()) {
      const vector = vectors[i];
      if (!Array.isArray(vector) || vector.length !== state.dimensions) { failed.add(row.id); continue; }
      await pool.query(`UPDATE thoughts SET embedding_next = $1::vector WHERE id = $2`,
        [JSON.stringify(vector), row.id]);
    }
    if (failed.size !== (state.failed || []).length) {
      state.failed = [...failed];
      await saveMigration(state);
    }
  }
}

// The same question against both columns, so the reader can see what the new
// model would return before choosing it. Scores are not comparable between two
// models; the order is what to look at.
export async function compareSearch(tiers, query) {
  const state = await readJson(MIGRATION_KEY);
  if (!state || !(await columnDimensions("embedding_next")))
    throw Object.assign(new Error("No re-embedding to compare with"), { status: 400 });
  const text = String(query || "").trim();
  if (!text) throw Object.assign(new Error("Empty search"), { status: 400 });
  const [current, [next]] = await Promise.all([
    embed(text), ai.embedInputs(text, { provider: state.provider, model: state.model }),
  ]);
  const top = async (column, vector) => (vector ? (await pool.query(
    `SELECT id, metadata->>'title' AS title, tier, 1 - (${column} <=> $1::vector) AS similarity
       FROM thoughts
      WHERE tier = ANY($2) AND ${column} IS NOT NULL
        AND coalesce(metadata->>'lifecycle', 'current') = 'current'
      ORDER BY ${column} <=> $1::vector LIMIT 5`,
    [JSON.stringify(vector), tiers])).rows : []);
  return { current: await top("embedding", current), next: await top("embedding_next", next) };
}

export async function switchEmbedding() {
  const state = await readJson(MIGRATION_KEY);
  if (state?.status !== "ready")
    throw Object.assign(new Error("The re-embedding is not finished"), { status: 409 });
  // Rows saved since the run finished have no new vector yet.
  await runWorker({ ...state, status: "running" });
  const finished = await readJson(MIGRATION_KEY);
  if (finished?.status !== "ready") throw new Error(finished?.error || "The re-embedding did not finish");

  await transaction(async (client) => {
    await client.query(`DROP TRIGGER IF EXISTS thoughts_embedding_next_reset ON thoughts`);
    await client.query(`DROP INDEX IF EXISTS thoughts_embedding_idx`);
    await client.query(`ALTER TABLE thoughts DROP COLUMN embedding`);
    await client.query(`ALTER TABLE thoughts RENAME COLUMN embedding_next TO embedding`);
    if (state.dimensions <= HNSW_MAX)
      await client.query(`CREATE INDEX thoughts_embedding_idx ON thoughts USING hnsw (embedding vector_cosine_ops)`);
    await client.query(`DELETE FROM app_settings WHERE key = $1`, [MIGRATION_KEY]);
    const roles = (await readJson(ROLES_KEY)) || {};
    roles.embedding = { provider: state.provider, model: state.model };
    await client.query(
      `INSERT INTO app_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [ROLES_KEY, JSON.stringify(roles)]);
  });
  await loadModelSettings();
  // Floors measured on the new vectors take effect with them.
  await promoteNextThresholds(state.model);
  // Anything that slipped through the narrow window, or failed above, gets a
  // vector from the new model now rather than staying unfindable.
  fillMissingEmbeddings().catch((error) => console.error("fill embeddings:", error.message));
  return ai.role("embedding");
}

export async function cancelReembed() {
  stopRequested = true;
  await waitForWorker();
  await transaction(async (client) => {
    await client.query(`DROP TRIGGER IF EXISTS thoughts_embedding_next_reset ON thoughts`);
    await client.query(`ALTER TABLE thoughts DROP COLUMN IF EXISTS embedding_next`);
    await client.query(`DELETE FROM app_settings WHERE key = $1`, [MIGRATION_KEY]);
  });
  await dropNextThresholds();
  return { cancelled: true };
}

// Current memories that have no vector - a save during an outage, or the
// switch window above. Archived ingest sources are left alone on purpose.
export async function fillMissingEmbeddings({ limit = 200 } = {}) {
  if (!ai.roleReady("embedding")) return 0;
  const { rows } = await pool.query(
    `SELECT id, content, metadata FROM thoughts
      WHERE embedding IS NULL AND coalesce(metadata->>'lifecycle', 'current') = 'current'
      ORDER BY created_at DESC LIMIT $1`, [limit]);
  let filled = 0;
  for (const row of rows) {
    const vector = await embed(embeddingText(row.content, row.metadata)).catch(() => null);
    if (!vector) continue;
    await pool.query(`UPDATE thoughts SET embedding = $1::vector WHERE id = $2 AND embedding IS NULL`,
      [JSON.stringify(vector), row.id]);
    filled += 1;
  }
  return filled;
}
