import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

// A script that embeds runs outside the server, so it does not have the models
// chosen on the Models card unless it loads them itself. Without them it embeds
// with the .env model, whose vectors may not fit the column (renormalise.mjs
// failed this way on 2026-11-03).
test("every script that embeds loads the stored model settings first", async () => {
  const dir = new URL("../scripts/", import.meta.url);
  for (const name of (await readdir(dir)).filter((file) => file.endsWith(".mjs"))) {
    const source = await readFile(new URL(name, dir), "utf8");
    const embeds = /\bembed\(|embedInputs\(|\bevaluate\(/.test(source);
    if (embeds) assert.match(source, /await loadModelSettings\(\)/, `${name} embeds without loadModelSettings()`);
  }
});
