// Statistics: the brain. Every current memory is a glowing node inside a
// wireframe brain. Two memories are connected when they share a kind, a task
// status, a project, a topic, a person or a system, or when they mean nearly
// the same thing. Where a memory sits follows its meaning, so related memories
// share a region like a lobe, and each region is labelled with what its
// memories have most in common. How deep it sits follows its connections: the
// most connected memory is the largest and sits deepest inside, the loneliest
// float at the surface.
//
// No library: a few hundred nodes and a few thousand lines are well within what
// a 2D canvas draws at full frame rate, and the dashboard has no build step and
// fetches nothing from the internet. The top half of this file is pure (no DOM)
// so the link and layout rules can be tested in Node.

// Connection kinds, in the order of their bit in a pair's mask.
export const LINK_TYPES = [
  { key: "similar", color: [110, 220, 255] },
  { key: "kind", color: [150, 150, 255], values: (n) => [n.kind] },
  { key: "task", color: [255, 120, 200], values: (n) => [n.task_status] },
  { key: "project", color: [255, 190, 90], values: (n) => [n.project] },
  { key: "topic", color: [120, 230, 150], values: (n) => n.topics || [] },
  { key: "person", color: [255, 120, 110], values: (n) => n.people || [] },
  { key: "system", color: [200, 150, 255], values: (n) => n.systems || [] },
];

// Pairs of node indices with a bit mask of what joins them. Values compare
// case-insensitively, as the statistics breakdowns already do for people and
// systems: "Home Assistant" and "home assistant" are one system.
export function buildLinks(nodes, similar, enabled) {
  const count = nodes.length;
  const pairs = new Map();
  const add = (a, b, bit) => {
    if (a === b) return;
    if (a > b) [a, b] = [b, a];
    const key = a * count + b;
    let pair = pairs.get(key);
    if (!pair) pairs.set(key, pair = { a, b, mask: 0, s: 0 });
    pair.mask |= 1 << bit;
  };

  LINK_TYPES.forEach((type, bit) => {
    if (!enabled.has(type.key)) return;
    if (!type.values) {
      for (const [a, b, s] of similar || []) {
        if (a >= count || b >= count) continue;
        add(a, b, bit);
        const pair = pairs.get(Math.min(a, b) * count + Math.max(a, b));
        pair.s = Math.max(pair.s, Number(s) || 0);
      }
      return;
    }
    const groups = new Map();
    nodes.forEach((node, index) => {
      const seen = new Set();
      for (const value of type.values(node)) {
        const key = String(value ?? "").trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(index);
      }
    });
    for (const members of groups.values())
      for (let x = 0; x < members.length; x++)
        for (let y = x + 1; y < members.length; y++) add(members[x], members[y], bit);
  });

  const list = [...pairs.values()];
  const degree = new Uint32Array(count);
  for (const pair of list) { degree[pair.a]++; degree[pair.b]++; }

  // A pair joined in several ways is drawn, at rest, in the colour of its
  // rarest kind - the one that says the most about why these two belong together.
  const totals = LINK_TYPES.map(() => 0);
  for (const pair of list)
    for (let bit = 0; bit < LINK_TYPES.length; bit++) if (pair.mask & (1 << bit)) totals[bit]++;
  for (const pair of list) {
    let best = -1;
    for (let bit = 0; bit < LINK_TYPES.length; bit++)
      if (pair.mask & (1 << bit) && (best < 0 || totals[bit] < totals[best])) best = bit;
    pair.primary = best;
  }
  return { pairs: list, degree, totals };
}

// x = front (+) to back (-), y = up, z = side. One unit is half the length.
// The brain is a union of ellipsoids - two hemispheres, two temporal lobes,
// two cerebellar halves and the stem - and where two of them meet, the seam
// reads as a fissure: between the halves, above the temporal lobe, above the
// cerebellum. [centre, radii]
const PARTS = [
  [[0.03, 0.12, 0.29], [1, 0.7, 0.46]],
  [[0.03, 0.12, -0.29], [1, 0.7, 0.46]],
  [[0.18, -0.3, 0.42], [0.56, 0.3, 0.3]],
  [[0.18, -0.3, -0.42], [0.56, 0.3, 0.3]],
  [[-0.6, -0.42, 0.2], [0.38, 0.26, 0.3]],
  [[-0.6, -0.42, -0.2], [0.38, 0.26, 0.3]],
  [[-0.16, -0.5, 0], [0.13, 0.32, 0.13]],
];

