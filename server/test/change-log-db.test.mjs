import test from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, skipWithoutDatabase, vectorAt } from "../testing/db.mjs";

test("the change log records every write, names the writer and can undo it", {
  skip: skipWithoutDatabase,
}, async () => {
  process.env.DATABASE_URL = await freshDatabase("test_change_log");
  process.env.OPENROUTER_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ embedding: vectorAt(0) }] }));
  const db = await import(new URL(`../lib.mjs?change-log=${Date.now()}`, import.meta.url));
  const meta = { title: "NAS address", summary: "Where the NAS lives.", kind: "fact" };

  try {
    await db.ensureSchema();
    // Twice, as on every boot: the upgrade must be idempotent.
    await db.ensureSchema();

    const saved = await db.runAs("tester", () => db.captureThought(db.ALL, "The NAS lives at 10.0.0.5", {
      metadata: meta, origin: "user", userConfirmed: true,
    }));
    let changes = await db.thoughtChanges(db.ALL, saved.id);
    assert.deepEqual(changes.map((c) => [c.action, c.actor]), [["create", "tester"]]);

    // The embedding written in the same transaction is not a change anyone reads.
    assert.equal(changes.length, 1);

    await db.runAs("editor", () => db.updateThought(db.ALL, saved.id, { content: "The NAS lives at 10.0.0.6" }));
    changes = await db.thoughtChanges(db.ALL, saved.id);
    assert.equal(changes[0].action, "update");
    assert.equal(changes[0].actor, "editor");
    assert.deepEqual(changes[0].fields, ["content"]);
    assert.equal(changes[0].before.content, "The NAS lives at 10.0.0.5");

    const restored = await db.runAs("web-ui", () => db.restoreChange(db.ALL, changes[0].id));
    assert.equal(restored.content, "The NAS lives at 10.0.0.5");
    assert.equal((await db.thoughtChanges(db.ALL, saved.id))[0].actor, "web-ui");

    // Direct SQL is logged too, under the database role.
    await db.pool.query(`UPDATE thoughts SET metadata = metadata || '{"verified_at":"2026-10-14"}' WHERE id = $1`, [saved.id]);
    changes = await db.thoughtChanges(db.ALL, saved.id);
    assert.equal(changes[0].actor, "sql:mimer");
    assert.deepEqual(changes[0].fields, ["metadata"]);
    await db.pool.query(`UPDATE thoughts SET embedding = embedding WHERE id = $1`, [saved.id]);
    assert.equal((await db.thoughtChanges(db.ALL, saved.id)).length, changes.length);

    // A delete keeps the text and the relations, and can be undone under the same id.
    const other = await db.captureThought(db.ALL, "The NAS backs up nightly", {
      metadata: { ...meta, title: "NAS backups" }, origin: "user", userConfirmed: true,
    });
    await db.linkRelations(db.ALL, other.id, [saved.id], "related_to");
    await db.runAs("cleaner", () => db.deleteThought(db.ALL, saved.id));
    const [deleted] = await db.deletedThoughts(db.ALL);
    assert.equal(deleted.thought_id, saved.id);
    assert.equal(deleted.actor, "cleaner");
    assert.equal(deleted.before.content, "The NAS lives at 10.0.0.5");
    assert.equal(deleted.before.relations.length, 1);

    const back = await db.restoreChange(db.ALL, deleted.id);
    assert.equal(back.id, saved.id);
    assert.equal(back.metadata.verified_at, "2026-10-14");
    assert.equal((await db.thoughtRelations(db.ALL, saved.id)).length, 1);
    assert.equal((await db.deletedThoughts(db.ALL)).length, 0);
    await assert.rejects(db.restoreChange(db.ALL, deleted.id), /already exists/);

    // The open listener never sees a change that touched the vault.
    const secret = await db.captureThought(db.ALL, "The vault note", {
      tier: "vault", metadata: { ...meta, title: "Vault note" }, origin: "user", userConfirmed: true,
    });
    assert.equal((await db.thoughtChanges(db.OPEN, secret.id)).length, 0);
    assert.equal((await db.thoughtChanges(db.ALL, secret.id)).length, 1);
    await db.deleteThought(db.ALL, secret.id);
    assert.equal((await db.deletedThoughts(db.OPEN)).length, 0);
    const [vaultDelete] = await db.deletedThoughts(db.ALL);
    await assert.rejects(db.restoreChange(db.OPEN, vaultDelete.id), /not found/i);

    // "Forget now" drops every kept copy at once, and only for a deleted memory.
    await assert.rejects(db.forgetDeleted(db.ALL, saved.id), /Only a deleted memory/);
    await db.deleteThought(db.ALL, other.id);
    assert.deepEqual(await db.forgetDeleted(db.ALL, other.id), { thought_id: other.id, forgotten: 1 });
    assert.equal((await db.deletedThoughts(db.ALL)).some((c) => c.thought_id === other.id), false);

    // After the retention window only the record of the delete remains.
    await db.pool.query(`UPDATE thought_changes SET at = now() - interval '40 days' WHERE id = $1`, [vaultDelete.id]);
    assert.equal(await db.pruneDeletedSnapshots(30), 1);
    assert.equal((await db.deletedThoughts(db.ALL)).length, 0);
    const kept = await db.thoughtChanges(db.ALL, secret.id);
    assert.deepEqual(kept.map((c) => [c.action, c.before]).sort(), [["create", null], ["delete", null]]);
  } finally {
    globalThis.fetch = realFetch;
    await db.pool.end();
  }
});
