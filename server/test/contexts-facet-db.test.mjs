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
    // Replaced by a newer memory: not in the list the chip opens, so not counted.
    await insert("Old work preference", { kind: "preference", project: "spectrogon", lifecycle: "superseded" });

    // A proposal is not listed; a fact of the project is not standing, so it
    // is not counted; a memory waiting for review still is.
    const stats = await db.stats(db.ALL);
    assert.deepEqual(stats.contexts, { semester: 1, spectrogon: 1 });
    // What a model gets with each context: the memory waiting for review is
    // counted in the context but is not in its start pack.
    assert.deepEqual(stats.contextPacks, {
      semester: { fits: [], omitted: 0 },
      spectrogon: { fits: [standing], omitted: 0 },
    });
    // The project list counts every lifecycle unless asked for one; the web
    // page asks for the lifecycle its list shows, so the chip and the list agree.
    assert.equal(stats.projects.spectrogon, 3);
    const current = await db.stats(db.ALL, { lifecycle: "current" });
    assert.equal(current.projects.spectrogon, 2);
    assert.equal(current.kinds.preference, 1);
    assert.equal(current.lifecycles.superseded, 1);
    assert.equal(current.total, stats.total);
    assert.equal((await db.stats(db.ALL, { lifecycle: "all" })).projects.spectrogon, 3);
    const ids = (rows) => rows.map((r) => r.id);
    assert.deepEqual(ids(await db.listThoughts(db.ALL, { context: "semester" })), [named]);
    assert.deepEqual(ids(await db.listThoughts(db.ALL, { context: "spectrogon" })), [standing]);
    assert.deepEqual(ids(await db.listThoughts(db.ALL, { context: "draft" })), []);
    assert.deepEqual(ids(await db.textSearch(db.ALL, "Work", { context: "spectrogon" })), [standing]);

    // Several chips in one group: a memory has one project, so two projects
    // mean either; it can name many systems, so two systems mean both. People
    // and systems match in any letter case, as the sidebar counts them.
    const both = await insert("Both systems", { project: "home", systems: ["Home Assistant", "ESPHome"] });
    const ha = await insert("One system", { project: "home", systems: ["home assistant"] });
    const sorted = async (filters) => ids(await db.listThoughts(db.ALL, filters)).sort();
    assert.deepEqual(await sorted({ system: ["Home Assistant", "ESPHome"] }), [both]);
    assert.deepEqual(await sorted({ system: "Home Assistant" }), [both, ha].sort());
    assert.equal((await db.listThoughts(db.ALL, { project: ["home", "spectrogon"] })).length, 4);
    assert.equal((await db.listThoughts(db.ALL, { project: "spectrogon", lifecycle: ["current", "superseded"] })).length, 3);
    assert.equal((await db.stats(db.ALL, { lifecycle: ["current", "superseded"] })).projects.spectrogon, 3);
    assert.deepEqual(ids(await db.textSearch(db.ALL, "system", { system: ["ESPHome", "home assistant"] })), [both]);
  } finally {
    await db.pool.end();
  }
});