// Distance from the centre to the surface, along a unit direction: the far
// side of whichever part reaches furthest. Every part overlaps the
// hemispheres, so the union seen from the centre has no holes.
export function brainRadius(x, y, z) {
  let r = 0;
  for (const [[cx, cy, cz], [ax, ay, az]] of PARTS) {
    const a = (x / ax) ** 2 + (y / ay) ** 2 + (z / az) ** 2;
    const b = x * cx / (ax * ax) + y * cy / (ay * ay) + z * cz / (az * az);
    const c = (cx / ax) ** 2 + (cy / ay) ** 2 + (cz / az) ** 2 - 1;
    const disc = b * b - a * c;
    if (disc >= 0) r = Math.max(r, (b + Math.sqrt(disc)) / a);
  }
  // Folds: a shallow ripple, so the surface is not a smooth balloon.
  return r * (1 + 0.02 * Math.sin(11 * x + 3 * y) * Math.sin(9 * y - 4 * z) * Math.sin(10 * z + 2 * x));
}

// Rest position of every node. Depth follows rank, not raw count, so a single
// enormous hub cannot squeeze every other node against the surface. The square
// root spreads the ranks through the volume: there is far more room near the
// surface than near the centre.
//
// Direction follows meaning: `places` holds each memory's position on the three
// main axes of its embedding (see server/semantic.mjs), and the node is held
// towards that direction while a gentle push keeps crowded areas apart. A
// memory without a place - its embedding is still pending - is pulled towards
// the memories it is connected to instead. Deterministic: the same memories
// give the same brain on every visit.
export function layout(count, pairs, degree, { places = [], iterations = 70 } = {}) {
  const homes = new Float32Array(count * 3);
  if (!count) return homes;
  const order = [...Array(count).keys()].sort((a, b) => degree[b] - degree[a] || a - b);
  const rank = new Float32Array(count);
  for (let i = 0; i < count;) {
    let j = i;
    while (j + 1 < count && degree[order[j + 1]] === degree[order[i]]) j++;
    const value = count > 1 ? (i + j) / 2 / (count - 1) : 0;
    for (let k = i; k <= j; k++) rank[order[k]] = value;
    i = j + 1;
  }

  const dirs = new Float64Array(count * 3);
  const anchors = new Float64Array(count * 3);
  const anchored = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const place = places[i];
    const length = place ? Math.hypot(place[0], place[1], place[2]) : 0;
    if (length > 1e-6) {
      anchored[i] = 1;
      anchors.set([place[0] / length, place[1] / length, place[2] / length], i * 3);
      dirs.set(anchors.subarray(i * 3, i * 3 + 3), i * 3);
      continue;
    }
    const y = 1 - 2 * (i + 0.5) / count;
    const ring = Math.sqrt(1 - y * y);
    const angle = i * 2.399963229728653;
    dirs.set([Math.cos(angle) * ring, y, Math.sin(angle) * ring], i * 3);
  }
  const push = new Float64Array(count * 3);
  for (let step = 0; step < iterations; step++) {
    push.fill(0);
    for (let i = 0; i < count; i++)
      if (anchored[i])
        for (let c = 0; c < 3; c++) push[i * 3 + c] += (anchors[i * 3 + c] - dirs[i * 3 + c]) * 1.5;
    for (const { a, b } of pairs) {
      if (anchored[a] && anchored[b]) continue;
      const weight = 1 / Math.sqrt(degree[a] * degree[b]);
      for (let c = 0; c < 3; c++) {
        const d = (dirs[b * 3 + c] - dirs[a * 3 + c]) * weight;
        if (!anchored[a]) push[a * 3 + c] += d;
        if (!anchored[b]) push[b * 3 + c] -= d;
      }
    }
    for (let a = 0; a < count; a++)
      for (let b = a + 1; b < count; b++) {
        const dx = dirs[a * 3] - dirs[b * 3];
        const dy = dirs[a * 3 + 1] - dirs[b * 3 + 1];
        const dz = dirs[a * 3 + 2] - dirs[b * 3 + 2];
        const force = 1 / ((dx * dx + dy * dy + dz * dz + 0.01) * count);
        push[a * 3] += dx * force; push[a * 3 + 1] += dy * force; push[a * 3 + 2] += dz * force;
        push[b * 3] -= dx * force; push[b * 3 + 1] -= dy * force; push[b * 3 + 2] -= dz * force;
      }
    for (let i = 0; i < count; i++) {
      let x = dirs[i * 3] + push[i * 3] * 0.04;
      let y = dirs[i * 3 + 1] + push[i * 3 + 1] * 0.04;
      let z = dirs[i * 3 + 2] + push[i * 3 + 2] * 0.04;
      const length = Math.hypot(x, y, z) || 1;
      dirs[i * 3] = x / length; dirs[i * 3 + 1] = y / length; dirs[i * 3 + 2] = z / length;
    }
  }

  for (let i = 0; i < count; i++) {
    const [x, y, z] = [dirs[i * 3], dirs[i * 3 + 1], dirs[i * 3 + 2]];
    const depth = degree[i] ? 0.12 + 0.86 * Math.sqrt(rank[i]) : 1;
    const r = depth * brainRadius(x, y, z);
    homes[i * 3] = x * r; homes[i * 3 + 1] = y * r; homes[i * 3 + 2] = z * r;
  }
  return homes;
}

