// The contradiction measurement on the Settings page: the same prompt the
// nightly check uses, put to one or two models over a set of pairs whose right
// answer is known.
//
// The contradiction model was chosen on 16 pairs once, and on 2026-10-21 a test
// of 57 pairs showed that choice had aged: Qwen3-235B raised again all four
// pairs Erik had dismissed, while gpt-6-luna missed a planted conflict. Without
// a way to rerun it, the next model change would be a guess again.
//
// A case names its two sides by memory id or gives the text itself, so a
// conflict can be planted against a real memory. Like the recall question set
// the cases live in the database, never in git, and a result names cases by id
// and gives verdicts only - no memory text, no model reasons.

import * as ai from "./ai.mjs";
import { getSetting, judgeContradiction, pool, setSetting } from "./lib.mjs";

const CASES_KEY = "contradiction_cases";
const EVALUATION_KEY = "contradiction_evaluation";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXPECT = new Set(["conflict", "consistent"]);
const MAX_MODELS = 2;

const fail = (status, message) => Object.assign(new Error(message), { status });

async function readJson(key) {
  try { return JSON.parse(await getSetting(key)) || null; } catch { return null; }
}

// `expect` may be left out: such a case is run and its verdicts shown, but it
// does not count. That is where a pair goes whose answer nobody knows yet.
export function parseCaseSet(text) {
  let data;
  try { data = JSON.parse(text); } catch (error) { throw new Error(`The case set is not JSON: ${error.message}`); }
  const list = Array.isArray(data) ? data : data?.cases;
  if (!Array.isArray(list) || !list.length) throw new Error("The case set has no cases");
  const seen = new Set();
  return list.map((entry, index) => {
    const id = String(entry?.id || "").trim();
    if (!id) throw new Error(`case ${index + 1} has no id`);
    if (seen.has(id)) throw new Error(`case ${index + 1}: the id ${id} is used twice`);
    seen.add(id);
    const side = (name) => {
      const value = String(entry?.[name] ?? "").trim();
      if (!value) throw new Error(`${id} has no ${name}: a memory id or the text itself`);
      return UUID.test(value) ? { memory: value.toLowerCase() } : { text: value };
    };
    const expect = entry.expect == null || entry.expect === "" ? null : String(entry.expect);
    if (expect !== null && !EXPECT.has(expect)) throw new Error(`${id}: expect must be "conflict", "consistent" or left out`);
    return { id, left: side("left"), right: side("right"), expect };
  });
}

// Pure, so the arithmetic can be tested without a model.
export function scoreModel(verdicts, cases) {
  const scored = cases.map((c, i) => ({ c, v: verdicts[i] })).filter(({ c }) => c.expect);
  const conflicts = scored.filter(({ c }) => c.expect === "conflict");
  const consistent = scored.filter(({ c }) => c.expect === "consistent");
  return {
    caught: conflicts.filter(({ v }) => v.verdict === "conflict").length,
    conflicts: conflicts.length,
    falseAlarms: consistent.filter(({ v }) => v.verdict === "conflict").length,
    consistent: consistent.length,
    errors: verdicts.filter((v) => v.verdict === "error").length,
    ms: verdicts.reduce((sum, v) => sum + (v.ms || 0), 0),
    wrong: scored.filter(({ c, v }) => v.verdict !== c.expect).map(({ c }) => c.id),
  };
}

export async function contradictionSettings() {
  const cases = await readJson(CASES_KEY);
  const evaluation = await readJson(EVALUATION_KEY);
  const list = cases?.cases || [];
  return {
    current: { provider: ai.role("contradiction").provider, model: ai.role("contradiction").model },
    cases: cases ? {
      count: list.length,
      conflicts: list.filter((c) => c.expect === "conflict").length,
      consistent: list.filter((c) => c.expect === "consistent").length,
      unlabelled: list.filter((c) => !c.expect).length,
      updated_at: cases.updated_at,
    } : null,
    evaluation: evaluation && { ...evaluation, ...(job ? { progress: { ...job.progress } } : {}) },
  };
}

