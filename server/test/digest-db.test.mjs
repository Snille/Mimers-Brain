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

test("a rewritten memory keeps its place in the digest, whatever kind the new text is guessed as", {
  skip: skipWithoutDatabase,
}, async () => {
  process.env.DATABASE_URL = await freshDatabase("test_digest_supersede");
  const db = await import(new URL(`../lib.mjs?digestSupersede=${Date.now()}`, import.meta.url));
  const insert = async (title, extra = {}) => (await db.pool.query(
    `INSERT INTO thoughts (content, metadata) VALUES ($1, $2::jsonb) RETURNING id`,
    [`${title}, in full.`, JSON.stringify({ title, kind: "procedure", review_status: "confirmed", ...extra })])).rows[0].id;
  const meta = async (id) => (await db.pool.query(`SELECT metadata FROM thoughts WHERE id = $1`, [id])).rows[0].metadata;
  const inDigest = async (id) => (await db.memoryDigest(db.ALL, { limit: 50 })).items.some((item) => item.id === id);

  try {
    await db.ensureSchema();

    // A procedure rewritten into text the model files as a preference stays out.
    const procedure = await insert("Old procedure");
    const asPreference = await insert("New text", { kind: "preference" });
    await db.linkSupersession(db.ALL, asPreference, [procedure], { fresh: true });
    assert.equal((await meta(asPreference)).pinned, false);
    assert.equal(await inDigest(asPreference), false, "a guessed preference does not join the digest");

    // The reader's opt-out survives a rewrite.
    const optedOut = await insert("Opted-out preference", { kind: "preference", pinned: false });
    const rewrite = await insert("Rewritten preference", { kind: "preference" });
    await db.linkSupersession(db.ALL, rewrite, [optedOut], { fresh: true });
    assert.equal(await inDigest(rewrite), false, "pinned: false is inherited");

    // A preference that the model now calls a fact keeps its place.
    const preference = await insert("Standing preference", { kind: "preference" });
    const asFact = await insert("Same rule as a fact", { kind: "fact" });
    await db.linkSupersession(db.ALL, asFact, [preference], { fresh: true });
    assert.equal(await inDigest(asFact), true, "a rule in the digest stays in it");

    // A pinned rule stays pinned, and an explicit pin on the replacement wins.
    const pinnedRule = await insert("Pinned rule", { pinned: true });
    const pinnedRewrite = await insert("Pinned rewrite");
    await db.linkSupersession(db.ALL, pinnedRewrite, [pinnedRule], { fresh: true });
    assert.equal((await meta(pinnedRewrite)).pinned, true);
    const chosen = await insert("Chosen for the digest", { kind: "preference", pinned: true });
    await db.linkSupersession(db.ALL, chosen, [await insert("Plain procedure")], { fresh: true });
    assert.equal(await inDigest(chosen), true);

    // A memory kept from a duplicate pair is not a rewrite: it keeps its own place.
    const kept = await insert("Kept preference", { kind: "preference" });
    await db.linkSupersession(db.ALL, kept, [await insert("Other procedure")]);
    assert.equal(await inDigest(kept), true);
  } finally {
    await db.pool.end();
  }
});
