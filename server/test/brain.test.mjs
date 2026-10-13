import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { LINK_TYPES, brainRadius, buildLinks, layout, regions } from "../public/brain.mjs";

const ALL = new Set(LINK_TYPES.map((type) => type.key));
const node = (extra = {}) => ({
  kind: "fact", project: null, task_status: null, topics: [], people: [], systems: [], ...extra,
});

test("memories connect through each shared value, case-insensitively", () => {
  const nodes = [
    node({ systems: ["Home Assistant"], people: ["Erik"] }),
    node({ systems: ["home assistant"], kind: "procedure" }),
    node({ people: ["erik"], kind: "procedure", project: "x" }),
    node({ kind: "lesson" }),
  ];
  const { pairs, degree } = buildLinks(nodes, [[0, 3, 0.71]], ALL);
  const mask = (a, b) => pairs.find((p) => p.a === a && p.b === b)?.mask || 0;
  const bit = (key) => 1 << LINK_TYPES.findIndex((type) => type.key === key);
  assert.equal(mask(0, 1), bit("system"));
  assert.equal(mask(0, 2), bit("person"));
  assert.equal(mask(1, 2), bit("kind"));
  assert.equal(mask(0, 3), bit("similar"));
  assert.deepEqual([...degree], [3, 2, 2, 1]);
});

test("a switched-off kind of connection counts for nothing", () => {
  const nodes = [node({ topics: ["ai"] }), node({ topics: ["ai"] }), node({ kind: "lesson" })];
  assert.equal(buildLinks(nodes, [], new Set(["kind"])).pairs.length, 1);
  assert.equal(buildLinks(nodes, [], new Set(["topic"])).pairs.length, 1);
  assert.equal(buildLinks(nodes, [], new Set()).pairs.length, 0);
});

test("the most connected memory sits deepest and every node stays inside", () => {
  const nodes = Array.from({ length: 30 }, (_, i) => node({
    kind: `k${i}`, topics: i < 10 ? ["shared"] : [], systems: i === 0 ? ["hub"] : [],
  }));
  for (let i = 1; i < 30; i++) nodes[i].systems = i % 2 ? ["hub"] : [];
  const { pairs, degree } = buildLinks(nodes, [], ALL);
  const homes = layout(nodes.length, pairs, degree);
  const depth = (i) => {
    const [x, y, z] = homes.slice(i * 3, i * 3 + 3);
    const length = Math.hypot(x, y, z);
    return length / brainRadius(x / length, y / length, z / length);
  };
  const hub = [...degree].indexOf(Math.max(...degree));
  const quiet = [...degree].indexOf(Math.min(...degree));
  assert.ok(depth(hub) < depth(quiet));
  for (let i = 0; i < nodes.length; i++) assert.ok(depth(i) <= 1.0001);
  assert.deepEqual(layout(nodes.length, pairs, degree), homes, "same memories, same brain");
});

test("both languages name every kind of connection", async () => {
  for (const language of ["en", "sv"]) {
    const messages = JSON.parse(await readFile(new URL(`../public/lang/${language}.json`, import.meta.url), "utf8"));
    assert.ok(messages.stats.sections.brain.title);
    for (const type of LINK_TYPES) assert.ok(messages.stats.brain.types[type.key], `${language}: ${type.key}`);
  }
});

test("memories that mean the same thing land in the same region", async () => {
  const { semanticAxes } = await import("../semantic.mjs");
  // Two clear groups in 8 dimensions, plus noise.
  const rows = Array.from({ length: 40 }, (_, i) => Array.from({ length: 8 }, (_, d) =>
    (i < 20 ? (d < 4 ? 1 : 0) : (d < 4 ? 0 : 1)) + Math.sin(i * 7 + d * 3) * 0.05));
  const places = semanticAxes(rows);
  assert.equal(places.length, 40);
  assert.deepEqual(semanticAxes(rows), places, "same memories, same places");
  const nodes = rows.map((_, i) => node({ topics: [i < 20 ? "alpha" : "beta"] }));
  const { pairs, degree } = buildLinks(nodes, [], new Set());
  const homes = layout(nodes.length, pairs, degree, { places });
  const dir = (i) => {
    const v = homes.slice(i * 3, i * 3 + 3);
    const length = Math.hypot(...v);
    return [...v].map((x) => x / length);
  };
  const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  assert.ok(dot(dir(0), dir(1)) > dot(dir(0), dir(30)));
  const labels = regions(nodes, homes, 2).map((region) => region.label).sort();
  assert.deepEqual(labels, ["Alpha", "Beta"]);
});
