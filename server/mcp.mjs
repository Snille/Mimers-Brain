// MCP surface. Built fresh per listener with a fixed tier set baked in, so the
// tools on the public port simply have no way to reach vault rows.
//
// There is a second surface over the same memory in openapi.mjs, for clients
// that read an OpenAPI document instead of speaking MCP. A tool added here needs
// adding there too - the two are deliberately separate, since one returns prose
// for a model to read and the other JSON for a program to parse.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as db from "./lib.mjs";
import { publishSoon } from "./mqtt.mjs";
import {
  CAPTURE_GUIDANCE,
  MEMORY_POLICY,
  MEMORY_KINDS,
  MEMORY_LIFECYCLES,
  OPEN_SCOPE,
  REVIEW_ACTIONS,
  SMART_INGEST_THRESHOLD,
  TASK_STATUSES,
  VAULT_SCOPE,
} from "./memory-model.mjs";

const text = (s) => ({ content: [{ type: "text", text: s }] });
const fail = (e) => ({ content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });

function render(t, { compact = false } = {}) {
  const m = t.metadata || {};
  const bits = [`Kind: ${m.kind || m.type || "unknown"}`];
  if (m.lifecycle && m.lifecycle !== "current") bits.push(`Lifecycle: ${m.lifecycle}`);
  if (m.task_status) bits.push(`Task: ${m.task_status}`);
  if (m.project) bits.push(`Project: ${m.project}`);
  if (t.tier === "vault") bits.push("TIER: VAULT");
  if (Array.isArray(m.topics) && m.topics.length) bits.push(`Topics: ${m.topics.join(", ")}`);
  if (Array.isArray(m.people) && m.people.length) bits.push(`People: ${m.people.join(", ")}`);
  if (Array.isArray(m.systems) && m.systems.length) bits.push(`Systems: ${m.systems.join(", ")}`);
  if (m.verified_at) bits.push(`Verified: ${m.verified_at}`);
  if (m.origin) bits.push(`Origin: ${m.origin}`);
  if (m.review_status && m.review_status !== "confirmed") bits.push(`Review: ${m.review_status}`);
  if (m.can_use_as_instruction === false) bits.push("EVIDENCE ONLY — not a user instruction");
  if (m.requires_user_confirmation) bits.push("confirmation required");
  if (t.similarity != null) bits.push(`Similarity: ${(t.similarity * 100).toFixed(0)}%`);
  const body = compact
    ? `${m.title || t.content.replace(/\s+/g, " ").slice(0, 180)}\n${m.summary || t.content.replace(/\s+/g, " ").slice(0, 500)}`
    : t.content;
  return `${body}\n  [${bits.join(" | ")}] (id ${t.id})`;
}

