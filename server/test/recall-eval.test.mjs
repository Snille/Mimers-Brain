import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { formatReport, hintIds, parseQuestionSet, rankOf, suggestThresholds, summarise } from "../recall-eval.mjs";
import { RANK_WEIGHTS, rankWeights } from "../lib.mjs";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";
const row = (id, semantic_score) => ({ id, semantic_score });

test("a question set needs ids, text and a list of expected memories", () => {
  const set = parseQuestionSet(JSON.stringify({ questions: [{ id: "a", q: "Where?", expect: [A.toUpperCase()] }, { id: "none", q: "Weather?", expect: [] }] }));
  assert.deepEqual(set, [{ id: "a", q: "Where?", expect: [A] }, { id: "none", q: "Weather?", expect: [] }]);
  assert.throws(() => parseQuestionSet("[]"), /no questions/);
  assert.throws(() => parseQuestionSet('[{"id":"a","q":"x"}]'), /needs expect/);
  assert.throws(() => parseQuestionSet('[{"id":"a","q":"x","expect":["nope"]}]'), /not a memory id/);
  assert.throws(() => parseQuestionSet(`[{"id":"a","q":"x","expect":[]},{"id":"a","q":"y","expect":[]}]`), /used twice/);
});

test("the example question set is valid", async () => {
  const text = await readFile(new URL("../../eval/recall-questions.example.json", import.meta.url), "utf8");
  assert.ok(parseQuestionSet(text).length >= 2);
});

test("rank is the position of the first expected memory", () => {
  assert.equal(rankOf([row(B), row(A)], [A, C]), 2);
  assert.equal(rankOf([row(B)], [A]), null);
});

test("hints follow recallHint: rank order, semantic floor, at most three", () => {
  const rows = [row(A, 0.49), row(B, 0.7), row(C, 0.5), row("d", 0.9), row("e", 0.8)];
  assert.deepEqual(hintIds(rows, 0.5), [B, C, "d"]);
});

test("summary counts hits, reciprocal rank, hint noise and misses", () => {
  const s = summarise([
    { id: "first", expect: [A], rows: [row(A, 0.8), row(B, 0.6)] },
    { id: "second", expect: [A], rows: [row(B, 0.6), row(A, 0.55)] },
    { id: "lost", expect: [C], rows: [row(B, 0.45)] },
    { id: "none", expect: [], rows: [row(B, 0.52)] },
  ], { floors: [0.5, 0.6] });
  assert.equal(s.positives, 3);
  assert.equal(s.negatives, 1);
  assert.equal(s.hit1, 1 / 3);
  assert.equal(s.hit5, 2 / 3);
  assert.equal(s.mrr, (1 + 1 / 2) / 3);
  assert.deepEqual(s.hint, [
    { floor: 0.5, hit: 2 / 3, offTarget: 0, noise: 1 },
    { floor: 0.6, hit: 1 / 3, offTarget: 1 / 3, noise: 0 },
  ]);
  assert.deepEqual(s.misses, [{ id: "lost", rank: null, top: B }]);
});

test("the report names memories by id only", () => {
  const summary = summarise([{ id: "q1", expect: [A], rows: [{ id: B, semantic_score: 0.4, content: "SECRET CONTENT", metadata: { title: "SECRET TITLE" } }] }]);
  const text = formatReport([{ name: "current", summary }]);
  assert.match(text, /q1: not in the top 20, first was 0{8}-/);
  assert.doesNotMatch(text, /SECRET/);
});

test("rank weights default to the shipped ranking and refuse unknown keys", () => {
  assert.deepEqual(rankWeights(), { ...RANK_WEIGHTS });
  assert.equal(rankWeights({ title: 0 }).title, 0);
  assert.throws(() => rankWeights({ titel: 0 }), /Unknown rank weight/);
  assert.throws(() => rankWeights({ title: "x" }), /must be a number/);
});

test("suggested thresholds: lowest right answer less a margin, and the hint floor with least noise", () => {
  const results = [
    { id: "a", expect: [A], expectedScore: 0.92, rows: [row(A, 0.92)] },
    { id: "b", expect: [B], expectedScore: 0.63, rows: [row(B, 0.63), row(C, 0.4)] },
    { id: "c", expect: [C], expectedScore: 0.57, rows: [row(C, 0.57)] },
    { id: "none", expect: [], expectedScore: null, rows: [row(A, 0.44)] },
  ];
  const s = suggestThresholds(results);
  // 0.57 - 0.1 = 0.47, rounded down to 0.45.
  assert.equal(s.search.value, 0.45);
  assert.equal(s.search.lowest, 0.57);
  // Every floor from 0.45 to 0.55 shows all three answers and no noise; the
  // highest of them wins.
  assert.equal(s.hint.value, 0.55);
  assert.equal(s.hint.hit, 1);
  assert.equal(s.hint.noise, 0);
});

test("no suggestion without enough questions to rest it on", () => {
  const one = [{ id: "a", expect: [A], expectedScore: 0.9, rows: [row(A, 0.9)] }];
  assert.deepEqual(suggestThresholds(one), { search: null, hint: null, positives: 1, negatives: 0 });
  const answeredOnly = ["a", "b", "c"].map((id) => ({ id, expect: [A], expectedScore: 0.99, rows: [row(A, 0.99)] }));
  const s = suggestThresholds(answeredOnly);
  assert.equal(s.search.value, 0.6, "clamped: a high score never makes search strict");
  assert.equal(s.hint, null, "a floor needs a question with no answer to measure noise");
});
