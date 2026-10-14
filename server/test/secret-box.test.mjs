import test from "node:test";
import assert from "node:assert/strict";
import { canSeal, open, seal } from "../secret-box.mjs";

test("sealed keys open only with the same SETTINGS_KEY", () => {
  const saved = process.env.SETTINGS_KEY;
  try {
    process.env.SETTINGS_KEY = "first-settings-key";
    assert.equal(canSeal(), true);
    const sealed = seal("sk-test-value-123456");
    assert.match(sealed, /^v1:/);
    assert.doesNotMatch(sealed, /sk-test/);
    assert.notEqual(seal("sk-test-value-123456"), sealed, "a fresh IV each time");
    assert.equal(open(sealed), "sk-test-value-123456");

    process.env.SETTINGS_KEY = "second-settings-key";
    assert.equal(open(sealed), null, "another key opens nothing");
    assert.equal(open(`${sealed.slice(0, -4)}AAAA`), null, "tampering is detected");

    delete process.env.SETTINGS_KEY;
    assert.equal(canSeal(), false);
    assert.equal(open(sealed), null);
    assert.throws(() => seal("x"), /SETTINGS_KEY/);
  } finally {
    if (saved === undefined) delete process.env.SETTINGS_KEY; else process.env.SETTINGS_KEY = saved;
  }
});
