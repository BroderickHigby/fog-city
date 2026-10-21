// Gate nightly checks on the drawn world: every tile GLB decoded (meshopt) and compared with the
// colliders and the sim (docs/qa/world-continuity-gate.md, sections A and C): collider/mesh
// parity, floating wall bottoms, the drawn road against the sim's surface, the ground poking
// through ribbons, ribbons drawn twice, and the ground meeting across seams.

import { cellKey } from "../../../src/sim/index.ts";
import { bbox, meshGroundHeight, percentile, r2, r3, readGlb, resample, surfaceAt, topHeightAt, triangleHeight, type GameWorld, type GlbNode } from "../world.ts";
import { Measured } from "./suite.ts";

/** Visit a 0.5 m raster of cell centres inside one triangle (xz), with the triangle's height there. */
function rasterTriangle(P: Float32Array, a: number, b: number, c: number, step: number, fn: (x: number, z: number, y: number) => void): void {
  const ax = P[a]!, ay = P[a + 1]!, az = P[a + 2]!;
  const bx = P[b]!, by = P[b + 1]!, bz = P[b + 2]!;
  const cx = P[c]!, cy = P[c + 1]!, cz = P[c + 2]!;
  const x0 = Math.floor(Math.min(ax, bx, cx) / step) * step + step / 2;
  const z0 = Math.floor(Math.min(az, bz, cz) / step) * step + step / 2;
  const x1 = Math.max(ax, bx, cx);
  const z1 = Math.max(az, bz, cz);
  for (let x = x0; x < x1; x += step) {
    for (let z = z0; z < z1; z += step) {
      const y = triangleHeight(x, z, ax, ay, az, bx, by, bz, cx, cy, cz);
      if (y !== null) fn(x, z, y);
    }
  }
}

