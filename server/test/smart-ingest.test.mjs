import test from "node:test";
import assert from "node:assert/strict";

import { fallbackAtoms, normalisePreviewCandidates } from "../smart-ingest.mjs";

test("fallback ingest makes bounded standalone candidates", () => {
  const source = `# Decision\n\nUse the new memory policy.\n\n${"A long verified procedure. ".repeat(120)}`;
  const atoms = fallbackAtoms(source);
  assert.ok(atoms.length >= 2);
  assert.ok(atoms.every((item) => item.length <= 1800));
});

test("preview validation removes empty and duplicate candidates", () => {
  const rows = normalisePreviewCandidates([
    { content: " One durable fact. " },
    { content: "one durable fact." },
    "",
    { content: "Another fact.", metadata: { kind: "fact" } },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].metadata.kind, "fact");
});
