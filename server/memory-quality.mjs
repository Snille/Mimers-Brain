import { SMART_INGEST_THRESHOLD, describesContent } from "./memory-model.mjs";
import { findSecret } from "./secret-gate.mjs";

const HISTORY_LANGUAGE = /\b(?:senaste fixar|tidigare rundor|från samma session|tillstånd efter|städ(?:at|ades) samma dag|latest fixes|earlier rounds|from the same session|current status after)\b/iu;
const COMPLETED_LANGUAGE = /^\s*(?:klart|färdig(?:t)?|genomfört|implementerat|completed|finished|implemented|verified and complete)\b/iu;
const COMPLETED_WORK = /^(?:uppgiften|arbetet) är (?:klart|klar|färdigt|slutfört)\b|^(?:the )?(?:task|work) (?:is |has been )?(?:complete[ds]?|finished|done)\b/iu;
const OPEN_TASK_LANGUAGE = /(?<![\p{L}\p{N}_])(?:väntande|återstår|nästa steg|kvar att göra|öppen uppgift|pending|remaining|next step|todo)(?![\p{L}\p{N}_])/iu;
// Require an actual credential/value assertion, not a mention of "prefix" in
// an instruction or a UI translation key followed by unrelated prose.
const SECRET_FRAGMENT_LANGUAGE = /\b(?:api[- ]?key|token(?:en)?|nyckel(?:n)?)\s+(?:(?:has|har|a|the|ett|en)\s+)*(?:slutar(?: på)?|börjar(?: med)?|end(?:s|ing)? (?:with|in)|start(?:s|ing)? with|prefix|suffix)\s*(?:(?:är|is|of)\s+|[:=]\s*)?["'`]?([a-z0-9_-]{3,})/giu;
const SECRET_VALUE_SHAPE = /\b(?:BSA|ghp|sk)[-_][A-Za-z0-9_-]{8,}\b/u;
// Compared as slugs, so "_secrets_" is "secrets" here.
const GENERIC_WORKSPACE_FOLDERS = new Set(["secrets", "images", "apps"]);
// A date after one of these words records when something happened, not what is
// true: "verified 2026-08-04", "Beslut 2026-10-31", "upptäckt 2026-09-08". A
// date that must be there, such as a deadline, has no such word in front of it.
const PAST_ACTION = "verifierat?|verified|upptäckt(?:es)?|discovered|found|hittad|hände|happened|bekräftat|confirmed|beslut(?:at)?|decided|lades till|added|skapad|created|uppmätt|measured|testat|tested|rättat|fixed|åtgärdat|moved|deleted|retired|flyttades|raderades|togs bort|togs ur bruk";
const DATED_HISTORY = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${PAST_ACTION})(?![\\p{L}\\p{N}_])[^.\\n]{0,40}?\\b20\\d\\d-\\d\\d(?:-\\d\\d)?\\b`, "iu");
const LEADING_DATED_HISTORY = /^(?:den\s+)?20\d\d-\d\d-\d\d\s+(?:bytte|flyttades|raderades|ändrades|uppgraderades|installed|moved|changed|upgraded)\b/iu;
const DATED_TEST_REPORT = /^(?:test|benchmark|batteritest)\s+20\d\d-\d\d-\d\d\b|\b[\w.-]+\.(?:ps1|mjs|py|sh)\s+\((?:från|from)\s+20\d\d-\d\d-\d\d\)/iu;
// "Since 0.15.2", "sedan 2026-10-25": the history of how the current state came about.
const SINCE_HISTORY = /\b(?:sedan|since|från v)\s*(?:v(?:ersion)?\s*)?(20\d\d-\d\d(?:-\d\d)?|\d+\.\d+(?:\.\d+)?)\b/giu;
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
    // A dependency, a reference document, a backup or another project's local
    // skill is not a claim about this memory's project ownership. Only an
    // explicit source/repository location gives us enough evidence to compare.
    const before = content.slice(Math.max(0, match.index - 100), match.index).replace(/["'`]$/u, "");
    if (!/\b(?:source|repository|repo|project|källkod(?:en)?|projekt(?:et)?|repot)\s+(?:(?:lives|is|located|root|at|in|ligger|finns|är)\s+){1,4}$/iu.test(before)) continue;
    const owner = slug(match[1]);
    // A path that ends a sentence takes the rest of the line with it
    // ("…\ESPHome är privat och …"), so a generic folder is also known by its start.
    const generic = [...GENERIC_WORKSPACE_FOLDERS].some((name) => owner === name || owner.startsWith(`${name}-`));
    if (owner && !generic) owners.push(owner);
  }
  return [...new Set(owners)];
}

