import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SecretRefused, findSecret, refuseSecrets } from "../secret-gate.mjs";
import { ageNote } from "../memory-model.mjs";

// Built from parts so this file never holds a string that looks like a live
// credential to a scanner.
const fake = (...parts) => parts.join("");

test("credential shapes are refused, wherever they hide", () => {
  const cases = {
    "private-key": fake("-----BEGIN OPENSSH ", "PRIVATE KEY-----\nabc"),
    "aws-access-key": fake("AKIA", "IOSFODNN7EXAMPLQ"),
    "api-key": fake("sk-or-v1-", "a".repeat(10), "1234567890abcdef"),
    "github-token": fake("ghp_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"),
    "slack-token": fake("xoxb-", "1234567890-abcdef"),
    "google-api-key": fake("AIza", "SyD1234567890abcdefghijklmnopqrstuv"),
    "brave-api-key": fake("BSA", "abcdefghij1234567890XY"),
    jwt: fake("eyJ", "hbGciOiJIUzI1NiJ9", ".eyJ", "zdWIiOiIxMjM0NTY3ODkwIn0", ".", "dozjgNryP4J3jVmNHl0w5N"),
    "url-credentials": fake("postgres://mimer:", "Hunter2pass", "@db:5432/valv"),
    "password-assignment": fake("password", ": Tr0ub4dor&3"),
  };
  for (const [kind, text] of Object.entries(cases))
    assert.equal(findSecret(`Note: ${text} end`), kind, kind);
  assert.equal(findSecret("ok", { title: "t", source_refs: [cases["api-key"]] }), "api-key");
  assert.equal(findSecret("lösenord = Sommar2026!"), "password-assignment");
});

test("pointers, placeholders and names for secrets pass", () => {
  for (const text of [
    "The key lives in C:\\Users\\eripet\\Coding\\_secrets_\\mimers-brain\\.env as OPENROUTER_API_KEY.",
    "SECRET_REF: _secrets_/home-assistant/token.txt",
    "token: ${HA_TOKEN}",
    "api_key=<your key here>",
    "password: ********",
    "password: required",
    "Set MCP_OPEN_KEY to a long random string.",
    "The token endpoint is /auth/token and the password field is optional.",
    "api_key=OPENROUTER_API_KEY",
    "secret: secrets.env",
    "Brave Search API (BSA) costs nothing below 2000 queries.",
  ]) assert.equal(findSecret(text), null, text);
});

test("a refusal names the kind and never the value", () => {
  const value = fake("sk-ant-", "api03-", "Z".repeat(30));
  assert.throws(() => refuseSecrets(`key ${value}`), (error) => {
    assert.ok(error instanceof SecretRefused);
    assert.equal(error.status, 422);
    assert.equal(error.kind, "api-key");
    assert.ok(!error.message.includes(value.slice(8)));
    return true;
  });
});

test("every write path runs the gate before anything leaves the house", async () => {
  const source = await readFile(new URL("../lib.mjs", import.meta.url), "utf8");
  const body = (name) => source.slice(source.indexOf(`export async function ${name}(`)).split("\nexport ")[0];
  assert.ok(body("captureThought").indexOf("refuseSecrets") < body("captureThought").indexOf("extractMetadata"));
  assert.ok(body("previewIngest").indexOf("refuseSecrets") < body("previewIngest").indexOf("extractAtoms"));
  assert.ok(body("applyIngest").indexOf("refuseSecrets") < body("applyIngest").indexOf("INSERT INTO thoughts"));
  assert.ok(body("updateThought").indexOf("refuseSecrets") < body("updateThought").indexOf("embed("));
  assert.match(body("resolveDuplicate"), /refuseSecrets\(merged_content\)/);
});

test("old memories carry an age note, history and incidents do not", () => {
  const now = new Date("2026-10-13T12:00:00Z");
  assert.equal(ageNote({ kind: "fact", verified_at: "2026-09-01" }, null, now), null);
  assert.match(ageNote({ kind: "fact", verified_at: "2026-02-01" }, null, now),
    /^Verified 8 months ago \(2026-02-01\) - may be outdated/);
  assert.match(ageNote({ kind: "procedure" }, "2025-09-01T00:00:00Z", now), /^Written 13 months ago/);
  assert.match(ageNote({ kind: "fact" }, "2024-01-01T00:00:00Z", now), /^Written 2 years ago/);
  assert.equal(ageNote({ kind: "incident" }, "2025-01-01T00:00:00Z", now), null);
  assert.equal(ageNote({ kind: "fact", lifecycle: "superseded" }, "2025-01-01T00:00:00Z", now), null);
  assert.equal(ageNote({ kind: "fact", verified_at: "not a date" }, null, now), null);
});

test("receipts nudge ranking and feed the review list", async () => {
  const source = await readFile(new URL("../lib.mjs", import.meta.url), "utf8");
  assert.match(source, /usefulness \* \$\{w\("usefulness"\)\}\s+AS rank_score/);
  const { RANK_WEIGHTS } = await import("../lib.mjs");
  assert.equal(RANK_WEIGHTS.usefulness, 1);
  assert.match(source, /export async function rarelyUseful/);
  for (const language of ["en", "sv"]) {
    const messages = JSON.parse(await readFile(new URL(`../public/lang/${language}.json`, import.meta.url), "utf8"));
    assert.ok(messages.review.rarelyUseful.title);
    assert.match(messages.review.rarelyUseful.count, /\{count\}/);
  }
});
