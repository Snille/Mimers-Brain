// Meaning in three dimensions, for the brain on the statistics page.
//
// Every embedding is 1536 numbers. Principal component analysis finds the
// three directions along which the memories differ the most and reads each
// memory's position along them, so memories that mean much the same thing land
// near one another. Power iteration on the centred rows is enough at this size:
// a few hundred memories, three components, no matrix library.

const ITERATIONS = 60;

function normalise(v) {
  let length = 0;
  for (const x of v) length += x * x;
  length = Math.sqrt(length) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= length;
  return v;
}

// rows: arrays of equal length. Returns one [a, b, c] per row, each axis scaled
// to unit spread so no single axis flattens the picture. Deterministic: the
// start vector is fixed and each axis's sign is chosen so its largest
// coordinate is positive, so the same memories keep their places.
export function semanticAxes(rows, components = 3) {
  const n = rows.length;
  if (!n) return [];
  const dims = rows[0].length;
  const mean = new Float64Array(dims);
  for (const row of rows) for (let d = 0; d < dims; d++) mean[d] += row[d] / n;
  const data = rows.map((row) => Float64Array.from(row, (x, d) => x - mean[d]));

  const out = rows.map(() => new Array(components).fill(0));
  const found = [];
  for (let c = 0; c < components; c++) {
    let v = normalise(Float64Array.from({ length: dims }, (_, d) => Math.sin(d * 12.9898 + c * 78.233)));
    const scores = new Float64Array(n);
    for (let step = 0; step < ITERATIONS; step++) {
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let d = 0; d < dims; d++) s += data[i][d] * v[d];
        scores[i] = s;
      }
      const next = new Float64Array(dims);
      for (let i = 0; i < n; i++) for (let d = 0; d < dims; d++) next[d] += scores[i] * data[i][d];
      // Remove what earlier components already explain.
      for (const earlier of found) {
        let dot = 0;
        for (let d = 0; d < dims; d++) dot += next[d] * earlier[d];
        for (let d = 0; d < dims; d++) next[d] -= dot * earlier[d];
      }
      v = normalise(next);
    }
    let biggest = 0;
    for (let d = 0; d < dims; d++) if (Math.abs(v[d]) > Math.abs(biggest)) biggest = v[d];
    if (biggest < 0) for (let d = 0; d < dims; d++) v[d] = -v[d];
    found.push(v);

    let spread = 0;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let d = 0; d < dims; d++) s += data[i][d] * v[d];
      scores[i] = s;
      spread += s * s / n;
    }
    spread = Math.sqrt(spread) || 1;
    for (let i = 0; i < n; i++) out[i][c] = Math.round(scores[i] / spread * 1000) / 1000;
  }
  return out;
}
