// Re-run the display and index facets of normaliseMeta over named memories.
//
//   node scripts/renormalise.mjs --only <id>[,<id>...] --dry-run
//   node scripts/renormalise.mjs --only <id>[,<id>...] --apply --expected-count N
//   node scripts/renormalise.mjs --only <id> --set '{"topics":["mimers-brain"]}' --dry-run
//
// Use this when a server-side guard is added and existing rows were written
// before it. It rewrites only title, summary, people and systems, and leaves
// every other metadata key byte-identical, so lifecycle, trust and review
// state are never touched by a cleanup pass.
//
// --set additionally applies explicit values for kind, project and topics to
// every named id. Those facets cannot be derived from the text, so a wrong one
// written by the extraction model can only be corrected by stating it. The
// result still passes through normaliseMeta, so the controlled vocabularies
// apply and a typo cannot enter the database.
//
// title and summary are part of embeddingText(), so a changed row is embedded
// again; a stale vector would otherwise keep matching the wrong wording.
//
// The report never prints memory content, titles, summaries or secret values.

import { embeddingText, normaliseMeta } from "../memory-model.mjs";
import { embed, pool } from "../lib.mjs";

const argv = process.argv.slice(2);
const args = new Set(argv);
const apply = args.has("--apply");
const valueOf = (flag) => {
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : null;
};

const ids = (valueOf("--only") || "").split(",").map((id) => id.trim()).filter(Boolean);
const expectedCount = Number(valueOf("--expected-count"));

if (!ids.length) throw new Error("--only <id>[,<id>...] is required");
if (!apply && !args.has("--dry-run")) throw new Error("Choose --dry-run or --apply");
if (apply && (!Number.isInteger(expectedCount) || expectedCount < 1)) {
  throw new Error("--apply requires --expected-count N, the number of rows the dry run reported as changed");
}

const FACETS = ["title", "summary", "people", "systems"];
const SETTABLE = ["kind", "project", "topics"];

const overrides = JSON.parse(valueOf("--set") || "{}");
const unknown = Object.keys(overrides).filter((key) => !SETTABLE.includes(key));
if (unknown.length) throw new Error(`--set only accepts ${SETTABLE.join(", ")}; got ${unknown.join(", ")}`);

const { rows } = await pool.query(
  "SELECT id, content, metadata FROM thoughts WHERE id = ANY($1::uuid[])",
  [ids],
);

const missing = ids.filter((id) => !rows.some((row) => row.id === id));
if (missing.length) throw new Error(`Unknown memory ids: ${missing.join(", ")}`);

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const proposed = rows.map((row) => {
  const old = row.metadata || {};
  const normalised = normaliseMeta({ ...old, ...overrides }, row.content);
  const next = { ...old };
  const touched = [...FACETS, ...Object.keys(overrides)];
  for (const facet of touched) next[facet] = normalised[facet];
  // normaliseMeta drops an empty project entirely, so mirror that here.
  if (next.project === undefined) delete next.project;
  const fields = touched.filter((facet) => !same(old[facet], next[facet]));
  return { row, next, fields };
});

const changed = proposed.filter((item) => item.fields.length);
const report = {
  mode: apply ? "apply" : "dry-run",
  requested: ids.length,
  changed: changed.length,
  changes: changed.map(({ row, fields }) => ({ id: row.id, fields })),
};

if (!apply) {
  console.log(JSON.stringify(report, null, 2));
  await pool.end();
  process.exit(0);
}

if (changed.length !== expectedCount) {
  throw new Error(`Refusing to write: ${changed.length} rows would change, expected ${expectedCount}`);
}

for (const { row, next } of changed) {
  const vector = await embed(embeddingText(row.content, next)).catch(() => null);
  await pool.query(
    `UPDATE thoughts
        SET metadata = $2::jsonb,
            embedding = COALESCE($3::vector, embedding),
            updated_at = now()
      WHERE id = $1`,
    [row.id, JSON.stringify(next), vector ? JSON.stringify(vector) : null],
  );
}

console.log(JSON.stringify({ ...report, applied: changed.length }, null, 2));
await pool.end();