// Values that say nothing about a region on their own.
const VAGUE = new Set(["other", "unknown", "misc", "general"]);
const labelKey = (value) => String(value ?? "").trim().toLowerCase().replace(/[-_\s]+/g, " ");

// Regions for the labels: the node directions grouped with k-means, each
// named after the topic, system or project that is most typical of it - common
// inside the region and rarer outside, so "Home Assistant" names its own lobe
// rather than every lobe it happens to touch. No name is used twice; a region
// with nothing typical enough stays unnamed.
export function regions(nodes, homes, k = Math.min(9, Math.max(4, Math.round(nodes.length / 35)))) {
  const count = nodes.length;
  if (count < k * 3) return [];
  const dirs = Array.from({ length: count }, (_, i) => {
    const [x, y, z] = homes.slice(i * 3, i * 3 + 3);
    const length = Math.hypot(x, y, z) || 1;
    return [x / length, y / length, z / length];
  });
  const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  const centres = [dirs[0]];
  while (centres.length < k) {
    let far = 0, worst = Infinity;
    dirs.forEach((dir, i) => {
      const best = Math.max(...centres.map((c) => dot(dir, c)));
      if (best < worst) { worst = best; far = i; }
    });
    centres.push(dirs[far]);
  }
  let member = new Array(count).fill(0);
  for (let step = 0; step < 15; step++) {
    member = dirs.map((dir) => centres.reduce((best, c, j) => (dot(dir, c) > dot(dir, centres[best]) ? j : best), 0));
    for (let j = 0; j < k; j++) {
      const sum = [0, 0, 0];
      dirs.forEach((dir, i) => { if (member[i] === j) for (let c = 0; c < 3; c++) sum[c] += dir[c]; });
      const length = Math.hypot(...sum);
      if (length) centres[j] = sum.map((v) => v / length);
    }
  }

  const spelling = new Map();
  const global = new Map();
  const local = Array.from({ length: k }, () => new Map());
  const sizes = new Array(k).fill(0);
  nodes.forEach((node, i) => {
    sizes[member[i]]++;
    const seen = new Set();
    for (const value of [...(node.topics || []), ...(node.systems || []), node.project]) {
      const key = labelKey(value);
      if (!key || VAGUE.has(key) || seen.has(key)) continue;
      seen.add(key);
      // Prefer the spelling with capitals: "Home Assistant" over "home-assistant".
      if (!spelling.has(key) || (/[A-Z]/.test(value) && !/[A-Z]/.test(spelling.get(key))))
        spelling.set(key, String(value).trim());
      global.set(key, (global.get(key) || 0) + 1);
      local[member[i]].set(key, (local[member[i]].get(key) || 0) + 1);
    }
  });
  const options = [];
  local.forEach((values, j) => {
    for (const [key, inside] of values) {
      const share = inside / sizes[j];
      if (inside < 3 || share < 0.2) continue;
      options.push({ j, key, score: inside * share / (global.get(key) / count) });
    }
  });
  options.sort((p, q) => q.score - p.score);
  const names = new Array(k).fill(null);
  const used = new Set();
  for (const { j, key } of options) {
    if (names[j] || used.has(key)) continue;
    const name = spelling.get(key);
    // An all-lowercase tag reads as a typo on its own: "ai" becomes "AI",
    // "photoframe" becomes "Photoframe".
    names[j] = /[A-Z]/.test(name) ? name : name.length <= 3 ? name.toUpperCase() : name[0].toUpperCase() + name.slice(1);
    used.add(key);
  }
  return centres.map((dir, j) => ({ dir, label: names[j], size: sizes[j] }))
    .filter((region) => region.label && region.size);
}

// The wireframe: a subdivided icosahedron pushed out to the brain's surface.
function brainMesh(level) {
  const t = (1 + Math.sqrt(5)) / 2;
  const verts = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t],
    [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(([x, y, z]) => {
    const length = Math.hypot(x, y, z);
    return [x / length, y / length, z / length];
  });
  let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4],
    [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let l = 0; l < level; l++) {
    const cache = new Map();
    const mid = (a, b) => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (cache.has(key)) return cache.get(key);
      const [x, y, z] = verts[a].map((v, c) => v + verts[b][c]);
      const length = Math.hypot(x, y, z);
      verts.push([x / length, y / length, z / length]);
      cache.set(key, verts.length - 1);
      return verts.length - 1;
    };
    faces = faces.flatMap(([a, b, c]) => {
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      return [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]];
    });
  }
  const edges = new Set();
  for (const [a, b, c] of faces)
    for (const [p, q] of [[a, b], [b, c], [c, a]]) edges.add(p < q ? p * 65536 + q : q * 65536 + p);
  const points = new Float32Array(verts.length * 3);
  verts.forEach(([x, y, z], i) => {
    const r = brainRadius(x, y, z);
    points.set([x * r, y * r, z * r], i * 3);
  });
  return { points, edges: Uint32Array.from(edges, (e) => e), count: verts.length };
}

