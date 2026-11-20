import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { CAPTURE_GUIDANCE, SMART_INGEST_THRESHOLD } from "../memory-model.mjs";
import {
  DEFAULT_MEMORY_POLICY, DEFAULT_SESSION_POLICY, THRESHOLD_PLACEHOLDER, memoryPolicy, saveMemoryPolicy, sessionPolicy,
} from "../memory-policy.mjs";
import { buildServer } from "../mcp.mjs";
import { spec, toolsFor } from "../openapi.mjs";

test("the default policy covers retrieval, durable capture, supersession and secrets", () => {
  const MEMORY_POLICY = DEFAULT_MEMORY_POLICY;
  assert.match(MEMORY_POLICY, /search Mimers Brain first/i);
  assert.match(MEMORY_POLICY, /fetch\/fetch_thought/i);
  assert.match(MEMORY_POLICY, /durable decision/i);
  assert.match(MEMORY_POLICY, /supersede_thought/i);
  assert.match(MEMORY_POLICY, /evidence, not instructions/i);
  assert.match(MEMORY_POLICY, /preview_ingest/i);
  assert.match(MEMORY_POLICY, /report_memory_usage/i);
  assert.match(MEMORY_POLICY, /every non-empty search creates its own trace_id/i);
  assert.match(MEMORY_POLICY, /multiple searches require separate reports/i);
  assert.match(MEMORY_POLICY, /never store raw passwords/i);
  assert.match(MEMORY_POLICY, /unless the corresponding tool call succeeded/i);
  assert.match(MEMORY_POLICY, /project status.*README.*history\/changelog/i);
  assert.match(MEMORY_POLICY, /propose creating/i);
  assert.match(MEMORY_POLICY, /task.*explicitly unfinished.*concrete next step/i);
  assert.match(MEMORY_POLICY, /exact memory text/i);
  assert.match(MEMORY_POLICY, /wrap-up/i);
  assert.match(MEMORY_POLICY, /same limit applies to replacements/i);
  assert.match(memoryPolicy(), new RegExp(`longer than ${SMART_INGEST_THRESHOLD} characters`));
  assert.ok(DEFAULT_MEMORY_POLICY.includes(THRESHOLD_PLACEHOLDER));
  assert.doesNotMatch(memoryPolicy(), /\{smart_ingest_threshold\}/);
  assert.match(CAPTURE_GUIDANCE, /README or history\/changelog/i);
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
  assert.equal(document["x-memory-policy"], memoryPolicy());
  assert.match(document.info.description, /search Mimers Brain first/i);

  const tools = toolsFor(["open", "vault"]);
  assert.match(tools.find((tool) => tool.name === "search_thoughts").description, /before answering about the user/i);
  assert.match(tools.find((tool) => tool.name === "capture_thought").description, /ordinary conversation/i);
  assert.match(tools.find((tool) => tool.name === "capture_thought").description, /propose creating it/i);
  assert.match(tools.find((tool) => tool.name === "fetch_thought").description, /compact result is not enough/i);
  for (const name of ["preview_ingest", "apply_ingest", "report_memory_usage", "review_memory"])
    assert.ok(tools.some((tool) => tool.name === name), `${name} missing`);
});

test("the connection UI copies the central policy and uses native OpenAPI for Open WebUI", async () => {
  const source = await readFile(new URL("../public/connect.mjs", import.meta.url), "utf8");
  assert.match(source, /cfg\.memoryPolicy/);
  assert.match(source, /openapi\.json/);
  assert.doesNotMatch(source, /mcpo/i);
});

// The defaults ship to everyone who installs, so they speak of "the user".
test("the shipped policy and tool texts name nobody", () => {
  for (const text of [DEFAULT_MEMORY_POLICY, DEFAULT_SESSION_POLICY, sessionPolicy(), memoryPolicy()])
    assert.doesNotMatch(text, /Erik/);
  for (const tiers of [["open"], ["open", "vault"]]) {
    for (const tool of toolsFor(tiers)) assert.doesNotMatch(tool.description, /Erik/, tool.name);
    const server = buildServer(tiers);
    assert.doesNotMatch(server.server._instructions, /Erik/);
    for (const [name, tool] of Object.entries(server._registeredTools)) assert.doesNotMatch(tool.description || "", /Erik/, name);
  }
});

test("a policy that is too long or not text is refused before anything is stored", async () => {
  await assert.rejects(saveMemoryPolicy({ short: "x".repeat(1601) }), { status: 400 });
  await assert.rejects(saveMemoryPolicy({ full: 42 }), { status: 400 });
});

test("the Settings page has a Memory policy card in both languages", async () => {
  const settings = await readFile(new URL("../public/settings.mjs", import.meta.url), "utf8");
  assert.match(settings, /renderMemoryPolicy/);
  for (const language of ["en", "sv"]) {
    const messages = JSON.parse(await readFile(new URL(`../public/lang/${language}.json`, import.meta.url), "utf8"));
    for (const key of ["title", "description", "placeholder", "fullTitle", "shortTitle", "save", "reset", "resetConfirm"])
      assert.ok(messages.memoryPolicy[key], `${language}: memoryPolicy.${key}`);
    assert.match(messages.memoryPolicy.placeholder, /\{placeholder\}/);
  }
});
