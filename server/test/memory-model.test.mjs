import test from "node:test";
import assert from "node:assert/strict";

import {
  CAPTURE_GUIDANCE,
  OPEN_SCOPE,
  VAULT_SCOPE,
  applyReview,
  deriveSummary,
  deriveTitle,
  describesContent,
  memoryFreshness,
  normaliseMeta,
  resolvePeople,
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

test("fetch freshness tells clients to follow a superseded memory before reading long content", () => {
  assert.deepEqual(memoryFreshness({ lifecycle: "current" }), {
    lifecycle: "current",
    superseded_by: null,
    is_current: true,
    freshness_instruction: null,
  });
  assert.deepEqual(memoryFreshness({
    lifecycle: "superseded",
    superseded_by: "2fe69676-0862-4256-9e37-5ea87655f769",
  }), {
    lifecycle: "superseded",
    superseded_by: "2fe69676-0862-4256-9e37-5ea87655f769",
    is_current: false,
    freshness_instruction: "Historical memory: fetch superseded_by before treating this as current knowledge.",
  });
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

test("tools and services proposed as people are moved to the systems facet", () => {
  const content = "Claude Code and Mimers Brain are two different MCP clients that Erik runs.";
  const meta = normaliseMeta(
    { people: ["Erik", "Claude Code", "Mimers Brain", "Snille"], systems: ["Docker"] },
    content,
  );
  assert.deepEqual(meta.people, ["Erik"]);
  assert.deepEqual(meta.systems, ["Docker", "Claude Code", "Mimers Brain", "Snille"]);
});

test("a name invented from prose never reaches the people facet", () => {
  // "Erik Bildmak" was extracted out of the Swedish phrase "Eriks bildsmak".
  const content = "ERIKS BILDSMAK för YouTube-kanalen: DIY-elektronik, inte polerade produktbilder.";
  const meta = normaliseMeta({ people: ["Erik Bildmak"] }, content);
  assert.deepEqual(meta.people, []);
});

test("a real name written in the memory survives even when it is unknown", () => {
  const content = "Anna Svensson på Spectrogon äger mätriggen och bokar tid i den.";
  const meta = normaliseMeta({ people: ["Anna Svensson"] }, content);
  assert.deepEqual(meta.people, ["Anna Svensson"]);
});

test("relationship labels are stored as the actual name", () => {
  const { people } = resolvePeople(["Eriks dotter", "Erik's brother"], [], "");
  assert.deepEqual(people, ["Louise", "Timo"]);
});

test("a name indexed as a system in the same memory is not also a person", () => {
  const { people, systems } = resolvePeople(["Sonos"], ["Sonos"], "Sonos speakers went unavailable.");
  assert.deepEqual(people, []);
  assert.deepEqual(systems, ["Sonos"]);
});

test("a title and summary about a different text are replaced by derived ones", () => {
  const content = [
    "SÅ ANVÄNDS PEOPLE- OCH SYSTEMS-FACETTERNA I MIMERS BRAIN.",
    "",
    "People är reserverat för människor och ska aldrig innehålla namngivna tekniska enheter.",
  ].join("\n");
  const meta = normaliseMeta({
    title: "Mäta och optimera Wi-Fi-nätverket hemma",
    summary: "Chatt om strategier för att förbättra täckning och hastighet med mesh.",
  }, content);
  assert.equal(meta.title, "SÅ ANVÄNDS PEOPLE- OCH SYSTEMS-FACETTERNA I MIMERS BRAIN.");
  assert.match(meta.summary, /^People är reserverat/);
});

test("a faithful title and summary are kept exactly as proposed", () => {
  const content = [
    "SÅ ANVÄNDS PEOPLE- OCH SYSTEMS-FACETTERNA I MIMERS BRAIN.",
    "",
    "People är reserverat för människor och ska aldrig innehålla namngivna tekniska enheter.",
  ].join("\n");
  const meta = normaliseMeta({
    title: "People-facetten i Mimers Brain",
    summary: "People är reserverat för människor; tekniska enheter hör under systems.",
  }, content);
  assert.equal(meta.title, "People-facetten i Mimers Brain");
  assert.match(meta.summary, /tekniska enheter/);
});

test("short content gives no signal, so proposed metadata is trusted", () => {
  assert.equal(describesContent("Anything at all here", "Too short."), true);
});

test("a faithful summary in the other language is kept, because anchors survive translation", () => {
  const content = [
    "Eriks ESPHome-miljö. Repot C:\\Users\\eripet\\Coding\\ESPHome redigeras på Windows.",
    "",
    "WSL2 (Ubuntu-24.04) är byggvägen för allt som ska hamna på hårdvara, och Docker är reservvägen.",
  ].join("\n");
  const english = "This document outlines the best practices for building and flashing devices"
    + " in an ESPHome environment using WSL2 and Docker.";
  assert.equal(describesContent(english, content), true);

  const meta = normaliseMeta({ summary: english }, content);
  assert.equal(meta.summary, english);
});

test("an English summary of a Swedish memory is trusted even without a shared name", () => {
  const content = [
    "EN NOTIS TAR SLOT 0 — andra slots överlever. Verifierat mot hårdvara.",
    "",
    "Håll egna scener borta från slot 0, eftersom scenen där förstörs och inte kommer tillbaka.",
  ].join("\n");
  const english = "Testing revealed that only the first slot is destroyed by notifications,"
    + " and that a decision was made not to implement a cache for this.";
  assert.equal(describesContent(english, content), true);
});

test("a hyphenated name matches the content it was split from", () => {
  const content = "Eriks ESPHome-miljö byggs i WSL2 och redigeras på Windows-laptopen.";
  assert.equal(
    describesContent("Eriks ESPHome-setup: best practices for flashing devices", content),
    true,
  );
});

test("a summary whose anchors are absent belongs to another text", () => {
  const content = [
    "Eriks ESPHome-miljö. Repot redigeras på Windows.",
    "",
    "WSL2 är byggvägen för allt som ska hamna på hårdvara.",
  ].join("\n");
  const foreign = "Chatt om strategier för att förbättra Wi-Fi-täckning hemma, inklusive mesh-system.";
  assert.equal(describesContent(foreign, content), false);
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
