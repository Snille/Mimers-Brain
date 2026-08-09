import test from "node:test";
import assert from "node:assert/strict";

import {
  CAPTURE_GUIDANCE,
  OPEN_SCOPE,
  VAULT_SCOPE,
  applyReview,
  deriveSummary,
  deriveTitle,
  normaliseMeta,
} from "../memory-model.mjs";

test("derives a compact title and summary without losing the content", () => {
  const content = "# Home Assistant SSH\n\nUse the root account.\n\nLong incident history.";
  assert.equal(deriveTitle(content), "Home Assistant SSH");
  assert.equal(deriveSummary(content), "Use the root account.");
});

test("legacy replacement prose is omitted from display titles", () => {
  assert.equal(
    deriveTitle("ERIKS MUSIKSMAK — ERSÄTTER den tidigare posten och en annan notering."),
    "ERIKS MUSIKSMAK",
  );
  assert.equal(
    deriveTitle("Löst nuläge. KOMPLETTERAR id abcdef12 med slutresultatet."),
    "Löst nuläge.",
  );
});

test("normalises topic aliases and keeps the legacy type", () => {
  const meta = normaliseMeta({
    type: "task",
    topics: ["Token Tracker", "token-tracker", "Nätverk"],
  }, "Follow up the collector problem.");
  assert.equal(meta.kind, "task");
  assert.equal(meta.type, "task");
  assert.equal(meta.task_status, "pending");
  assert.deepEqual(meta.topics, ["tokentracker", "network"]);
});

test("keeps non-canonical detail without polluting the topic facet", () => {
  const meta = normaliseMeta({ topics: ["very specific device quirk"] }, "A useful detail.");
  assert.deepEqual(meta.topics, ["other"]);
  assert.deepEqual(meta.legacy_topics, ["very specific device quirk"]);
});

test("classifies Luba and Sleipner as systems, never people", () => {
  const meta = normaliseMeta({ people: ["Erik", "Luba"], systems: ["Home Assistant"] },
    "Luba is Erik's Mammotion mower and is named Sleipner in Home Assistant.");
  assert.deepEqual(meta.people, ["Erik"]);
  assert.deepEqual(meta.systems, ["Home Assistant", "Luba", "Sleipner"]);
});

test("non-task memories cannot carry a task status", () => {
  const meta = normaliseMeta({ kind: "procedure", task_status: "pending" }, "Deploy safely.");
  assert.equal(meta.task_status, undefined);
});

test("agent memories start as evidence while user-confirmed memories may instruct", () => {
  const inferred = normaliseMeta({}, "A model inferred this.", { origin: "agent" });
  assert.equal(inferred.origin, "agent");
  assert.equal(inferred.provenance, "inferred");
  assert.equal(inferred.review_status, "pending");
  assert.equal(inferred.can_use_as_instruction, false);
  assert.equal(inferred.requires_user_confirmation, true);

  const confirmed = normaliseMeta({}, "Erik confirmed this.", {
    origin: "agent", userConfirmed: true,
  });
  assert.equal(confirmed.provenance, "user_confirmed");
  assert.equal(confirmed.review_status, "confirmed");
  assert.equal(confirmed.can_use_as_instruction, true);
});

test("review actions deterministically control allowed use", () => {
  const pending = normaliseMeta({}, "Needs review.", { origin: "agent" });
  const confirmed = applyReview(pending, "confirm", { actor: "Erik", at: "2026-08-09T12:00:00Z" });
  assert.equal(confirmed.can_use_as_instruction, true);
  assert.equal(confirmed.reviewed_by, "Erik");

  const rejected = applyReview(pending, "reject");
  assert.equal(rejected.review_status, "rejected");
  assert.equal(rejected.lifecycle, "archived");
  assert.equal(rejected.can_use_as_evidence, false);
});

test("every public tool description forbids raw secret values", () => {
  for (const text of [CAPTURE_GUIDANCE, OPEN_SCOPE, VAULT_SCOPE]) {
    assert.match(text, /never store raw/i);
  }
  assert.doesNotMatch(VAULT_SCOPE, /vault \(keys, passwords, tokens\)/i);
});
