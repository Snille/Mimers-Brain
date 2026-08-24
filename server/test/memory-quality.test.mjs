import test from "node:test";
import assert from "node:assert/strict";

import { memoryQualityWarnings } from "../memory-quality.mjs";

const codes = (row) => memoryQualityWarnings(row).map((warning) => warning.code);

test("quality audit flags oversized, multi-purpose session history without printing content", () => {
  const content = [
    "# Latest fixes",
    "A long account of work from the same session. ".repeat(20),
    "## Tests",
    "All checks completed. ".repeat(20),
    "## Release",
    "Version 1.2.3 was published. ".repeat(20),
  ].join("\n");
  const warnings = memoryQualityWarnings({ content, metadata: { lifecycle: "current", kind: "fact" } });

  assert.ok(warnings.some((warning) => warning.code === "oversized-current-memory"));
  assert.ok(warnings.some((warning) => warning.code === "possible-multiple-purposes"));
  assert.ok(warnings.some((warning) => warning.code === "session-history-language"));
  assert.equal(JSON.stringify(warnings).includes("Version 1.2.3"), false);
});

test("quality audit distinguishes an unfinished task from completed work", () => {
  assert.ok(codes({
    content: "Implemented and verified the migration.",
    metadata: { lifecycle: "current", kind: "task", task_status: "pending" },
  }).includes("pending-task-looks-completed"));

  const doneCodes = codes({
    content: "Next step: verify the migration on the live host.",
    metadata: { lifecycle: "current", kind: "task", task_status: "done" },
  });
  assert.ok(doneCodes.includes("completed-task-is-current"));
  assert.equal(doneCodes.includes("pending-task-looks-completed"), false);
});

test("quality audit catches secret fragments and ungrounded metadata", () => {
  const warnings = memoryQualityWarnings({
    content: "API key ends with abc123 and is stored outside the repository.",
    metadata: {
      lifecycle: "current",
      kind: "reference",
      title: "zimage_base_better_pussy_v1.0 setup",
    },
  });
  assert.ok(warnings.some((warning) => warning.code === "possible-secret-fragment"));
  assert.ok(warnings.some((warning) =>
    warning.code === "metadata-not-grounded-in-content" && warning.field === "title"));
});

test("quality audit compares project ownership with a Windows workspace path", () => {
  const warnings = codes({
    content: "The source lives at C:\\Users\\eripet\\Coding\\Mimers-Brain\\server.",
    metadata: { lifecycle: "current", kind: "reference", project: "desktop-commander" },
  });
  assert.ok(warnings.includes("project-differs-from-workspace-path"));
});

test("quality audit ignores historical rows and accepts a focused current procedure", () => {
  assert.deepEqual(memoryQualityWarnings({
    content: "Latest fixes from the same session included a token ending in abc123.",
    metadata: { lifecycle: "superseded", kind: "fact" },
  }), []);

  assert.deepEqual(memoryQualityWarnings({
    content: "To restart Mimers Brain, run docker compose up after validating the environment file.",
    metadata: {
      lifecycle: "current",
      kind: "procedure",
      project: "mimers-brain",
      title: "Restart Mimers Brain",
    },
  }), []);
});
