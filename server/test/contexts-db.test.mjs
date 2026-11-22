// Contexts: one start pack per kind of work. The base holds what is true
// everywhere; a context's memories leave the base and come back only when a
// model asks for that context, where they win.

import test from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, skipWithoutDatabase } from "../testing/db.mjs";

test("a context takes its memories out of the base and gives them back on request", {
  skip: skipWithoutDatabase,
}, async () => {
  process.env.DATABASE_URL = await freshDatabase("test_contexts");
  // Plain imports: contexts.mjs and mcp.mjs share lib.mjs's pool with the test.
  const db = await import("../lib.mjs");
  const contexts = await import("../contexts.mjs");
  const { buildServer } = await import("../mcp.mjs");
  const insert = async (title, meta = {}, tier = "open") => (await db.pool.query(
    `INSERT INTO thoughts (content, metadata, tier) VALUES ($1, $2::jsonb, $3) RETURNING id`,
    [`${title}.`, JSON.stringify({ title, kind: "preference", review_status: "confirmed", ...meta }), tier])).rows[0].id;
  const ids = (digest) => digest.items.map((i) => i.id).sort();
  const digestText = async (tiers, args = {}) => {
    const out = await buildServer(tiers, { writable: false })._registeredTools.memory_digest
      .handler({ include_base: true, ...args });
    return { error: out.isError === true, text: out.content.map((c) => c.text).join("\n") };
  };
  try {
    await db.ensureSchema();
    const green = await insert("Erik likes a green accent");
    const red = await insert("Spectrogon apps use red", { project: "spectrogon" });
    const holidayFact = await insert("Link holiday pictures from Immich", { kind: "fact", contexts: ["semester"] });
    const plainFact = await insert("A plain fact", { kind: "fact", project: "spectrogon" });

    // No context yet: everything standing is in the base, and the named
    // context means nothing while it does not exist.
    assert.deepEqual(ids(await db.memoryDigest(db.ALL)), [green, red].sort());

    // A new context gets its id from its name; editing an id that does not
    // exist is refused.
    await assert.rejects(contexts.saveContext({ id: "nowhere", name: "X" }), /No context/);
    const work = await contexts.saveContext({ name: "Spectrogon", projects: "spectrogon, ", description: "Work apps", instruction: "Use the company look." });
    assert.equal(work.id, "spectrogon");
    assert.equal(work.status, "confirmed");
    const holiday = await contexts.saveContext({ name: "Semester", description: "Trips and holidays" });
    assert.equal(holiday.id, "semester");
    assert.deepEqual(work.projects, ["spectrogon"]);

    // The base no longer holds the work rule; the context does, and the
    // named fact joins its context whatever its kind. A fact of the project
    // that was never standing stays out of both.
    assert.deepEqual(ids(await db.memoryDigest(db.ALL)), [green]);
    assert.deepEqual(ids(await db.memoryDigest(db.ALL, { context: work })), [red]);
    assert.deepEqual(ids(await db.memoryDigest(db.ALL, { context: holiday })), [holidayFact]);
    assert.equal((await db.memoryDigest(db.ALL, { context: work })).items.some((i) => i.id === plainFact), false);
    assert.equal(Number((await db.stats(db.ALL)).digest), 1);

    // A model proposes a context: saved, but not listed, used or scoping.
    const proposed = await contexts.saveContext({ name: "Skattjakt", projects: ["treasure"] }, { proposed: true, by: "Claude Code" });
    assert.equal(proposed.status, "proposed");
    await insert("Treasure hunt rule", { project: "treasure" });
    assert.equal((await db.memoryDigest(db.ALL)).count, 2);
    assert.equal((await contexts.listContexts()).some((c) => c.id === "skattjakt"), false);
    await assert.rejects(contexts.saveContext({ name: "Semester" }, { proposed: true }), /exists already/);
    await contexts.confirmContext("skattjakt");
    assert.equal((await db.memoryDigest(db.ALL)).count, 1);

    // The MCP digest lists the contexts, and gives one on request.
    const base = await digestText(db.ALL);
    assert.match(base.text, /Contexts - kinds of work/);
    assert.match(base.text, /- semester: Semester - Trips and holidays/);
    assert.match(base.text, /Erik likes a green accent/);
    assert.doesNotMatch(base.text, /Spectrogon apps use red/);
    const chosen = await digestText(db.ALL, { context: work.id, include_base: false });
    assert.match(chosen.text, /Context: Spectrogon/);
    assert.match(chosen.text, /In this context:\nUse the company look\./);
    assert.match(chosen.text, /Spectrogon apps use red/);
    assert.doesNotMatch(chosen.text, /green accent/);
    assert.doesNotMatch(chosen.text, /Connection scope/);
    assert.match((await digestText(db.ALL, { context: work.id })).text, /green accent/);
    const unknown = await digestText(db.ALL, { context: "nowhere" });
    assert.equal(unknown.error, true);
    assert.match(unknown.text, /Contexts: semester, skattjakt, spectrogon/);

    // propose_context exists on the full listener only.
    const names = (tiers) => Object.keys(buildServer(tiers, {})._registeredTools);
    assert.equal(names(db.ALL).includes("propose_context"), true);
    assert.equal(names(["open"]).includes("propose_context"), false);

    // An agent cannot put its own memory in a context; the reader can.
    const saved = await db.captureThought(db.ALL, "An agent memory that asks for a context.", {
      metadata: { title: "Agent memory", kind: "fact", contexts: ["semester"] },
    });
    assert.equal("contexts" in saved.metadata, false);

    // A replacement keeps the contexts of what it replaces.
    const replacement = await insert("Holiday pictures, corrected", { kind: "fact" });
    await db.linkSupersession(db.ALL, replacement, [holidayFact]);
    assert.deepEqual((await db.getThought(db.ALL, replacement)).metadata.contexts, ["semester"]);

    // Deleting a context puts its memories back in the base.
    await contexts.deleteContext(work.id);
    assert.deepEqual(ids(await db.memoryDigest(db.ALL)), [green, red].sort());
  } finally {
    await db.pool.end();
  }
});
