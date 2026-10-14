// Providers and models, in one place.
//
// Three jobs call a model: embedding (search and every save), metadata (title,
// summary and facets on save) and contradiction (the nightly pair check). Each
// is a *role* with a provider and a model. The defaults come from the
// environment, so an installation that never opens the Models card behaves
// exactly as before; a choice made on that card is stored in app_settings and
// wins over the environment.
//
// API keys never leave the environment. The card can choose among providers
// that have a key, never type one in: a key in app_settings would sit in every
// pg_dump, which is exactly where the secret store rule says it must not be.
//
// Every provider speaks the OpenAI wire format - /embeddings, /chat/completions
// and /models under one base URL - which OpenRouter, OpenAI, Ollama and most
// self-hosted servers do.

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
export const ROLES = ["embedding", "metadata", "contradiction"];

// OpenRouter attributes spend by these two headers and lists the request as
// "Unknown" without them. Harmless to send to any other OpenAI-compatible API.
const APP_NAME = process.env.APP_NAME || "Mimers Brain";
const APP_URL = process.env.APP_URL || "https://github.com/Snille/Mimers-Brain";

const trimSlash = (url) => String(url || "").trim().replace(/\/+$/, "");
const stripTail = (url, tail) => trimSlash(url).replace(new RegExp(`/${tail}$`), "");

// EMBED_URL and META_URL predate providers and name a whole endpoint. One that
// points anywhere but OpenRouter becomes a provider of its own, keyed with
// OPENROUTER_API_KEY as it always was, so an old .env keeps working unchanged.
function legacyBase(variable, tail) {
  const raw = process.env[variable];
  if (!raw) return null;
  const base = stripTail(raw, tail);
  return base === OPENROUTER_BASE ? null : base;
}

export function providers() {
  const list = [
    { id: "openrouter", label: "OpenRouter", base: OPENROUTER_BASE,
      key: process.env.OPENROUTER_API_KEY || "", keyName: "OPENROUTER_API_KEY" },
    { id: "openai", label: "OpenAI", base: "https://api.openai.com/v1",
      key: process.env.OPENAI_API_KEY || "", keyName: "OPENAI_API_KEY" },
  ];
  // Ollama needs no key, only an address. Its OpenAI-compatible API lives
  // under /v1, which is easy to leave off when typing the address.
  const ollama = trimSlash(process.env.OLLAMA_URL);
  list.push({ id: "ollama", label: "Ollama", base: ollama ? (ollama.endsWith("/v1") ? ollama : `${ollama}/v1`) : "",
    key: "", keyName: "OLLAMA_URL", keyless: true });
  list.push({ id: "custom", label: process.env.CUSTOM_AI_NAME || "Custom", base: trimSlash(process.env.CUSTOM_AI_URL),
    key: process.env.CUSTOM_AI_KEY || "", keyName: "CUSTOM_AI_URL", keyless: true });

  const chat = legacyBase("META_URL", "chat/completions");
  const embed = legacyBase("EMBED_URL", "embeddings");
  if (chat) list.push({ id: "env-chat", label: new URL(chat).host, base: chat,
    key: process.env.OPENROUTER_API_KEY || "", keyName: "META_URL", keyless: true });
  if (embed && embed !== chat) list.push({ id: "env-embed", label: new URL(embed).host, base: embed,
    key: process.env.OPENROUTER_API_KEY || "", keyName: "EMBED_URL", keyless: true });

  for (const p of list) p.configured = Boolean(p.base && (p.key || p.keyless));
  return list;
}

export const provider = (id) => providers().find((p) => p.id === id) || null;

function defaults() {
  const chatProvider = legacyBase("META_URL", "chat/completions") ? "env-chat" : "openrouter";
  const embedBase = legacyBase("EMBED_URL", "embeddings");
  const embedProvider = !embedBase ? "openrouter"
    : embedBase === legacyBase("META_URL", "chat/completions") ? "env-chat" : "env-embed";
  const metaModel = process.env.META_MODEL || "openai/gpt-4o-mini";
  return {
    embedding: { provider: embedProvider, model: process.env.EMBED_MODEL || "openai/text-embedding-3-small", dimensions: 1536 },
    metadata: { provider: chatProvider, model: metaModel },
    // See CONTRADICTION_MODEL's history in lib.mjs: gpt-4o-mini raised nine
    // false alarms in sixteen pairs where Qwen3-235B raised none.
    contradiction: { provider: chatProvider,
      model: process.env.CONTRADICTION_MODEL || (chatProvider === "openrouter" ? "qwen/qwen3-235b-a22b-2507" : metaModel) },
  };
}