export async function measureGlb(gw: GameWorld): Promise<Measured> {
  const m = new Measured("glb", "nightly");
  const world = gw.world;
  const colliders = new Map(gw.tiles.map((t) => [t.tileId, t]));
  let parityBad = 0;
  const parityFirst: string[] = [];
  let floating = 0;
  const floatFirst: string[] = [];
  let roadSamples = 0;
  let roadSunk = 0;
  let roadMax = 0;
  let roadMaxAt = "";
  const roadD: number[] = [];
  let ribbonCells = 0;
  let poke = 0;
  let fwyCells = 0;
  let fwyUnder = 0;
  let covered = 0;
  let double = 0;
  const borders = new Map<string, number>();
  let seamBad = 0;
  // Edges by tile: an edge belongs to every tile its 2 m samples fall in.
  const edgesByTile = new Map<string, Array<{ e: (typeof gw.roads.edges)[number]; pts: Array<[number, number]> }>>();
  for (const e of gw.roads.edges) {
    if (e.pedestrian || e.gradeSeparated || e.kind === "ramp") continue;
    const pts = resample(e.points, 2);
    const seen = new Set<string>();
    for (const [x, z] of pts) {
      const id = `t${Math.floor(x / 500)}_${Math.floor(z / 500)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const l = edgesByTile.get(id) ?? [];
      l.push({ e, pts });
      edgesByTile.set(id, l);
    }
  }
  for (const t of gw.manifest.tiles) {
    if (!t.glb) continue;
    const g = await readGlb(`public/tiles/${gw.name}/${t.glb}`, ["ground", "roads", "freeways", "buildings"], ["POSITION"]);
    const node = (name: string): GlbNode | undefined => g.nodes.find((n) => n.name === name);
    const col = colliders.get(t.id);
    // ---- parity: one GLB range per collider record, same order, same extents
    const bn = node("buildings");
    const recs = col?.buildings ?? [];
    const ranges = (bn?.extras?.buildings ?? []) as Array<[string, number, number]>;
    if (ranges.length !== recs.length || ranges.some((r, i) => r[0] !== recs[i]!.id)) {
      parityBad += Math.max(1, Math.abs(ranges.length - recs.length));
      if (parityFirst.length < 10) parityFirst.push(`${t.id}: ${ranges.length} ranges, ${recs.length} records`);
    } else if (bn) {
      ranges.forEach(([id, first, count], i) => {
        const r = recs[i]!;
        let maxY = -Infinity;
        let minY = Infinity;
        let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
        const bottoms: number[] = [];
        for (let k = first; k < first + count; k++) {
          const v = bn.indices[k]! * 3;
          const x = bn.positions[v]!;
          const y = bn.positions[v + 1]!;
          const z = bn.positions[v + 2]!;
          maxY = Math.max(maxY, y);
          minY = Math.min(minY, y);
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
          z0 = Math.min(z0, z);
          z1 = Math.max(z1, z);
          bottoms.push(v);
        }
        const [fx0, fz0, fx1, fz1] = bbox(r.footprint);
        const tol = 0.1 + 2 * (bn.positions.length ? 1 / 64 : 0);
        if (Math.abs(maxY - r.topY) > tol || Math.abs(x0 - fx0) > tol || Math.abs(x1 - fx1) > tol || Math.abs(z0 - fz0) > tol || Math.abs(z1 - fz1) > tol) {
          parityBad++;
          if (parityFirst.length < 10) parityFirst.push(`${id}: top ${r2(maxY)} vs ${r.topY}`);
        }
        // Floating wall bottoms (L-02): the lowest vertices against the drawn ground under them.
        let float = 0;
        for (const v of bottoms) {
          const y = bn.positions[v + 1]!;
          if (y > minY + 0.01) continue;
          float = Math.max(float, y - meshGroundHeight(world, bn.positions[v]!, bn.positions[v + 2]!));
        }
        if (float > 0.05) {
          floating++;
          if (floatFirst.length < 10) floatFirst.push(`${id} ${r2(float)} m`);
        }
      });
    }
    // ---- the drawn road against the sim's surface (W-09)
    const rn = node("roads");
    if (rn) {
      for (const { e, pts } of edgesByTile.get(t.id) ?? []) {
        const half = (e.widthM ?? 8) / 2;
        for (let i = 0; i < pts.length; i++) {
          const [x, z] = pts[i]!;
          if (Math.floor(x / 500) !== t.ix || Math.floor(z / 500) !== t.iz) continue;
          const j = Math.min(pts.length - 1, i + 1);
          const k = Math.max(0, i - 1);
          const dx = pts[j]![0] - pts[k]![0];
          const dz = pts[j]![1] - pts[k]![1];
          const L = Math.hypot(dx, dz) || 1;
          for (const off of [0, half - 0.3, -(half - 0.3)]) {
            const sx = x - (dz / L) * off;
            const sz = z + (dx / L) * off;
            const drawn = topHeightAt(rn, sx, sz);
            if (drawn === null) continue;
            const d = drawn - surfaceAt(world, sx, sz);
            roadSamples++;
            roadD.push(Math.abs(d));
            if (d > 0.3) roadSunk++;
            if (Math.abs(d) > roadMax) {
              roadMax = Math.abs(d);
              roadMaxAt = `${e.id} ${e.name}`;
            }
          }
        }
      }
      // ---- the ground through the ribbons (W-10) and ribbons drawn twice (W-32), on a 0.5 m raster
      const counts = new Uint8Array(1000 * 1000);
      const ox = (t.ix ?? 0) * 500;
      const oz = (t.iz ?? 0) * 500;
      for (let q = 0; q < rn.indices.length; q += 3) {
        rasterTriangle(rn.positions, rn.indices[q]! * 3, rn.indices[q + 1]! * 3, rn.indices[q + 2]! * 3, 0.5, (x, z, y) => {
          const i = Math.floor((x - ox) * 2);
          const k = Math.floor((z - oz) * 2);
          if (i < 0 || i >= 1000 || k < 0 || k >= 1000) return;
          const c = counts[k * 1000 + i]!;
          if (c === 0) {
            ribbonCells++;
            if (meshGroundHeight(world, x, z) > y + 0.02) poke++;
          }
          if (c < 255) counts[k * 1000 + i] = c + 1;
        });
      }
      for (let c = 0; c < counts.length; c++) {
        if (counts[c]! >= 1) covered++;
        if (counts[c]! >= 2) double++;
      }
    }
    const fn = node("freeways");
    if (fn) {
      for (let q = 0; q < fn.indices.length; q += 3) {
        rasterTriangle(fn.positions, fn.indices[q]! * 3, fn.indices[q + 1]! * 3, fn.indices[q + 2]! * 3, 1, (x, z, y) => {
          fwyCells++;
          if (meshGroundHeight(world, x, z) > y + 0.02) fwyUnder++;
        });
      }
    }
    // ---- ground border vertices agree across seams
    const gn = node("ground");
    if (gn) {
      for (let v = 0; v < gn.positions.length; v += 3) {
        const x = gn.positions[v]!;
        const z = gn.positions[v + 2]!;
        const onX = x % 500 === 0;
        const onZ = z % 500 === 0;
        if (!onX && !onZ) continue;
        const key = `${x},${z}`;
        const y = gn.positions[v + 1]!;
        const prev = borders.get(key);
        if (prev === undefined) borders.set(key, y);
        else if (prev !== y) seamBad++;
      }
    }
  }
  void cellKey;
  m.metric({ id: "N.glb.parityMismatches", target: 0, better: "lower", unit: "records", defects: [], desc: "building records without exactly one GLB range in the same order, or whose drawn roof and footprint extents differ from the collider by more than 0.1 m (invisible walls, ghost meshes)" }, parityBad, parityFirst);
  m.metric({ id: "N.glb.floatingWallBottoms", target: 0, better: "lower", unit: "buildings", defects: ["L-02"], desc: "buildings whose drawn wall bottoms stand more than 0.05 m above the drawn ground" }, floating, floatFirst);
  m.metric({ id: "N.glb.roadSunkShare", target: 0, better: "lower", unit: "share of samples", defects: ["W-09"], desc: "centreline and kerb-inset samples (every 2 m of every surface street) where the drawn road is more than 0.3 m above the sim's surface (the car sinks into the road)" }, r3(roadSamples ? roadSunk / roadSamples : 0), { samples: roadSamples });
  m.metric({ id: "N.glb.roadSurfaceMaxM", target: 0.05, better: "lower", unit: "m", defects: ["W-09"], desc: "the largest |drawn road top - sim surface| over the same samples" }, r2(roadMax), roadMaxAt);
  m.metric({ id: "N.glb.roadSurfaceP99M", target: 0.05, better: "lower", unit: "m", defects: ["W-09"], desc: "the 99th percentile of |drawn road top - sim surface| over the same samples" }, r3(percentile(roadD, 99)));
  m.metric({ id: "N.glb.groundThroughRoadsShare", target: 0, better: "lower", unit: "share of road area", defects: ["W-10"], desc: "road ribbon area (0.5 m raster) where the drawn ground is more than 0.02 m above the ribbon" }, r3(ribbonCells ? poke / ribbonCells : 0), { cells: ribbonCells });
  m.metric({ id: "N.glb.freewayUnderGroundShare", target: 0, better: "lower", unit: "share of freeway area", defects: ["W-03", "W-10"], desc: "freeway ribbon area (1 m raster) under the drawn ground" }, r3(fwyCells ? fwyUnder / fwyCells : 0));
  m.metric({ id: "N.glb.doubleRibbonShare", target: 0.005, better: "lower", unit: "share of road area", defects: ["W-32"], desc: "road area (0.5 m raster) covered by two or more ribbons at once (junction overlaps that z-fight)" }, r3(covered ? double / covered : 0), { coveredKm2: r3((covered * 0.25) / 1e6) });
  m.metric({ id: "N.glb.groundSeamMismatches", target: 0, better: "lower", unit: "vertices", defects: [], desc: "ground border vertices whose height differs from the neighbouring tile's vertex at the same place (cracks)" }, seamBad);
  return m;
}
