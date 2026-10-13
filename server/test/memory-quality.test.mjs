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

test("a title or summary that is just the cut-off opening of the content is flagged", async () => {
  const { memoryQualityWarnings } = await import("../memory-quality.mjs");
  const content = "Eriks interna DNS ligger på gatewayen 10.0.0.1 och har lokala överstyrningar som pekar tjänstenamnen till Nginx Proxy Manager på 10.0.0.7 och mer därtill.";
  const codes = (metadata) => memoryQualityWarnings({ content, metadata }).map((w) => w.code);
  assert.ok(codes({ title: content.slice(0, 90), summary: content.slice(0, 120) }).includes("title-looks-cut"));
  assert.ok(codes({ title: "x", summary: content.slice(0, 120) }).includes("summary-looks-cut"));
  const clean = codes({ title: "Eriks interna DNS på 10.0.0.1", summary: "Tjänstenamnen pekar på Nginx Proxy Manager 10.0.0.7." });
  assert.ok(!clean.includes("title-looks-cut") && !clean.includes("summary-looks-cut"));
});

test("the metadata model is told to keep the text's language and never cut it", async () => {
  const { readFile } = await import("node:fs/promises");
  const lib = await readFile(new URL("../lib.mjs", import.meta.url), "utf8");
  assert.match(lib, /SAME LANGUAGE as the text/);
  assert.match(lib, /never copy or cut off the opening words/);
});
