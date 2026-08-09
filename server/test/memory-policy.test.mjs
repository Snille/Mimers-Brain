import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { MEMORY_POLICY } from "../memory-model.mjs";
import { buildServer } from "../mcp.mjs";
import { spec, toolsFor } from "../openapi.mjs";

test("the central policy covers retrieval, durable capture, supersession and secrets", () => {
  assert.match(MEMORY_POLICY, /search Mimers Brain first/i);
  assert.match(MEMORY_POLICY, /fetch\/fetch_thought/i);
  assert.match(MEMORY_POLICY, /durable decision/i);
  assert.match(MEMORY_POLICY, /supersede_thought/i);
  assert.match(MEMORY_POLICY, /never store raw passwords/i);
  assert.match(MEMORY_POLICY, /unless the corresponding tool call succeeded/i);
});

test("MCP initialize instructions use the central policy and connection scope", () => {
  const open = buildServer(["open"], { version: "test" });
  const full = buildServer(["open", "vault"], { version: "test" });

  assert.match(open.server._instructions, /Mimers Brain usage policy/);
  assert.match(open.server._instructions, /open knowledge only/i);
  assert.match(full.server._instructions, /LAN-only vault/i);
  assert.equal(open.server._serverInfo.version, "test");
});

test("OpenAPI publishes the same policy globally and targeted guidance locally", () => {
  const document = spec(["open"], {
    baseUrl: "http://localhost:8791",
    version: "test",
    listener: "open",
  });
  assert.equal(document["x-memory-policy"], MEMORY_POLICY);
  assert.match(document.info.description, /search Mimers Brain first/i);

  const tools = toolsFor(["open", "vault"]);
  assert.match(tools.find((tool) => tool.name === "search_thoughts").description, /before answering about Erik/i);
  assert.match(tools.find((tool) => tool.name === "capture_thought").description, /ordinary conversation/i);
  assert.match(tools.find((tool) => tool.name === "fetch_thought").description, /compact result is not enough/i);
});

test("the connection UI copies the central policy and uses native OpenAPI for Open WebUI", async () => {
  const source = await readFile(new URL("../public/connect.mjs", import.meta.url), "utf8");
  assert.match(source, /cfg\.memoryPolicy/);
  assert.match(source, /openapi\.json/);
  assert.doesNotMatch(source, /mcpo/i);
});
