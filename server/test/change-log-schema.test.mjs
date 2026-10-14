import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CHANGE_LOG_SQL, CONTRADICTION_SQL } from "../lib.mjs";

const squash = (sql) => sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();

test("init.sql and the boot-time upgrade define the same change log and contradiction schema", async () => {
  const schema = squash(await readFile(new URL("../../db/init.sql", import.meta.url), "utf8"));
  assert.ok(schema.includes(squash(CHANGE_LOG_SQL)), "CHANGE_LOG_SQL differs from db/init.sql");
  assert.ok(schema.includes(squash(CONTRADICTION_SQL)), "CONTRADICTION_SQL differs from db/init.sql");
});

test("the record of a delete outlives the row it describes", () => {
  const table = CHANGE_LOG_SQL.match(/CREATE TABLE IF NOT EXISTS thought_changes[\s\S]*?\);/)?.[0] || "";
  assert.match(table, /thought_id uuid NOT NULL,/);
  assert.doesNotMatch(table, /REFERENCES/);
  assert.match(CHANGE_LOG_SQL, /BEFORE DELETE ON thoughts/);
});
