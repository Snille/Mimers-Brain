import test from "node:test";
import assert from "node:assert/strict";

const KEYS = ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "OLLAMA_URL", "CUSTOM_AI_URL", "CUSTOM_AI_KEY",
  "EMBED_URL", "META_URL", "EMBED_MODEL", "META_MODEL", "CONTRADICTION_MODEL"];

async function fresh(env) {
  const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, env);
  const ai = await import(new URL(`../ai.mjs?t=${Date.now()}-${Math.random()}`, import.meta.url));
  return { ai, restore: () => { for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  } } };
}

test("roles default to the environment, and stored choices win", async () => {
  const { ai, restore } = await fresh({ OPENROUTER_API_KEY: "or-test", OLLAMA_URL: "http://192.0.2.5:11434" });
  try {
    assert.deepEqual(
      Object.fromEntries(ai.ROLES.map((name) => [name, [ai.role(name).provider, ai.role(name).model]])),
      {
        embedding: ["openrouter", "openai/text-embedding-3-small"],
        metadata: ["openrouter", "openai/gpt-4o-mini"],
        contradiction: ["openrouter", "qwen/qwen3-235b-a22b-2507"],
      });
    const byId = Object.fromEntries(ai.providers().map((p) => [p.id, p]));
    assert.equal(byId.openrouter.configured, true);
    assert.equal(byId.openai.configured, false, "no key, no choice");
    assert.equal(byId.ollama.configured, true, "Ollama needs only an address");
    assert.equal(byId.ollama.base, "http://192.0.2.5:11434/v1");
    assert.equal(byId.custom.configured, false);

    ai.applyStored({ metadata: { provider: "ollama", model: "llama3.1" } }, { dimensions: 1024 });
    assert.equal(ai.role("metadata").model, "llama3.1");
    assert.equal(ai.role("metadata").source, "settings");
    assert.equal(ai.role("embedding").dimensions, 1024, "the column decides the dimensions");
    assert.equal(ai.role("contradiction").source, "environment");
  } finally { restore(); }
});

test("an old .env pointing META_URL elsewhere keeps working", async () => {
  const { ai, restore } = await fresh({
    OPENROUTER_API_KEY: "k", META_URL: "http://192.0.2.9:8000/v1/chat/completions", META_MODEL: "local-model",
  });
  try {
    assert.equal(ai.role("metadata").provider, "env-chat");
    assert.equal(ai.role("contradiction").model, "local-model", "no OpenRouter, so no OpenRouter model id");
    assert.equal(ai.provider("env-chat").base, "http://192.0.2.9:8000/v1");
    assert.equal(ai.role("embedding").provider, "openrouter");
  } finally { restore(); }
});

test("chat answers in a code fence still parse, and model lists carry prices", async () => {
  const { ai, restore } = await fresh({ OPENROUTER_API_KEY: "k", OPENAI_API_KEY: "o" });
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, auth: init?.headers?.Authorization });
    if (String(url).endsWith("/chat/completions"))
      return new Response(JSON.stringify({ choices: [{ message: { content: '```json\n{"ok": true}\n```' } }] }));
    if (String(url).endsWith("/embeddings/models"))
      return new Response(JSON.stringify({ data: [{ id: "baai/bge-m3", pricing: { prompt: "0.00000001" } }] }));
    return new Response(JSON.stringify({ data: [{ id: "gpt-4.1-mini" }, { id: "text-embedding-3-large" }, { id: "whisper-1" }] }));
  };
  try {
    const tested = await ai.testRole("metadata", { provider: "openrouter", model: "x" });
    assert.equal(tested.ok, true);
    assert.equal(typeof tested.ms, "number");
    const [bge] = await ai.listModels("openrouter", "embedding");
    assert.equal(bge.id, "baai/bge-m3");
    assert.ok(Math.abs(bge.price_in - 0.01) < 1e-9, "per million tokens");
    assert.deepEqual((await ai.listModels("openai", "embedding")).map((m) => m.id), ["text-embedding-3-large"]);
    assert.deepEqual((await ai.listModels("openai", "chat")).map((m) => m.id), ["gpt-4.1-mini"]);
    assert.ok(calls.some((c) => c.url === "https://api.openai.com/v1/models" && c.auth === "Bearer o"));
    await assert.rejects(ai.listModels("custom", "chat"), /not configured/);
  } finally {
    globalThis.fetch = realFetch;
    restore();
  }
});
