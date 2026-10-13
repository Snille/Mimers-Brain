import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { MEMORY_POLICY, SESSION_POLICY } from "../memory-model.mjs";
import { buildServer } from "../mcp.mjs";
import { toolsFor } from "../openapi.mjs";

const source = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("every model is told to read the digest, on every listener", () => {
  assert.match(MEMORY_POLICY, /call memory_digest once/);
  for (const [tiers, writable] of [[["open", "vault"], true], [["open"], true], [["open"], false]]) {
    const names = Object.keys(buildServer(tiers, { writable })._registeredTools || {});
    assert.ok(names.includes("memory_digest"), `${tiers} writable=${writable}`);
    assert.ok(toolsFor(tiers, {}, { writable }).some((tool) => tool.name === "memory_digest" && tool.action === "read"));
  }
});

test("every client sees the whole short policy, and the digest carries the full one", async () => {
  // Claude Code cuts MCP server instructions at 2048 characters.
  for (const [tiers, writable] of [[["open", "vault"], true], [["open"], true], [["open"], false]]) {
    const instructions = buildServer(tiers, { writable }).server._instructions;
    assert.ok(instructions.length < 2048, `${tiers} writable=${writable}: ${instructions.length}`);
    assert.match(instructions, /^Mimers Brain usage policy/);
    assert.match(instructions, /call memory_digest once/);
  }
  assert.match(SESSION_POLICY, /report_memory_usage/);
  assert.match(SESSION_POLICY, /never raw secrets/);
  const mcp = await source("../mcp.mjs");
  assert.match(mcp, /const policy = `\$\{MEMORY_POLICY\}/);
  const digest = toolsFor(["open"]).find((tool) => tool.name === "memory_digest");
  assert.match(digest.run.toString(), /policy: MEMORY_POLICY/);
});

test("only the reader can put a memory in the digest", async () => {
  const lib = await source("../lib.mjs");
  const capture = lib.slice(lib.indexOf("export async function captureThought("));
  assert.match(capture.slice(0, capture.indexOf("normaliseMeta(")), /"captured_by", "pinned",?\s*\]\) delete proposed\[field\]/);
  const rule = lib.slice(lib.indexOf("const DIGEST_SQL = `"), lib.indexOf("`;", lib.indexOf("const DIGEST_SQL = `")));
  assert.match(rule, /review_status', 'confirmed'\) = 'confirmed'/);
  assert.match(rule, /can_use_as_instruction', 'true'\) = 'true'/);
  assert.match(rule, /lifecycle', 'current'\) = 'current'/);
  // One rule for the digest itself, the Thoughts filter and the sidebar count.
  assert.match(lib.slice(lib.indexOf("export async function memoryDigest(")), /AND \$\{DIGEST_SQL\}/);
  assert.equal(lib.match(/\$\{DIGEST_SQL\}/g).length, 4);
});

test("the Thoughts page and the server agree on what is in the digest", async () => {
  const lib = await source("../lib.mjs");
  const page = await source("../public/index.html");
  assert.match(lib, /metadata->>'kind' IN \('preference', 'profile'\) AND coalesce\(metadata->>'pinned', ''\) <> 'false'/);
  assert.match(page, /const DIGEST_KINDS = \["preference", "profile"\];/);
  assert.match(page, /m\.pinned === true \|\| \(m\.pinned !== false && DIGEST_KINDS\.includes\(m\.kind\)\)/);
  assert.match(page, /const digestReady = \(m\) => inDigest\(m\)/);
  assert.match(page, /chips\("#f-digest"/);
  for (const language of ["en", "sv"]) {
    const messages = JSON.parse(await source(`../public/lang/${language}.json`));
    assert.ok(messages.editor.pinned && messages.editor.pinnedHint && messages.thought.pinned);
  }
});
