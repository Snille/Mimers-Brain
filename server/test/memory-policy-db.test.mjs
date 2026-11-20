import test from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, skipWithoutDatabase } from "../testing/db.mjs";

test("each instance keeps its own memory policy, and an empty text brings back the default", {
  skip: skipWithoutDatabase,
}, async () => {
  process.env.DATABASE_URL = await freshDatabase("test_memory_policy");
  const db = await import(new URL("../lib.mjs", import.meta.url));
  const policy = await import(new URL("../memory-policy.mjs", import.meta.url));
  const { SMART_INGEST_THRESHOLD } = await import(new URL("../memory-model.mjs", import.meta.url));
  const { buildServer } = await import(new URL("../mcp.mjs", import.meta.url));
  try {
    await db.ensureSchema();
    await policy.loadMemoryPolicy();
    assert.equal(policy.policySettings().custom.full, false);

    const own = "Policy for Alex.\r\nLong text over {smart_ingest_threshold} characters goes through preview_ingest.  ";
    const saved = await policy.saveMemoryPolicy({ full: own });
    assert.equal(saved.custom.full, true);
    assert.equal(saved.custom.short, false, "a field left out keeps its value");
    assert.equal(saved.full, "Policy for Alex.\nLong text over {smart_ingest_threshold} characters goes through preview_ingest.");
    assert.equal(policy.memoryPolicy(), `Policy for Alex.\nLong text over ${SMART_INGEST_THRESHOLD} characters goes through preview_ingest.`);

    await policy.saveMemoryPolicy({ short: "Call memory_digest first. Alex's rules." });
    assert.match(buildServer(["open"]).server._instructions, /^Call memory_digest first\. Alex's rules\./);

    // After a restart the stored text is back.
    await policy.loadMemoryPolicy();
    assert.match(policy.memoryPolicy(), /^Policy for Alex\./);

    // Saving the default text is the same as going back to it.
    const back = await policy.saveMemoryPolicy({ full: "", short: policy.DEFAULT_SESSION_POLICY });
    assert.deepEqual(back.custom, { full: false, short: false });
    assert.equal(JSON.parse(await db.getSetting("memory_policy")).full, null);
  } finally {
    await db.pool.end();
  }
});
