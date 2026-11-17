import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { freshDatabase, skipWithoutDatabase } from "../testing/db.mjs";

test("the audit CLI examines stored metadata and history without writing or exposing content", {
  skip: skipWithoutDatabase,
}, async () => {
  const databaseUrl = await freshDatabase("test_quality_audit");
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const insert = async (content, metadata = {}, tier = "open") => (await client.query(
    "INSERT INTO thoughts (content,metadata,tier) VALUES ($1,$2::jsonb,$3) RETURNING id",
    [content, JSON.stringify({ kind: "fact", lifecycle: "current", ...metadata }), tier],
  )).rows[0].id;
  const snapshot = async () => (await client.query(
    "SELECT id,content,metadata,tier,updated_at FROM thoughts ORDER BY id",
  )).rows;
  try {
    const completed = await insert("Uppgiften är klar. Testfilerna är raderade. Inget återstår.");
    const malformed = await insert(String.raw`Token: SECRET_REF C:\Users\tester\Credentials\token.txt.`, {}, "vault");
    const credential = ["sk", "syntheticCredentialForAudit012345"].join("-");
    const historical = await insert("An archived reference.", { lifecycle: "archived", summary: credential }, "vault");
    const wrongPath = await insert(
      String.raw`Read C:\Users\tester\Coding\_secrets_\<project>\<file> for access; no values belong in memory.`,
      { summary: String.raw`Read C:\Users\tester\Coding\_secrets\<project>\<file> for access.` },
    );
    const cutoff = await insert("Backups are encrypted since 2026-11-14; keep the key to restore them.");
    const before = await snapshot();
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL("../scripts/renormalise.mjs", import.meta.url)), "--all", "--dry-run",
    ], { env: { ...process.env, DATABASE_URL: databaseUrl }, timeout: 15000 });
    const report = JSON.parse(stdout);
    assert.equal(stderr, "");
    const has = (id, code) => report.quality_warnings.some((w) => w.id === id && w.code === code);
    assert.ok(has(completed, "completed-work-is-current"));
    assert.ok(has(malformed, "malformed-secret-ref"));
    assert.ok(has(historical, "raw-secret-value"), "normalisation must not erase the evidence before checking");
    assert.ok(has(wrongPath, "metadata-not-grounded-in-content"));
    assert.ok(report.changes.some((c) => c.id === wrongPath && c.fields.includes("summary")));
    assert.ok(!report.quality_warnings.some((w) => w.id === cutoff));
    for (const forbidden of [credential, "Testfilerna", "C:\\Users\\tester", "An archived reference"])
      assert.ok(!stdout.includes(forbidden), "the report may contain ids and codes only");
    assert.deepEqual(await snapshot(), before, "dry-run must not change the database");
  } finally {
    await client.end();
  }
});
