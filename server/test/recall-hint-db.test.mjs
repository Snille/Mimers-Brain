import test from "node:test";
import assert from "node:assert/strict";
import { degreesFor, freshDatabase, skipWithoutDatabase, vectorAt } from "../testing/db.mjs";

test("a recall hint returns only clear hits and never embeds a credential", {
  skip: skipWithoutDatabase,
}, async () => {
  process.env.DATABASE_URL = await freshDatabase("test_recall_hint");
  process.env.OPENROUTER_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  let embedded = 0;
  globalThis.fetch = async () => {
    embedded += 1;
    return new Response(JSON.stringify({ data: [{ embedding: vectorAt(0) }] }));
  };
  const db = await import(new URL(`../lib.mjs?recall-hint=${Date.now()}`, import.meta.url));
  const insert = async (title, degrees, extra = {}) => (await db.pool.query(
    `INSERT INTO thoughts (content, metadata, tier, embedding) VALUES ($1, $2::jsonb, 'open', $3::vector) RETURNING id`,
    [`${title}, in full.`, JSON.stringify({ title, summary: `${title}.`, kind: "procedure", ...extra }),
      JSON.stringify(vectorAt(degrees))])).rows[0].id;

  try {
    await db.ensureSchema();
    const exact = await insert("Deploy Mimers Brain", 0, { project: "mimers-brain" });
    const close = await insert("Restart the brain container", degreesFor(0.8));
    const near = await insert("Back up the brain database", degreesFor(0.6));
    await insert("Weak match", degreesFor(0.45));
    await insert("Rejected match", degreesFor(0.9), { review_status: "rejected" });

    const { hits } = await db.recallHint(db.ALL, "How do I deploy the brain to the server?");
    assert.deepEqual(hits.map((hit) => hit.id), [exact, close, near]);
    assert.equal(hits[0].project, "mimers-brain");
    assert.equal(hits[0].similarity, 1);

    const again = await db.recallHint(db.ALL, "How do I deploy the brain to the server?", { exclude: [exact] });
    assert.deepEqual(again.hits.map((hit) => hit.id), [close, near]);

    const before = embedded;
    assert.deepEqual(await db.recallHint(db.ALL, "ok kör"), { hits: [], skipped: "short" });
    assert.deepEqual(
      await db.recallHint(db.ALL, "use this key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"),
      { hits: [], skipped: "secret" });
    assert.equal(embedded, before, "nothing was sent to the embedder");

    // Searching leaves no receipt behind: the model did not ask.
    assert.equal(Number((await db.pool.query("SELECT count(*) FROM recall_traces")).rows[0].count), 0);
  } finally {
    globalThis.fetch = realFetch;
    await db.pool.end();
  }
});
