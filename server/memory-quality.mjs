import { SMART_INGEST_THRESHOLD, describesContent } from "./memory-model.mjs";

const HISTORY_LANGUAGE = /\b(?:senaste fixar|tidigare rundor|från samma session|samma session|tillstånd efter|städ(?:at|ades) samma dag|latest fixes|earlier rounds|from the same session|current status after)\b/iu;
const COMPLETED_LANGUAGE = /^\s*(?:klart|färdig(?:t)?|genomfört|implementerat|completed|finished|implemented|verified and complete)\b/iu;
const OPEN_TASK_LANGUAGE = /\b(?:väntande|återstår|nästa steg|kvar att göra|öppen uppgift|pending|remaining|next step|todo)\b/iu;
const SECRET_FRAGMENT_LANGUAGE = /(?:api[- ]?key|token|nyckel).{0,50}(?:slutar|börjar|ends? with|starts? with|prefix|suffix)\s*(?:är|is|på|:|=)?\s*["'`]?([a-z0-9_-]{3,})/iu;
const SECRET_VALUE_SHAPE = /\b(?:BSA|ghp|sk)[-_][A-Za-z0-9_-]{8,}\b/u;
const GENERIC_WORKSPACE_FOLDERS = new Set(["_secrets_", "images", "apps"]);

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
  if (SECRET_FRAGMENT_LANGUAGE.test(content) || SECRET_VALUE_SHAPE.test(content))
    add("possible-secret-fragment", "content");
  if (content.length >= 800 && sectionCount(content) >= 3)
    add("possible-multiple-purposes", "content");

  for (const field of ["title", "summary"]) {
    if (metadata[field] && !describesContent(metadata[field], content))
      add("metadata-not-grounded-in-content", field);
  }

  const project = slug(metadata.project);
  const owners = workspaceOwners(content);
  if (project && owners.length && !owners.includes(project))
    add("project-differs-from-workspace-path", "project");

  return warnings;
}
