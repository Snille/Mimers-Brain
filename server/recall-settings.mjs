// Recall thresholds and the measurement behind them, from the Models card.
//
// The search threshold and the recall-hook floor are similarity scores, and a
// score means something only for the embedding model that produced it. Before
// this, a new embedding model kept the floors measured for the old one until
// someone ran scripts/eval-recall.mjs over SSH, edited .env and restarted.
// Now the card stores the floors, runs the same measurement in the background
// and proposes new ones - against the vectors of a re-embedding in progress,
// too, so the floors can be in place the moment the switch happens.
//
// The question set is real questions about real systems, so it lives in the
// database next to the memories it is about: never in git or the image. Like
// the rest of the card it is reachable on the full listener only. A result
// names questions by id and memories by UUID, never by their text.

import * as ai from "./ai.mjs";
import {
  DEFAULT_THRESHOLDS, PAIR_FLOORS, applyRecallThresholds, embed, getSetting, pool, recallThresholds, searchThoughts,
  setSetting,
} from "./lib.mjs";
import { DEFAULT_FLOORS, parseQuestionSet, summarise, suggestThresholds } from "./recall-eval.mjs";

const THRESHOLDS_KEY = "recall_thresholds";
const QUESTIONS_KEY = "recall_questions";
const EVALUATION_KEY = "recall_evaluation";
const MIGRATION_KEY = "embedding_migration";
// The defaults were measured with this model; see DEFAULT_THRESHOLDS in lib.mjs.
export const DEFAULTS_MEASURED_WITH = "openai/text-embedding-3-small";
// Low enough that the score of every plausible answer is seen, whatever the
// model's scale. The reported hit rates apply the real search threshold after.
const SCAN_THRESHOLD = 0.1;

const fail = (status, message) => Object.assign(new Error(message), { status });

async function readJson(key) {
  try { return JSON.parse(await getSetting(key)) || null; } catch { return null; }
}

// At boot. A measurement the last restart cut short is reported as such
// instead of showing "running" forever.
export async function loadRecallSettings() {
  applyRecallThresholds((await readJson(THRESHOLDS_KEY)) || {});
  const evaluation = await readJson(EVALUATION_KEY);
  if (evaluation?.status === "running" && !job)
    await setSetting(EVALUATION_KEY, JSON.stringify({ ...evaluation, status: "failed", error: "Interrupted by a restart" }));
}

export async function recallSettings() {
  const stored = (await readJson(THRESHOLDS_KEY)) || {};
  const active = recallThresholds();
  const envHint = Number(process.env.RECALL_HINT_FLOOR) > 0;
  const questions = await readJson(QUESTIONS_KEY);
  const evaluation = await readJson(EVALUATION_KEY);
  const migration = await readJson(MIGRATION_KEY);
  const counted = questions?.questions || [];
  return {
    thresholds: {
      search: active.search,
      hint: active.hint,
      ...Object.fromEntries(PAIR_FLOORS.map((k) => [k, active[k]])),
      source: {
        search: stored.search ? "settings" : "default",
        hint: stored.hint ? "settings" : envHint ? "environment" : "default",
        ...Object.fromEntries(PAIR_FLOORS.map((k) => [k, stored[k] ? "settings" : "default"])),
      },
      defaults: DEFAULT_THRESHOLDS,
      // The embedding model these floors were set for. The card warns when it
      // is not the one in use.
      model: ["search", "hint", ...PAIR_FLOORS].some((k) => stored[k]) ? stored.model || null : DEFAULTS_MEASURED_WITH,
      next: stored.next || null,
    },
    embedding: ai.role("embedding").model,
    migration: migration ? { model: migration.model, status: migration.status } : null,
    questions: questions ? {
      count: counted.length,
      positives: counted.filter((q) => q.expect.length).length,
      negatives: counted.filter((q) => !q.expect.length).length,
      updated_at: questions.updated_at,
    } : null,
    evaluation: evaluation && { ...evaluation, ...(job ? { progress: { ...job.progress } } : {}) },
  };
}

function threshold(value, name) {
  if (value === null || value === undefined || value === "") return undefined;
  const n = Number(value);
  if (!(n >= 0.05 && n <= 0.95)) throw fail(400, `The ${name} threshold must be between 0.05 and 0.95`);
  return Math.round(n * 1000) / 1000;
}

