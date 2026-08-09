// OpenAPI surface - the same memory, for clients that do not speak MCP.
//
// Open WebUI's "external tool servers" are the reason this exists: they take an
// OpenAPI document and call plain REST, and no amount of configuration makes
// them talk JSON-RPC to /mcp. Rather than run a separate MCP-to-OpenAPI proxy
// beside the brain, the brain describes itself.
//
// This is an addition, not a replacement. /mcp is untouched and stays the way in
// for Claude, ChatGPT and Gemini; nothing here can reach a tier the listener it
// runs on was not built with, exactly as in mcp.mjs.
//
// When you add a tool to mcp.mjs, add it here too. The two surfaces are kept
// deliberately separate - one returns prose for a model to read, the other
// returns JSON for a program to parse - so there is no shared table to fall back
// on. TOOLS below is the whole of it; keep the descriptions in step.

import * as db from "./lib.mjs";
import { publishSoon } from "./mqtt.mjs";
import {
  CAPTURE_GUIDANCE,
  MEMORY_POLICY,
  MEMORY_KINDS,
  MEMORY_LIFECYCLES,
  OPEN_SCOPE,
  TASK_STATUSES,
  VAULT_SCOPE,
} from "./memory-model.mjs";

// A bad argument is the caller's mistake, not a server fault. Carrying the
// status on the error keeps the dispatcher free of per-tool special cases.
class BadRequest extends Error {
  constructor(msg) { super(msg); this.status = 400; }
}

// One memory, flattened. The MCP tools render prose because a model reads it;
// here the caller is a program, so the fields stay fields.
function memory(t) {
  const m = t.metadata || {};
  return {
    id: t.id,
    content: t.content,
    title: m.title || null,
    summary: m.summary || null,
    kind: m.kind || null,
    lifecycle: m.lifecycle || "current",
    task_status: m.task_status || null,
    project: m.project || null,
    type: m.type || null,
    topics: m.topics || [],
    people: m.people || [],
    systems: m.systems || [],
    verified_at: m.verified_at || null,
    valid_for_version: m.valid_for_version || null,
    tier: t.tier,
    created_at: t.created_at,
    updated_at: t.updated_at,
    ...(t.similarity != null ? { similarity: Number(t.similarity.toFixed?.(3) ?? t.similarity) } : {}),
  };
}

const str = (description) => ({ type: "string", description });

// Postgres raises a syntax error on a malformed uuid, which would surface as a
// 500 for what is plainly a bad argument. Check it here instead.
function uuid(v) {
  const s = String(v || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s))
    throw new BadRequest("id must be a uuid, as returned by search_thoughts");
  return s;
}

