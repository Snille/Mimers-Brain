import test from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, skipWithoutDatabase } from "../testing/db.mjs";

test("what does not fit in the digest is counted and named, not dropped in silence", {
  skip: skipWithoutDatabase,
}, async () => {
  process.env.DATABASE_URL = await freshDatabase("test_digest");
  const db = await import(new URL(`../lib.mjs?digest=${Date.now()}`, import.meta.url));
  const insert = async (title, extra = {}, tier = "open") => (await db.pool.query(
    `INSERT INTO thoughts (content, metadata, tier) VALUES ($1, $2::jsonb, $3) RETURNING id`,
    [`${title}, in full.`, JSON.stringify({ title, summary: `${title}.`, kind: "preference", ...extra }), tier])).rows[0].id;

  try {
    await db.ensureSchema();
    const pinned = await insert("Pinned rule", { kind: "fact", pinned: true });
    for (let i = 0; i < db.DIGEST_LIMIT + 1; i += 1) await insert(`Preference ${i}`);
    await insert("Unticked preference", { pinned: false });
    await insert("Unconfirmed preference", { review_status: "pending" });
    const secret = await insert("Vault preference", {}, "vault");

    const all = await db.memoryDigest(db.ALL);
    assert.equal(all.count, db.DIGEST_LIMIT);
    assert.equal(all.items[0].id, pinned, "pinned memories come first");
    assert.equal(all.omitted, 3);
    assert.equal(all.omitted_items.length, 3);
    assert.ok(all.omitted_items.every((item) => item.id && item.title));

    // The open listener neither shows nor counts a vault memory.
    const open = await db.memoryDigest(db.OPEN);
    assert.equal(open.omitted, 2);
    assert.ok(![...open.items, ...open.omitted_items].some((item) => item.id === secret));

    const stats = await db.stats(db.OPEN);
    assert.equal(stats.digestOmitted, 2);
    assert.equal(stats.digestLimit, db.DIGEST_LIMIT);

    // The character budget stops the digest as well as the count does.
    const long = "x".repeat(db.DIGEST_WHOLE);
    await db.pool.query(`UPDATE thoughts SET content = $1, metadata = metadata || jsonb_build_object('summary', $1::text)
                          WHERE metadata->>'title' LIKE 'Preference %'`, [long]);
    const tight = await db.memoryDigest(db.OPEN);
    assert.ok(tight.count < db.DIGEST_LIMIT);
    assert.equal(tight.count + tight.omitted, open.count + open.omitted);
    assert.ok(tight.items.reduce((sum, item) => sum + item.text.length, 0) <= db.DIGEST_BUDGET);
  } finally {
    await db.pool.end();
  }
});
