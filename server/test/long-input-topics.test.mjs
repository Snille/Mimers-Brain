import test from "node:test";
import assert from "node:assert/strict";

// lib.mjs reads OPENROUTER_API_KEY once, at module load, and returns a fixed
// fallback without it - so the key has to be set before the first import, which
// rules out a static one here.
process.env.OPENROUTER_API_KEY ||= "test-key";
process.env.META_URL = "http://localhost/never-called";
const lib = await import("../lib.mjs");

// Roughly the size of the two Swedish memories that came back as ["other"] on
// 2026-08-20: prose about Mimers Brain itself, with no shape a keyword rule
// could catch.
const LONG_SWEDISH_TEXT = (
  "Mimers Brain ar minnesservern som haller Eriks varaktiga kunskap. " +
  "Den kors i Docker pa LAN och exponerar bade en oppen niva och ett valv. " +
  "Extraktionen foreslar metadata, men servern ager ordforradet och validerar. "
).repeat(24);

async function promptFor(text) {
  let captured = "";
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init.body).messages[0].content;
    return { ok: true, json: async () => ({ choices: [{ message: { content: "{}" } }] }) };
  };
  try {
    await lib.extractMetadata(text);
  } finally {
    globalThis.fetch = realFetch;
  }
  return captured;
}

// supersede_thought has no length guard - capture refuses anything from
// SMART_INGEST_THRESHOLD characters upwards and routes it through
// preview_ingest, which yields short atoms - so it is the only write path that
// hands the extraction a body this size. The closed vocabulary must still be
// next to the decision at the end of it.
test("a long text keeps the topic vocabulary within reach of the answer", async () => {
  assert.ok(LONG_SWEDISH_TEXT.length > 3000, "the fixture must be a long input");
  const prompt = await promptFor(LONG_SWEDISH_TEXT);

  // The rule still opens the prompt.
  const ruleAt = prompt.indexOf("1-3 values chosen only from");
  const textAt = prompt.indexOf(LONG_SWEDISH_TEXT);
  assert.ok(ruleAt >= 0, "the topic rule must be in the prompt");
  assert.ok(textAt > ruleAt, "the topic rule must precede the text");

  // And it is restated after it, so "other" is read as a fallback rather than
  // as the twenty-sixth equal option.
  const reminderAt = prompt.lastIndexOf("the last resort");
  assert.ok(reminderAt > textAt, "the last-resort sentence must follow the text");
  assert.ok(
    prompt.length - reminderAt < 700,
    "the last-resort sentence must stay close to the end of the prompt",
  );

  // The subject of these two rows was in the vocabulary all along.
  assert.ok(prompt.slice(textAt).includes("mimers-brain"),
    "the closed list must be repeated after the text");

  // A long body must not be able to read as prompt text.
  assert.match(prompt, /<<<TEXT\n[\s\S]*\nTEXT>>>/);
});

// project was correct in both rows while topics was not, so the reminder spends
// its last line on that gap.
test("the reminder points project back at topics", () => {
  const reminder = lib.topicReminder();
  assert.match(reminder, /"other" is the last resort/);
  assert.match(reminder, /mimers-brain/);
  assert.match(reminder, /"project" names[\s\S]*belongs in "topics"/);
  assert.ok(!/other,/.test(lib.topicRule()), "other is never offered as a listed value");
});

// Short memories, which the 0.9.13 fix was validated on, take the same path.
test("a short text gets the same closing reminder", async () => {
  const prompt = await promptFor("Valv-appen startas om med docker compose up -d.");
  assert.ok(prompt.trimEnd().endsWith('that subject belongs in "topics".'));
});
