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

test("quality audit flags dated history, version history and an open SECRET_REF, but not a deadline", () => {
  const current = { lifecycle: "current", kind: "fact" };
  assert.ok(codes({ content: "The trap was verified 2026-08-04 on the laptop.", metadata: current }).includes("dated-history"));
  assert.ok(codes({ content: "Beslut 2026-10-31: PBS körs som CT.", metadata: current }).includes("dated-history"));
  assert.ok(codes({ content: "Sedan 0.15.2 skrivs formaten på en egen sida.", metadata: current }).includes("version-history"));
  assert.ok(codes({ content: "The proxy points at Base since 2026-10-25.", metadata: current }).includes("version-history"));
  assert.deepEqual(codes({ content: "Change nothing on the hall mirror before the hunt on 2026-11-07.", metadata: current }), []);
  assert.deepEqual(codes({ content: "In Frigate 0.18 detect.enabled is false by default.", metadata: current }), []);

  const pointer = "Key: SECRET_REF: C:\\Users\\eripet\\Coding\\_secrets_\\omniroute\\secrets.env :: OMNIROUTE_API_KEY";
  assert.ok(codes({ content: pointer, metadata: current, tier: "open" }).includes("secret-ref-in-open-tier"));
  assert.equal(codes({ content: pointer, metadata: current, tier: "vault" }).includes("secret-ref-in-open-tier"), false);
  // The rule quoting the pointer format is not a pointer.
  const template = "Skriv exakt: SECRET_REF: C:\\Users\\eripet\\Coding\\_secrets_\\<projekt>\\<fil> :: <KEY_NAME>.";
  assert.equal(codes({ content: template, metadata: current, tier: "open" }).includes("secret-ref-in-open-tier"), false);
});

test("the writer is told what to do about each warning", async () => {
  const { qualityAdvice } = await import("../memory-quality.mjs");
  assert.equal(qualityAdvice([]), "");
  const advice = qualityAdvice([{ code: "dated-history" }, { code: "version-history" }]);
  assert.match(advice, /present tense/);
  assert.match(advice, /since <version or date>/);
  assert.match(advice, /supersede_thought/);
});

