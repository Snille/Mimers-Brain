// Canonical memory vocabulary and compatibility helpers.
//
// The database intentionally keeps metadata in JSONB so old clients and old
// rows continue to work while the model evolves.  This module is the one place
// that turns free-form model output or UI input into the v2 shape.

export const MEMORY_KINDS = [
  "fact", "reference", "procedure", "decision", "lesson", "incident",
  "task", "idea", "preference", "profile",
];

export const MEMORY_LIFECYCLES = ["current", "superseded", "archived"];
export const TASK_STATUSES = ["pending", "done"];

export const CANONICAL_TOPICS = [
  "ai", "backup", "database", "deployment", "docker", "esphome", "git",
  "github", "home-assistant", "immich", "mimers-brain", "music", "network",
  "node-red", "open-webui", "photoframe", "powershell", "proxmox", "security",
  "snille-net", "ssh", "storagesystem", "tokentracker", "user-interface", "wsl", "other",
];

const TOPIC_ALIASES = new Map(Object.entries({
  "api key": "security",
  "api keys": "security",
  "backup procedures": "backup",
  "credentials": "security",
  "credentials management": "security",
  "data safety": "security",
  "data security": "security",
  "deploy": "deployment",
  "development workflow": "deployment",
  "docker-compose": "docker",
  "e-ink": "photoframe",
  "home automation": "home-assistant",
  "hacs integration": "home-assistant",
  "hacs": "home-assistant",
  "lan": "network",
  "mcp": "mimers-brain",
  "memory": "mimers-brain",
  "minne": "mimers-brain",
  "mimers valv": "mimers-brain",
  "nätverk": "network",
  "networking": "network",
  "säkerhet": "security",
  "server infrastructure": "network",
  "system access": "security",
  "token tracker": "tokentracker",
  "token-tracker": "tokentracker",
  "token tracking": "tokentracker",
  "user interface": "user-interface",
  "webui": "open-webui",
}));

const TYPE_TO_KIND = {
  observation: "fact",
  reference: "reference",
  project: "reference",
  task: "task",
  idea: "idea",
  person_note: "profile",
};

const KIND_TO_TYPE = {
  fact: "observation",
  reference: "reference",
  procedure: "reference",
  decision: "observation",
  lesson: "observation",
  incident: "observation",
  task: "task",
  idea: "idea",
  preference: "person_note",
  profile: "person_note",
};

export const VAULT_SCOPE =
  "This connection reaches open knowledge and the LAN-only vault. The vault is for sensitive context and SECRET_REF pointers only; never store raw passwords, tokens, API keys, private keys, or other secret values.";

export const OPEN_SCOPE =
  "This connection reaches open knowledge only. Sensitive context and SECRET_REF pointers belong in the LAN-only vault; never store raw secret values in either tier.";

export const CAPTURE_GUIDANCE =
  "Write one durable, standalone memory with one main purpose. Never store raw passwords, tokens, API keys, private keys, or other secret values. Use an exact SECRET_REF pointer instead.";

export const MEMORY_POLICY = [
  "Mimers Brain usage policy:",
  "1. Before answering about Erik, his systems, access, configuration, workflows, preferences, prior decisions, or pending work, search Mimers Brain first.",
  "2. Use search_thoughts (or search) for discovery. Fetch the selected memory with fetch/fetch_thought when its compact summary is not enough.",
  "3. Use current memories by default. Read superseded or archived history only when the question needs it.",
  "4. After a durable decision, verified result, preference, procedure, or future task is established, save one standalone memory with one main purpose.",
  "5. Do not save ordinary conversation, tentative reasoning, or content that is still being actively edited.",
  "6. When correcting existing knowledge, use supersede_thought on the trusted full connection so the old memory remains navigable. If that tool is unavailable, do not create an unlinked duplicate; use a trusted full connection or tell the user what is needed.",
  "7. Never store raw passwords, tokens, API keys, private keys, or other secret values. Store only sensitive context and exact SECRET_REF pointers in the LAN-only vault.",
  "8. Never claim that something was saved, replaced, or deleted unless the corresponding tool call succeeded.",
].join("\n");

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

