// Contexts: one start pack per kind of work.
//
// The session digest used to be one list for everything, so a rule that holds
// for Erik's own apps (his green accent) sat next to one that holds at work
// (Spectrogon's red) and every model had to guess which one won. A context
// names a kind of work - Personal, Spectrogon, Holiday - and owns the standing
// memories that hold only there. The digest without a context is the base:
// the rules that hold everywhere, plus a list of the contexts. A model that
// sees the task fits one asks for it with memory_digest(context=<id>) and gets
// the base and that context's memories, which win where the two differ.
//
// A memory belongs to a context in two ways:
//   - `metadata.contexts` names it. The reader sets this in the editor; it is a
//     pin into that context, whatever the memory's kind. Like `pinned`, it is
//     never taken from an agent's capture (see captureThought in lib.mjs).
//   - its `project` is one of the context's projects. Then only what would
//     have been in the digest anyway (a preference, a profile, a pin) moves
//     from the base to the context.
// Either way it leaves the base, so it is read only where it applies.
//
// Contexts live in app_settings, beside the media sources. One made on the
// Settings page is confirmed at once. One a model proposes (propose_context,
// full listener only) waits for the reader, because its instruction would
// otherwise be an agent's words read as the user's by every later session.
// Only confirmed contexts are listed, used, or take memories out of the base.

import { CONTEXT_MEMBER_SQL, CONTEXTS_KEY } from "./context-sql.mjs";
import { getSetting, pool, setSetting } from "./lib.mjs";

export { BASE_DIGEST_SQL, CONTEXT_MEMBER_SQL, CONTEXTS_KEY } from "./context-sql.mjs";
export const CONTEXT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const LIMITS = { name: 40, description: 200, instruction: 1200, projects: 20 };

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const clean = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
export const slug = (name) => String(name || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);

async function readContexts() {
  try { return JSON.parse(await getSetting(CONTEXTS_KEY)) || {}; } catch { return {}; }
}

function listOf(value) {
  const raw = Array.isArray(value) ? value : String(value ?? "").split(",");
  return [...new Set(raw.map(clean).filter(Boolean))].slice(0, LIMITS.projects);
}

const shape = (id, c) => ({
  id, name: c.name, description: c.description || "", instruction: c.instruction || "",
  projects: c.projects || [], status: c.status || "confirmed",
  ...(c.created_by ? { created_by: c.created_by } : {}),
});

// How many memories each context holds, counted with the same rule the digest
// uses, so the Settings card shows what a model would get.
async function counts(tiers, contexts) {
  const out = {};
  for (const c of contexts) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM thoughts WHERE tier = ANY($1) AND ${CONTEXT_MEMBER_SQL(2, 3)}`,
      [tiers, c.id, c.projects]);
    out[c.id] = rows[0].n;
  }
  return out;
}

export async function listContexts({ tiers = ["open"], all = false, withCounts = false } = {}) {
  const stored = await readContexts();
  const list = Object.entries(stored).map(([id, c]) => shape(id, c))
    .filter((c) => all || c.status === "confirmed")
    .sort((a, b) => a.name.localeCompare(b.name, "sv"));
  if (!withCounts) return list;
  const n = await counts(tiers, list.filter((c) => c.status === "confirmed"));
  return list.map((c) => ({ ...c, memories: n[c.id] ?? 0 }));
}

export async function getContext(id) {
  const stored = await readContexts();
  const c = stored[String(id || "")];
  return c ? shape(id, c) : null;
}

// One save path for the Settings card and propose_context. `by` is the client
// for a proposal; a proposal never overwrites a context that exists, and never
// confirms itself.
export async function saveContext({ id, name, description, instruction, projects } = {}, { proposed = false, by = "" } = {}) {
  const stored = await readContexts();
  const existing = id ? stored[id] : null;
  if (id && !existing && !proposed) throw fail(`No context "${id}"`, 404);
  const label = clean(name ?? existing?.name).slice(0, LIMITS.name);
  if (!label) throw fail("A name is required");
  const entry = {
    ...(existing || {}),
    name: label,
    description: clean(description ?? existing?.description).slice(0, LIMITS.description),
    instruction: String(instruction ?? existing?.instruction ?? "").trim().slice(0, LIMITS.instruction),
    projects: listOf(projects ?? existing?.projects ?? []),
  };
  let contextId = id && existing ? id : slug(id || label);
  if (!CONTEXT_ID.test(contextId)) throw fail("The name must contain a letter or a digit");
  if (proposed) {
    if (stored[contextId]) throw fail(`A context "${contextId}" exists already; the user changes it on the Settings page`, 409);
    entry.status = "proposed";
    entry.created_by = clean(by).slice(0, 80) || "agent";
  } else if (!existing) {
    for (let n = 2; stored[contextId]; n += 1) contextId = `${slug(label).slice(0, 29)}-${n}`;
    entry.status = "confirmed";
  }
  stored[contextId] = entry;
  await setSetting(CONTEXTS_KEY, JSON.stringify(stored));
  return shape(contextId, entry);
}

export async function confirmContext(id) {
  const stored = await readContexts();
  if (!stored[id]) throw fail(`No context "${id}"`, 404);
  stored[id].status = "confirmed";
  await setSetting(CONTEXTS_KEY, JSON.stringify(stored));
  return shape(id, stored[id]);
}

// The memories go back to the base digest; their `contexts` entry stays, and
// counts again if a context with the same id is made.
export async function deleteContext(id) {
  const stored = await readContexts();
  if (!stored[id]) throw fail(`No context "${id}"`, 404);
  delete stored[id];
  await setSetting(CONTEXTS_KEY, JSON.stringify(stored));
  return { deleted: id };
}