export async function saveCases({ text, clear } = {}) {
  if (clear) {
    await pool.query(`DELETE FROM app_settings WHERE key = $1`, [CASES_KEY]);
    return contradictionSettings();
  }
  let cases;
  try { cases = parseCaseSet(String(text || "")); } catch (error) { throw fail(400, error.message); }
  await setSetting(CASES_KEY, JSON.stringify({ cases, updated_at: new Date().toISOString() }));
  return contradictionSettings();
}

// --- measurement -----------------------------------------------------------------

let job = null;

// Read only: no contradiction_checks row, no usage event. A memory outside
// `tiers` is treated as missing, so the open listener could never read the vault
// through a case - though only the full listener reaches this at all.
export async function evaluate(tiers, cases, models, { judge = judgeContradiction, onProgress } = {}) {
  const ids = [...new Set(cases.flatMap((c) => [c.left.memory, c.right.memory]).filter(Boolean))];
  const { rows } = await pool.query(
    `SELECT id::text, content FROM thoughts WHERE id = ANY($1::uuid[]) AND tier = ANY($2)`, [ids, tiers]);
  const text = new Map(rows.map((row) => [row.id, row.content]));
  const warnings = ids.filter((id) => !text.has(id)).map((id) => `${id} does not exist or is outside these tiers`);
  const runnable = cases.filter((c) => [c.left, c.right].every((s) => s.text || text.has(s.memory)));
  const read = (side) => side.text ?? text.get(side.memory);

  const verdicts = models.map(() => []);
  for (const [i, c] of runnable.entries()) {
    await Promise.all(models.map(async (cfg, j) => {
      const t0 = Date.now();
      try {
        const { verdict } = await judge(read(c.left), read(c.right), cfg);
        verdicts[j][i] = { verdict, ms: Date.now() - t0 };
      } catch (error) {
        verdicts[j][i] = { verdict: "error", ms: Date.now() - t0, error: String(error.message || error).slice(0, 200) };
      }
    }));
    onProgress?.(i + 1);
  }

  return {
    warnings,
    skipped: cases.length - runnable.length,
    models: models.map((cfg, j) => ({ provider: cfg.provider, model: cfg.model, ...scoreModel(verdicts[j], runnable) })),
    // Verdicts per case, so a pair two models disagree on can be looked up and
    // given an answer.
    cases: runnable.map((c, i) => ({ id: c.id, expect: c.expect, verdicts: verdicts.map((v) => v[i].verdict) })),
  };
}

// `models` is up to two {provider, model}; the model in use is the default.
export async function startEvaluation(tiers, { models } = {}) {
  if (job) throw fail(409, "A measurement is already running");
  const cases = (await readJson(CASES_KEY))?.cases;
  if (!cases?.length) throw fail(400, "Add a case set first");
  const current = ai.role("contradiction");
  const picked = (Array.isArray(models) && models.length ? models : [current])
    .map((m) => ({ provider: String(m?.provider || "").trim(), model: String(m?.model || "").trim() }))
    .filter((m) => m.provider && m.model).slice(0, MAX_MODELS);
  if (!picked.length) throw fail(400, "Name a provider and a model");
  for (const m of picked)
    if (!ai.provider(m.provider)?.configured) throw fail(400, `Provider "${m.provider}" is not configured`);

  const state = { status: "running", models: picked, started_at: new Date().toISOString() };
  await setSetting(EVALUATION_KEY, JSON.stringify(state));
  const save = (patch) => setSetting(EVALUATION_KEY, JSON.stringify({ ...state, ...patch, finished_at: new Date().toISOString() }));
  job = { progress: { done: 0, total: cases.length } };
  job.promise = evaluate(tiers, cases, picked, { onProgress: (done) => { job.progress.done = done; } })
    .then((result) => save({ status: "done", result }))
    .catch((error) => save({ status: "failed", error: String(error.message || error).slice(0, 300) }))
    .finally(() => { job = null; });
  return state;
}

export const waitForEvaluation = () => job?.promise || Promise.resolve();

// At boot, like loadRecallSettings(): a run the restart cut short says so.
export async function loadContradictionSettings() {
  const evaluation = await readJson(EVALUATION_KEY);
  if (evaluation?.status === "running" && !job)
    await setSetting(EVALUATION_KEY, JSON.stringify({ ...evaluation, status: "failed", error: "Interrupted by a restart" }));
}
