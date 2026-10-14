import test from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, skipWithoutDatabase, vectorAt } from "../testing/db.mjs";

// The new model answers in 8 dimensions, and puts anything about a port on one
// axis and everything else on another, so a search can tell the models apart.
const NEW = "test/new-embed";
function newVector(text) {
  const out = new Array(8).fill(0);
  out[/port/i.test(text) ? 0 : 1] = 1;
  return out;
}

test("a new embedding model is filled in beside the old one and switched in one step", {
  skip: skipWithoutDatabase,
}, async () => {
  process.env.DATABASE_URL = await freshDatabase("test_reembed");
  process.env.OPENROUTER_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return new Response(JSON.stringify({ data: inputs.map((text, index) =>
      ({ index, embedding: body.model === NEW || body.model === "test/other" ? newVector(text) : vectorAt(0) })) }));
  };
  const db = await import(new URL(`../lib.mjs?reembed=${Date.now()}`, import.meta.url));
  const models = await import(new URL(`../model-settings.mjs?reembed=${Date.now()}`, import.meta.url));
  const meta = (title) => ({ metadata: { title, summary: `${title}.`, kind: "fact" }, origin: "user", userConfirmed: true });

  try {
    await db.ensureSchema();
    await models.loadModelSettings();
    assert.equal((await models.modelSettings()).roles.embedding.dimensions, 1536);

    const port = await db.captureThought(db.ALL, "The brain listens on port 8790", meta("Brain port"));
    const docker = await db.captureThought(db.ALL, "The brain runs in Docker", meta("Brain runtime"));
    const backup = await db.captureThought(db.ALL, "Backups run nightly", meta("Backups"));
    await db.pool.query(
      `INSERT INTO contradiction_checks (left_id, right_id, verdict, reason, model)
       VALUES (LEAST($1::uuid, $2::uuid), GREATEST($1::uuid, $2::uuid), 'conflict', 'test', $3)`,
      [port.id, docker.id, db.contradictionModel()]);
    const stamps = async () => (await db.pool.query(`SELECT id, updated_at FROM thoughts ORDER BY id`)).rows;
    const before = await stamps();
    const changesBefore = Number((await db.pool.query(`SELECT count(*) FROM thought_changes`)).rows[0].count);

    await models.startReembed({ provider: "openrouter", model: NEW });
    await models.waitForWorker();
    let settings = await models.modelSettings();
    assert.equal(settings.migration.status, "ready");
    assert.deepEqual(settings.migration.progress, { total: 3, done: 3 });
    assert.equal(settings.roles.embedding.model, "openai/text-embedding-3-small", "search keeps the old model");

    // A new vector is not a new version: no updated_at, no change log, no lost verdict.
    assert.deepEqual(await stamps(), before);
    assert.equal(Number((await db.pool.query(`SELECT count(*) FROM thought_changes`)).rows[0].count), changesBefore);
    assert.equal((await db.contradictions(db.ALL)).length, 1);

    const compared = await models.compareSearch(db.ALL, "which port");
    assert.equal(compared.current.length, 3);
    assert.equal(compared.next[0].id, port.id);

    // An edit during the run sends the row back to the queue.
    await db.updateThought(db.ALL, backup.id, { content: "Backups run nightly at 00:10" });
    const { rows: [edited] } = await db.pool.query(`SELECT embedding_next IS NULL AS cleared FROM thoughts WHERE id = $1`, [backup.id]);
    assert.equal(edited.cleared, true);

    const role = await models.switchEmbedding();
    assert.deepEqual([role.provider, role.model, role.dimensions], ["openrouter", NEW, 8]);
    assert.equal(await models.columnDimensions("embedding"), 8);
    assert.equal(await models.columnDimensions("embedding_next"), null);
    const { rows: [counts] } = await db.pool.query(`SELECT count(*) FILTER (WHERE embedding IS NULL) AS missing FROM thoughts`);
    assert.equal(Number(counts.missing), 0, "the edited row was caught up before the switch");
    const [top] = await db.searchThoughts(db.ALL, "which port", { limit: 1 });
    assert.equal(top.id, port.id, "search now embeds the question with the new model");
    assert.equal((await db.contradictions(db.ALL)).length, 1, "the verdict survived the switch");
    settings = await models.modelSettings();
    assert.equal(settings.migration, null);
    assert.equal(settings.roles.embedding.source, "settings");

    // Choosing the same model again is refused; a run can be cancelled cleanly.
    await assert.rejects(models.startReembed({ provider: "openrouter", model: NEW }), /already in use/);
    await models.startReembed({ provider: "openrouter", model: "test/other" });
    await models.waitForWorker();
    await models.cancelReembed();
    assert.equal(await models.columnDimensions("embedding_next"), null);
    assert.equal((await models.modelSettings()).migration, null);

    // The chat roles change at once; the embedding role only through a switch.
    const saved = await models.saveRole("metadata", { provider: "openrouter", model: "some/model" });
    assert.equal(saved.model, "some/model");
    await assert.rejects(models.saveRole("embedding", { provider: "openrouter", model: "x" }), /re-embedding/);
    const openaiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    await assert.rejects(models.saveRole("metadata", { provider: "openai", model: "x" }), /not configured/);
    if (openaiKey !== undefined) process.env.OPENAI_API_KEY = openaiKey;

    // A save that missed its vector is filled in by the nightly pass.
    await db.pool.query(`UPDATE thoughts SET embedding = NULL WHERE id = $1`, [docker.id]);
    assert.equal(await models.fillMissingEmbeddings(), 1);
  } finally {
    globalThis.fetch = realFetch;
    await db.pool.end();
  }
});
