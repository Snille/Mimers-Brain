// Media sources and the pictures behind a memory, against a stand-in Immich.
// What matters most here is the tier rule: the open listener serves a picture
// only when an open memory links it, and get_media follows getThought, so a
// vault memory's media stays on the LAN.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { freshDatabase, skipWithoutDatabase } from "../testing/db.mjs";

const KEY = "immich-test-key";
const PERSON = "11111111-1111-4111-8111-111111111111";
const ALBUM = "22222222-2222-4222-8222-222222222222";
const ASSET = "33333333-3333-4333-8333-333333333333";
const SECRET_ASSET = "44444444-4444-4444-8444-444444444444";
const PIXEL = Buffer.from("fake-webp");

// Just the endpoints media.mjs calls, each refusing a wrong key like Immich.
function fakeImmich() {
  const calls = [];
  const state = { people: true };
  const server = createServer(async (req, res) => {
    calls.push(`${req.method} ${req.url}`);
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const send = (code, body) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers["x-api-key"] !== KEY) return send(401, { message: "Invalid API key" });
    const asset = (id, extra = {}) => ({ id, type: "IMAGE", originalFileName: `${id.slice(0, 4)}.jpg`, ...extra });
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/search/metadata") {
      const body = raw ? JSON.parse(raw) : {};
      const items = body.personIds ? [asset(ASSET), asset(SECRET_ASSET)] : body.albumIds ? [asset(ASSET)] : [asset(ASSET)];
      return send(200, { assets: { items: items.slice(0, body.size || 10) } });
    }
    if (url.pathname === "/api/search/smart") return send(200, { assets: { items: [asset(ASSET, { exifInfo: { description: "The router" } })] } });
    if (url.pathname === "/api/albums") return send(200, [{ id: ALBUM, albumName: "Router how-to", assetCount: 3, albumThumbnailAssetId: ASSET }]);
    if (url.pathname === `/api/albums/${ALBUM}`) return send(200, { id: ALBUM, albumName: "Router how-to", assetCount: 3, albumThumbnailAssetId: ASSET });
    if (url.pathname === "/api/people" || url.pathname === "/api/search/person") {
      if (!state.people) return send(403, { message: "Missing required permission: person.read" });
      const list = [{ id: PERSON, name: "Camilla" }, { id: "x", name: "" }];
      return send(200, url.pathname === "/api/people" ? { people: list, total: 2 } : list.slice(0, 1));
    }
    if (url.pathname === `/api/people/${PERSON}`) return send(200, { id: PERSON, name: "Camilla" });
    const one = url.pathname.match(/^\/api\/assets\/([0-9a-f-]{36})$/);
    if (one) return send(200, asset(one[1], { localDateTime: "2026-05-01T10:00:00" }));
    if (/^\/api\/(assets|people)\/[^/]+\/thumbnail$/.test(url.pathname)) {
      res.writeHead(200, { "Content-Type": "image/webp" });
      return res.end(PIXEL);
    }
    return send(404, { message: "Not found" });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () =>
    resolve({ server, calls, state, url: `http://127.0.0.1:${server.address().port}` })));
}

