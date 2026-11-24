// Write a new title or summary, with the metadata model, for memories whose
// title or summary is in another language than the memory itself.
//
//   node scripts/resummarise.mjs --dry-run --out /tmp/resummarise.json
//   node scripts/resummarise.mjs --apply --from /tmp/resummarise.json --expected-count N
//
// normaliseMeta refuses a title or summary in another language, and the audit
// (npm run audit) lists the rows written before that rule. renormalise.mjs
// would fix them with a derived summary, which is the opening of the text cut
// short. This asks the metadata model for a real one instead.
//
// The dry run is the only step that calls the model. It writes every proposal
// to --out, and the apply step writes exactly those texts, so what was read
// is what is written and the model is paid for once. A proposal that still
// fails describesContent() (another language, another subject) is listed as
// unresolved and never written.
//
// Only title and summary change; every other metadata key stays byte-identical,
// so lifecycle, trust and review state are never touched. A changed row is
// embedded again, because title and summary are part of embeddingText().
//
// The console report holds ids and counts only. The --out file holds the old
// and new texts so they can be read before --apply; it stays inside the
// container and is gone when the container is recreated.

import { readFile, writeFile } from "node:fs/promises";
import { describesContent, differsInLanguage, embeddingText } from "../memory-model.mjs";
import { embed, extractMetadata, pool, runAs, transaction } from "../lib.mjs";
import { loadModelSettings } from "../model-settings.mjs";

const argv = process.argv.slice(2);
const args = new Set(argv);
const valueOf = (flag) => {
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : null;
};
const apply = args.has("--apply");
const FIELDS = ["title", "summary"];
const CONCURRENCY = 4;

if (apply === args.has("--dry-run")) throw new Error("Choose --dry-run or --apply");

await loadModelSettings();

if (!apply) {
  const out = valueOf("--out");
  if (!out) throw new Error("--dry-run requires --out <file>, where the proposals are written");
  const { rows } = await pool.query("SELECT id, content, metadata, tier FROM thoughts ORDER BY created_at");
  const wrong = rows
    .map((row) => ({ row, fields: FIELDS.filter((f) => row.metadata?.[f] && differsInLanguage(row.metadata[f], row.content)) }))
    .filter((item) => item.fields.length);

  const proposals = [];
  const unresolved = [];
  let next = 0;
  async function worker() {
    while (next < wrong.length) {
      const { row, fields } = wrong[next++];
      const meta = await extractMetadata(row.content);
      const change = {};
      for (const field of fields) {
        const value = String(meta?.[field] || "").trim();
        if (value && describesContent(value, row.content)) change[field] = value;
      }
      const missing = fields.filter((field) => !(field in change));
      if (missing.length) unresolved.push({ id: row.id, fields: missing });
      if (Object.keys(change).length) proposals.push({
        id: row.id, tier: row.tier,
        old: Object.fromEntries(Object.keys(change).map((f) => [f, row.metadata[f]])),
        new: change,
      });
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  await writeFile(out, JSON.stringify(proposals, null, 2));
  console.log(JSON.stringify({
    mode: "dry-run", scanned: rows.length, wrong_language: wrong.length,
    proposals: proposals.length, unresolved: unresolved.length, unresolved_ids: unresolved, out,
  }, null, 2));
  await pool.end();
  process.exit(0);
}

const from = valueOf("--from");
const expectedCount = Number(valueOf("--expected-count"));
if (!from) throw new Error("--apply requires --from <file> from the dry run");
if (!Number.isInteger(expectedCount) || expectedCount < 1)
  throw new Error("--apply requires --expected-count N, the number of proposals the dry run reported");
const proposals = JSON.parse(await readFile(from, "utf8"));
if (proposals.length !== expectedCount)
  throw new Error(`Refusing to write: ${proposals.length} proposals in the file, expected ${expectedCount}`);

let applied = 0;
const skipped = [];
for (const proposal of proposals) {
  const { rows: [row] } = await pool.query("SELECT id, content, metadata FROM thoughts WHERE id = $1", [proposal.id]);
  // The memory may have been edited since the dry run; then the proposal
  // describes old text and is left for the next run.
  const stale = !row || Object.entries(proposal.old).some(([f, v]) => row.metadata?.[f] !== v);
  if (stale) { skipped.push(proposal.id); continue; }
  const next = { ...row.metadata, ...proposal.new };
  const vector = await embed(embeddingText(row.content, next)).catch(() => null);
  await runAs("resummarise-script", () => transaction((client) => client.query(
    `UPDATE thoughts
        SET metadata = $2::jsonb,
            embedding = COALESCE($3::vector, embedding),
            updated_at = now()
      WHERE id = $1`,
    [row.id, JSON.stringify(next), vector ? JSON.stringify(vector) : null],
  )));
  applied++;
}

console.log(JSON.stringify({ mode: "apply", applied, skipped: skipped.length, skipped_ids: skipped }, null, 2));
await pool.end();
