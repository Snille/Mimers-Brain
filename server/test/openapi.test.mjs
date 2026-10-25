import test from "node:test";
import assert from "node:assert/strict";

import { spec, toolsFor } from "../openapi.mjs";
import { MEMORY_POLICY, SMART_INGEST_THRESHOLD, normaliseMeta } from "../memory-model.mjs";
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
  for (const name of ["list_contradictions", "dismiss_contradiction", "list_duplicates", "resolve_duplicate"]) {
    assert.equal(openNames.includes(name), false, name);
    assert.equal(fullNames.includes(name), true, name);
  }
  for (const name of ["preview_ingest", "apply_ingest", "report_memory_usage"])
    assert.equal(openNames.includes(name), true);

  const captureOpen = open.find((tool) => tool.name === "capture_thought");
  assert.deepEqual(captureOpen.schema.properties.tier.enum, ["open"]);
  assert.equal(captureOpen.schema.properties.user_confirmed.default, false);
  assert.ok(captureOpen.schema.properties.source_refs);
  assert.ok(captureOpen.schema.properties.artifact_refs);
  assert.equal(captureOpen.schema.properties.title.maxLength, 100);
  assert.equal(captureOpen.schema.required.includes("title"), false);
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
  const reference = recallReference(id);
  assert.equal(reference.trace_id, id);
  assert.equal(reference.request_id, id);
  assert.equal(reference.receipt_required, true);
  assert.match(reference.receipt_instruction, /every search separately/i);
  assert.deepEqual(recallReference(null), {
    trace_id: null,
    request_id: null,
    receipt_required: false,
    receipt_instruction: null,
  });

  const search = toolsFor(["open"]).find((tool) => tool.name === "search_thoughts");
  const report = toolsFor(["open"]).find((tool) => tool.name === "report_memory_usage");
  assert.match(search.description, /every non-empty search/i);
  assert.match(report.description, /multiple searches need separate reports/i);
  assert.deepEqual(report.schema.required, ["trace_id"]);
});

test("supersede cannot bypass atomic ingest for long replacement text", async () => {
  const supersede = toolsFor(["open", "vault"]).find((tool) => tool.name === "supersede_thought");
  await assert.rejects(
    supersede.run({
      old_ids: ["123e4567-e89b-12d3-a456-426614174000"],
      content: "x".repeat(SMART_INGEST_THRESHOLD),
    }),
    /Long replacement text must be split into atomic memories below 1200 characters/,
  );
});

test("supersede accepts a caller-chosen title, still held to the content", () => {
  const supersede = toolsFor(["open", "vault"]).find((tool) => tool.name === "supersede_thought");
  assert.equal(supersede.schema.properties.title.type, "string");
  assert.equal(supersede.schema.properties.title.maxLength, 100);
  assert.equal(supersede.schema.required.includes("title"), false);

  // The case that prompted it: a replacement kept the subject, but the server
  // renamed it. The old title describes the new text and must survive.
  const content = "Fälla på OmniRoute-LXC:n omniroute01 (10.0.0.42): omniroute-CLI:t läser inte " +
    "samma env som systemd-tjänsten. Tjänsten kör med DATA_DIR=/opt/omniroute, men CLI:t utgår " +
    "från /root/.omniroute/. Åtgärden är att /root/.omniroute/.env är en symlänk till " +
    "/opt/omniroute/.env, så CLI:t och tjänsten delar samma .env och samma nyckel.";
  const kept = "OmniRoute-LXC:n (10.0.0.42): CLI:t och tjänsten måste dela samma .env";
  assert.equal(normaliseMeta({ title: kept }, content).title, kept);
  // A title from another memory is not let through just because a caller chose it.
  assert.notEqual(normaliseMeta({ title: "Glance Clock: release med gh --repo Snille/glance_clock_ha" }, content).title,
    "Glance Clock: release med gh --repo Snille/glance_clock_ha");
});
