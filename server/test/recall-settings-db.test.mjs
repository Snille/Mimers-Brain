import test from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, skipWithoutDatabase } from "../testing/db.mjs";

// Each question gets two axes of its own: the question lies on the first, and a
// memory placed at similarity s to it lies between the two. Memories meant for
// one question score zero against every other.
const vectorFor = (axis, similarity = 1) => {
  const out = new Array(1536).fill(0);
  out[axis * 2] = similarity;
  out[axis * 2 + 1] = Math.sqrt(1 - similarity * similarity);
  return out;
};
const QUESTIONS = ["Where is alpha kept", "When does bravo run", "Who owns charlie", "Recipe for pancakes"];
const NEXT = "test/next-embed";

test("recall thresholds are stored, measured and follow a switch of embedding model", {
  skip: skipWithoutDatabase,
}, async () => {
  process.env.DATABASE_URL = await freshDatabase("test_recall_settings");
  process.env.OPENROUTER_API_KEY = "test-key";
  delete process.env.RECALL_HINT_FLOOR;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    // The next model sees every text alike, so every score is 1.
    const embedding = (text) => body.model === NEXT ? [1, 0, 0, 0, 0, 0, 0, 0] : vectorFor(Math.max(0, QUESTIONS.indexOf(text)));
    return new Response(JSON.stringify({ data: inputs.map((text, index) => ({ index, embedding: embedding(text) })) }));
  };
  // Plain imports: recall-settings.mjs and model-settings.mjs share this lib.mjs,
  // and with it the thresholds in force.
  const db = await import("../lib.mjs");
  const models = await import("../model-settings.mjs");
  const recall = await import("../recall-settings.mjs");
  const insert = async (title, vector) => (await db.pool.query(
    `INSERT INTO thoughts (content, metadata, tier, embedding) VALUES ($1, $2::jsonb, 'open', $3::vector) RETURNING id`,
    [`Note number ${title}.`, JSON.stringify({ title: `Note ${title}`, summary: "x.", kind: "fact" }), JSON.stringify(vector)])).rows[0].id;

  try {
    await db.ensureSchema();
    await models.loadModelSettings();
    await recall.loadRecallSettings();

    let settings = await recall.recallSettings();
    assert.deepEqual([settings.thresholds.search, settings.thresholds.hint], [0.3, 0.5]);
    assert.deepEqual(settings.thresholds.source, { search: "default", hint: "default", contradiction: "default", duplicate: "default" });
    assert.equal(settings.thresholds.contradiction, 0.6);
    assert.equal(settings.thresholds.model, recall.DEFAULTS_MEASURED_WITH);

    // A stored value is in force at once, for search's own default too.
    const a = await insert("one", vectorFor(0, 0.95));
    const b = await insert("two", vectorFor(1, 0.63));
    const c = await insert("three", vectorFor(2, 0.57));
    await insert("four", vectorFor(3, 0.44));
    settings = await recall.saveThresholds({ search: 0.6 });
    assert.equal(db.recallThresholds().search, 0.6);
    assert.equal(settings.thresholds.source.search, "settings");
    assert.equal(settings.thresholds.model, "openai/text-embedding-3-small");
    assert.deepEqual((await db.searchThoughts(db.ALL, QUESTIONS[1])).map((row) => row.id), [b]);
    await assert.rejects(recall.saveThresholds({ search: 2 }), /between 0.05 and 0.95/);
    settings = await recall.saveThresholds({ search: "" });
    assert.equal(db.recallThresholds().search, 0.3, "an empty value brings back the default");

    // The contradiction floor changes only when it is named, so saving a
    // measured suggestion for search and hint leaves it alone.
    settings = await recall.saveThresholds({ contradiction: 0.7 });
    assert.equal(db.recallThresholds().contradiction, 0.7);
    assert.equal(settings.thresholds.source.contradiction, "settings");
    await recall.saveThresholds({ search: 0.35, hint: 0.5 });
    assert.equal(db.recallThresholds().contradiction, 0.7);
    await assert.rejects(recall.saveThresholds({ contradiction: 1 }), /contradiction threshold must be between/);
    await recall.saveThresholds({ search: "", hint: "", contradiction: "" });
    assert.deepEqual(db.recallThresholds(), { search: 0.3, hint: 0.5, contradiction: 0.6, duplicate: 0.86 });

    // The question set is checked before it is stored.
    await assert.rejects(recall.startEvaluation(db.ALL), /question set/);
    await assert.rejects(recall.saveQuestions({ text: "{}" }), /no questions/);
    settings = await recall.saveQuestions({ text: JSON.stringify({ questions: [
      { id: "alpha", q: QUESTIONS[0], expect: [a] },
      { id: "bravo", q: QUESTIONS[1], expect: [b] },
      { id: "charlie", q: QUESTIONS[2], expect: [c] },
      { id: "none", q: QUESTIONS[3], expect: [] },
    ] }) });
    assert.deepEqual(settings.questions, { ...settings.questions, count: 4, positives: 3, negatives: 1 });

    await recall.startEvaluation(db.ALL);
    await assert.rejects(recall.startEvaluation(db.ALL), /already running/);
    await recall.waitForEvaluation();
    let { evaluation } = await recall.recallSettings();
    assert.equal(evaluation.status, "done", evaluation.error);
    assert.equal(evaluation.result.variants[0].summary.hit1, 1);
    // Lowest right answer 0.57, less 0.1, rounded down; the highest floor that
    // still shows every answer and nothing for the pancakes.
    assert.equal(evaluation.result.suggestion.search.value, 0.45);
    assert.equal(evaluation.result.suggestion.hint.value, 0.55);
    assert.doesNotMatch(JSON.stringify(evaluation), /Note number|alpha kept/, "ids only, never text");
    assert.equal(Number((await db.pool.query("SELECT count(*) FROM recall_traces")).rows[0].count), 0);

    // Floors measured on a re-embedding wait for the switch.
    await models.startReembed({ provider: "openrouter", model: NEXT });
    await models.waitForWorker();
    await recall.startEvaluation(db.ALL, { target: "next" });
    await recall.waitForEvaluation();
    ({ evaluation } = await recall.recallSettings());
    assert.equal(evaluation.status, "done", evaluation.error);
    assert.equal(evaluation.model, NEXT);
    assert.equal(evaluation.result.suggestion.search.value, 0.6, "clamped");
    await recall.saveThresholds({ target: "next", contradiction: 0.65, duplicate: 0.82 });
    settings = await recall.saveThresholds({ target: "next", search: 0.6, hint: 0.85 });
    assert.deepEqual(settings.thresholds.next, { search: 0.6, hint: 0.85, contradiction: 0.65, duplicate: 0.82, model: NEXT });
    assert.equal(db.recallThresholds().search, 0.3, "not before the switch");

    await models.switchEmbedding();
    settings = await recall.recallSettings();
    assert.deepEqual([settings.thresholds.search, settings.thresholds.hint, settings.thresholds.model], [0.6, 0.85, NEXT]);
    assert.equal(settings.thresholds.next, null);
    assert.deepEqual(db.recallThresholds(), { search: 0.6, hint: 0.85, contradiction: 0.65, duplicate: 0.82 });

    // A cancelled run takes its floors with it.
    await models.startReembed({ provider: "openrouter", model: "test/other" });
    await models.waitForWorker();
    await recall.saveThresholds({ target: "next", search: 0.4 });
    await models.cancelReembed();
    assert.equal((await recall.recallSettings()).thresholds.next, null);
    assert.deepEqual(db.recallThresholds(), { search: 0.6, hint: 0.85, contradiction: 0.65, duplicate: 0.82 });
  } finally {
    globalThis.fetch = realFetch;
    await db.pool.end();
  }
});
