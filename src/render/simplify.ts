// Vertex-clustering simplification for far-away agent proxies. Pure (no three.js): works on
// flat position and index arrays, so tests/render/agent-lod.test.ts covers it.
//
// Every vertex snaps to the average position of the grid cell it falls in; a triangle whose
// corners land in fewer than three cells disappears, and of several triangles over the same
// three cells with the same winding only the first is kept. Triangles flagged `keep` (lamps:
// small, and the only thing visible of a car at night) pass through untouched. The result is
// a triangle soup: output triangle t is a simplified copy of input triangle source[t], so the
// caller copies per-triangle attributes (colour, material) from the source.

export interface Simplified {
  /** 9 floats per output triangle. */
  positions: Float32Array;
  /** Input triangle index of each output triangle. */
  source: Int32Array;
}

export function clusterSimplify(
  positions: ArrayLike<number>,
  index: ArrayLike<number> | null,
  cell: number,
  keep: (triangle: number) => boolean = () => false,
): Simplified {
  const nv = Math.floor(positions.length / 3);
  const nt = Math.floor((index ? index.length : nv) / 3);
  const vi = (t: number, k: number): number => (index ? index[t * 3 + k]! : t * 3 + k);
  const inv = 1 / cell;
  // Cell of each vertex, and the running average position of each cell.
  const cellOf = new Int32Array(nv);
  const ids = new Map<string, number>();
  const sum: number[] = [];
  for (let v = 0; v < nv; v++) {
    const x = positions[v * 3]!;
    const y = positions[v * 3 + 1]!;
    const z = positions[v * 3 + 2]!;
    const key = `${Math.floor(x * inv)},${Math.floor(y * inv)},${Math.floor(z * inv)}`;
    let c = ids.get(key);
    if (c === undefined) {
      c = ids.size;
      ids.set(key, c);
      sum.push(0, 0, 0, 0);
    }
    cellOf[v] = c;
    sum[c * 4]! += x;
    sum[c * 4 + 1]! += y;
    sum[c * 4 + 2]! += z;
    sum[c * 4 + 3]! += 1;
  }
  const out: number[] = [];
  const src: number[] = [];
  const seen = new Set<string>();
  for (let t = 0; t < nt; t++) {
    const a = vi(t, 0);
    const b = vi(t, 1);
    const c = vi(t, 2);
    if (keep(t)) {
      for (const v of [a, b, c]) out.push(positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!);
      src.push(t);
      continue;
    }
    const ca = cellOf[a]!;
    const cb = cellOf[b]!;
    const cc = cellOf[c]!;
    if (ca === cb || cb === cc || ca === cc) continue;
    // Same cells and winding = same triangle: rotate so the smallest cell comes first.
    const r = ca < cb && ca < cc ? [ca, cb, cc] : cb < cc ? [cb, cc, ca] : [cc, ca, cb];
    const key = `${r[0]},${r[1]},${r[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const k of [ca, cb, cc]) {
      const n = sum[k * 4 + 3]!;
      out.push(sum[k * 4]! / n, sum[k * 4 + 1]! / n, sum[k * 4 + 2]! / n);
    }
    src.push(t);
  }
  return { positions: Float32Array.from(out), source: Int32Array.from(src) };
}
