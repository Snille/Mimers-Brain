import test from "node:test";
import assert from "node:assert/strict";
import { degreesFor, freshDatabase, skipWithoutDatabase, vectorAt } from "../testing/db.mjs";

test("contradiction checks judge each similar pair once and keep the verdict", {
  skip: skipWithoutDatabase,
}, async () => {
  process.env.DATABASE_URL = await freshDatabase("test_contradictions");
  process.env.OPENROUTER_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  const judged = [];
  // Stands in for the metadata model: two memories that both name a port
  // disagree, anything else is consistent.
  globalThis.fetch = async (_url, init) => {
    const prompt = JSON.parse(init.body).messages[0].content;
    judged.push(prompt);
    const memories = prompt.match(/<<<FIRST[\s\S]*SECOND>>>/)[0];
    const conflict = (memories.match(/port \d+/g) || []).length >= 2;
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(conflict
        ? { verdict: "conflict", reason: "The two memories name different ports." }
        : { verdict: "consistent", reason: "" }) } }],
    }));
  };
  const db = await import(new URL(`../lib.mjs?contradictions=${Date.now()}`, import.meta.url));
  const confirmed = JSON.stringify({ kind: "fact", lifecycle: "current", review_status: "confirmed" });
  const insert = async (content, degrees, tier = "open") => (await db.pool.query(
    `INSERT INTO thoughts (content, metadata, tier, embedding) VALUES ($1, $2::jsonb, $3, $4::vector) RETURNING id`,
    [content, confirmed, tier, JSON.stringify(vectorAt(degrees))])).rows[0].id;

  try {
    await db.ensureSchema();
    const a = await insert("The brain listens on port 8790", 0);
    const b = await insert("The brain listens on port 9000", degreesFor(0.75));
    await insert("Something unrelated", 120);
    const e = await insert("The brain runs in Docker", -degreesFor(0.7));

    let run = await db.checkContradictions(db.ALL, { limit: 20 });
    assert.equal(run.checked, 2);
    assert.equal(run.conflicts, 1);
    let open = await db.contradictions(db.ALL);
    assert.equal(open.length, 1);
    assert.deepEqual([open[0].left_id, open[0].right_id].sort(), [a, b].sort());
    assert.match(open[0].reason, /different ports/);

    // Nothing changed, so nothing is paid for twice.
    assert.equal((await db.checkContradictions(db.ALL)).checked, 0);

    // A verdict from an earlier model is neither shown nor kept: it is judged again.
    await db.pool.query(`UPDATE contradiction_checks SET model = 'an-earlier-model'`);
    assert.equal((await db.contradictions(db.ALL)).length, 0);
    assert.equal((await db.checkContradictions(db.ALL)).checked, 2);
    assert.equal((await db.contradictions(db.ALL)).length, 1);

    // A changed memory is judged again.
    await db.pool.query(`UPDATE thoughts SET content = 'The brain listens on port 9001' WHERE id = $1`, [b]);
    assert.equal((await db.contradictions(db.ALL)).length, 0, "a verdict on old text is not shown");
    run = await db.checkContradictions(db.ALL);
    assert.equal(run.checked, 1);
    assert.equal((await db.contradictions(db.ALL)).length, 1);

    // The reader's "not a contradiction" sticks until the text changes.
    await db.dismissContradiction(db.ALL, { left_id: b, right_id: a });
    assert.equal((await db.contradictions(db.ALL)).length, 0);
    assert.equal((await db.checkContradictions(db.ALL)).checked, 0);

    // Superseding one side takes the pair off the list.
    await db.pool.query(`UPDATE contradiction_checks SET verdict = 'conflict', model = $1 WHERE verdict = 'dismissed'`,
      [db.contradictionModel()]);
    assert.equal((await db.contradictions(db.ALL)).length, 1);
    await db.linkSupersession(db.ALL, a, [b]);
    assert.equal((await db.contradictions(db.ALL)).length, 0);

    // Linked memories are not compared, and the open listener never reaches the vault.
    const v = await insert("The vault says port 7000", degreesFor(0.72), "vault");
    await db.linkRelations(db.ALL, e, [a], "related_to");
    judged.length = 0;
    assert.equal((await db.checkContradictions(db.OPEN)).checked, 0);
    run = await db.checkContradictions(db.ALL);
    assert.equal(run.checked, 1);
    assert.ok(judged.every((prompt) => prompt.match(/<<<FIRST[\s\S]*SECOND>>>/)[0].includes("port 7000")));
    assert.equal((await db.contradictions(db.OPEN)).length, 0);
    assert.equal((await db.contradictions(db.ALL)).some((pair) => [pair.left_id, pair.right_id].includes(v)), true);

    // The floor belongs to the embedding model and is a setting: above 0.72
    // the vault pair is no longer a candidate.
    await db.pool.query(`UPDATE thoughts SET content = 'The vault says port 7001' WHERE id = $1`, [v]);
    db.applyRecallThresholds({ contradiction: 0.8 });
    assert.equal((await db.checkContradictions(db.ALL)).checked, 0);
    db.applyRecallThresholds({});
    assert.equal(db.recallThresholds().contradiction, 0.6, "the default is back");
    assert.equal((await db.checkContradictions(db.ALL)).checked, 1);

    // The duplicate floor is the same kind of setting. At 0.86 the 0.72 pair is
    // not a duplicate; at 0.7 it is, and an explicit threshold still wins.
    const isPair = (row) => [row.left_id, row.right_id].sort().join() === [a, v].sort().join();
    assert.equal((await db.duplicateCandidates(db.ALL)).some(isPair), false);
    db.applyRecallThresholds({ duplicate: 0.7 });
    assert.equal((await db.duplicateCandidates(db.ALL)).some(isPair), true);
    assert.equal((await db.duplicateCandidates(db.ALL, { threshold: 0.9 })).some(isPair), false);
    db.applyRecallThresholds({});
  } finally {
    globalThis.fetch = realFetch;
    await db.pool.end();
  }
});
