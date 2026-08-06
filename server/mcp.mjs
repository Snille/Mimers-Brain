// MCP surface. Built fresh per listener with a fixed tier set baked in, so the
// tools on the public port simply have no way to reach vault rows.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as db from "./lib.mjs";
import { publishSoon } from "./mqtt.mjs";

const text = (s) => ({ content: [{ type: "text", text: s }] });
const fail = (e) => ({ content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });

function render(t) {
  const m = t.metadata || {};
  const bits = [`Type: ${m.type || "unknown"}`];
  if (t.tier === "vault") bits.push("TIER: VAULT");
  if (Array.isArray(m.topics) && m.topics.length) bits.push(`Topics: ${m.topics.join(", ")}`);
  if (Array.isArray(m.people) && m.people.length) bits.push(`People: ${m.people.join(", ")}`);
  if (t.similarity != null) bits.push(`Similarity: ${(t.similarity * 100).toFixed(0)}%`);
  return `${t.content}\n  [${bits.join(" | ")}] (id ${t.id})`;
}

export function buildServer(tiers, ctx = {}) {
  const full = tiers.includes("vault");
  const server = new McpServer({
    name: full ? "mimers-brain" : "mimers-brain-open",
    version: "0.1.0",
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

  const scope = full
    ? "This connection reaches both open knowledge and the vault (keys, passwords, tokens)."
    : "This connection reaches open knowledge only. The vault is served on the local network alone.";

  server.registerTool("search_thoughts", {
    title: "Search the memory",
    description: `Search the memory by meaning. Reach for this first whenever you need to know how a system is accessed or how something works. ${scope}`,
    inputSchema: {
      query: z.string().describe("What you are looking for"),
      // 5, not 10: a search returns whole memories, so every extra hit costs a
      // few hundred tokens of the caller's context. In practice the answer is in
      // the first result or two. Raise it explicitly when casting a wide net.
      limit: z.number().default(5).describe("Raise this when searching broadly"),
      threshold: z.number().default(0.3),
    },
  }, track("search_thoughts", "read", async ({ query, limit, threshold }, note) => {
    try {
      const rows = await db.searchThoughts(tiers, query, { limit, threshold });
      note.count = rows.length;
      if (!rows.length) return text(`Nothing matched "${query}".`);
      return text(rows.map(render).join("\n\n"));
    } catch (e) { return fail(e); }
  }));

  server.registerTool("list_thoughts", {
    title: "List memories",
    description: `List the most recent memories, with optional filters. ${scope}`,
    inputSchema: {
      limit: z.number().default(10),
      type: z.string().optional(),
      topic: z.string().optional(),
      person: z.string().optional(),
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
      `Save something to the memory. Write it as a standalone statement that will ` +
      `still make sense years later with no surrounding context. ` +
      (full
        ? `Set tier="vault" for keys, passwords and tokens - those then never leave the local network.`
        : `This connection can only write open knowledge; secrets must be saved from the local network.`),
    inputSchema: {
      content: z.string(),
      tier: full ? z.enum(["open", "vault"]).default("open") : z.literal("open").default("open"),
    },
  }, track("capture_thought", "write", async ({ content, tier }, note) => {
    try {
      const r = await db.captureThought(tiers, content, { tier });
      note.tier = r.tier;
      note.count = 1;
      const m = r.metadata;
      return text(
        `Saved as ${m.type || "observation"}${r.tier === "vault" ? " in the VAULT" : ""}` +
        `${m.topics?.length ? ` - ${m.topics.join(", ")}` : ""}` +
        `${r.embedded ? "" : " (no embedding - will not be findable by semantic search)"}`);
    } catch (e) { return fail(e); }
  }));

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
        `Types:\n${top(s.types)}\n\nTopics:\n${top(s.topics)}\n\nPeople:\n${top(s.people)}`);
    } catch (e) { return fail(e); }
  }));

  // ChatGPT / deep-research compatibility pair, same contract as OB1.
  server.registerTool("search", {
    title: "Search",
    description: `Read-only search over the memory, for clients expecting search/fetch. ${scope}`,
    inputSchema: { query: z.string() },
  }, track("search", "read", async ({ query }, note) => {
    try {
      const rows = await db.searchThoughts(tiers, query, { limit: 10, threshold: 0.4 });
      note.count = rows.length;
      return text(JSON.stringify({
        results: rows.map((r) => ({
          id: r.id,
          title: r.content.replace(/\s+/g, " ").slice(0, 80),
          text: r.content,
          url: `${process.env.CITATION_BASE_URL || "http://localhost:8790/thoughts"}/${r.id}`,
        })),
      }));
    } catch (e) { return fail(e); }
  }));

  server.registerTool("fetch", {
    title: "Fetch",
    description: "Fetch one memory by id after using search.",
    inputSchema: { id: z.string() },
  }, track("fetch", "read", async ({ id }, note) => {
    try {
      const t = await db.getThought(tiers, id);
      if (!t) return fail(new Error("Not found"));
      note.count = 1;
      return text(JSON.stringify({
        id: t.id,
        title: t.content.replace(/\s+/g, " ").slice(0, 80),
        text: t.content,
        metadata: t.metadata,
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
