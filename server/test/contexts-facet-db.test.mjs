// The Contexts list in the sidebar of the Memories page: one chip per
// confirmed context, its count, and a filter that agrees with the tag.

import test from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, skipWithoutDatabase } from "../testing/db.mjs";

test("the sidebar lists each context with a count and filters on it", {
  skip: skipWithoutDatabase,
}, async () => {
  process.env.DATABASE_URL = await freshDatabase("test_context_facet");
  const db = await import("../lib.mjs");
  const contexts = await import("../contexts.mjs");
  const insert = async (title, meta = {}) => (await db.pool.query(
    `INSERT INTO thoughts (content, metadata, tier) VALUES ($1, $2::jsonb, 'open') RETURNING id`,
    [`${title}.`, JSON.stringify({ title, kind: "fact", ...meta })])).rows[0].id;
  try {
    await db.ensureSchema();
    await contexts.saveContext({ name: "Spectrogon", projects: ["spectrogon"] });
    await contexts.saveContext({ name: "Semester" });
    await contexts.saveContext({ name: "Draft" }, { proposed: true });
    const named = await insert("Named fact", { contexts: ["semester"], review_status: "pending" });
    const standing = await insert("Work preference", { kind: "preference", project: "spectrogon" });
    await insert("Work fact", { project: "spectrogon" });
    await insert("Draft fact", { contexts: ["draft"] });

    // A proposal is not listed; a fact of the project is not standing, so it
    // is not counted; a memory waiting for review still is.
    assert.deepEqual((await db.stats(db.ALL)).contexts, { semester: 1, spectrogon: 1 });
    const ids = (rows) => rows.map((r) => r.id);
    assert.deepEqual(ids(await db.listThoughts(db.ALL, { context: "semester" })), [named]);
    assert.deepEqual(ids(await db.listThoughts(db.ALL, { context: "spectrogon" })), [standing]);
    assert.deepEqual(ids(await db.listThoughts(db.ALL, { context: "draft" })), []);
    assert.deepEqual(ids(await db.textSearch(db.ALL, "Work", { context: "spectrogon" })), [standing]);
  } finally {
    await db.pool.end();
  }
});
