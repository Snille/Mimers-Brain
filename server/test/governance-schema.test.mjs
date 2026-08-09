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
  for (const action of ["confirm", "evidence_only", "restrict", "stale", "reject",
    "keep_both", "related", "supersede", "merge"])
    assert.match(source, new RegExp(action));
});