// target "current" changes the floors in use now. target "next" stores floors
// for the re-embedding in progress; switchEmbedding() puts them in force in the
// same step as the new vectors. An empty value brings back the default.
// The pair floors (contradiction, duplicate) change only when the call names
// them: the measurement suggests search and hint, and saving that suggestion
// must not throw away a floor set by hand.
export async function saveThresholds({ search, hint, target = "current", ...rest } = {}) {
  const values = { search: threshold(search, "search"), hint: threshold(hint, "hint") };
  const named = PAIR_FLOORS.filter((k) => rest[k] !== undefined);
  const floors = Object.fromEntries(named.map((k) => [k, threshold(rest[k], k)]));
  const stored = (await readJson(THRESHOLDS_KEY)) || {};
  if (target === "next") {
    const migration = await readJson(MIGRATION_KEY);
    if (!migration) throw fail(409, "No re-embedding is in progress");
    const kept = stored.next?.model === migration.model ? stored.next : {};
    const pairs = Object.fromEntries(PAIR_FLOORS
      .map((k) => [k, named.includes(k) ? floors[k] : kept[k]]).filter(([, v]) => v));
    stored.next = { ...values, ...pairs, model: migration.model };
  } else {
    for (const key of ["search", "hint"]) if (values[key] === undefined) delete stored[key]; else stored[key] = values[key];
    for (const key of named) if (floors[key] === undefined) delete stored[key]; else stored[key] = floors[key];
    stored.model = ai.role("embedding").model;
  }
  await setSetting(THRESHOLDS_KEY, JSON.stringify(stored));
  applyRecallThresholds(stored);
  return recallSettings();
}

// Called by switchEmbedding() once the new vectors are in place. Floors stored
// for that model replace the current ones; without them the old floors stay,
// and the card says they belong to another model.
export async function promoteNextThresholds(model) {
  const stored = (await readJson(THRESHOLDS_KEY)) || {};
  const next = stored.next;
  delete stored.next;
  const promoted = next?.model === model
    ? { model, ...Object.fromEntries(["search", "hint", ...PAIR_FLOORS].filter((k) => next[k]).map((k) => [k, next[k]])) }
    : stored;
  await setSetting(THRESHOLDS_KEY, JSON.stringify(promoted));
  applyRecallThresholds(promoted);
}

export async function dropNextThresholds() {
  const stored = await readJson(THRESHOLDS_KEY);
  if (!stored?.next) return;
  delete stored.next;
  await setSetting(THRESHOLDS_KEY, JSON.stringify(stored));
}

// --- question set ----------------------------------------------------------------

export async function saveQuestions({ text, clear } = {}) {
  if (clear) {
    await pool.query(`DELETE FROM app_settings WHERE key = $1`, [QUESTIONS_KEY]);
    return recallSettings();
  }
  let questions;
  try { questions = parseQuestionSet(String(text || "")); } catch (error) { throw fail(400, error.message); }
  await setSetting(QUESTIONS_KEY, JSON.stringify({ questions, updated_at: new Date().toISOString() }));
  return recallSettings();
}

// --- measurement -----------------------------------------------------------------

let job = null;

async function bestScore(column, vector, ids, tiers) {
  const { rows } = await pool.query(
    `SELECT max(1 - (${column} <=> $1::vector)) AS score FROM thoughts
      WHERE id = ANY($2::uuid[]) AND tier = ANY($3) AND ${column} IS NOT NULL`,
    [JSON.stringify(vector), ids, tiers]);
  return rows[0]?.score == null ? null : Number(rows[0].score);
}

