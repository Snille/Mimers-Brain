import test from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, skipWithoutDatabase } from "../testing/db.mjs";

test("text search finds a memory by its GUID, whole or in part", {
  skip: skipWithoutDatabase,
}, async () => {
  process.env.DATABASE_URL = await freshDatabase("test_id_search");
  const db = await import(new URL(`../lib.mjs?id-search=${Date.now()}`, import.meta.url));
  const insert = async (title, extra = {}) => (await db.pool.query(
    `INSERT INTO thoughts (content, metadata, tier) VALUES ($1, $2::jsonb, 'open') RETURNING id`,
    [`${title}, in full.`, JSON.stringify({ title, summary: `${title}.`, kind: "fact", ...extra })])).rows[0].id;
  try {
    await db.ensureSchema();
    const current = await insert("Current memory");
    const old = await insert("Old memory", { lifecycle: "superseded" });

    assert.deepEqual((await db.textSearch(db.ALL, current)).map((r) => r.id), [current]);
    assert.deepEqual((await db.textSearch(db.ALL, current.slice(0, 8))).map((r) => r.id), [current]);
    // A full GUID finds the memory even when it is no longer current.
    assert.deepEqual((await db.textSearch(db.ALL, old)).map((r) => r.id), [old]);
    // A part of one still respects the lifecycle filter.
    assert.deepEqual((await db.textSearch(db.ALL, old.slice(0, 8))).map((r) => r.id), []);
  } finally {
    await db.pool.end();
  }
});
