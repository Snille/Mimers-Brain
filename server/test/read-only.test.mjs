// The read-only listener. What is tested here is an absence: a port that a
// model of modest judgement can be pointed at, where no amount of trying finds
// a tool that changes the memory.

import test from "node:test";
import assert from "node:assert/strict";

import { buildServer } from "../mcp.mjs";
import { spec, toolsFor, callTool } from "../openapi.mjs";
import { READ_ONLY_SCOPE } from "../memory-model.mjs";

const WRITERS = [
  "capture_thought", "apply_ingest", "preview_ingest",
  "review_memory", "supersede_thought", "delete_thought",
];

test("a read-only MCP server registers no tool that writes", () => {
  // Vault tiers on purpose: read-only must hold even where every tool exists.
  const server = buildServer(["open", "vault"], { writable: false });
  const names = Object.keys(server._registeredTools || {});

  for (const name of WRITERS) assert.equal(names.includes(name), false, name);
  for (const name of ["search_thoughts", "list_thoughts", "fetch", "search", "thought_stats"])
    assert.equal(names.includes(name), true, name);

  // The receipt stays: every search asks for one, and it writes a usage row
  // rather than a memory.
  assert.equal(names.includes("report_memory_usage"), true);
});

test("a writable MCP server is unchanged", () => {
  const names = Object.keys(buildServer(["open", "vault"], {})._registeredTools || {});
  for (const name of WRITERS) assert.equal(names.includes(name), true, name);
});

test("the read-only OpenAPI surface offers nothing that writes", () => {
  const names = toolsFor(["open", "vault"], {}, { writable: false }).map((t) => t.name);
  for (const name of WRITERS) assert.equal(names.includes(name), false, name);
  assert.equal(names.includes("report_memory_usage"), true);
  assert.equal(names.includes("fetch_thought"), true);
});

test("a write tool is unknown to the dispatcher on a read-only listener", async () => {
  await assert.rejects(
    () => callTool(["open", "vault"], "capture_thought", { content: "x" }, {}, { writable: false }),
    (err) => err.status === 404,
  );
});

test("the read-only document describes only what it can do", () => {
  const document = spec(["open"], {
    baseUrl: "http://localhost:8792",
    version: "test",
    listener: "open",
    writable: false,
  });
  for (const name of WRITERS)
    assert.equal(Boolean(document.paths[`/tools/${name}`]), false, name);
  assert.ok(document.paths["/tools/search_thoughts"]);
  assert.match(document.info.title, /read only/i);
});

test("the read-only scope tells the model not to promise to remember", () => {
  assert.match(READ_ONLY_SCOPE, /READ ONLY/);
  assert.match(READ_ONLY_SCOPE, /never promise to remember/i);
});