// What the server runs with right now. Starts from the environment and takes
// the stored choices once applyStored() has read them; synchronous on purpose,
// since every save and search asks.
let stored = {};
let embeddingDimensions = null;

export function applyStored(value, { dimensions } = {}) {
  stored = value && typeof value === "object" ? value : {};
  if (dimensions) embeddingDimensions = dimensions;
}

export function role(name) {
  const base = defaults()[name];
  if (!base) throw new Error(`Unknown model role "${name}"`);
  const chosen = stored[name] || {};
  const out = { ...base, ...chosen, source: stored[name] ? "settings" : "environment" };
  if (name === "embedding" && embeddingDimensions) out.dimensions = embeddingDimensions;
  return out;
}

export function roleReady(name) {
  return Boolean(provider(role(name).provider)?.configured);
}

export function headers(p) {
  const h = { "Content-Type": "application/json" };
  if (p.key) h.Authorization = `Bearer ${p.key}`;
  if (p.id === "openrouter") Object.assign(h, { "HTTP-Referer": APP_URL, "X-Title": APP_NAME });
  return h;
}

// One request, any role. `cfg` is a role-shaped { provider, model } - the live
// role by default, or a candidate being tested before it is saved.
export async function embedInputs(input, cfg = role("embedding")) {
  const p = provider(cfg.provider);
  if (!p?.configured) throw new Error(`Provider "${cfg.provider}" is not configured`);
  const r = await fetch(`${p.base}/embeddings`, {
    method: "POST", headers: headers(p), body: JSON.stringify({ model: cfg.model, input }),
  });
  if (!r.ok) throw new Error(`Embedding failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const data = (await r.json()).data || [];
  // The API may answer out of order; `index` is what ties a vector to its input.
  return data.slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((row) => row.embedding);
}

export async function chatJson(cfg, content, { temperature } = {}) {
  const p = provider(cfg.provider);
  if (!p?.configured) throw new Error(`Provider "${cfg.provider}" is not configured`);
  const r = await fetch(`${p.base}/chat/completions`, {
    method: "POST",
    headers: headers(p),
    body: JSON.stringify({
      model: cfg.model,
      response_format: { type: "json_object" },
      ...(temperature == null ? {} : { temperature }),
      messages: [{ role: "user", content }],
    }),
  });
  if (!r.ok) throw new Error(`${cfg.model} failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  // Some providers wrap the JSON in a code fence even when asked not to.
  const raw = String((await r.json()).choices?.[0]?.message?.content || "")
    .trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  return JSON.parse(raw);
}

// The model list for one provider, for the picker on the Models card. Prices
// are per million tokens when the provider publishes them (OpenRouter does),
// and absent otherwise. `kind` separates embedding models from chat models
// where the provider can tell them apart; elsewhere every model is offered.
export async function listModels(id, kind) {
  const p = provider(id);
  if (!p?.configured) throw new Error(`Provider "${id}" is not configured`);
  const url = p.id === "openrouter" && kind === "embedding" ? `${p.base}/embeddings/models` : `${p.base}/models`;
  const r = await fetch(url, { headers: headers(p) });
  if (!r.ok) throw new Error(`Listing models failed: ${r.status}`);
  const body = await r.json();
  const rows = Array.isArray(body) ? body : body.data || body.models || [];
  const perMillion = (value) => (value == null || value === "" ? null : Number(value) * 1e6);
  let models = rows.map((m) => ({
    id: m.id || m.name,
    price_in: perMillion(m.pricing?.prompt),
    price_out: perMillion(m.pricing?.completion),
    context: m.context_length || null,
  })).filter((m) => m.id);
  if (p.id === "openai") {
    const embedding = (m) => /embed/i.test(m.id);
    const other = (m) => /tts|whisper|dall-e|image|audio|realtime|moderation|transcribe/i.test(m.id);
    models = models.filter((m) => (kind === "embedding" ? embedding(m) : !embedding(m) && !other(m)));
  }
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

// A small real call, so a choice is known to work before it is saved.
export async function testRole(name, cfg) {
  const t0 = Date.now();
  if (name === "embedding") {
    const [vector] = await embedInputs("Mimers Brain", cfg);
    if (!Array.isArray(vector) || !vector.length) throw new Error("The model returned no vector");
    return { ok: true, ms: Date.now() - t0, dimensions: vector.length };
  }
  const out = await chatJson(cfg, 'Return the JSON object {"ok": true} and nothing else.', { temperature: 0 });
  if (out?.ok !== true) throw new Error("The model did not return the requested JSON");
  return { ok: true, ms: Date.now() - t0 };
}
