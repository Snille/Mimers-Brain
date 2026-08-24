import test from "node:test";
import assert from "node:assert/strict";

import { projectRule, topicRule } from "../lib.mjs";

// A stray project name is invisible to every project filter, and the extraction
// model only invents one because it cannot see what already exists.
test("the project rule offers the existing names and rules out topic words", () => {
  const rule = projectRule(["home-assistant", "glance-clock"]);
  assert.match(rule, /Reuse an existing project name/);
  assert.match(rule, /home-assistant, glance-clock/);
  assert.match(rule, /names a subject, never a project/);
  assert.match(rule, /repository or service.*never the client, harness/s);
  assert.match(rule, /project folder in a path/);
});

// The list comes from the database, so an unreachable database must omit only
// the reuse hint while retaining the ownership rules.
test("the project rule retains ownership guidance when no project exists yet", () => {
  const rule = projectRule([]);
  assert.match(rule, /^- "project": one lower-kebab-case owning project, or empty/m);
  assert.doesNotMatch(rule, /Reuse an existing/);
  assert.match(rule, /never the client, harness/);
  assert.match(rule, /leave project empty when ownership is unclear/);
});

// "other" was one of twenty-six equal options, and the model reached for it
// whenever it hesitated. It has to read as the fallback it is.
test("the topic rule offers the real subjects and holds other back", () => {
  const rule = topicRule();
  assert.match(rule, /home-assistant/);
  assert.doesNotMatch(rule, /chosen only from:[^\n]*\bother\b/);
  assert.match(rule, /Use "other" only when not one of those values applies/);
  assert.match(rule, /never\n {2}beside a value that does apply/);
});
