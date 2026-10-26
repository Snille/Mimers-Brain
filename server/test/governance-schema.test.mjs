import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("schema contains review, duplicate and privacy-preserving recall records", async () => {
  const schema = await readFile(new URL("../../db/init.sql", import.meta.url), "utf8");
  assert.match(schema, /CREATE TABLE IF NOT EXISTS memory_review_events/i);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS duplicate_resolutions/i);
  const recall = schema.match(/CREATE TABLE IF NOT EXISTS recall_traces[\s\S]*?\);/i)?.[0] || "";
  assert.match(recall, /result_ids/);
  assert.match(recall, /used_ids/);
  assert.doesNotMatch(recall, /\bquery\b|\bcontent\b|\banswer\b/i);
  assert.match(schema, /derived_from/);
});

test("review UI exposes all non-destructive resolution choices", async () => {
  const source = await readFile(new URL("../public/review.mjs", import.meta.url), "utf8");
  for (const action of ["confirm", "evidence_only", "stale", "reject",
    "keep_both", "related", "supersede", "merge"])
    assert.match(source, new RegExp(action));
  assert.doesNotMatch(source, /"restrict"/);
});

test("review queues and counters only treat current memories as actionable", async () => {
  const source = await readFile(new URL("../lib.mjs", import.meta.url), "utf8");
  const queue = source.match(/export async function reviewQueue[\s\S]*?return rows;\n}/)?.[0] || "";
  assert.match(queue, /lifecycle',[^\n]*\) = 'current'/i);
  assert.doesNotMatch(queue, /lifecycle',[^\n]*\) <> 'archived'/i);

  const pendingCte = source.match(/pending AS \([\s\S]*?\n     \)/)?.[0] || "";
  assert.match(pendingCte, /WHERE lifecycle = 'current'/i);
  assert.match(source, /lifecycle',[^\n]*\) = 'current'[\s\S]*?AS mem_pending_review/i);
});

test("the Thoughts filter, the counter and the Review queue share one review rule", async () => {
  const source = await readFile(new URL("../lib.mjs", import.meta.url), "utf8");
  for (const name of ["reviewQueue", "listThoughts", "textSearch"]) {
    const start = source.indexOf(`export async function ${name}(`);
    const body = start < 0 ? "" : source.slice(start, source.indexOf("\n}\n", start));
    assert.match(body, /AWAITING_REVIEW_SQL/, name);
  }
  assert.match(source, /AWAITING_REVIEW_SQL\}[\s\S]*?AS awaiting_review/);
  const page = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(page, /data-review="\$\{action\}"/);
  assert.match(page, /\/api\/thoughts\/\$\{t\.id\}\/review/);
});
