// Non-destructive-by-default migration of legacy memories to metadata v2.
//
//   node scripts/migrate-v2.mjs --dry-run
//   node scripts/migrate-v2.mjs --apply --expected-count 84
//
// The report never prints memory content, titles, summaries or secret values.

import { embeddingText, normaliseMeta } from "../memory-model.mjs";
import { embed, fingerprint, pool } from "../lib.mjs";

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const expectedAt = process.argv.indexOf("--expected-count");
const expectedCount = expectedAt >= 0 ? Number(process.argv[expectedAt + 1]) : null;

if (!apply && !args.has("--dry-run")) {
  throw new Error("Choose --dry-run or --apply --expected-count N");
}
if (apply && (!Number.isInteger(expectedCount) || expectedCount < 1)) {
  throw new Error("--apply requires --expected-count N");
}

const KIND_OVERRIDES = new Map(Object.entries({
  "a8fbda65-3fb8-4af7-acbf-bd05768e0492": "incident",
  "15e471e9-eda3-4882-916d-cbe895d98fe7": "profile",
  "21c08aac-52c5-4986-a4e9-d647644ece6f": "procedure",
  "84f71ac6-0fe9-4dc1-bd73-255aa19982a9": "procedure",
  "d4fa3024-83ba-4ec6-82a0-32170ad10d67": "task",
  "b131f7f3-9c0d-4188-8188-a7cdc2b14390": "procedure",
  "205bdb69-acaf-48c3-8582-9904fdd8daac": "procedure",
  "d28e1938-6fb6-4803-b313-d58c4d5919c8": "procedure",
  "9c78f44a-d4af-405b-a0e2-bbec2bf73680": "procedure",
  "9f96b3ef-80d9-48e1-b322-834a901f3446": "task",
  "1c58a8de-71ed-421d-9c48-67f91f64cae2": "procedure",
  "ffedefb7-74b8-42a6-b268-22bad0e9ff3c": "procedure",
  "bb0dda2f-a877-4186-8d25-3e1e308db91e": "procedure",
}));

const TITLE_OVERRIDES = new Map(Object.entries({
  "1c58a8de-71ed-421d-9c48-67f91f64cae2": "Home Assistant: aktuell SSH-inloggning, SSHFS, REST och websocket",
  "ffedefb7-74b8-42a6-b268-22bad0e9ff3c": "Bygg och flasha ESPHome-enheter från WSL",
  "bb0dda2f-a877-4186-8d25-3e1e308db91e": "Deploya Mimers Brain säkert",
}));

const SUMMARY_OVERRIDES = new Map(Object.entries({
  "1c58a8de-71ed-421d-9c48-67f91f64cae2": "Use ssh ha as root for commands on the Home Assistant machine; use H: only for files, REST for states and services, and websocket for registries and recorder APIs.",
  "ffedefb7-74b8-42a6-b268-22bad0e9ff3c": "Match the WSL ESPHome version to the Home Assistant add-on, compile with esphome-wsl against the real secrets file, then flash from WSL.",
  "bb0dda2f-a877-4186-8d25-3e1e308db91e": "On valv, update the live git clone with git pull --ff-only and rebuild with docker compose up -d --build; the pinned Compose project name protects the data volume.",
}));

const NON_PEOPLE = new Map([
  ["claude", "Claude"],
  ["claude code", "Claude Code"],
  ["claude opus", "Claude Opus"],
  ["luba", "Luba"],
  ["mimer", "Mimer"],
  ["mimers valv", "Mimers Valv"],
  ["snille", "Snille"],
]);

const PROJECT_RULES = [
  ["coffee-grinds", /coffee grinds|coffee-grinds|coffee_grinds/i],
  ["storagesystem", /storagesystem|lagersystem/i],
  ["photoframe", /photoframe|fotoram/i],
  ["music-assistant", /music assistant/i],
  ["tokentracker", /tokentracker|token-tracker/i],
  ["esphome", /esphome/i],
  ["open-webui", /open webui|open-webui/i],
  ["snille-net", /^deploy av snille\.net|snille\.net-2026|personlig webbsajt/i],
  ["mimers-brain", /^mimers brain|^mimers brains|mimers-brain release|mcp_open_key|mimers valv/i],
  ["home-assistant", /home assistant|home-assistant/i],
];

const SYSTEM_RULES = [
  ["Home Assistant", /home assistant|home-assistant/i],
  ["Mimers Brain", /mimers brain|mimers-brain/i],
  ["ESPHome", /esphome/i],
  ["Tokentracker", /tokentracker|token-tracker/i],
  ["Music Assistant", /music assistant/i],
  ["Node-RED", /node-red/i],
  ["Open WebUI", /open webui|open-webui/i],
  ["Immich", /immich/i],
  ["Docker", /docker/i],
  ["Proxmox", /proxmox/i],
  ["Luba", /mammotion luba|\bluba\b/i],
  ["Sleipner", /\bsleipner\b/i],
];

const uniq = (values) => [...new Map(values.filter(Boolean).map((v) => [v.toLowerCase(), v])).values()];
const replaceDeadRefs = (text) => String(text ?? "").replace(/\bid\s+[0-9a-f]{8}\b/gi, "den tidigare posten");

function projectFor(content, oldMeta) {
  if (oldMeta.project) return String(oldMeta.project);
  // Ownership comes from what the memory is about, not every system it happens
  // to mention. The first line is the established human-written title in the
  // legacy rows and avoids classifying an Immich note as snille-net merely
  // because its URL ends in that domain.
  const heading = (String(content).split(/\r?\n/).find((line) => line.trim()) || "").slice(0, 300);
  return PROJECT_RULES.find(([, pattern]) => pattern.test(heading))?.[0];
}

