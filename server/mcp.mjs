// MCP surface. Built fresh per listener with a fixed tier set baked in, so the
// tools on the public port simply have no way to reach vault rows.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as db from "./lib.mjs";

const text = (s) => ({ content: [{ type: "text", text: s }] });
const fail = (e) => ({ content: [{ type: "text", text: `Fel: ${e.message}` }], isError: true });

function render(t) {
  const m = t.metadata || {};
  const bits = [`Typ: ${m.type || "okänd"}`];
  if (t.tier === "vault") bits.push("NIVÅ: VALV");
  if (Array.isArray(m.topics) && m.topics.length) bits.push(`Ämnen: ${m.topics.join(", ")}`);
  if (Array.isArray(m.people) && m.people.length) bits.push(`Personer: ${m.people.join(", ")}`);
  if (t.similarity != null) bits.push(`Träffsäkerhet: ${(t.similarity * 100).toFixed(0)}%`);
  return `${t.content}\n  [${bits.join(" | ")}] (id ${t.id})`;
}

export function buildServer(tiers) {
  const full = tiers.includes("vault");
  const server = new McpServer({
    name: full ? "mimers-brain" : "mimers-brain-open",
    version: "0.1.0",
  });

  const scope = full
    ? "Denna anslutning når både öppen kunskap och valvet (nycklar, lösenord, tokens)."
    : "Denna anslutning når endast öppen kunskap. Valvet serveras bara på hemnätet.";

  server.registerTool("search_thoughts", {
    title: "Sök i minnet",
    description: `Sök Eriks minne på betydelse. Använd detta först när du behöver veta hur ett system nås eller hur något fungerar. ${scope}`,
    inputSchema: {
      query: z.string().describe("Vad du söker efter"),
      limit: z.number().default(10),
      threshold: z.number().default(0.3),
    },
  }, async ({ query, limit, threshold }) => {
    try {
      const rows = await db.searchThoughts(tiers, query, { limit, threshold });
      if (!rows.length) return text(`Inget matchade "${query}".`);
      return text(rows.map(render).join("\n\n"));
    } catch (e) { return fail(e); }
  });

  server.registerTool("list_thoughts", {
    title: "Lista minnen",
    description: `Lista senaste minnena, med valfria filter. ${scope}`,
    inputSchema: {
      limit: z.number().default(10),
      type: z.string().optional(),
      topic: z.string().optional(),
      person: z.string().optional(),
      days: z.number().optional(),
      },
  }, async (args) => {
    try {
      const rows = await db.listThoughts(tiers, args);
      if (!rows.length) return text("Inga minnen hittades.");
      return text(rows.map(render).join("\n\n"));
    } catch (e) { return fail(e); }
  });

  server.registerTool("capture_thought", {
    title: "Spara minne",
    description:
      `Spara något i Eriks minne. Skriv det som ett fristående påstående som går ` +
      `att förstå långt senare utan sammanhang. ` +
      (full
        ? `Sätt tier="vault" för nycklar, lösenord och tokens — de lämnar då aldrig hemnätet.`
        : `Denna anslutning kan bara skriva öppen kunskap; hemligheter måste sparas hemifrån.`),
    inputSchema: {
      content: z.string(),
      tier: full ? z.enum(["open", "vault"]).default("open") : z.literal("open").default("open"),
    },
  }, async ({ content, tier }) => {
    try {
      const r = await db.captureThought(tiers, content, { tier });
      const m = r.metadata;
      return text(
        `Sparat som ${m.type || "observation"}${r.tier === "vault" ? " i VALVET" : ""}` +
        `${m.topics?.length ? ` — ${m.topics.join(", ")}` : ""}` +
        `${r.embedded ? "" : " (utan embedding — blir inte sökbar semantiskt)"}`);
    } catch (e) { return fail(e); }
  });

  server.registerTool("thought_stats", {
    title: "Statistik",
    description: `Sammanfattning av minnet: totaler, typer, vanligaste ämnen och personer. ${scope}`,
    inputSchema: {},
  }, async () => {
    try {
      const s = await db.stats(tiers);
      const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([k, v]) => `  ${k}: ${v}`).join("\n");
      return text(
        `Totalt: ${s.total}\n` +
        `Per nivå: ${Object.entries(s.byTier).map(([k, v]) => `${k}=${v}`).join(", ") || "-"}\n\n` +
        `Typer:\n${top(s.types)}\n\nÄmnen:\n${top(s.topics)}\n\nPersoner:\n${top(s.people)}`);
    } catch (e) { return fail(e); }
  });

  // ChatGPT / deep-research compatibility pair, same contract as OB1.
  server.registerTool("search", {
    title: "Search",
    description: `Read-only search over Erik's memory, for clients expecting search/fetch. ${scope}`,
    inputSchema: { query: z.string() },
  }, async ({ query }) => {
    try {
      const rows = await db.searchThoughts(tiers, query, { limit: 10, threshold: 0.4 });
      return text(JSON.stringify({
        results: rows.map((r) => ({
          id: r.id,
          title: r.content.replace(/\s+/g, " ").slice(0, 80),
          text: r.content,
          url: `${process.env.CITATION_BASE_URL || "http://localhost:8790/thoughts"}/${r.id}`,
        })),
      }));
    } catch (e) { return fail(e); }
  });

  server.registerTool("fetch", {
    title: "Fetch",
    description: "Fetch one memory by id after using search.",
    inputSchema: { id: z.string() },
  }, async ({ id }) => {
    try {
      const t = await db.getThought(tiers, id);
      if (!t) return fail(new Error("Hittades inte"));
      return text(JSON.stringify({
        id: t.id,
        title: t.content.replace(/\s+/g, " ").slice(0, 80),
        text: t.content,
        metadata: t.metadata,
        url: `${process.env.CITATION_BASE_URL || "http://localhost:8790/thoughts"}/${t.id}`,
      }));
    } catch (e) { return fail(e); }
  });

  if (full) {
    server.registerTool("delete_thought", {
      title: "Ta bort minne",
      description: "Ta bort ett minne permanent. Bekräfta med Erik först.",
      inputSchema: { id: z.string() },
    }, async ({ id }) => {
      try {
        await db.deleteThought(tiers, id);
        return text(`Borttaget: ${id}`);
      } catch (e) { return fail(e); }
    });
  }

  return server;
}
