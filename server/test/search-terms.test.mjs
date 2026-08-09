import test from "node:test";
import assert from "node:assert/strict";

import { searchTerms } from "../lib.mjs";

test("search title terms remove question noise and lightly stem Swedish verbs", () => {
  assert.deepEqual(searchTerms("Hur deployar jag Mimers Brain?"), ["deploy", "mimers", "brain"]);
  assert.deepEqual(searchTerms("Hur bygger och flashar jag ESPHome?"), ["bygg", "flash", "esphome"]);
});