function proposal(row) {
  const old = row.metadata || {};
  const content = replaceDeadRefs(row.content);
  const movedSystems = [];
  const people = [];
  for (const person of Array.isArray(old.people) ? old.people : []) {
    const system = NON_PEOPLE.get(String(person).toLowerCase());
    if (system) movedSystems.push(system);
    else people.push(person);
  }

  const systems = uniq([
    ...(Array.isArray(old.systems) ? old.systems : []),
    ...movedSystems,
    ...SYSTEM_RULES.filter(([, pattern]) => pattern.test(content)).map(([name]) => name),
  ]);
  const project = projectFor(content, old);
  const meta = normaliseMeta({
    ...old,
    title: replaceDeadRefs(old.title),
    summary: replaceDeadRefs(old.summary),
    people,
    systems,
    project,
  }, content);

  if (KIND_OVERRIDES.has(row.id)) {
    meta.kind = KIND_OVERRIDES.get(row.id);
    meta.type = meta.kind === "task" ? "task" : meta.kind === "profile" ? "person_note" :
      meta.kind === "procedure" ? "reference" : "observation";
  }
  if (meta.kind === "task") meta.task_status = "pending";
  else delete meta.task_status;

  if (TITLE_OVERRIDES.has(row.id)) meta.title = TITLE_OVERRIDES.get(row.id);
  if (SUMMARY_OVERRIDES.has(row.id)) meta.summary = SUMMARY_OVERRIDES.get(row.id);
  if (row.id === "a3e65e74-8112-4151-a535-d9c28a49a176") delete meta.project;

  const date = content.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1];
  if (!meta.verified_at && date && /verifier|mätt|beslut|genomför|löst|avslutat/i.test(content))
    meta.verified_at = date;
  const version = content.match(/\b(?:version|v)(\d+\.\d+(?:\.\d+)?)\b/i)?.[1];
  if (!meta.valid_for_version && version) meta.valid_for_version = version;
  return { content, metadata: meta };
}

function changedFields(row, next) {
  const fields = [];
  if (row.content !== next.content) fields.push("content.dead_id_reference");
  const keys = new Set([...Object.keys(row.metadata || {}), ...Object.keys(next.metadata)]);
  for (const key of keys) {
    if (JSON.stringify(row.metadata?.[key]) !== JSON.stringify(next.metadata[key])) fields.push(`metadata.${key}`);
  }
  return fields;
}

const { rows } = await pool.query(
  "SELECT id::text, content, metadata, tier, created_at, updated_at FROM thoughts ORDER BY created_at",
);
if (apply && rows.length !== expectedCount) {
  throw new Error(`Expected ${expectedCount} memories, found ${rows.length}; refusing to write`);
}

const proposed = rows.map((row) => ({ row, next: proposal(row) }));
const changed = proposed.map(({ row, next }) => ({ id: row.id, fields: changedFields(row, next), chars: row.content.length }))
  .filter((item) => item.fields.length);

const beforeTopics = new Set(rows.flatMap((row) => row.metadata?.topics || []));
const afterTopics = new Set(proposed.flatMap(({ next }) => next.metadata.topics || []));
const tally = (values) => Object.fromEntries([...values.reduce((map, value) => {
  if (value) map.set(value, (map.get(value) || 0) + 1);
  return map;
}, new Map())].sort((a, b) => b[1] - a[1]));
const report = {
  mode: apply ? "apply" : "dry-run",
  memories: rows.length,
  open: rows.filter((row) => row.tier === "open").length,
  vault: rows.filter((row) => row.tier === "vault").length,
  changed: changed.length,
  dead_id_references: changed.filter((item) => item.fields.includes("content.dead_id_reference")).length,
  pending_tasks: proposed.filter(({ next }) => next.metadata.kind === "task" && next.metadata.task_status === "pending").length,
  unique_topics_before: beforeTopics.size,
  unique_topics_after: afterTopics.size,
  kinds: tally(proposed.map(({ next }) => next.metadata.kind)),
  projects: tally(proposed.map(({ next }) => next.metadata.project)),
  people: tally(proposed.flatMap(({ next }) => next.metadata.people || [])),
  systems: tally(proposed.flatMap(({ next }) => next.metadata.systems || [])),
  pending_task_ids: proposed.filter(({ next }) => next.metadata.kind === "task" && next.metadata.task_status === "pending")
    .map(({ row }) => row.id),
  split_candidates_over_2500_chars: changed.filter((item) => item.chars > 2500).map((item) => item.id),
  changes: changed.map(({ id, fields }) => ({ id, fields })),
};

if (!apply) {
  console.log(JSON.stringify(report, null, 2));
  await pool.end();
  process.exit(0);
}

for (const { row, next } of proposed) {
  if (!changedFields(row, next).length) continue;
  const vector = await embed(embeddingText(next.content, next.metadata)).catch(() => null);
  await pool.query(
    `UPDATE thoughts
        SET content = $2,
            content_fingerprint = $3,
            metadata = $4::jsonb,
            embedding = coalesce($5::vector, embedding)
      WHERE id = $1`,
    [row.id, next.content, fingerprint(next.content), JSON.stringify(next.metadata),
      vector ? JSON.stringify(vector) : null],
  );
}

console.log(JSON.stringify({ ...report, applied: changed.length }, null, 2));
await pool.end();
