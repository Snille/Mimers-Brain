import test from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, skipWithoutDatabase } from "../testing/db.mjs";

test("the contradiction measurement reads memories, runs two models and stores ids and verdicts only", {
  skip: skipWithoutDatabase,
}, async () => {
  process.env.DATABASE_URL = await freshDatabase("test_contradiction_eval");
  process.env.OPENROUTER_API_KEY = "test-key";
  const db = await import("../lib.mjs");
  const evalMod = await import("../contradiction-eval.mjs");
  const insert = async (content, tier = "open") => (await db.pool.query(
    `INSERT INTO thoughts (content, metadata, tier) VALUES ($1, '{"kind":"fact"}'::jsonb, $2) RETURNING id`,
    [content, tier])).rows[0].id;

  try {
    await db.ensureSchema();
    const port = await insert("The brain listens on port 8790");
    const docker = await insert("The brain runs in Docker");
    const vault = await insert("The vault says port 7000", "vault");
    // "strict" sees a conflict only when both sides name a port; "eager" sees one everywhere.
    const judge = async (left, right, cfg) => ({
      verdict: cfg.model === "eager" || (/port \d+/.test(left) && /port \d+/.test(right)) ? "conflict" : "consistent",
    });
    const cases = evalMod.parseCaseSet(JSON.stringify({ cases: [
      { id: "planted", left: port, right: "The brain listens on port 9000", expect: "conflict" },
      { id: "fine", left: port, right: docker, expect: "consistent" },
      { id: "open", left: docker, right: "It is a Node.js app" },
      { id: "vault", left: vault, right: port, expect: "conflict" },
    ] }));

    let result = await evalMod.evaluate(db.ALL, cases,
      [{ provider: "openrouter", model: "strict" }, { provider: "openrouter", model: "eager" }], { judge });
    assert.deepEqual(result.models.map((m) => [m.model, m.caught, m.conflicts, m.falseAlarms, m.consistent]),
      [["strict", 2, 2, 0, 1], ["eager", 2, 2, 1, 1]]);
    assert.deepEqual(result.cases.find((c) => c.id === "open"), { id: "open", expect: null, verdicts: ["consistent", "conflict"] });
    assert.doesNotMatch(JSON.stringify(result), /listens|Docker|vault says/, "ids and verdicts only, never text");

    // The open tier cannot read the vault through a case.
    result = await evalMod.evaluate(db.OPEN, cases, [{ provider: "openrouter", model: "strict" }], { judge });
    assert.equal(result.skipped, 1);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.cases.some((c) => c.id === "vault"), false);

    // Stored cases and the background run, refused without a set or a provider.
    await assert.rejects(evalMod.startEvaluation(db.ALL), /case set first/);
    const settings = await evalMod.saveCases({ text: JSON.stringify({ cases: [
      { id: "a", left: port, right: docker, expect: "consistent" }, { id: "b", left: "x", right: "y" }] }) });
    assert.deepEqual(settings.cases, { ...settings.cases, count: 2, conflicts: 0, consistent: 1, unlabelled: 1 });
    await assert.rejects(evalMod.startEvaluation(db.ALL, { models: [{ provider: "nowhere", model: "m" }] }), /not configured/);

    // A stored run, then an answer given on the page: the texts are read on
    // request, the answer counts at once and the file can be downloaded.
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ verdict: "conflict", reason: "x" }) } }] }));
    try {
      await evalMod.startEvaluation(db.ALL, { models: [{ provider: "openrouter", model: "always" }] });
      await evalMod.waitForEvaluation();
    } finally { globalThis.fetch = realFetch; }
    let { evaluation } = await evalMod.contradictionSettings();
    assert.equal(evaluation.status, "done", evaluation.error);
    assert.deepEqual([evaluation.result.models[0].falseAlarms, evaluation.result.models[0].consistent], [1, 1]);

    const texts = await evalMod.caseTexts(db.ALL, "b");
    assert.deepEqual([texts.left.text, texts.right.text, texts.expect], ["x", "y", null]);
    assert.equal((await evalMod.caseTexts(db.ALL, "a")).right.text, "The brain runs in Docker");
    await assert.rejects(evalMod.caseTexts(db.ALL, "nope"), /No case/);

    await assert.rejects(evalMod.labelCase({ id: "b", expect: "maybe" }), /expect must be/);
    ({ evaluation } = await evalMod.labelCase({ id: "b", expect: "conflict" }));
    assert.deepEqual([evaluation.result.models[0].caught, evaluation.result.models[0].conflicts], [1, 1]);
    assert.equal(evaluation.result.cases.find((c) => c.id === "b").expect, "conflict");
    assert.deepEqual((await evalMod.exportCases()).cases.map((c) => c.expect), ["consistent", "conflict"]);
    await evalMod.labelCase({ id: "b", expect: "" });
    assert.equal((await evalMod.exportCases()).cases[1].expect, undefined);

    assert.equal((await evalMod.saveCases({ clear: true })).cases, null);
    assert.equal(Number((await db.pool.query("SELECT count(*) FROM contradiction_checks")).rows[0].count), 0);
  } finally {
    await db.pool.end();
  }
});