// The measurement itself, shared by the card and scripts/eval-recall.mjs.
// Read only: no recall trace, no usage event. `cfg` and `column` point it at a
// re-embedding in progress instead of the vectors in use.
export async function evaluate(tiers, questions, {
  column = "embedding", cfg = null, variants = [{ name: "current", weights: {} }], onProgress,
} = {}) {
  const embedQuestion = cfg ? async (text) => (await ai.embedInputs(text, cfg))[0] : embed;

  // An expected memory that is gone, replaced or outside these tiers can never
  // be found; say so instead of letting it read as a ranking failure.
  const expected = [...new Set(questions.flatMap((q) => q.expect))];
  const { rows: known } = await pool.query(
    `SELECT t.id::text, t.tier, coalesce(t.metadata->>'lifecycle', 'current') AS lifecycle,
            (SELECT r.from_id::text FROM thought_relations r
              WHERE r.to_id = t.id AND r.relation = 'supersedes' LIMIT 1) AS replaced_by
       FROM thoughts t WHERE t.id = ANY($1::uuid[])`,
    [expected]);
  const byId = new Map(known.map((row) => [row.id, row]));
  const warnings = [];
  for (const q of questions)
    for (const id of q.expect) {
      const row = byId.get(id);
      if (!row) warnings.push(`${q.id}: ${id} does not exist`);
      else if (row.lifecycle !== "current")
        warnings.push(`${q.id}: ${id} is ${row.lifecycle}${row.replaced_by ? `, replaced by ${row.replaced_by}` : ""}`);
      else if (!tiers.includes(row.tier)) warnings.push(`${q.id}: ${id} is in the ${row.tier} tier, outside these tiers`);
    }

  const runs = variants.map(() => []);
  for (const [i, q] of questions.entries()) {
    const vector = await embedQuestion(q.q);
    if (!vector) throw new Error("No embedding model is configured");
    const expectedScore = q.expect.length ? await bestScore(column, vector, q.expect, tiers) : null;
    for (const [j, variant] of variants.entries()) {
      const rows = await searchThoughts(tiers, q.q, {
        limit: 20, threshold: SCAN_THRESHOLD, vector, weights: variant.weights, column,
      });
      runs[j].push({
        id: q.id, expect: q.expect, expectedScore,
        rows: rows.map((row) => ({ id: row.id, semantic_score: Number(row.semantic_score), lexical_score: Number(row.lexical_score) })),
      });
    }
    onProgress?.(i + 1);
  }

  const suggestion = suggestThresholds(runs[0]);
  // Hit rates at the search threshold this vector column would be searched
  // with: the one in use, or for a re-embedding the one proposed for it.
  const active = recallThresholds();
  const searchAt = column === "embedding" ? active.search : suggestion.search?.value ?? active.search;
  const hintAt = column === "embedding" ? active.hint : suggestion.hint?.value ?? active.hint;
  const floors = [...new Set([...DEFAULT_FLOORS, hintAt, suggestion.hint?.value].filter(Number.isFinite))].sort((a, b) => a - b);
  const passes = (r) => ({ ...r, rows: r.rows.filter((row) => row.semantic_score > searchAt || row.lexical_score > 0) });
  return {
    tiers, warnings, searchThreshold: searchAt, hintFloor: hintAt, suggestion,
    variants: variants.map((variant, j) => ({ name: variant.name, summary: summarise(runs[j].map(passes), { floors }) })),
  };
}

export async function startEvaluation(tiers, { target = "current" } = {}) {
  if (job) throw fail(409, "A measurement is already running");
  const questions = (await readJson(QUESTIONS_KEY))?.questions;
  if (!questions?.length) throw fail(400, "Add a question set first");

  let column = "embedding", cfg = null, model = ai.role("embedding").model;
  if (target === "next") {
    const migration = await readJson(MIGRATION_KEY);
    if (migration?.status !== "ready") throw fail(409, "The new model can be measured once its re-embedding is finished");
    column = "embedding_next";
    cfg = { provider: migration.provider, model: migration.model };
    model = migration.model;
  } else if (!ai.roleReady("embedding")) throw fail(400, "No embedding model is configured");

  const state = { status: "running", target: target === "next" ? "next" : "current", model, started_at: new Date().toISOString() };
  await setSetting(EVALUATION_KEY, JSON.stringify(state));
  const save = (patch) => setSetting(EVALUATION_KEY, JSON.stringify({ ...state, ...patch, finished_at: new Date().toISOString() }));
  job = { progress: { done: 0, total: questions.length } };
  job.promise = evaluate(tiers, questions, { column, cfg, onProgress: (done) => { job.progress.done = done; } })
    .then((result) => save({ status: "done", result }))
    .catch((error) => save({ status: "failed", error: String(error.message || error).slice(0, 300) }))
    .finally(() => { job = null; });
  return state;
}

export const waitForEvaluation = () => job?.promise || Promise.resolve();
