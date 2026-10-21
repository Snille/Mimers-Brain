import test from "node:test";
import assert from "node:assert/strict";

// Pure parsing and scoring. The database test is contradiction-eval-db.test.mjs:
// lib.mjs opens its pool on import, so the two cannot share a process.

const ID = "00000000-0000-4000-8000-0000000000";

test("a case set names each side by memory id or by its text, and expect may be left out", async () => {
  const { parseCaseSet } = await import("../contradiction-eval.mjs");
  const cases = parseCaseSet(JSON.stringify({ cases: [
    { id: "ids", left: `${ID}01`, right: `${ID}02`.toUpperCase(), expect: "consistent" },
    { id: "planted", left: `${ID}01`, right: "The port is 9000.", expect: "conflict" },
    { id: "open", left: "One text.", right: "Another text." },
  ] }));
  assert.deepEqual(cases[0], { id: "ids", left: { memory: `${ID}01` }, right: { memory: `${ID}02` }, expect: "consistent" });
  assert.deepEqual(cases[1].right, { text: "The port is 9000." });
  assert.equal(cases[2].expect, null);
  const withNote = parseCaseSet(JSON.stringify([{ id: "n", left: "a", right: "b", note: " Why. " }]));
  assert.equal(withNote[0].note, "Why.");
  const { caseFile } = await import("../contradiction-eval.mjs");
  assert.deepEqual(caseFile([...cases, ...withNote]).cases.map((c) => [c.left, c.right, c.expect, c.note]), [
    [`${ID}01`, `${ID}02`, "consistent", undefined], [`${ID}01`, "The port is 9000.", "conflict", undefined],
    ["One text.", "Another text.", undefined, undefined], ["a", "b", undefined, "Why."]]);
  assert.throws(() => parseCaseSet("{"), /not JSON/);
  assert.throws(() => parseCaseSet(JSON.stringify({ cases: [] })), /no cases/);
  assert.throws(() => parseCaseSet(JSON.stringify([{ id: "a", left: "x" }])), /a has no right/);
  assert.throws(() => parseCaseSet(JSON.stringify([{ id: "a", left: "x", right: "y" }, { id: "a", left: "x", right: "y" }])), /used twice/);
  assert.throws(() => parseCaseSet(JSON.stringify([{ id: "a", left: "x", right: "y", expect: "maybe" }])), /expect must be/);
});

test("a model is scored on the cases with an answer only", async () => {
  const { scoreModel } = await import("../contradiction-eval.mjs");
  const cases = [{ id: "c1", expect: "conflict" }, { id: "c2", expect: "conflict" }, { id: "k1", expect: "consistent" },
    { id: "k2", expect: "consistent" }, { id: "open", expect: null }];
  const verdicts = [{ verdict: "conflict", ms: 10 }, { verdict: "consistent", ms: 10 }, { verdict: "conflict", ms: 10 },
    { verdict: "error", ms: 5 }, { verdict: "conflict", ms: 10 }];
  assert.deepEqual(scoreModel(verdicts, cases), {
    caught: 1, conflicts: 2, falseAlarms: 1, consistent: 2, errors: 1, ms: 45, wrong: ["c2", "k1", "k2"],
  });
});
