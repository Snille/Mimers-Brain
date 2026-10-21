import test from "node:test";
import assert from "node:assert/strict";
import { freshDatabase, skipWithoutDatabase } from "../testing/db.mjs";

test("the appearance is dark and green by default, stored once for every browser, and checked", {
  skip: skipWithoutDatabase,
}, async () => {
  process.env.DATABASE_URL = await freshDatabase("test_appearance");
  const db = await import("../lib.mjs");
  const appearance = await import("../appearance.mjs");
  try {
    await db.ensureSchema();
    assert.deepEqual(await appearance.appearance(), { theme: "dark", accent: "#95c200" });

    assert.deepEqual(await appearance.saveAppearance({ theme: "light" }), { theme: "light", accent: "#95c200" });
    assert.deepEqual(await appearance.saveAppearance({ accent: "#4AA3C7" }), { theme: "light", accent: "#4aa3c7" });
    assert.deepEqual(await appearance.appearance(), { theme: "light", accent: "#4aa3c7" }, "a field left out keeps its value");

    await assert.rejects(appearance.saveAppearance({ theme: "neon" }), /theme must be one of/);
    await assert.rejects(appearance.saveAppearance({ accent: "red" }), /accent must be a colour/);
    await assert.rejects(appearance.saveAppearance({ accent: "#95c200; background: url(x)" }), /accent must be a colour/);

    assert.deepEqual(await appearance.saveAppearance({ theme: "", accent: "" }), { theme: "dark", accent: "#95c200" },
      "an empty value brings back the default");
    // A damaged stored value never reaches a page as anything but the defaults.
    await db.setSetting("ui_appearance", JSON.stringify({ theme: "x", accent: "</style>" }));
    assert.deepEqual(await appearance.appearance(), { theme: "dark", accent: "#95c200" });
  } finally {
    await db.pool.end();
  }
});
