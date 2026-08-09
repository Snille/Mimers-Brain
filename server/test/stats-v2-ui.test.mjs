import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("statistics v2 presents health, recall, activity and operations separately", async () => {
  const source = await readFile(new URL("../public/stats.mjs", import.meta.url), "utf8");
  for (const section of ["sections.health", "sections.recall", "sections.activity", "sections.operations"])
    assert.match(source, new RegExp(section.replace(".", "\\.")));
  assert.match(source, /memoryHealth/);
  assert.match(source, /reportedReturned/);
  assert.match(source, /keys: \["active", "inactive"\]/);
  assert.doesNotMatch(source, /newMemoriesPerDay/);
});

test("both languages explain that pre-receipt calls are not missing reports", async () => {
  for (const language of ["en", "sv"]) {
    const messages = JSON.parse(await readFile(new URL(`../public/lang/${language}.json`, import.meta.url), "utf8"));
    assert.ok(messages.stats.sections.health.title);
    assert.ok(messages.stats.kpi.receiptCoverage);
    assert.match(messages.stats.recall.since, language === "sv" ? /Äldre anrop/ : /Earlier calls/);
  }
});
