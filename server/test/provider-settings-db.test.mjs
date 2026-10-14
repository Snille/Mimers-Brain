import test from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, skipWithoutDatabase } from "../testing/db.mjs";

test("a key typed into the web UI is sealed, never shown, and checked before it is kept", {
  skip: skipWithoutDatabase,
}, async () => {
  process.env.DATABASE_URL = await freshDatabase("test_provider_settings");
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.SETTINGS_KEY = "a-long-random-settings-key-for-tests";
  const savedOpenAi = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.OLLAMA_URL;
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization });
    if (init?.headers?.Authorization === "Bearer sk-wrong-123456")
      return new Response('{"error":{"message":"Incorrect API key provided: sk-wrong-123456"}}', { status: 401 });
    return new Response(JSON.stringify({ data: [{ id: "gpt-4.1-mini" }] }));
  };
  const db = await import(new URL(`../lib.mjs?providers=${Date.now()}`, import.meta.url));
  const models = await import(new URL(`../model-settings.mjs?providers=${Date.now()}`, import.meta.url));
  const ai = await import(new URL("../ai.mjs", import.meta.url));
  const storedText = async () => (await db.getSetting("ai_providers")) || "";

  try {
    await db.ensureSchema();
    await models.loadModelSettings();
    assert.equal(ai.provider("openai").configured, false);

    const saved = await models.saveProvider("openai", { key: "sk-test-openai-123456" });
    assert.equal(saved.configured, true);
    assert.equal(saved.keySource, "settings");
    assert.ok(calls.some((c) => c.url === "https://api.openai.com/v1/models" && c.auth === "Bearer sk-test-openai-123456"),
      "the key was tried before it was kept");
    assert.doesNotMatch(await storedText(), /sk-test-openai/, "the database holds only ciphertext");
    assert.equal(ai.provider("openai").key, "sk-test-openai-123456", "the server can use it");

    const view = JSON.stringify(await models.modelSettings());
    assert.doesNotMatch(view, /sk-test-openai/);
    assert.doesNotMatch(view, /"key"\s*:/, "the card is never sent a key field");
    assert.equal(JSON.parse(view).canStoreKeys, true);

    // A wrong key is refused, and the stored one stays.
    await assert.rejects(models.saveProvider("openai", { key: "sk-wrong-123456" }), (error) =>
      /did not answer/.test(error.message) && !error.message.includes("sk-wrong"));
    assert.equal(ai.provider("openai").key, "sk-test-openai-123456");

    // Addresses are plain settings; Ollama gets its /v1.
    await models.saveProvider("ollama", { url: "http://192.0.2.5:11434" });
    assert.equal(ai.provider("ollama").base, "http://192.0.2.5:11434/v1");
    assert.equal(ai.provider("ollama").configured, true);
    await assert.rejects(models.saveProvider("ollama", { url: "192.0.2.5:11434" }), /http/);
    await assert.rejects(models.saveProvider("openrouter", { url: "http://elsewhere" }).then(() => {
      if (ai.provider("openrouter").base !== "https://openrouter.ai/api/v1") throw new Error("moved");
      throw new Error("ignored");
    }), /ignored/, "OpenRouter's address is not editable");

    // A different SETTINGS_KEY cannot open what the old one sealed.
    process.env.SETTINGS_KEY = "another-key";
    await models.loadModelSettings();
    assert.equal(ai.provider("openai").configured, false);
    assert.equal(ai.provider("openai").keyUnreadable, true);
    process.env.SETTINGS_KEY = "a-long-random-settings-key-for-tests";
    await models.loadModelSettings();
    assert.equal(ai.provider("openai").configured, true);

    // Clearing brings back whatever .env says - here, nothing.
    await models.saveProvider("openai", { clear: ["key"] });
    assert.equal(ai.provider("openai").configured, false);
    assert.doesNotMatch(await storedText(), /openai/);

    // Without SETTINGS_KEY a key cannot be stored, but an address can.
    delete process.env.SETTINGS_KEY;
    await assert.rejects(models.saveProvider("openai", { key: "sk-test-openai-123456" }), /SETTINGS_KEY/);
    assert.equal((await models.modelSettings()).canStoreKeys, false);
  } finally {
    globalThis.fetch = realFetch;
    if (savedOpenAi !== undefined) process.env.OPENAI_API_KEY = savedOpenAi;
    await db.pool.end();
  }
});
