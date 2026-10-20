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
// Each search is the one search_thoughts does: current memories, at the search
// threshold in use. The recall hook columns apply recallHint's rule to the same
// rows. The measurement itself is evaluate() in recall-settings.mjs, which the
// Models card runs too; it also proposes thresholds for the model in use.
//
// Read only. No recall trace and no usage event is written, so the evaluation
// does not move the receipts it is measuring. The receipt nudge in the ranking
// does read the live receipts, so a later run can differ slightly with no code
// change; run the variants you compare in the same invocation.
//
// The report names questions by their id and memories by their UUID - never
// memory content, titles or summaries.

import { pool, rankWeights } from "../lib.mjs";
import { loadModelSettings } from "../model-settings.mjs";
import { formatReport, parseQuestionSet } from "../recall-eval.mjs";
import { evaluate, loadRecallSettings } from "../recall-settings.mjs";

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

const fixed = (value) => (value == null ? "-" : value.toFixed(2));

try {
  await loadModelSettings();
  await loadRecallSettings();
  const out = await evaluate(tiers, questions, { variants });
  const report = out.variants.map((variant, i) => ({ ...variant, weights: rankWeights(variants[i].weights) }));
  if (flag("--json")) process.stdout.write(`${JSON.stringify({ ...out, variants: report }, null, 2)}
`);
  else {
    const { search, hint } = out.suggestion;
    process.stdout.write(`${formatReport(report, { warnings: out.warnings })}
Thresholds: search ${fixed(out.searchThreshold)}, hint ${fixed(out.hintFloor)}.
Suggested: search ${search ? `${fixed(search.value)} (lowest right answer ${fixed(search.lowest)})` : "- (needs 3 answered questions)"}, hint ${hint ? fixed(hint.value) : "- (needs 3 answered and 1 unanswerable question)"}.
`);
  }
} finally {
  await pool.end();
}
