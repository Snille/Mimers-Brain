// Measure how well search finds the right memory, before a ranking change is
// made rather than after.
//
//   node scripts/eval-recall.mjs < questions.json
//   node scripts/eval-recall.mjs --variant 'no-title={"title":0}' < questions.json
//   node scripts/eval-recall.mjs --tiers open --json < questions.json
//
// The question set arrives on stdin, so it never has to be in the image or in
// git: it holds real questions about real systems. The format is in
// eval/recall-questions.example.json at the repository root.
//
// Every question is embedded once and searched once per variant with the same
// vector, so variants differ only in ranking. A variant is a name and a JSON
// object of RANK_WEIGHTS overrides (lib.mjs); "current" is always run first.
// Each search is the one search_thoughts does: current memories, threshold
// 0.3. The recall hook columns apply recallHint's rule to the same rows.
//
// Read only. No recall trace and no usage event is written, so the evaluation
// does not move the receipts it is measuring. The receipt nudge in the ranking
// does read the live receipts, so a later run can differ slightly with no code
// change; run the variants you compare in the same invocation.
//
// The report names questions by their id and memories by their UUID - never
// memory content, titles or summaries.

import { embed, pool, rankWeights, searchThoughts } from "../lib.mjs";
import { loadModelSettings } from "../model-settings.mjs";
import { DEFAULT_FLOORS, formatReport, parseQuestionSet, summarise } from "../recall-eval.mjs";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const values = (name) => argv.flatMap((arg, i) => (arg === name && argv[i + 1] ? [argv[i + 1]] : []));

const tiers = (values("--tiers")[0] || "all") === "open" ? ["open"] : ["open", "vault"];
const variants = [{ name: "current", weights: {} }];
for (const spec of values("--variant")) {
  const at = spec.indexOf("=");
  if (at < 1) throw new Error(`--variant needs name={json}, got ${spec}`);
  const weights = JSON.parse(spec.slice(at + 1));
  rankWeights(weights); // refuse an unknown key before anything is embedded
  variants.push({ name: spec.slice(0, at), weights });
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const questions = parseQuestionSet(Buffer.concat(chunks).toString("utf8"));

try {
  await loadModelSettings();

  // An expected memory that is gone, replaced or outside these tiers can never
  // be found; say so instead of letting it read as a ranking failure.
  const expected = [...new Set(questions.flatMap((q) => q.expect))];
  const { rows: known } = await pool.query(
    `SELECT t.id::text, t.tier, coalesce(t.metadata->>'lifecycle', 'current') AS lifecycle,
            (SELECT r.from_id::text FROM thought_relations r
              WHERE r.to_id = t.id AND r.relation = 'supersedes' LIMIT 1) AS replaced_by
       FROM thoughts t WHERE t.id = ANY($1::uuid[])`,
    [expected],
  );
  const byId = new Map(known.map((row) => [row.id, row]));
  const warnings = [];
  for (const q of questions)
    for (const id of q.expect) {
      const row = byId.get(id);
      if (!row) warnings.push(`${q.id}: ${id} does not exist`);
      else if (row.lifecycle !== "current")
        warnings.push(`${q.id}: ${id} is ${row.lifecycle}${row.replaced_by ? `, replaced by ${row.replaced_by}` : ""}`);
      else if (!tiers.includes(row.tier)) warnings.push(`${q.id}: ${id} is in the ${row.tier} tier, outside --tiers`);
    }

  const runs = variants.map(() => []);
  for (const q of questions) {
    const vector = await embed(q.q);
    if (!vector) throw new Error("No embedding model is configured");
    for (const [i, variant] of variants.entries()) {
      const rows = await searchThoughts(tiers, q.q, { limit: 20, threshold: 0.3, vector, weights: variant.weights });
      runs[i].push({ id: q.id, expect: q.expect, rows });
    }
  }

  const report = variants.map((variant, i) => ({ name: variant.name, weights: rankWeights(variant.weights), summary: summarise(runs[i], { floors: DEFAULT_FLOORS }) }));
  process.stdout.write(flag("--json") ? `${JSON.stringify({ tiers, warnings, variants: report }, null, 2)}\n` : formatReport(report, { warnings }));
} finally {
  await pool.end();
}
