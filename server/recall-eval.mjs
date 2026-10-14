// Scoring for the recall evaluation (scripts/eval-recall.mjs). Pure functions:
// no database, no model, so the arithmetic can be tested on its own.
//
// A question set is a list of questions someone actually asked, each with the
// memories that answer it. A question that no memory should answer has an
// empty list; those measure how often the recall hook adds noise.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const HINT_MAX = 3;
export const DEFAULT_FLOORS = [0.4, 0.45, 0.5, 0.55, 0.6];

export function parseQuestionSet(text) {
  let data;
  try { data = JSON.parse(text); } catch (error) { throw new Error(`The question set is not JSON: ${error.message}`); }
  const list = Array.isArray(data) ? data : data?.questions;
  if (!Array.isArray(list) || !list.length) throw new Error("The question set has no questions");
  const seen = new Set();
  return list.map((entry, index) => {
    const where = `question ${index + 1}`;
    const id = String(entry?.id || "").trim();
    const q = String(entry?.q || "").trim();
    if (!id) throw new Error(`${where} has no id`);
    if (seen.has(id)) throw new Error(`${where}: the id ${id} is used twice`);
    seen.add(id);
    if (!q) throw new Error(`${id} has no question text (q)`);
    if (!Array.isArray(entry.expect)) throw new Error(`${id} needs expect: a list of memory ids, or [] for none`);
    const bad = entry.expect.find((value) => !UUID.test(String(value)));
    if (bad !== undefined) throw new Error(`${id}: ${bad} is not a memory id`);
    return { id, q, expect: entry.expect.map((value) => String(value).toLowerCase()) };
  });
}

// 1-based position of the first expected memory, or null when it is absent.
export function rankOf(rows, expect) {
  const wanted = new Set(expect);
  const at = rows.findIndex((row) => wanted.has(String(row.id).toLowerCase()));
  return at < 0 ? null : at + 1;
}

// The same rule as recallHint() in lib.mjs: rows in rank order, only those at or
// above the semantic floor, at most three.
export function hintIds(rows, floor, max = HINT_MAX) {
  return rows.filter((row) => Number(row.semantic_score) >= floor).slice(0, max).map((row) => String(row.id).toLowerCase());
}

const share = (count, total) => (total ? count / total : null);

// results: [{ id, expect, rows }], rows in rank order as searchThoughts returns them.
export function summarise(results, { floors = DEFAULT_FLOORS } = {}) {
  const positives = results.filter((r) => r.expect.length);
  const negatives = results.filter((r) => !r.expect.length);
  const ranks = positives.map((r) => ({ id: r.id, rank: rankOf(r.rows, r.expect), top: r.rows[0]?.id || null }));
  const within = (k) => ranks.filter((r) => r.rank && r.rank <= k).length;
  const hint = floors.map((floor) => {
    let hit = 0, offTarget = 0, noise = 0;
    for (const r of positives) {
      const ids = hintIds(r.rows, floor);
      if (ids.some((id) => r.expect.includes(id))) hit += 1;
      else if (ids.length) offTarget += 1;
    }
    for (const r of negatives) if (hintIds(r.rows, floor).length) noise += 1;
    return { floor, hit: share(hit, positives.length), offTarget: share(offTarget, positives.length), noise: share(noise, negatives.length) };
  });
  return {
    questions: results.length,
    positives: positives.length,
    negatives: negatives.length,
    hit1: share(within(1), positives.length),
    hit5: share(within(5), positives.length),
    mrr: share(ranks.reduce((sum, r) => sum + (r.rank && r.rank <= 10 ? 1 / r.rank : 0), 0), positives.length),
    hint,
    misses: ranks.filter((r) => !r.rank || r.rank > 5),
  };
}

const pct = (value) => (value === null ? "   -" : `${(value * 100).toFixed(0).padStart(3)}%`);
const num = (value) => (value === null ? "    -" : value.toFixed(3));

export function formatReport(variants, { warnings = [] } = {}) {
  const lines = [];
  const first = variants[0]?.summary;
  if (first) lines.push(`${first.positives} questions with an answer, ${first.negatives} without.`, "");
  for (const warning of warnings) lines.push(`WARNING ${warning}`);
  if (warnings.length) lines.push("");
  const width = Math.max(7, ...variants.map((v) => v.name.length));
  lines.push(`${"variant".padEnd(width)}  hit@1  hit@5    MRR`);
  for (const { name, summary } of variants)
    lines.push(`${name.padEnd(width)}  ${pct(summary.hit1)}   ${pct(summary.hit5)}  ${num(summary.mrr)}`);
  lines.push("", `Recall hook (top ${HINT_MAX} at or above the floor): hit = right memory shown,`,
    "off = only wrong memories shown, noise = something shown for a question with no answer.");
  lines.push(`${"variant".padEnd(width)}  floor   hit   off  noise`);
  for (const { name, summary } of variants)
    for (const h of summary.hint)
      lines.push(`${name.padEnd(width)}  ${h.floor.toFixed(2)}  ${pct(h.hit)}  ${pct(h.offTarget)}   ${pct(h.noise)}`);
  for (const { name, summary } of variants) {
    if (!summary.misses.length) continue;
    lines.push("", `Not in the top five (${name}):`);
    for (const miss of summary.misses)
      lines.push(`  ${miss.id}: ${miss.rank ? `rank ${miss.rank}` : "not in the top 20"}, first was ${miss.top || "nothing"}`);
  }
  return `${lines.join("\n")}\n`;
}