test("quality audit compares project ownership with a Windows workspace path", () => {
  const warnings = codes({
    content: "The source lives at C:\\Users\\eripet\\Coding\\Mimers-Brain\\server.",
    metadata: { lifecycle: "current", kind: "reference", project: "desktop-commander" },
  });
  assert.ok(warnings.includes("project-differs-from-workspace-path"));

  // Not for the secret store, a related folder, or a folder name that runs on
  // into the rest of the sentence.
  const fine = (project, content) => assert.equal(
    codes({ content, metadata: { lifecycle: "current", kind: "reference", project } }).includes("project-differs-from-workspace-path"),
    false, `${project}: ${content}`);
  fine("arr-suite", "Key: SECRET_REF: C:\\Users\\eripet\\Coding\\_secrets_\\arr-suite\\secrets.env :: KEY");
  fine("storagesystem", "Deploy notes in C:\\Users\\eripet\\Coding\\Storagesystem-base\\docs\\DEPLOYMENT.md.");
  fine("comfyui-lora-manager", "Scripts in C:\\Users\\eripet\\Coding\\ComfyUI - Sync\\tools\\hf-match.py.");
  fine("esphome", "The repo C:\\Users\\eripet\\Coding\\ESPHome is private and edited on Windows.");
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

test("completion reports are history even when labelled as facts", () => {
  const content = "Uppgiften är klar. Backuptestet lyckades och testfilerna är borttagna. Inget återstår.";
  assert.ok(codes({ content, metadata: { kind: "fact" } }).includes("completed-work-is-current"));
  assert.ok(codes({ content, metadata: { kind: "task", task_status: "pending" } }).includes("pending-task-looks-completed"));
  assert.ok(!codes({
    content: "The task is complete. Next step: test the remaining data groups.",
    metadata: { kind: "task", task_status: "pending" },
  }).includes("pending-task-looks-completed"));
  assert.ok(!codes({ content: "Uppgiften är klar för lokal drift. Återstår: prova återställning från fjärrservern.", metadata: { kind: "task", task_status: "pending" } }).includes("pending-task-looks-completed"));
  assert.ok(!codes({ content: "Mark the task complete only after a restore test.", metadata: { kind: "procedure" } }).includes("completed-work-is-current"));
});

test("dated moves, script releases and test reports are caught without flagging an expiry", () => {
  for (const content of [
    "Root scripts live outside the share. Moved 2026-11-16.",
    "Den gamla kopian togs ur bruk 2026-11-16.",
    "Åtgärdat 2026-11-16: felaktiga sökvägar är rättade.",
    "2026-11-14 bytte vi integrationens källa.",
    "sync.ps1 (från 2026-11-13): filen flyttas till arkivet.",
    "Test 2026-10-23: modellen hittade sex av åtta fel.",
  ]) assert.ok(codes({ content }).includes("dated-history"), content);
  assert.ok(!codes({ content: "The client secret expires 2028-11-05; renew it before then." }).includes("dated-history"));
});

test("encryption cutoffs do not hide unrelated version history", () => {
  for (const content of [
    "PBS krypterar alla backuper sedan 2026-11-14. Nyckeln krävs för återställning.",
    "Backups are encrypted since 2026-11-14; keep the key to restore them.",
  ]) assert.ok(!codes({ content }).includes("version-history"), content);
  assert.ok(codes({ content: "Backups are encrypted since 2026-11-14. The proxy uses a new address since 2026-11-16." }).includes("version-history"));
  assert.ok(codes({ content: "Backups are encrypted since version 1.4.0." }).includes("version-history"));
  assert.ok(codes({ content: "The controller has a sleep mode från v1.4.0." }).includes("version-history"));
});

test("coherent procedures and numbered pitfalls are not multi-purpose just because they have steps", () => {
  const step = "Check the actual response before continuing; a successful request does not prove that the setting was saved. ";
  for (const content of [
    ["To build the printer driver:", ...[1, 2, 3, 4].map((n) => `${n}. ${step.repeat(3)}`)].join("\n"),
    ["# Connection check", "## Prerequisites", step.repeat(3), "## Method", step.repeat(3), "## Verification", step.repeat(3)].join("\n"),
    ["FÄLLA 1:", step.repeat(3), "METOD:", step.repeat(3), "KONTROLL:", step.repeat(3)].join("\n"),
  ]) assert.ok(!codes({ content }).includes("possible-multiple-purposes"));
  const bundle = ["# DNS configuration", step.repeat(3), "## Printer calibration", step.repeat(3), "## Music playback", step.repeat(3)].join("\n");
  assert.ok(codes({ content: bundle }).includes("possible-multiple-purposes"));
});

test("same-session maintenance instructions are not session history", () => {
  for (const content of [
    "Ändras ett steg: uppdatera alla kopior i samma session.",
    "When changing the workflow, update every copy in the same session.",
  ]) assert.ok(!codes({ content }).includes("session-history-language"));
  assert.ok(codes({ content: "Latest fixes from the same session: the service was rebuilt." }).includes("session-history-language"));
});

test("secret terminology and translation keys are not credential fragments", () => {
  for (const content of [
    "The search tool reads its key from a file; never put the value, prefix or suffix in memory.",
    "Nyckeln finns i en fil; minnet ska inte innehålla nyckelvärde, prefix eller suffix.",
    'UI-texten är i18n-nyckeln message.maxTokens. Loadern importerar namn som börjar med ".".',
    "The token prefix is the provider name, not a credential value.",
    "Key fingerprint starts with 2f:10:ab:cd.",
  ]) assert.ok(!codes({ content }).includes("possible-secret-fragment"), content);
  for (const content of ["Token prefix is abc123.", "Nyckeln slutar på deadbeef.", "API key ends with abc123."])
    assert.ok(codes({ content }).includes("possible-secret-fragment"), content);
});

test("references to other projects do not assert source ownership", () => {
  const metadata = { project: "notes-service", kind: "reference" };
  for (const content of [
    String.raw`The backup is in C:\Users\tester\Coding\Backup Scripts\notes\backup.json.`,
    String.raw`For restore instructions, read C:\Users\tester\Coding\Infrastructure\README.md.`,
    String.raw`A repo-local skill at C:\Users\tester\Coding\Firmware\SKILL.md takes precedence.`,
    String.raw`The scope is bound to C:\Users\tester\Coding\Company\Server Management.`,
  ]) assert.ok(!codes({ content, metadata }).includes("project-differs-from-workspace-path"), content);
  assert.ok(codes({ content: String.raw`The repository lives in C:\Users\tester\Coding\Unrelated\server.`, metadata }).includes("project-differs-from-workspace-path"));
  assert.ok(codes({ content: String.raw`The source lives at "C:\Users\tester\Coding\Unrelated\server".`, metadata }).includes("project-differs-from-workspace-path"));
});

test("real SECRET_REF pointers require a colon and absolute path, while templates and prose are accepted", () => {
  for (const content of [
    String.raw`Token: SECRET_REF C:\Users\tester\Coding\_secrets_\app\token.txt.`,
    String.raw`Token: SECRET_REF: _secrets_\app\token.txt.`,
    String.raw`Token: SECRET_REF: ..\credentials\token.txt.`,
    String.raw`Token: SECRET_REF: C:\Users\tester\Coding\_secrets_\app\secrets.env#API_KEY.`,
    String.raw`SECRET_REF: the token is in C:\Users\tester\Coding\_secrets_\app\token.txt.`,
  ]) assert.ok(codes({ content, tier: "vault" }).includes("malformed-secret-ref"), content);
  for (const content of [
    String.raw`Token: SECRET_REF: C:\Users\tester\Coding\_secrets_\app\secrets.env :: API_KEY.`,
    "Token: SECRET_REF: /srv/credentials/token.txt.",
    String.raw`Token: SECRET_REF: "C:\Program Data\Credentials\token.txt".`,
    String.raw`Use SECRET_REF: C:\Users\tester\Coding\_secrets_\<project>\<file> :: <KEY_NAME>.`,
    "Write the password to the SECRET_REF file; never store the value here.",
  ]) assert.ok(!codes({ content, tier: "vault" }).includes("malformed-secret-ref"), content);
  assert.ok(codes({ content: String.raw`Token: SECRET_REF: _secrets_\app\token.txt.`, tier: "open" }).includes("secret-ref-in-open-tier"));
  assert.ok(codes({ content: String.raw`Token: SECRET_REF: "C:\Program Data\Credentials\token.txt".`, tier: "open" }).includes("secret-ref-in-open-tier"));
});

test("raw-secret checks cover stored metadata and historical rows without exposing the matched value", async () => {
  const { qualityAdvice } = await import("../memory-quality.mjs");
  const credential = ["sk", "syntheticCredentialForAudit012345"].join("-");
  for (const lifecycle of ["current", "archived", "superseded"]) {
    const warnings = memoryQualityWarnings({ content: "An ordinary reference.", metadata: { lifecycle, summary: credential } });
    assert.ok(warnings.some((w) => w.code === "raw-secret-value" && w.field === "metadata"));
    assert.ok(!JSON.stringify(warnings).includes(credential));
    assert.ok(!qualityAdvice(warnings).includes("supersede_thought"));
  }
});
