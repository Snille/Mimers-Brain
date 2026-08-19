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
});

// The list comes from the database, so an unreachable database must degrade to
// the plain instruction rather than to a broken prompt.
test("the project rule stays a single plain line when no project exists yet", () => {
  const rule = projectRule([]);
  assert.equal(rule, `- "project": one lower-kebab-case owning project, or empty\n`);
  assert.doesNotMatch(rule, /Reuse an existing/);
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