function dedupe(list, { lower = false } = {}) {
  const seen = new Set();
  const kept = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const value = clean(raw);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(lower ? key : value);
  }
  return kept;
}

export function canonicalTopic(value) {
  const topic = clean(value).toLowerCase();
  const canonical = TOPIC_ALIASES.get(topic) || topic;
  return CANONICAL_TOPICS.includes(canonical) ? canonical : null;
}

export function cleanTitle(value) {
  return clean(value)
    .replace(/^#+\s*/, "")
    .replace(/\s+(?:(?:—|–|-)\s*)?(?:ERSÄTTER|KOMPLETTERAR)\b.*$/iu, "")
    .replace(/[,:;—–-]\s*$/, "")
    .slice(0, 180);
}

export function deriveTitle(content) {
  const line = String(content ?? "").split(/\r?\n/).map(clean).find(Boolean) || "Untitled memory";
  return cleanTitle(line);
}

export function deriveSummary(content) {
  const paragraphs = String(content ?? "").trim().split(/\r?\n\s*\r?\n/).map(clean).filter(Boolean);
  const title = deriveTitle(content);
  const useful = paragraphs.find((part, index) =>
    index > 0 && part.replace(/^#+\s*/, "") !== title) || paragraphs[0] || content;
  return clean(useful).slice(0, 500);
}

export function normaliseMeta(meta = {}, content = "") {
  const out = { ...meta };

  out.title = cleanTitle(out.title) || deriveTitle(content);
  out.summary = clean(out.summary) || deriveSummary(content);

  const proposedKind = clean(out.kind).toLowerCase();
  out.kind = MEMORY_KINDS.includes(proposedKind)
    ? proposedKind
    : (TYPE_TO_KIND[clean(out.type).toLowerCase()] || "fact");

  const proposedLifecycle = clean(out.lifecycle).toLowerCase();
  out.lifecycle = MEMORY_LIFECYCLES.includes(proposedLifecycle)
    ? proposedLifecycle
    : "current";

  if (out.kind === "task") {
    const taskStatus = clean(out.task_status).toLowerCase();
    out.task_status = TASK_STATUSES.includes(taskStatus) ? taskStatus : "pending";
  } else {
    delete out.task_status;
  }

  // Keep the old facet alive for clients released before the v2 model.
  out.type = clean(out.type) || KIND_TO_TYPE[out.kind] || "observation";
  out.project = clean(out.project).toLowerCase().replace(/\s+/g, "-") || undefined;
  if (!out.project) delete out.project;

  const rawTopics = dedupe(out.topics || [], { lower: true });
  out.topics = dedupe(rawTopics.map(canonicalTopic).filter(Boolean), { lower: true });
  const legacyTopics = dedupe([
    ...(out.legacy_topics || []),
    ...rawTopics.filter((topic) => !canonicalTopic(topic)),
  ], { lower: true });
  if (legacyTopics.length) out.legacy_topics = legacyTopics;
  else delete out.legacy_topics;
  if (!out.topics.length) out.topics = ["other"];
  out.people = dedupe(out.people);
  out.systems = dedupe(out.systems);

  // Luba is a Mammotion robot mower (Sleipner in Home Assistant), not a person.
  if (out.people.some((person) => person.toLowerCase() === "luba")) {
    out.people = out.people.filter((person) => person.toLowerCase() !== "luba");
    out.systems = dedupe([...out.systems, "Luba", "Sleipner"]);
  }

  for (const field of ["verified_at", "valid_for_version"]) {
    const value = clean(out[field]);
    if (value) out[field] = value;
    else delete out[field];
  }

  return out;
}

export function embeddingText(content, metadata = {}) {
  const m = normaliseMeta(metadata, content);
  return [m.title, m.summary, content].filter(Boolean).join("\n\n");
}
