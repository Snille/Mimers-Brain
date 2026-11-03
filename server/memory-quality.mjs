import { SMART_INGEST_THRESHOLD, describesContent } from "./memory-model.mjs";

const HISTORY_LANGUAGE = /\b(?:senaste fixar|tidigare rundor|från samma session|samma session|tillstånd efter|städ(?:at|ades) samma dag|latest fixes|earlier rounds|from the same session|current status after)\b/iu;
const COMPLETED_LANGUAGE = /^\s*(?:klart|färdig(?:t)?|genomfört|implementerat|completed|finished|implemented|verified and complete)\b/iu;
const OPEN_TASK_LANGUAGE = /\b(?:väntande|återstår|nästa steg|kvar att göra|öppen uppgift|pending|remaining|next step|todo)\b/iu;
const SECRET_FRAGMENT_LANGUAGE = /(?:api[- ]?key|token|nyckel).{0,50}(?:slutar|börjar|ends? with|starts? with|prefix|suffix)\s*(?:är|is|på|:|=)?\s*["'`]?([a-z0-9_-]{3,})/iu;
const SECRET_VALUE_SHAPE = /\b(?:BSA|ghp|sk)[-_][A-Za-z0-9_-]{8,}\b/u;
const GENERIC_WORKSPACE_FOLDERS = new Set(["_secrets_", "images", "apps"]);
// A date after one of these words records when something happened, not what is
// true: "verified 2026-08-04", "Beslut 2026-10-31", "upptäckt 2026-09-08". A
// date that must be there, such as a deadline, has no such word in front of it.
const DATED_HISTORY = /\b(?:verifierat?|verified|upptäckt(?:es)?|discovered|found|hittad|hände|happened|bekräftat|confirmed|beslut(?:at)?|decided|lades till|added|skapad|created|uppmätt|measured|testat|tested|rättat|fixed|åtgärdat)\b[^.\n]{0,40}?\b20\d\d-\d\d(?:-\d\d)?\b/iu;
// "Since 0.15.2", "sedan 2026-10-25": the history of how the current state came about.
const SINCE_HISTORY = /\b(?:sedan|since)\s+(?:v(?:ersion)?\s*)?(?:20\d\d-\d\d(?:-\d\d)?|\d+\.\d+(?:\.\d+)?)\b/iu;
// A real pointer, not the template "<projekt>\<fil>" that the rules themselves quote.
export const SECRET_REF_PATH = /SECRET_REF:?\s*[A-Za-z]:\\[^\s<>]+(?=$|\s|::|[.,;)])/u;

const clean = (value) => String(value ?? "").trim();
const slug = (value) => clean(value)
  .replace(/\.git$/iu, "")
  .replace(/[_\s]+/gu, "-")
  .replace(/[^\p{L}\p{N}-]+/gu, "-")
  .replace(/-+/gu, "-")
  .replace(/^-|-$/gu, "")
  .toLowerCase();

function workspaceOwners(content) {
  const owners = [];
  const pattern = /C:\\Users\\[^\\\r\n]+\\(?:Coding(?: - DeepSeek)?|Apps)\\([^\\\r\n]+)/giu;
  for (const match of String(content ?? "").matchAll(pattern)) {
    const owner = slug(match[1]);
    if (owner && !GENERIC_WORKSPACE_FOLDERS.has(owner)) owners.push(owner);
  }
  return [...new Set(owners)];
}

function sectionCount(content) {
  return String(content ?? "").split(/\r?\n/).filter((line) =>
    /^\s*(?:#{1,3}\s+|\d+[.)]\s+|[A-ZÅÄÖ][A-ZÅÄÖ0-9 _/-]{5,}:)/u.test(line)).length;
}

export function memoryQualityWarnings(row = {}) {
  const content = clean(row.content);
  const metadata = row.metadata || {};
  const lifecycle = clean(metadata.lifecycle) || "current";
  if (lifecycle !== "current") return [];

  const warnings = [];
  const add = (code, field) => warnings.push(field ? { code, field } : { code });

  if (content.length >= SMART_INGEST_THRESHOLD) add("oversized-current-memory", "content");

  if ((metadata.kind || metadata.type) === "task") {
    if (metadata.task_status === "done") add("completed-task-is-current", "task_status");
    if (metadata.task_status !== "done" && COMPLETED_LANGUAGE.test(content) && !OPEN_TASK_LANGUAGE.test(content))
      add("pending-task-looks-completed", "content");
  }

  if (HISTORY_LANGUAGE.test(content)) add("session-history-language", "content");
  if (DATED_HISTORY.test(content)) add("dated-history", "content");
  if (SINCE_HISTORY.test(content)) add("version-history", "content");
  if (row.tier === "open" && SECRET_REF_PATH.test(content)) add("secret-ref-in-open-tier", "tier");
  if (SECRET_FRAGMENT_LANGUAGE.test(content) || SECRET_VALUE_SHAPE.test(content))
    add("possible-secret-fragment", "content");
  if (content.length >= 800 && sectionCount(content) >= 3)
    add("possible-multiple-purposes", "content");

  for (const field of ["title", "summary"]) {
    if (metadata[field] && !describesContent(metadata[field], content))
      add("metadata-not-grounded-in-content", field);
  }

  // A title or summary that is just the opening of the content, stopped
  // mid-sentence, is a cut, not a description.
  const flat = content.replace(/\s+/g, " ");
  const title = clean(metadata.title).replace(/\s+/g, " ");
  const summary = clean(metadata.summary).replace(/\s+/g, " ");
  if (title.length > 60 && flat.startsWith(title) && flat.length > title.length && !/[.!?…)]$/u.test(title))
    add("title-looks-cut", "title");
  if (summary && flat.startsWith(summary) && flat.length > summary.length && !/[.!?…)]$/u.test(summary))
    add("summary-looks-cut", "summary");

  const project = slug(metadata.project);
  const owners = workspaceOwners(content);
  if (project && owners.length && !owners.includes(project))
    add("project-differs-from-workspace-path", "project");

  return warnings;
}

// What the writer should do about each warning, said where the memory was just
// written. The audit (renormalise.mjs --all --dry-run) reports the same codes.
const ADVICE = {
  "oversized-current-memory": "split it into memories below the size limit",
  "completed-task-is-current": "a finished task is history: keep the lasting lesson or delete it",
  "pending-task-looks-completed": "the text reads as finished work: keep the lasting lesson or mark the task done",
  "session-history-language": "remove the session history and state what is true now",
  "dated-history": "remove when it was verified, found, decided or changed; state the fact in the present tense",
  "version-history": "remove \"since <version or date>\"; state what is true now",
  "secret-ref-in-open-tier": "a SECRET_REF pointer belongs in the vault",
  "possible-secret-fragment": "remove the fragment of a secret value",
  "possible-multiple-purposes": "split it into one memory per purpose",
  "metadata-not-grounded-in-content": "give it a title and summary that describe this text",
  "title-looks-cut": "give it a title that describes the memory instead of its first words",
  "summary-looks-cut": "the summary is the first words of the text, cut off",
  "project-differs-from-workspace-path": "the project differs from the folder the text names",
};

export function qualityAdvice(warnings = []) {
  if (!warnings.length) return "";
  const lines = [...new Set(warnings.map((warning) => ADVICE[warning.code] || warning.code))];
  return `Quality warnings: ${lines.join("; ")}. Correct it now with supersede_thought.`;
}
