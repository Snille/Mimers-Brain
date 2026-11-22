// Media sources: the servers a memory's pictures, albums and people live on.
//
// A memory stores a pointer - { source, type, id, title } - and never the file
// (see normaliseMedia in memory-model.mjs). The source is set up once on the
// Settings page: its address, an optional address for links that open in a
// browser, and an API key. The key is sealed with SETTINGS_KEY exactly like a
// model provider's key (secret-box.mjs) and is never shown again. It should be
// a key that can only read: Immich keys are scoped, and asset.read,
// asset.view, album.read and person.read are all this module uses.
//
// The brain fetches on the client's behalf, so a model or a browser never sees
// the key. Tiers hold here too: the open listener serves a thumbnail only when
// an open memory points at it, so a picture linked from a vault memory cannot
// be read from outside, and an id cannot be guessed into a picture nobody
// linked. Searching a server for something to link is a full-listener action.
//
// Immich is the only kind so far. Another kind (Plex, Audiobookshelf) adds a
// client below and an entry in KINDS; the stored pointer does not change.

import { getSetting, pool, setSetting } from "./lib.mjs";
import { MEDIA_TYPES } from "./memory-model.mjs";
import * as box from "./secret-box.mjs";

const SOURCES_KEY = "media_sources";
export const KINDS = ["immich"];
export const IMMICH_SCOPES = ["asset.read", "asset.view", "album.read", "person.read"];
const TIMEOUT_MS = Number(process.env.MEDIA_TIMEOUT_MS || 10000);
const SEARCH_LIMIT = 40;

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const trimUrl = (value) => String(value || "").trim().replace(/\/+$/, "");
const slug = (name) => String(name || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "media";

async function readSources() {
  try { return JSON.parse(await getSetting(SOURCES_KEY)) || {}; } catch { return {}; }
}

// Whether a key exists and opens - never the key.
function publicSource(id, s, { full }) {
  const base = { id, kind: s.kind, name: s.name, webUrl: trimUrl(s.web_url || s.url) };
  if (!full) return base;
  return { ...base, url: s.url, hasKey: Boolean(s.key), keyUnreadable: Boolean(s.key && !box.open(s.key)) };
}

export async function listSources({ full = false } = {}) {
  const stored = await readSources();
  return {
    canStoreKeys: box.canSeal(),
    scopes: IMMICH_SCOPES,
    sources: Object.entries(stored).map(([id, s]) => publicSource(id, s, { full })),
  };
}

async function sourceFor(id) {
  const stored = await readSources();
  const s = stored[String(id || "")];
  if (!s) throw fail(`No media source "${id}"`, 404);
  return { id, ...s };
}

// --- Immich --------------------------------------------------------------------

async function immich(source, path, { method = "GET", body, binary = false, key } = {}) {
  const apiKey = key ?? box.open(source.key);
  if (!apiKey) throw fail(`The key for ${source.name} cannot be opened; enter it again under Settings`, 503);
  let r;
  try {
    r = await fetch(`${trimUrl(source.url)}${path}`, {
      method,
      headers: {
        "x-api-key": apiKey,
        Accept: binary ? "image/*" : "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw fail(`${source.name} did not answer: ${error.cause?.code || error.message}`, 502);
  }
  if (!r.ok) {
    const detail = await r.json().then((d) => d.message).catch(() => "");
    throw fail(`${source.name} answered ${r.status}${detail ? `: ${detail}` : ""}`, r.status === 404 ? 404 : 502);
  }
  if (!binary) return r.json();
  return { contentType: r.headers.get("content-type") || "image/jpeg", data: Buffer.from(await r.arrayBuffer()) };
}

const assetsOf = (out) => out?.assets?.items || [];
const assetTitle = (a) => a.exifInfo?.description || a.originalFileName || a.id;

// One real call per permission, so a key that is missing a scope is named
// when it is saved rather than when a picture fails to load. Reading assets is
// required; the rest only limit what can be linked.
async function probeImmich(source, key) {
  await immich(source, "/api/search/metadata", { method: "POST", body: { size: 1 }, key });
  const warnings = [];
  await immich(source, "/api/albums", { key }).catch(() => warnings.push("album.read"));
  await immich(source, "/api/people?size=1", { key }).catch(() => warnings.push("person.read"));
  return warnings;
}

async function immichSearch(source, type, q) {
  const query = String(q || "").trim();
  if (type === "person") {
    const people = query
      ? await immich(source, `/api/search/person?name=${encodeURIComponent(query)}`)
      : (await immich(source, "/api/people?size=200")).people || [];
    return people.filter((p) => p.name && !p.isHidden).slice(0, SEARCH_LIMIT)
      .map((p) => ({ type, id: p.id, title: p.name }));
  }
  if (type === "album") {
    const needle = query.toLowerCase();
    const albums = await immich(source, "/api/albums");
    return albums.filter((a) => !needle || String(a.albumName || "").toLowerCase().includes(needle))
      .slice(0, SEARCH_LIMIT)
      .map((a) => ({ type, id: a.id, title: a.albumName || a.id, count: a.assetCount ?? null }));
  }
  // Assets: CLIP search when there is a query (it needs Immich's machine
  // learning), the file name when that is switched off, else the newest.
  let out;
  if (query) {
    out = await immich(source, "/api/search/smart", { method: "POST", body: { query, size: SEARCH_LIMIT } })
      .catch(() => immich(source, "/api/search/metadata", {
        method: "POST", body: { originalFileName: query, size: SEARCH_LIMIT },
      }));
  } else {
    out = await immich(source, "/api/search/metadata", { method: "POST", body: { size: SEARCH_LIMIT, order: "desc" } });
  }
  return assetsOf(out).slice(0, SEARCH_LIMIT)
    .map((a) => ({ type: "asset", id: a.id, title: assetTitle(a), video: a.type === "VIDEO" }));
}

// What a pointer is now: its name on the server, a link for a browser, and a
// few of the assets behind it for a model to look at.
async function immichDescribe(source, ref, { assets = 0 } = {}) {
  const web = trimUrl(source.web_url || source.url);
  if (ref.type === "asset") {
    const a = await immich(source, `/api/assets/${ref.id}`);
    return {
      title: assetTitle(a), url: `${web}/photos/${a.id}`, video: a.type === "VIDEO",
      taken: a.localDateTime || a.fileCreatedAt || null, assets: [{ id: a.id, video: a.type === "VIDEO" }],
    };
  }
  const isPerson = ref.type === "person";
  const info = isPerson
    ? await immich(source, `/api/people/${ref.id}`)
    : await immich(source, `/api/albums/${ref.id}?withoutAssets=true`);
  const found = assets > 0
    ? assetsOf(await immich(source, "/api/search/metadata", {
        method: "POST",
        body: { ...(isPerson ? { personIds: [ref.id] } : { albumIds: [ref.id] }), size: assets, order: "desc" },
      }))
    : [];
  return {
    title: isPerson ? info.name || ref.title || ref.id : info.albumName || ref.title || ref.id,
    url: `${web}/${isPerson ? "people" : "albums"}/${ref.id}`,
    count: isPerson ? null : info.assetCount ?? null,
    cover: isPerson ? null : info.albumThumbnailAssetId || null,
    assets: found.slice(0, assets).map((a) => ({ id: a.id, video: a.type === "VIDEO" })),
  };
}

async function immichThumbnail(source, type, id, size = "thumbnail") {
  const wanted = size === "preview" ? "preview" : "thumbnail";
  if (type === "person") return immich(source, `/api/people/${id}/thumbnail`, { binary: true });
  if (type === "album") {
    const album = await immich(source, `/api/albums/${id}?withoutAssets=true`);
    if (!album.albumThumbnailAssetId) throw fail("The album has no cover", 404);
    return immich(source, `/api/assets/${album.albumThumbnailAssetId}/thumbnail?size=${wanted}`, { binary: true });
  }
  return immich(source, `/api/assets/${id}/thumbnail?size=${wanted}`, { binary: true });
}

// --- the source list -----------------------------------------------------------

// Nothing is stored until a real call with the new values has worked, as on
// the Models card. `id` edits an existing source; without it a new one is made.
export async function saveSource({ id, kind = "immich", name, url, web_url, key } = {}) {
  if (!KINDS.includes(kind)) throw fail(`Unknown kind of media source "${kind}"`);
  const stored = await readSources();
  const existing = id ? stored[id] : null;
  if (id && !existing) throw fail(`No media source "${id}"`, 404);
  const label = String(name ?? existing?.name ?? "").trim().slice(0, 40);
  if (!label) throw fail("A name is required");
  const address = trimUrl(url ?? existing?.url);
  if (!/^https?:\/\/[^\s/]+/i.test(address)) throw fail("The address must start with http:// or https://");
  const webAddress = trimUrl(web_url ?? existing?.web_url ?? "");
  if (webAddress && !/^https?:\/\/[^\s/]+/i.test(webAddress))
    throw fail("The address for links must start with http:// or https://");
  const newKey = typeof key === "string" ? key.trim() : "";
  if (!newKey && !existing?.key) throw fail("An API key is required");
  const plainKey = newKey || box.open(existing.key);
  if (!plainKey) throw fail("The stored key cannot be opened; enter it again");

  const candidate = { kind, name: label, url: address, ...(webAddress ? { web_url: webAddress } : {}) };
  let warnings;
  try {
    warnings = await probeImmich(candidate, plainKey);
  } catch (error) {
    throw fail(error.message, 400);
  }
  candidate.key = newKey ? box.seal(newKey) : existing.key;

  let sourceId = id;
  if (!sourceId) {
    const base = slug(label);
    sourceId = base;
    for (let n = 2; stored[sourceId]; n += 1) sourceId = `${base.slice(0, 29)}-${n}`;
  }
  stored[sourceId] = candidate;
  await setSetting(SOURCES_KEY, JSON.stringify(stored));
  return { ...publicSource(sourceId, candidate, { full: true }), warnings };
}

// Memories that point at the source keep their pointers; they show as an
// unknown source until one with the same id is added again.
export async function deleteSource(id) {
  const stored = await readSources();
  if (!stored[id]) throw fail(`No media source "${id}"`, 404);
  delete stored[id];
  await setSetting(SOURCES_KEY, JSON.stringify(stored));
  return { deleted: id };
}

export async function searchSource(id, type, q) {
  if (!MEDIA_TYPES.includes(type)) throw fail(`Unknown media type "${type}"`);
  return immichSearch(await sourceFor(id), type, q);
}

// Whether a memory on these tiers points at the item. The full listener can
// read every tier and also needs thumbnails for the picker, so it skips this.
export async function isLinked(tiers, source, type, id) {
  const { rows } = await pool.query(
    `SELECT 1 FROM thoughts WHERE tier = ANY($1) AND metadata->'media' @> $2::jsonb LIMIT 1`,
    [tiers, JSON.stringify([{ source, type, id }])]);
  return rows.length > 0;
}

export async function thumbnail(tiers, { source, type, id, size }, { full = false } = {}) {
  if (!MEDIA_TYPES.includes(type) || !/^[A-Za-z0-9_-]{1,64}$/.test(String(id || "")))
    throw fail("Unknown media");
  if (!full && !(await isLinked(tiers, source, type, id))) throw fail("Not found", 404);
  return immichThumbnail(await sourceFor(source), type, id, size);
}

// Everything a model needs to use a memory's media: a line per pointer, and
// images of the first few assets. A broken pointer is reported in its line,
// not thrown, so one deleted photo does not hide the rest.
export async function resolveMedia(refs, { images = 4, size = "thumbnail" } = {}) {
  const stored = await readSources();
  const items = [];
  const pictures = [];
  let budget = Math.max(0, Math.min(Number(images) || 0, 8));
  // Every item gets a picture before any item gets a second one.
  const list = Array.isArray(refs) ? refs : [];
  const perItem = Math.max(1, Math.floor(budget / Math.max(1, list.filter((r) => r.type !== "link").length)));
  for (const [index, ref] of list.entries()) {
    if (ref.type === "link") {
      items.push({ type: "link", title: ref.title || ref.url, url: ref.url });
      continue;
    }
    const s = stored[ref.source];
    if (!s) {
      items.push({ ...ref, error: `Unknown media source "${ref.source}"` });
      continue;
    }
    const source = { id: ref.source, ...s };
    try {
      const want = ref.type === "asset" ? 1 : Math.min(budget, perItem);
      const info = await immichDescribe(source, ref, { assets: want });
      const item = { ...ref, source_name: s.name, ...info };
      delete item.assets;
      const shown = [];
      for (const a of info.assets || []) {
        if (budget <= 0) break;
        try {
          const thumb = await immich(source, `/api/assets/${a.id}/thumbnail?size=${size === "preview" ? "preview" : "thumbnail"}`, { binary: true });
          pictures.push({ ...thumb, caption: `${index + 1}. ${item.title}${a.video ? " (video)" : ""}` });
          shown.push(a.id);
          budget -= 1;
        } catch { /* a missing thumbnail is not worth failing the rest */ }
      }
      item.images_shown = shown.length;
      items.push(item);
    } catch (error) {
      items.push({ ...ref, source_name: s.name, error: error.message });
    }
  }
  return { items, pictures };
}

// One line for each pointer, for a search result a model reads.
export function mediaSummary(refs) {
  const list = Array.isArray(refs) ? refs : [];
  if (!list.length) return "";
  return list.map((r) => (r.type === "link" ? `link "${r.title || r.url}"` : `${r.type} "${r.title || r.id}"`)).join(", ");
}