export function toolsFor(tiers) {
  const full = tiers.includes("vault");
  const scope = full ? VAULT_SCOPE : OPEN_SCOPE;

  const tools = [
    {
      name: "search_thoughts",
      action: "read",
      summary: "Search the memory",
      description:
        `Search the memory by meaning. Use this before answering about Erik, his systems, ` +
        `access, configuration, workflows, preferences, prior decisions, or pending work. ${scope}`,
      schema: {
        type: "object",
        required: ["query"],
        properties: {
          query: str("What you are looking for"),
          limit: { type: "integer", default: 5, description: "Raise this when searching broadly" },
          threshold: { type: "number", default: 0.3 },
          kind: { type: "string", enum: MEMORY_KINDS },
          lifecycle: { type: "string", enum: [...MEMORY_LIFECYCLES, "all"], default: "current" },
          task_status: { type: "string", enum: TASK_STATUSES },
          project: str("Only memories owned by this project"),
        },
      },
      async run({ query, limit = 5, threshold = 0.3, kind, lifecycle = "current", task_status, project }) {
        if (!String(query || "").trim()) throw new BadRequest("query is required");
        const rows = await db.searchThoughts(tiers, String(query).trim(), {
          limit, threshold, kind, lifecycle, taskStatus: task_status, project,
        });
        return { count: rows.length, results: rows.map(memory) };
      },
    },
    {
      name: "list_thoughts",
      action: "read",
      summary: "List memories",
      description: `List the most recent memories, with optional filters. ${scope}`,
      schema: {
        type: "object",
        properties: {
          limit: { type: "integer", default: 10 },
          type: str("Only memories of this type, e.g. observation, reference"),
          kind: { type: "string", enum: MEMORY_KINDS },
          lifecycle: { type: "string", enum: [...MEMORY_LIFECYCLES, "all"], default: "current" },
          task_status: { type: "string", enum: TASK_STATUSES },
          project: str("Only memories owned by this project"),
          topic: str("Only memories carrying this topic"),
          person: str("Only memories mentioning this person"),
          system: str("Only memories mentioning this system or device"),
          days: { type: "integer", description: "Only memories from the last N days" },
        },
      },
      async run(args) {
        const rows = await db.listThoughts(tiers, args);
        return { count: rows.length, results: rows.map(memory) };
      },
    },
    {
      name: "capture_thought",
      action: "write",
      summary: "Save a memory",
      description:
        `Save a durable conclusion, not ordinary conversation or tentative reasoning. ` +
        `If this corrects existing knowledge, use supersede_thought when available. ` +
        `${CAPTURE_GUIDANCE} Never report success unless this call succeeds. ${scope}`,
      schema: {
        type: "object",
        required: ["content"],
        properties: {
          content: str("The memory, as a standalone statement"),
          tier: { type: "string", enum: full ? ["open", "vault"] : ["open"], default: "open" },
        },
      },
      async run({ content, tier = "open" }) {
        if (!String(content || "").trim()) throw new BadRequest("content is required");
        const r = await db.captureThought(tiers, String(content).trim(), { tier });
        publishSoon();
        return {
          id: r.id,
          tier: r.tier,
          type: r.metadata?.type || null,
          topics: r.metadata?.topics || [],
          embedded: r.embedded,
          // Said plainly rather than left to be inferred from `embedded: false`:
          // a memory with no vector is saved but invisible to semantic search.
          note: r.embedded ? "Saved." : "Saved, but with no embedding - it will not be found by semantic search.",
        };
      },
    },
    {
      name: "thought_stats",
      action: "read",
      summary: "Statistics",
      description: `A summary of the memory: totals, types, most common topics and people. ${scope}`,
      schema: { type: "object", properties: {} },
      async run() {
        return db.stats(tiers);
      },
    },
    {
      name: "fetch_thought",
      action: "read",
      summary: "Fetch one memory",
      description: "Fetch the full content and relations of one memory by id after search when the compact result is not enough.",
      schema: {
        type: "object",
        required: ["id"],
        properties: { id: str("The memory's uuid") },
      },
      async run({ id }) {
        const t = await db.getThought(tiers, uuid(id));
        if (!t) throw new BadRequest("No memory with that id on this tier");
        return { ...memory(t), relations: await db.thoughtRelations(tiers, t.id) };
      },
    },
  ];

  if (full) {
    tools.push({
      name: "supersede_thought",
      action: "write",
      summary: "Replace one or more memories",
      description:
        "Create a current replacement and preserve the old memories as navigable superseded history. " +
        CAPTURE_GUIDANCE,
      schema: {
        type: "object",
        required: ["old_ids", "content"],
        properties: {
          old_ids: { type: "array", minItems: 1, items: str("A full memory uuid") },
          content: str("The replacement memory as a standalone statement"),
          tier: { type: "string", enum: ["open", "vault"], default: "open" },
        },
      },
      async run({ old_ids, content, tier = "open" }) {
        if (!Array.isArray(old_ids) || !old_ids.length) throw new BadRequest("old_ids is required");
        const ids = old_ids.map(uuid);
        if (!String(content || "").trim()) throw new BadRequest("content is required");
        await db.validateSupersession(tiers, ids, tier);
        const saved = await db.captureThought(tiers, String(content).trim(), { tier });
        const linked = await db.linkSupersession(tiers, saved.id, ids);
        publishSoon();
        return { id: saved.id, tier: saved.tier, superseded_ids: linked.superseded_ids };
      },
    });

    tools.push({
      name: "delete_thought",
      action: "delete",
      summary: "Delete a memory",
      description: "Permanently delete a memory. Confirm with the user first.",
      schema: {
        type: "object",
        required: ["id"],
        properties: { id: str("The memory's uuid") },
      },
      async run({ id }) {
        const target = uuid(id);
        // deleteThought throws "Not found" for a row that is not there or sits
        // on a tier this listener cannot see. Either way it is the caller's id
        // that is wrong, not the server.
        try {
          await db.deleteThought(tiers, target);
        } catch {
          throw new BadRequest("No memory with that id on this tier");
        }
        publishSoon();
        return { deleted: true, id: target };
      },
    });
  }

  return tools;
}

// The document Open WebUI reads. `baseUrl` comes from the request rather than
// from configuration, so the same instance describes itself correctly whether it
// was reached on the LAN address or through the proxy.
export function spec(tiers, { baseUrl, version, listener }) {
  const paths = {};
  for (const t of toolsFor(tiers)) {
    paths[`/tools/${t.name}`] = {
      post: {
        operationId: t.name,
        summary: t.summary,
        description: t.description,
        requestBody: {
          required: true,
          content: { "application/json": { schema: t.schema } },
        },
        responses: {
          200: {
            description: "Success",
            content: { "application/json": { schema: { type: "object" } } },
          },
          400: { description: "Bad request" },
          401: { description: "Missing or wrong key" },
        },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: listener === "full" ? "Mimers Brain" : "Mimers Brain (open)",
      version,
      description: `${listener === "full"
        ? "Memory, open and vault tiers. Local network only."
        : "Memory, open tier. The vault is not reachable through this server."}\n\n${MEMORY_POLICY}`,
    },
    "x-memory-policy": MEMORY_POLICY,
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
      },
    },
    security: [{ bearerAuth: [] }],
    paths,
  };
}

// Dispatch. Returns the tool's result; throws with .status set for anything the
// caller got wrong.
export async function callTool(tiers, name, args) {
  const tool = toolsFor(tiers).find((t) => t.name === name);
  if (!tool) {
    const e = new Error(`Unknown tool "${name}"`);
    e.status = 404;
    throw e;
  }
  const out = await tool.run(args || {});
  return { tool, out };
}
