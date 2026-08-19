import test from "node:test";
import assert from "node:assert/strict";

import { projectRule } from "../lib.mjs";

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