// A folder belongs to a project when one name starts the other or both start
// with the same word: storagesystem and Storagesystem-base, magicmirror and
// MagicMirror Modules, comfyui-lora-manager and ComfyUI - Sync. The prefix test
// also covers a folder name that ran on into the rest of the sentence.
function relatedFolder(project, owner) {
  if (owner === project || owner.startsWith(`${project}-`) || project.startsWith(`${owner}-`)) return true;
  return owner.split("-")[0] === project.split("-")[0];
}

function sectionCount(content) {
  // List items and method/problem/check labels belong to a single procedure.
  // Distinct substantive Markdown headings are stronger evidence of a bundle.
  return String(content ?? "").split(/\r?\n/).filter((line) =>
    /^\s*#{1,3}\s+/u.test(line)
    && !/^\s*#{1,3}\s+(?:steps?|method|procedure|prerequisites?|requirements?|verification|validation|checks?|troubleshooting|problem|context|steg|metod|förutsättningar|krav|kontroll|felsökning|bakgrund)\b/iu.test(line)).length;
}

function hasOpenTask(content) {
  const positive = content.replace(/\b(?:inget återstår|inga väntande uppgifter|nothing remains|no (?:pending|remaining) (?:work|tasks?))\b/giu, "");
  return OPEN_TASK_LANGUAGE.test(positive);
}

function hasVersionHistory(content) {
  return [...content.matchAll(SINCE_HISTORY)].some((match) => {
    // The encryption cutoff determines which snapshots need this key. It is
    // part of the restore contract, not a date of verification. Keep the
    // exemption local so it cannot hide unrelated history in another sentence.
    const boundary = content.lastIndexOf(". ", match.index);
    const end = content.indexOf(". ", match.index);
    const sentence = content.slice(boundary < 0 ? 0 : boundary + 2, end < 0 ? content.length : end);
    return !(/^20\d\d-\d\d(?:-\d\d)?$/u.test(match[1])
      && /\b(?:backups?|backuper(?:na)?|snapshots?)\b/iu.test(sentence)
      && /\b(?:encrypt\w*|krypter\w*)/iu.test(sentence));
  });
}

function hasSecretFragment(content) {
  return [...content.matchAll(SECRET_FRAGMENT_LANGUAGE)].some((match) => {
    const value = match[1];
    // Generic prose ("prefix or suffix", "starts with a dot") is not a value.
    return /\d/u.test(value) || /^[a-f]{4,}$/iu.test(value);
  });
}

function secretReferences(content) {
  const refs = [];
  const pattern = /\bSECRET_REF(:)?[ \t]*(?:(["'`])([^"'`\r\n]+)\2|((?:[A-Za-z]:[\\/]|_secrets_[\\/]|\.{1,2}[\\/]|\/)[^\s<>"'`;,]+))/gu;
  for (const match of content.matchAll(pattern)) {
    // A template that stops just before <project>/<file> is not a pointer.
    const path = match[3] || match[4];
    if (content[match.index + match[0].length] === "<" || /[<>]/u.test(path)) continue;
    if (!/^(?:[A-Za-z]:[\\/]|\/|_secrets_[\\/]|\.{1,2}[\\/])/u.test(path)) continue;
    refs.push({
      valid: Boolean(match[1]) && /^(?:[A-Za-z]:[\\/]|\/)/u.test(path)
        && !/\.env#[\w]+/u.test(path),
    });
  }
  // An explanation inserted between the marker and the path also breaks the
  // machine-readable format. Generic mentions of SECRET_REF have no path.
  if (/\bSECRET_REF:[ \t]+(?!["'`]?\b[A-Za-z]:[\\/]|["'`]?\/|_secrets_[\\/])[^\r\n]{1,100}?\b[A-Za-z]:[\\/][^\s<>]+/u.test(content))
    refs.push({ valid: false });
  return refs;
}

export function memoryQualityWarnings(row = {}) {
  const content = clean(row.content);
  const metadata = row.metadata || {};
  const lifecycle = clean(metadata.lifecycle) || "current";
  const secretField = findSecret(content) ? "content" : findSecret(metadata) ? "metadata" : null;
  // Raw credentials are forbidden in history as well as in current knowledge.
  if (lifecycle !== "current") return secretField ? [{ code: "raw-secret-value", field: secretField }] : [];

  const warnings = [];
  const add = (code, field) => warnings.push(field ? { code, field } : { code });

  if (content.length >= SMART_INGEST_THRESHOLD) add("oversized-current-memory", "content");

  if ((metadata.kind || metadata.type) === "task") {
    if (metadata.task_status === "done") add("completed-task-is-current", "task_status");
    if (metadata.task_status !== "done" && (COMPLETED_LANGUAGE.test(content) || COMPLETED_WORK.test(content)) && !hasOpenTask(content))
      add("pending-task-looks-completed", "content");
  } else if (COMPLETED_WORK.test(content) && !hasOpenTask(content)) {
    add("completed-work-is-current", "content");
  }

  if (HISTORY_LANGUAGE.test(content)) add("session-history-language", "content");
  if (DATED_HISTORY.test(content) || LEADING_DATED_HISTORY.test(content) || DATED_TEST_REPORT.test(content)) add("dated-history", "content");
  if (hasVersionHistory(content)) add("version-history", "content");
  const refs = secretReferences(content);
  if (row.tier === "open" && (SECRET_REF_PATH.test(content) || refs.length)) add("secret-ref-in-open-tier", "tier");
  if (refs.some((ref) => !ref.valid)) add("malformed-secret-ref", "content");
  if (secretField) add("raw-secret-value", secretField);
  if (hasSecretFragment(content) || SECRET_VALUE_SHAPE.test(content))
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
  if (project && owners.length && !owners.some((owner) => relatedFolder(project, owner)))
    add("project-differs-from-workspace-path", "project");

  return warnings;
}

// What the writer should do about each warning, said where the memory was just
// written. The audit (renormalise.mjs --all --dry-run) reports the same codes.
const ADVICE = {
  "oversized-current-memory": "split it into memories below the size limit",
  "completed-task-is-current": "a finished task is history: keep the lasting lesson or delete it",
  "pending-task-looks-completed": "the text reads as finished work: keep the lasting lesson or mark the task done",
  "completed-work-is-current": "archive the completion report or keep only its lasting lesson",
  "session-history-language": "remove the session history and state what is true now",
  "dated-history": "remove when it was verified, found, decided or changed; state the fact in the present tense",
  "version-history": "remove \"since <version or date>\"; state what is true now",
  "secret-ref-in-open-tier": "a SECRET_REF pointer belongs in the vault",
  "malformed-secret-ref": "use SECRET_REF: followed by an absolute path and :: KEY_NAME for a selected value",
  "raw-secret-value": "remove the credential and keep only a SECRET_REF pointer in the vault",
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
  const next = warnings.some((warning) => warning.code === "raw-secret-value")
    ? "Remove the credential from current and historical records without copying it."
    : "Review the warnings; use supersede_thought for confirmed content corrections.";
  return `Quality warnings: ${lines.join("; ")}. ${next}`;
}