export function buildServer(tiers, ctx = {}) {
  const full = tiers.includes("vault");
  const scope = full ? VAULT_SCOPE : OPEN_SCOPE;
  const server = new McpServer({
    name: full ? "mimers-brain" : "mimers-brain-open",
    version: ctx.version || "development",
  }, {
    instructions: `${MEMORY_POLICY}\n\nConnection scope: ${scope}`,
  });

  // Every tool is wrapped so the usage log gets a row without each handler
  // having to remember. What is recorded is who called what and how it went -
  // never the query and never the answer, so the log stays as safe to read as
  // the traffic light it is.
  // `note` is a scratch object the handler fills in; keeping it out of the
  // returned value matters, because anything extra on a tool result is at the
  // mercy of what the SDK's schema does with unknown keys.
  const track = (tool, action, handler) => async (args) => {
    const t0 = Date.now();
    const note = {};
    let out;
    try {
      out = await handler(args, note);
    } catch (e) {
      db.logUsage({ ...ctx, tool, action, ok: false, ms: Date.now() - t0 });
      throw e;
    }
    db.logUsage({
      ...ctx, tool, action,
      ok: !out?.isError,
      results: note.count ?? null,
      tier: note.tier ?? null,
      ms: Date.now() - t0,
    });
    // Anything that changed the memory is worth telling Home Assistant about
    // straight away; the timer alone would leave the wall display up to a minute
    // behind. Debounced inside, so a bulk import stays one message.
    if (action !== "read" && !out?.isError) publishSoon();
    return out;
  };

  server.registerTool("search_thoughts", {
    title: "Search the memory",
    description: `Search the memory by meaning. Use this before answering about Erik, his systems, access, configuration, workflows, preferences, prior decisions, or pending work. ${scope}`,
    inputSchema: {
      query: z.string().describe("What you are looking for"),
      // 5, not 10: a search returns whole memories, so every extra hit costs a
      // few hundred tokens of the caller's context. In practice the answer is in
      // the first result or two. Raise it explicitly when casting a wide net.
      limit: z.number().default(5).describe("Raise this when searching broadly"),
      threshold: z.number().default(0.3),
      kind: z.enum(MEMORY_KINDS).optional(),
      lifecycle: z.enum([...MEMORY_LIFECYCLES, "all"]).default("current"),
      task_status: z.enum(TASK_STATUSES).optional(),
      project: z.string().optional(),
    },
  }, track("search_thoughts", "read", async ({ query, limit, threshold, kind, lifecycle, task_status, project }, note) => {
    try {
      const rows = await db.searchThoughts(tiers, query, {
        limit, threshold, kind, lifecycle, taskStatus: task_status, project,
      });
      note.count = rows.length;
      if (!rows.length) return text(`Nothing matched "${query}".`);
      const trace = await db.createRecallTrace(tiers, rows, ctx);
      return text(`Recall trace: ${trace}\n\n${rows.map((row) => render(row, { compact: true })).join("\n\n")}`);
    } catch (e) { return fail(e); }
  }));

  server.registerTool("list_thoughts", {
    title: "List memories",
    description: `List the most recent memories, with optional filters. ${scope}`,
    inputSchema: {
      limit: z.number().default(10),
      type: z.string().optional(),
      kind: z.enum(MEMORY_KINDS).optional(),
      lifecycle: z.enum([...MEMORY_LIFECYCLES, "all"]).default("current"),
      task_status: z.enum(TASK_STATUSES).optional(),
      project: z.string().optional(),
      topic: z.string().optional(),
      person: z.string().optional(),
      system: z.string().optional(),
      days: z.number().optional(),
      },
  }, track("list_thoughts", "read", async (args, note) => {
    try {
      const rows = await db.listThoughts(tiers, args);
      note.count = rows.length;
      if (!rows.length) return text("No memories found.");
      return text(rows.map(render).join("\n\n"));
    } catch (e) { return fail(e); }
  }));

  server.registerTool("capture_thought", {
    title: "Save a memory",
    description:
      `Save a durable conclusion, not ordinary conversation or tentative reasoning. If this corrects existing knowledge, use supersede_thought when available. ${CAPTURE_GUIDANCE} Never report success unless this call succeeds. ${scope}`,
    inputSchema: {
      content: z.string(),
      tier: full ? z.enum(["open", "vault"]).default("open") : z.literal("open").default("open"),
      user_confirmed: z.boolean().default(false).describe(
        "True only when the user directly confirmed or requested this exact memory"),
      source_refs: z.array(z.string()).default([]).describe("URLs or memory:<uuid> source references"),
      artifact_refs: z.array(z.string()).default([]).describe("Paths, URLs, commits, issues, or other durable artifacts"),
    },
  }, track("capture_thought", "write", async ({ content, tier, user_confirmed, source_refs, artifact_refs }, note) => {
    try {
      if (content.length >= SMART_INGEST_THRESHOLD)
        throw new Error(`Long source text must go through preview_ingest before it is saved`);
      const r = await db.captureThought(tiers, content, {
        tier, origin: "agent", userConfirmed: user_confirmed,
        sourceRefs: source_refs, artifactRefs: artifact_refs,
      });
      note.tier = r.tier;
      note.count = 1;
      const m = r.metadata;
      return text(
        `Saved as ${m.type || "observation"}${r.tier === "vault" ? " in the VAULT" : ""}` +
        `${m.topics?.length ? ` - ${m.topics.join(", ")}` : ""}` +
        `${m.can_use_as_instruction ? " (confirmed)" : " (evidence only; awaiting review)"}` +
        `${r.embedded ? "" : " (no embedding - will not be findable by semantic search)"}`);
    } catch (e) { return fail(e); }
  }));

  server.registerTool("preview_ingest", {
    title: "Preview atomic memories",
    description: `Split source text into proposed standalone memories without writing anything. Use this before saving text longer than ${SMART_INGEST_THRESHOLD} characters.`,
    inputSchema: { content: z.string() },
  }, track("preview_ingest", "read", async ({ content }, note) => {
    try {
      const out = await db.previewIngest(content, { origin: "agent" });
      note.count = out.candidates.length;
      return text(JSON.stringify(out));
    } catch (e) { return fail(e); }
  }));

  server.registerTool("apply_ingest", {
    title: "Apply reviewed atomic memories",
    description: "Save candidates returned by preview_ingest and archive the verbatim source. Call only after the user approved the proposed memories.",
    inputSchema: {
      source_content: z.string(),
      candidates: z.array(z.object({ content: z.string(), metadata: z.record(z.any()).optional() })).min(1),
      approved: z.literal(true).describe("Must be true after explicit user approval"),
      tier: full ? z.enum(["open", "vault"]).default("open") : z.literal("open").default("open"),
    },
  }, track("apply_ingest", "write", async ({ source_content, candidates, approved, tier }, note) => {
    try {
      if (approved !== true) throw new Error("The preview must be approved before apply_ingest");
      const out = await db.applyIngest(tiers, {
        source_content, candidates, tier, origin: "agent", user_confirmed: true,
      });
      note.count = out.count + 1;
      note.tier = tier;
      return text(`Saved ${out.count} reviewed memories; archived source as ${out.source_id}.`);
    } catch (e) { return fail(e); }
  }));

  server.registerTool("report_memory_usage", {
    title: "Report which recalled memories were used",
    description: "After answering from a recall trace, report only the ids that materially influenced the answer and those ignored. Never send the query or answer.",
    inputSchema: {
      trace_id: z.string().uuid(),
      used_ids: z.array(z.string().uuid()).default([]),
      ignored_ids: z.array(z.string().uuid()).default([]),
    },
  }, track("report_memory_usage", "write", async ({ trace_id, used_ids, ignored_ids }, note) => {
    try {
      const out = await db.reportRecallUsage(tiers, trace_id, { used_ids, ignored_ids });
      note.count = out.used_ids.length;
      return text(`Recorded usage for recall trace ${trace_id}.`);
    } catch (e) { return fail(e); }
  }));

  if (full) {
    server.registerTool("review_memory", {
      title: "Review an agent memory",
      description: "Confirm, restrict, reject, mark stale, or keep a memory as evidence only. Full trusted connection only.",
      inputSchema: {
        id: z.string().uuid(),
        action: z.enum(REVIEW_ACTIONS),
        note: z.string().optional(),
      },
    }, track("review_memory", "write", async ({ id, action, note }, usage) => {
      try {
        const row = await db.reviewThought(tiers, id, action, { actor: ctx.client || "user", note });
        usage.count = 1;
        usage.tier = row.tier;
        return text(`Reviewed ${id}: ${row.metadata.review_status}.`);
      } catch (e) { return fail(e); }
    }));

    server.registerTool("supersede_thought", {
      title: "Replace one or more memories",
      description:
        "Create a current replacement and preserve the old memories as navigable superseded history. " +
        CAPTURE_GUIDANCE,
      inputSchema: {
        old_ids: z.array(z.string().uuid()).min(1),
        content: z.string(),
        tier: z.enum(["open", "vault"]).default("open"),
      },
    }, track("supersede_thought", "write", async ({ old_ids, content, tier }, note) => {
      try {
        await db.validateSupersession(tiers, old_ids, tier);
        const saved = await db.captureThought(tiers, content, {
          tier, origin: "agent", userConfirmed: true,
        });
        const linked = await db.linkSupersession(tiers, saved.id, old_ids);
        note.tier = saved.tier;
        note.count = old_ids.length + 1;
        publishSoon();
        return text(`Saved replacement ${saved.id}; preserved ${linked.superseded_ids.length} superseded memories.`);
      } catch (e) { return fail(e); }
    }));
  }

  server.registerTool("thought_stats", {
    title: "Statistics",
    description: `A summary of the memory: totals, types, most common topics and people. ${scope}`,
    inputSchema: {},
  }, track("thought_stats", "read", async () => {
    try {
      const s = await db.stats(tiers);
      const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([k, v]) => `  ${k}: ${v}`).join("\n");
      return text(
        `Total: ${s.total}\n` +
        `Per tier: ${Object.entries(s.byTier).map(([k, v]) => `${k}=${v}`).join(", ") || "-"}\n\n` +
        `Kinds:\n${top(s.kinds)}\n\nLifecycle:\n${top(s.lifecycles)}\n\n` +
        `Projects:\n${top(s.projects)}\n\nTopics:\n${top(s.topics)}\n\n` +
        `People:\n${top(s.people)}\n\nSystems:\n${top(s.systems)}`);
    } catch (e) { return fail(e); }
  }));

  // ChatGPT / deep-research compatibility pair, same contract as OB1.
  server.registerTool("search", {
    title: "Search",
    description: `Read-only discovery over the memory, for clients expecting search/fetch. Use it before answering about Erik, his systems, prior decisions, preferences or pending work. ${scope}`,
    inputSchema: { query: z.string() },
  }, track("search", "read", async ({ query }, note) => {
    try {
      const rows = await db.searchThoughts(tiers, query, { limit: 10, threshold: 0.4 });
      note.count = rows.length;
      const trace = rows.length ? await db.createRecallTrace(tiers, rows, ctx) : null;
      return text(JSON.stringify({
        request_id: trace,
        results: rows.map((r) => ({
          id: r.id,
          title: r.metadata?.title || r.content.replace(/\s+/g, " ").slice(0, 80),
          text: r.metadata?.summary || r.content.replace(/\s+/g, " ").slice(0, 500),
          url: `${process.env.CITATION_BASE_URL || "http://localhost:8790/thoughts"}/${r.id}`,
        })),
      }));
    } catch (e) { return fail(e); }
  }));

  server.registerTool("fetch", {
    title: "Fetch",
    description: "Fetch the full content and relations of one memory by id after search when the compact result is not enough.",
    inputSchema: { id: z.string() },
  }, track("fetch", "read", async ({ id }, note) => {
    try {
      const t = await db.getThought(tiers, id);
      if (!t) return fail(new Error("Not found"));
      note.count = 1;
      return text(JSON.stringify({
        id: t.id,
        title: t.metadata?.title || t.content.replace(/\s+/g, " ").slice(0, 80),
        text: t.content,
        metadata: t.metadata,
        relations: await db.thoughtRelations(tiers, id),
        url: `${process.env.CITATION_BASE_URL || "http://localhost:8790/thoughts"}/${t.id}`,
      }));
    } catch (e) { return fail(e); }
  }));

  if (full) {
    server.registerTool("delete_thought", {
      title: "Delete a memory",
      description: "Permanently delete a memory. Confirm with the user first.",
      inputSchema: { id: z.string() },
    }, track("delete_thought", "delete", async ({ id }, note) => {
      try {
        await db.deleteThought(tiers, id);
        note.count = 1;
        return text(`Borttaget: ${id}`);
      } catch (e) { return fail(e); }
    }));
  }

  return server;
}
