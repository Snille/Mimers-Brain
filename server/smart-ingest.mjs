// Pure helpers for smart ingest. The network-backed extraction lives in lib.mjs;
// keeping validation and fallback splitting here makes the safety rules easy to
// test without a database or an AI provider.

export const MAX_INGEST_CANDIDATES = 30;
export const MAX_ATOM_LENGTH = 1800;

const clean = (value) => String(value ?? "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

function sentenceChunks(text) {
  const sentences = text.split(/(?<=[.!?])\s+(?=[\p{Lu}\d#])/u).map(clean).filter(Boolean);
  const chunks = [];
  let current = "";
  for (const sentence of sentences.length ? sentences : [text]) {
    if (current && `${current} ${sentence}`.length > MAX_ATOM_LENGTH) {
      chunks.push(current);
      current = sentence;
    } else {
      current = clean(`${current} ${sentence}`);
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function fallbackAtoms(source) {
  const text = clean(source);
  if (!text) return [];
  const paragraphs = text.split(/\n\s*\n/).map(clean).filter(Boolean);
  const raw = paragraphs.flatMap((part) => part.length > MAX_ATOM_LENGTH ? sentenceChunks(part) : [part]);
  const merged = [];
  for (const part of raw) {
    const last = merged.at(-1);
    // A heading or tiny fragment needs its following paragraph to be useful on
    // its own. Never merge beyond the atom size cap.
    if (last && (last.length < 120 || part.length < 120) && `${last}\n\n${part}`.length <= MAX_ATOM_LENGTH)
      merged[merged.length - 1] = `${last}\n\n${part}`;
    else merged.push(part);
  }
  return [...new Set(merged)].slice(0, MAX_INGEST_CANDIDATES);
}

export function normalisePreviewCandidates(items) {
  if (!Array.isArray(items)) throw new Error("Smart ingest must return an array of memories");
  const seen = new Set();
  const out = [];
  for (const raw of items) {
    const item = typeof raw === "string" ? { content: raw } : (raw || {});
    const content = clean(item.content);
    if (!content || content.length > MAX_ATOM_LENGTH * 2) continue;
    const key = content.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      content,
      metadata: item.metadata && typeof item.metadata === "object" ? item.metadata : {},
    });
    if (out.length >= MAX_INGEST_CANDIDATES) break;
  }
  if (!out.length) throw new Error("Smart ingest produced no usable memories");
  return out;
}