test("media sources, thumbnails and get_media respect the tiers", {
  skip: skipWithoutDatabase,
}, async () => {
  process.env.DATABASE_URL = await freshDatabase("test_media");
  process.env.SETTINGS_KEY = "test-settings-key-for-media";
  // Plain imports: media.mjs and mcp.mjs import lib.mjs themselves, and must
  // share its pool with the test.
  const db = await import("../lib.mjs");
  const media = await import("../media.mjs");
  const immich = await fakeImmich();
  try {
    await db.ensureSchema();

    // A wrong key is caught when the source is saved, not later.
    await assert.rejects(media.saveSource({ name: "Immich", url: immich.url, key: "wrong" }), /401/);
    const saved = await media.saveSource({ name: "Immich", url: `${immich.url}/`, web_url: "https://photos.example.com", key: KEY });
    assert.equal(saved.id, "immich");
    assert.deepEqual(saved.warnings, []);
    const second = await media.saveSource({ name: "Immich", url: immich.url, key: KEY });
    assert.equal(second.id, "immich-2");
    await media.deleteSource("immich-2");

    // The key is sealed in storage and never listed.
    const stored = await db.getSetting("media_sources");
    assert.doesNotMatch(stored, new RegExp(KEY));
    const listed = await media.listSources({ full: true });
    assert.equal(listed.sources.length, 1);
    assert.equal(listed.sources[0].hasKey, true);
    assert.equal(listed.sources[0].webUrl, "https://photos.example.com");
    assert.doesNotMatch(JSON.stringify(listed), new RegExp(KEY));
    assert.deepEqual(Object.keys((await media.listSources()).sources[0]).sort(), ["id", "kind", "name", "webUrl"]);
    // An edit without a key keeps the stored one.
    await media.saveSource({ id: "immich", name: "Photos", key: "" });
    assert.equal((await media.listSources()).sources[0].name, "Photos");

    // Searching names only the named people, and finds albums and assets.
    assert.deepEqual(await media.searchSource("immich", "person", ""), [{ type: "person", id: PERSON, title: "Camilla" }]);
    assert.equal((await media.searchSource("immich", "album", "router"))[0].count, 3);
    assert.equal((await media.searchSource("immich", "album", "garden")).length, 0);
    assert.equal((await media.searchSource("immich", "asset", "router"))[0].title, "The router");

    const insert = async (tier, refs) => (await db.pool.query(
      `INSERT INTO thoughts (content, metadata, tier) VALUES ($1, $2::jsonb, $3) RETURNING id`,
      [`A memory with media on ${tier}.`, JSON.stringify({ title: `Media ${tier}`, kind: "profile", media: refs }), tier])).rows[0].id;
    const openId = await insert("open", [
      { source: "immich", type: "person", id: PERSON, title: "Camilla" },
      { type: "link", url: "https://example.com/manual.pdf", title: "Manual" },
    ]);
    const vaultId = await insert("vault", [{ source: "immich", type: "asset", id: SECRET_ASSET, title: "Secret" }]);

    // The open listener serves only what an open memory links.
    const open = ["open"];
    const pic = await media.thumbnail(open, { source: "immich", type: "person", id: PERSON });
    assert.equal(pic.contentType, "image/webp");
    await assert.rejects(media.thumbnail(open, { source: "immich", type: "asset", id: SECRET_ASSET }), /Not found/);
    await assert.rejects(media.thumbnail(open, { source: "immich", type: "asset", id: ASSET }), /Not found/);
    // The full listener needs any thumbnail, for the picker.
    assert.ok(await media.thumbnail(db.ALL, { source: "immich", type: "asset", id: SECRET_ASSET }, { full: true }));

    // get_media through MCP: links in text, pictures as images, key nowhere.
    const { buildServer } = await import("../mcp.mjs");
    const call = (tiers, args) => buildServer(tiers, { writable: false })._registeredTools.get_media
      .handler({ images: 4, size: "thumbnail", ...args });
    const out = await call(open, { id: openId });
    const textOut = out.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    assert.match(textOut, /Person "Camilla" on Photos: https:\/\/photos\.example\.com\/people\//);
    assert.match(textOut, /Link "Manual": https:\/\/example\.com\/manual\.pdf/);
    const images = out.content.filter((c) => c.type === "image");
    assert.equal(images.length, 2);
    assert.equal(images[0].mimeType, "image/webp");
    assert.equal(Buffer.from(images[0].data, "base64").toString(), PIXEL.toString());
    assert.doesNotMatch(JSON.stringify(out), new RegExp(KEY));
    assert.equal((await call(open, { id: vaultId })).isError, true);
    assert.equal((await call(db.ALL, { id: vaultId })).content.filter((c) => c.type === "image").length, 1);
    assert.equal((await call(open, { id: openId, images: 0 })).content.filter((c) => c.type === "image").length, 0);

    // A broken pointer is reported in its line; the rest still resolve.
    const broken = await media.resolveMedia([
      { source: "gone", type: "album", id: ALBUM },
      { source: "immich", type: "album", id: ALBUM },
    ], { images: 1 });
    assert.match(broken.items[0].error, /Unknown media source/);
    assert.equal(broken.items[1].title, "Router how-to");
    assert.equal(broken.pictures.length, 1);

    // A replacement without media of its own keeps the old memory's media.
    const replacement = await insert("open", []);
    await db.linkSupersession(open, replacement, [openId]);
    const row = await db.getThought(open, replacement);
    assert.equal(row.metadata.media.length, 2);

    // A key without person.read is saved, and the card names what it lacks.
    immich.state.people = false;
    const limited = await media.saveSource({ name: "Limited", url: immich.url, key: KEY });
    assert.deepEqual(limited.warnings, ["person.read"]);
  } finally {
    immich.server.close();
    await db.pool.end();
  }
});
