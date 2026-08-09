import test from "node:test";
import assert from "node:assert/strict";

import { spec, toolsFor } from "../openapi.mjs";
import { MEMORY_POLICY } from "../memory-model.mjs";
import { recallReference } from "../recall.mjs";

test("open and full OpenAPI surfaces keep the tier boundary", () => {
  const open = toolsFor(["open"]);
  const full = toolsFor(["open", "vault"]);
  const openNames = open.map((tool) => tool.name);
  const fullNames = full.map((tool) => tool.name);

  assert.equal(openNames.includes("delete_thought"), false);
  assert.equal(openNames.includes("supersede_thought"), false);
  assert.equal(openNames.includes("review_memory"), false);
  assert.equal(fullNames.includes("delete_thought"), true);
  assert.equal(fullNames.includes("supersede_thought"), true);
  assert.equal(fullNames.includes("review_memory"), true);
  for (const name of ["preview_ingest", "apply_ingest", "report_memory_usage"])
    assert.equal(openNames.includes(name), true);

  const captureOpen = open.find((tool) => tool.name === "capture_thought");
  assert.deepEqual(captureOpen.schema.properties.tier.enum, ["open"]);
  assert.equal(captureOpen.schema.properties.user_confirmed.default, false);
  assert.ok(captureOpen.schema.properties.source_refs);
  assert.ok(captureOpen.schema.properties.artifact_refs);
  assert.match(captureOpen.description, /never store raw/i);
});

test("the OpenAPI document exposes v2 filters", () => {
  const document = spec(["open"], {
    baseUrl: "http://localhost:8791",
    version: "test",
    listener: "open",
  });
  const properties = document.paths["/tools/search_thoughts"].post
    .requestBody.content["application/json"].schema.properties;
  for (const name of ["kind", "lifecycle", "task_status", "project"]) {
    assert.ok(properties[name], `${name} is missing`);
  }
  assert.equal(document["x-memory-policy"], MEMORY_POLICY);
});

test("recall searches expose trace_id with a backwards-compatible request_id alias", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  assert.deepEqual(recallReference(id), { trace_id: id, request_id: id });

  const search = toolsFor(["open"]).find((tool) => tool.name === "search_thoughts");
  const report = toolsFor(["open"]).find((tool) => tool.name === "report_memory_usage");
  assert.match(search.description, /returned trace_id/i);
  assert.deepEqual(report.schema.required, ["trace_id"]);
});