// --- Browser ------------------------------------------------------------------

const STORAGE_KEY = "mimers-brain-links";
const DIST = 4.2;
const VIEW = { yaw: Math.PI + 0.12, pitch: 0.1, zoom: 1 };
const MESH_RGB = "125, 85, 235";
// Node colour follows size: blue for the quiet ones, green in the middle,
// white for the hubs. The vault is orange, whatever its size.
const NODE_RGB = [[70, 120, 235], [80, 165, 245], [70, 200, 150], [150, 235, 195], [235, 240, 255]];
const VAULT_RGB = [255, 140, 40];

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const rgb = (c, a = 1) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;

function sprite(color) {
  const size = 96;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  const dark = color.map((v) => Math.round(v * 0.22));
  g.addColorStop(0, rgb(dark, 1));
  g.addColorStop(0.3, rgb(dark.map((v) => v * 1.3), 1));
  g.addColorStop(0.38, rgb(color, 1));
  g.addColorStop(0.44, rgb(color, 0.55));
  g.addColorStop(0.65, rgb(color, 0.16));
  g.addColorStop(1, rgb(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

function loadEnabled() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (Array.isArray(saved)) return new Set(saved.filter((key) => LINK_TYPES.some((t) => t.key === key)));
  } catch { /* unavailable */ }
  return new Set(LINK_TYPES.map((type) => type.key));
}

// Mounts the brain into `element` and returns a function that stops it. The
// statistics page re-renders on every visit, so the old loop must not linger.
export function mountBrain(element, graph, labels) {
  const nodes = graph.nodes || [];
  element.innerHTML = `
    <div class="brain-wrap">
      <canvas class="brain-canvas" role="img"></canvas>
      <div class="brain-panel" hidden></div>
      <div class="brain-tip" hidden></div>
      <div class="brain-tools">
        <button type="button" data-zoom="in" title="${esc(labels.zoomIn)}" aria-label="${esc(labels.zoomIn)}">+</button>
        <button type="button" data-zoom="out" title="${esc(labels.zoomOut)}" aria-label="${esc(labels.zoomOut)}">−</button>
        <button type="button" data-zoom="reset" title="${esc(labels.reset)}" aria-label="${esc(labels.reset)}">⟲</button>
      </div>
      <div class="brain-hint">${esc(labels.hint)}</div>
    </div>
    <div class="brain-legend"></div>`;
  const wrap = element.querySelector(".brain-wrap");
  const canvas = element.querySelector("canvas");
  const panel = element.querySelector(".brain-panel");
  const tip = element.querySelector(".brain-tip");
  const legend = element.querySelector(".brain-legend");
  const ctx = canvas.getContext("2d");
  if (!nodes.length) {
    wrap.innerHTML = `<div class="empty">${esc(labels.empty)}</div>`;
    return () => {};
  }

  const count = nodes.length;
  const mesh = brainMesh(4);
  const meshScreen = new Float32Array(mesh.count * 3);
  const sprites = [...NODE_RGB, VAULT_RGB].map(sprite);
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const pos = new Float32Array(count * 3);
  const vel = new Float32Array(count * 3);
  const sx = new Float32Array(count), sy = new Float32Array(count);
  const sr = new Float32Array(count), sz = new Float32Array(count);
  const drawOrder = [...Array(count).keys()];
  const view = { ...VIEW };
  let enabled = loadEnabled();
  let links, homes, adjacency, sizes, colors, labelled = [];
  let width = 0, height = 0, dpr = 1, scale = 1, background = null;
  let hovered = -1, selected = -1, grabbed = -1, grabZ = 0;
  let orbit = false, moved = false, last = null, lastActive = 0;
  let running = false, frame = 0, visible = false;
  const pointers = new Map();
  let pinch = 0;

  function rebuild(first) {
    links = buildLinks(nodes, graph.edges, enabled);
    homes = layout(count, links.pairs, links.degree, { places: nodes.map((node) => node.place) });
    labelled = regions(nodes, homes).map((region) => {
      const [x, y, z] = region.dir;
      const r = brainRadius(x, y, z) * 1.02;
      return { ...region, at: [x * r, y * r, z * r] };
    });
    if (first) pos.set(homes);
    adjacency = Array.from({ length: count }, () => []);
    for (const pair of links.pairs) {
      adjacency[pair.a].push(pair);
      adjacency[pair.b].push(pair);
    }
    // Size spans the range actually present. With every kind of connection
    // on, even the quietest memory has dozens (everyone shares a person or a
    // kind with someone), so a scale from zero would draw them all alike.
    const low = Math.min(...links.degree);
    const span = Math.max(1, Math.max(...links.degree) - low);
    sizes = new Float32Array(count);
    colors = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const t = (links.degree[i] - low) / span;
      sizes[i] = 0.01 + 0.04 * t ** 1.5;
      colors[i] = nodes[i].tier === "vault" ? NODE_RGB.length : Math.min(NODE_RGB.length - 1, Math.floor(t * NODE_RGB.length));
    }
    canvas.setAttribute("aria-label", labels.summary(count, links.pairs.length));
    renderLegend();
    renderPanel();
  }

  function renderLegend() {
    legend.innerHTML = LINK_TYPES.map((type, bit) => `
      <button type="button" class="chip brain-type ${enabled.has(type.key) ? "on" : ""}" data-type="${type.key}"
        aria-pressed="${enabled.has(type.key)}">
        <i style="background:${rgb(type.color)}"></i>${esc(labels.types[type.key])}
        <b>${enabled.has(type.key) ? links.totals[bit] : "–"}</b></button>`).join("")
      + (nodes.some((node) => node.tier === "vault")
        ? `<span class="sub brain-vault"><i style="background:${rgb(VAULT_RGB)}"></i>${esc(labels.vault)}</span>` : "");
    for (const button of legend.querySelectorAll("[data-type]"))
      button.onclick = () => {
        const key = button.dataset.type;
        if (enabled.has(key)) enabled.delete(key); else enabled.add(key);
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...enabled])); } catch { /* unavailable */ }
        rebuild(false);
        wake();
      };
  }

  function typeCounts(index) {
    const counts = LINK_TYPES.map(() => 0);
    for (const pair of adjacency[index])
      for (let bit = 0; bit < LINK_TYPES.length; bit++) if (pair.mask & (1 << bit)) counts[bit]++;
    return counts;
  }

  // The memory under the cursor, or the last one picked up, with what joins it
  // to its closest neighbours: most shared kinds first, then meaning.
  function renderPanel() {
    if (selected < 0) { panel.hidden = true; return; }
    const node = nodes[selected];
    const bits = (mask) => { let n = 0; for (; mask; mask &= mask - 1) n++; return n; };
    const closest = adjacency[selected].slice()
      .sort((p, q) => bits(q.mask) - bits(p.mask) || q.s - p.s).slice(0, 5);
    const counts = typeCounts(selected);
    panel.hidden = false;
    panel.innerHTML = `
      <button type="button" class="brain-close" aria-label="${esc(labels.close)}">×</button>
      <b class="brain-title">${esc(node.title)}</b>
      <div class="sub">${esc(labels.kindName(node.kind))} · ${esc(labels.connections(links.degree[selected]))}</div>
      <div class="brain-counts">${LINK_TYPES.map((type, bit) => counts[bit]
        ? `<span><i style="background:${rgb(type.color)}"></i>${esc(labels.types[type.key])} ${counts[bit]}</span>` : "").join("")}</div>
      ${closest.length ? `<div class="sub brain-closest">${esc(labels.closest)}</div>
      <ul>${closest.map((pair) => {
        const other = pair.a === selected ? pair.b : pair.a;
        const dots = LINK_TYPES.map((type, bit) => pair.mask & (1 << bit)
          ? `<i style="background:${rgb(type.color)}"></i>` : "").join("");
        return `<li><button type="button" data-node="${other}">${dots}<span>${esc(nodes[other].title)}</span></button></li>`;
      }).join("")}</ul>` : ""}`;
    panel.querySelector(".brain-close").onclick = () => { selected = -1; renderPanel(); };
    for (const button of panel.querySelectorAll("[data-node]"))
      button.onclick = () => { selected = Number(button.dataset.node); renderPanel(); wake(); };
  }

  function resize() {
    const rect = wrap.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    width = rect.width; height = rect.height;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    scale = Math.min(width * 0.42, height * 0.6);
    // Stars and the dark backdrop never move, so they are painted once.
    background = document.createElement("canvas");
    background.width = canvas.width; background.height = canvas.height;
    const b = background.getContext("2d");
    const g = b.createRadialGradient(canvas.width / 2, canvas.height / 2, 0,
      canvas.width / 2, canvas.height / 2, Math.max(canvas.width, canvas.height) * 0.7);
    g.addColorStop(0, "#0d0f26");
    g.addColorStop(1, "#04050c");
    b.fillStyle = g;
    b.fillRect(0, 0, canvas.width, canvas.height);
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 180; i++) {
      b.fillStyle = `rgba(200, 210, 255, ${0.15 + random() * 0.5})`;
      const size = (random() < 0.9 ? 0.8 : 1.6) * dpr;
      b.fillRect(random() * canvas.width, random() * canvas.height, size, size);
    }
  }

  // World to screen. Returns nothing; writes into the given arrays at `i`.
  function camera() {
    const cy = Math.cos(view.yaw), syw = Math.sin(view.yaw);
    const cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
    const focal = scale * view.zoom * DIST;
    const cx = width / 2, cyy = height / 2;
    return (x, y, z, out, i) => {
      const X = x * cy + z * syw;
      const Z1 = -x * syw + z * cy;
      const Y = y * cp - Z1 * sp;
      const Z = y * sp + Z1 * cp;
      const s = focal / (DIST - Z);
      out[i] = cx + X * s; out[i + 1] = cyy - Y * s; out[i + 2] = Z;
      return s;
    };
  }

  // Screen back to world, at a given camera depth: where a dragged node goes.
  function unproject(px, py, Z) {
    const focal = scale * view.zoom * DIST;
    const depth = DIST - Z;
    const X = (px - width / 2) * depth / focal;
    const Y = -(py - height / 2) * depth / focal;
    const cy = Math.cos(view.yaw), syw = Math.sin(view.yaw);
    const cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
    const y = Y * cp + Z * sp;
    const Z1 = -Y * sp + Z * cp;
    return [X * cy - Z1 * syw, y, X * syw + Z1 * cy];
  }

  // How far each neighbour leans after a held memory, as a share of how far
  // the held one has moved. Only a nudge: the held memory stretches its lines
  // out while the rest of the brain stays where it is. Closer neighbours and
  // ones joined in more ways lean a little more, so the brain never moves as
  // one block even when the held memory touches most of it.
  let lean = new Map();
  function measureLean(index) {
    lean = new Map();
    for (const pair of adjacency[index]) {
      const other = pair.a === index ? pair.b : pair.a;
      let ways = 0;
      for (let mask = pair.mask; mask; mask &= mask - 1) ways++;
      const distance = Math.hypot(homes[other * 3] - homes[index * 3],
        homes[other * 3 + 1] - homes[index * 3 + 1], homes[other * 3 + 2] - homes[index * 3 + 2]);
      lean.set(other, Math.min(0.1, 0.03 * ways) * Math.exp(-distance / 0.5));
    }
  }

  // Released memories spring home slowly.
  function physics() {
    for (let i = 0; i < count; i++) {
      if (i === grabbed) { vel[i * 3] = vel[i * 3 + 1] = vel[i * 3 + 2] = 0; continue; }
      const share = grabbed >= 0 ? lean.get(i) || 0 : 0;
      for (let c = 0; c < 3; c++) {
        const j = i * 3 + c;
        const target = homes[j] + (share ? (pos[grabbed * 3 + c] - homes[grabbed * 3 + c]) * share : 0);
        vel[j] = (vel[j] + (target - pos[j]) * 0.006) * 0.86;
        pos[j] += vel[j];
      }
    }
  }

  function focusNode() {
    return grabbed >= 0 ? grabbed : hovered >= 0 ? hovered : selected;
  }

  // The lit memory fades in over about three quarters of a second and out
  // over a quarter. Moving the cursor across a crowded patch then shows a
  // calm glow instead of a new set of lines flashing up for every node passed.
  let lit = -1, glow = 0;
  function fadeLight() {
    const want = focusNode();
    if (want !== lit) {
      glow = Math.max(0, glow - 1 / 15);
      if (glow === 0) lit = want;
    } else if (lit >= 0) glow = Math.min(1, glow + 1 / 45);
  }

  function draw() {
    const project = camera();
    const tmp = new Float32Array(3);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.drawImage(background, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Wireframe, in three depth bands so the far side reads as further away.
    for (let i = 0; i < mesh.count; i++)
      project(mesh.points[i * 3], mesh.points[i * 3 + 1], mesh.points[i * 3 + 2], meshScreen, i * 3);
    ctx.lineWidth = 0.6;
    const bands = [new Path2D(), new Path2D(), new Path2D()];
    for (const edge of mesh.edges) {
      const a = Math.floor(edge / 65536) * 3, b = (edge % 65536) * 3;
      const z = meshScreen[a + 2] + meshScreen[b + 2];
      const path = bands[z < -0.5 ? 0 : z < 0.5 ? 1 : 2];
      path.moveTo(meshScreen[a], meshScreen[a + 1]);
      path.lineTo(meshScreen[b], meshScreen[b + 1]);
    }
    [0.09, 0.17, 0.3].forEach((alpha, i) => {
      ctx.strokeStyle = `rgba(${MESH_RGB}, ${alpha})`;
      ctx.stroke(bands[i]);
    });

    for (let i = 0; i < count; i++) {
      const s = project(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], tmp, 0);
      sx[i] = tmp[0]; sy[i] = tmp[1]; sz[i] = tmp[2]; sr[i] = sizes[i] * s;
    }

    // Connections. At rest every pair is a faint line in its rarest colour;
    // with a memory in focus its own lines brighten, one per kind of
    // connection, side by side, while the rest dim a little.
    const focus = lit;
    const g = glow * glow * (3 - 2 * glow);
    ctx.globalCompositeOperation = "lighter";
    const pairs = links.pairs;
    const restAlpha = Math.min(0.22, Math.max(0.025, 6 / Math.sqrt(pairs.length || 1)));
    const paths = LINK_TYPES.map(() => new Path2D());
    for (const pair of pairs) {
      const path = paths[pair.primary];
      path.moveTo(sx[pair.a], sy[pair.a]);
      path.lineTo(sx[pair.b], sy[pair.b]);
    }
    ctx.lineWidth = 0.7;
    LINK_TYPES.forEach((type, bit) => {
      ctx.strokeStyle = rgb(type.color, restAlpha * (1 - 0.6 * g));
      ctx.stroke(paths[bit]);
    });
    let near = null;
    if (focus >= 0 && g > 0) {
      near = new Set([focus]);
      const lit = LINK_TYPES.map(() => new Path2D());
      for (const pair of adjacency[focus]) {
        near.add(pair.a === focus ? pair.b : pair.a);
        const dx = sx[pair.b] - sx[pair.a], dy = sy[pair.b] - sy[pair.a];
        const length = Math.hypot(dx, dy) || 1;
        const nx = -dy / length * 1.5, ny = dx / length * 1.5;
        const bits = [];
        for (let bit = 0; bit < LINK_TYPES.length; bit++) if (pair.mask & (1 << bit)) bits.push(bit);
        bits.forEach((bit, k) => {
          const o = k - (bits.length - 1) / 2;
          lit[bit].moveTo(sx[pair.a] + nx * o, sy[pair.a] + ny * o);
          lit[bit].lineTo(sx[pair.b] + nx * o, sy[pair.b] + ny * o);
        });
      }
      ctx.lineWidth = 0.9;
      LINK_TYPES.forEach((type, bit) => {
        ctx.strokeStyle = rgb(type.color, 0.4 * g);
        ctx.stroke(lit[bit]);
      });
    }

    // Nodes, back to front, painted over one another: their dark cores must
    // hide what is behind them, or the dense middle adds up to plain white.
    ctx.globalCompositeOperation = "source-over";
    drawOrder.sort((a, b) => sz[a] - sz[b]);
    for (const i of drawOrder) {
      const depth = Math.min(1, Math.max(0, (sz[i] + 1.2) / 2.4));
      let alpha = 0.4 + 0.6 * depth;
      if (near && !near.has(i)) alpha *= 1 - 0.6 * g;
      const r = sr[i] * (i === focus ? 1 + 0.15 * g : 1) * 2.6;
      ctx.globalAlpha = alpha;
      ctx.drawImage(sprites[colors[i]], sx[i] - r, sy[i] - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;

    // Region labels, on top and faint; those on the far side fade further.
    ctx.font = "600 12px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    for (const region of labelled) {
      project(region.at[0], region.at[1], region.at[2], tmp, 0);
      const front = Math.min(1, Math.max(0, (tmp[2] + 1) / 2));
      ctx.globalAlpha = (0.12 + 0.68 * front) * (1 - 0.5 * g);
      ctx.strokeStyle = "rgba(4, 5, 12, 0.85)";
      ctx.strokeText(region.label, tmp[0], tmp[1]);
      ctx.fillStyle = "rgb(225, 228, 255)";
      ctx.fillText(region.label, tmp[0], tmp[1]);
    }
    ctx.globalAlpha = 1;
    if (selected >= 0 && selected !== focus) {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(sx[selected], sy[selected], sr[selected] * 1.6 + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Physics runs in fixed 60 Hz steps, so a 144 Hz screen does not make the
  // brain spin or spring back faster than a 60 Hz one.
  let previous = 0, pending = 0;
  function tick(now) {
    if (!running) return;
    frame = requestAnimationFrame(tick);
    pending = Math.min(pending + (previous ? now - previous : 16.7), 100);
    previous = now;
    for (; pending >= 16.7; pending -= 16.7) {
      if (!reduceMotion && grabbed < 0 && !orbit && pointers.size === 0 && now - lastActive > 5000)
        view.yaw += 0.0012;
      physics();
      fadeLight();
    }
    draw();
  }

  function wake() {
    lastActive = performance.now();
    if (!running && visible && !document.hidden) {
      running = true;
      frame = requestAnimationFrame(tick);
    }
  }
  function sleep() {
    running = false;
    previous = 0;
    cancelAnimationFrame(frame);
  }

  // Frontmost node within reach of the pointer.
  function pick(px, py) {
    let best = -1;
    for (let i = 0; i < count; i++) {
      const reach = Math.max(sr[i] + 3, 7);
      if ((sx[i] - px) ** 2 + (sy[i] - py) ** 2 > reach * reach) continue;
      if (best < 0 || sz[i] > sz[best]) best = i;
    }
    return best;
  }

  function local(event) {
    const rect = canvas.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }

  function showTip(index, px, py) {
    if (index < 0) { tip.hidden = true; return; }
    tip.hidden = false;
    tip.innerHTML = `<b>${esc(nodes[index].title)}</b><span>${esc(labels.connections(links.degree[index]))}</span>`;
    const x = Math.min(px + 14, width - tip.offsetWidth - 6);
    const y = py + 16 + tip.offsetHeight > height ? py - tip.offsetHeight - 10 : py + 16;
    tip.style.transform = `translate(${Math.max(6, x)}px, ${y}px)`;
  }

  canvas.addEventListener("pointerdown", (event) => {
    try { canvas.setPointerCapture(event.pointerId); } catch { /* synthetic pointer */ }
    pointers.set(event.pointerId, local(event));
    wake();
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = Math.hypot(a[0] - b[0], a[1] - b[1]);
      grabbed = -1; orbit = false;
      return;
    }
    const [px, py] = local(event);
    last = [px, py];
    moved = false;
    const hit = pick(px, py);
    if (hit >= 0) {
      grabbed = hit; selected = hit; grabZ = sz[hit];
      measureLean(hit);
      canvas.style.cursor = "grabbing";
      renderPanel();
    } else orbit = true;
    tip.hidden = true;
  });

  canvas.addEventListener("pointermove", (event) => {
    const [px, py] = local(event);
    if (pointers.has(event.pointerId)) pointers.set(event.pointerId, [px, py]);
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch) view.zoom = Math.min(5, Math.max(0.5, view.zoom * distance / pinch));
      pinch = distance;
      wake();
      return;
    }
    if (last && Math.hypot(px - last[0], py - last[1]) > 3) moved = true;
    if (grabbed >= 0) {
      const [x, y, z] = unproject(px, py, grabZ);
      pos[grabbed * 3] = x; pos[grabbed * 3 + 1] = y; pos[grabbed * 3 + 2] = z;
      wake();
    } else if (orbit && last) {
      view.yaw += (px - last[0]) * 0.007;
      view.pitch = Math.min(1.25, Math.max(-1.25, view.pitch + (py - last[1]) * 0.007));
      last = [px, py];
      wake();
    } else if (!pointers.size) {
      const hit = pick(px, py);
      if (hit !== hovered) { hovered = hit; wake(); }
      canvas.style.cursor = hit >= 0 ? "grab" : "";
      showTip(hit, px, py);
    }
  });

  const release = (event) => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = 0;
    if (orbit && !moved && pointers.size === 0) { selected = -1; renderPanel(); }
    if (pointers.size === 0) { grabbed = -1; orbit = false; last = null; }
    canvas.style.cursor = "";
    wake();
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("pointerleave", () => {
    if (pointers.size) return;
    hovered = -1;
    tip.hidden = true;
  });
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    view.zoom = Math.min(5, Math.max(0.5, view.zoom * Math.exp(-event.deltaY * 0.0012)));
    wake();
  }, { passive: false });

  for (const button of element.querySelectorAll("[data-zoom]"))
    button.onclick = () => {
      const action = button.dataset.zoom;
      if (action === "in") view.zoom = Math.min(5, view.zoom * 1.25);
      else if (action === "out") view.zoom = Math.max(0.5, view.zoom / 1.25);
      else { Object.assign(view, VIEW); selected = -1; renderPanel(); }
      wake();
    };

  // Only animate while the brain can be seen.
  const resizer = new ResizeObserver(() => { resize(); if (visible) draw(); });
  const watcher = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) wake(); else sleep();
  });
  const onVisibility = () => (document.hidden ? sleep() : wake());
  document.addEventListener("visibilitychange", onVisibility);

  rebuild(true);
  resize();
  resizer.observe(wrap);
  watcher.observe(wrap);

  return () => {
    sleep();
    resizer.disconnect();
    watcher.disconnect();
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
