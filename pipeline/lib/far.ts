// Citywide far-LOD massing: every building footprint, heavily simplified and merged per large
// cell, so the renderer can draw the whole skyline and the hills beyond the streaming radius.
//
// Per cell (a square of cellM on a grid anchored at the world's north-west corner) one glb with
// one node "far" and one primitive (one draw call), no normals (three.js shades it flat), vertex
// colours. The parameters are FarParams (defaults in FAR_DEFAULTS):
//   * terrain: the DEM on a coarse lattice (groundStepM), land quads only, lowered groundDropM so
//     the sea plane and near tiles win where they overlap;
//   * tall records (tallM and up): each record's convex hull, simplified, flat roof;
//   * everything else: records closer than clusterGapM merge into a cluster (in SF, a row of
//     houses or a block face); a cluster becomes its convex hull, simplified, at the members'
//     area-weighted mean height above the terrain, its roof following the terrain.
// Every hull's walls start skirtM below the lowest ground under it, so coarse terrain never
// shows a gap. The renderer is meant to draw this layer only beyond the streamed radius.

import type { Building } from "./buildings.ts";
import { signedArea, type P2 } from "./geom.ts";
import { meshGlb } from "./glb.ts";
import { facadeStyle, MeshData, rgba } from "./mesh.ts";

export interface FarParams {
  /** Cell side, metres. The whole city must fit in at most 40 cells (one draw call each). */
  cellM: number;
  /** Terrain lattice step, metres. */
  groundStepM: number;
  groundDropM: number;
  /** Records at least this tall (roof above street level) keep their own hull. */
  tallM: number;
  /** Records closer than this merge into one cluster. */
  clusterGapM: number;
  skirtM: number;
  /** Vertex caps for hulls (each hull of n vertices costs 3n - 2 triangles). */
  tallMaxVerts: number;
  clusterMaxVerts: number;
  singleMaxVerts: number;
}

export const FAR_DEFAULTS: FarParams = {
  cellM: 2500,
  groundStepM: 100,
  groundDropM: 0.5,
  tallM: 30,
  clusterGapM: 2,
  skirtM: 3,
  tallMaxVerts: 6,
  clusterMaxVerts: 6,
  singleMaxVerts: 4,
};
export const FAR_CELL_M = FAR_DEFAULTS.cellM;

export interface FarCellOut {
  id: string;
  cx: number;
  cz: number;
  bbox: [number, number, number, number];
  glb: Uint8Array;
  stats: { records: number; hulls: number; triangles: number };
}

export interface FarInputs {
  buildings: readonly Building[];
  /** Ground anywhere the DEM covers (null outside it), and whether it is water. */
  terrain: (x: number, z: number) => { h: number; water: boolean } | null;
  /** The rectangle far terrain may cover (the DEM's reach), [minX, minZ, maxX, maxZ]. */
  bounds: readonly [number, number, number, number];
}

/** Andrew's monotone chain; returns the hull counter-clockwise on a north-up map (negative shoelace). */
export function convexHull(points: readonly P2[]): P2[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: P2, a: P2, b: P2): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: P2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: P2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  if (signedArea(hull) > 0) hull.reverse();
  return hull;
}

/** Drop vertices of a convex ring, the one cutting the least area first, down to `max`. */
export function simplifyConvex(ring: readonly P2[], max: number): P2[] {
  const r = ring.slice();
  const tri = (a: P2, b: P2, c: P2): number => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
  while (r.length > Math.max(3, max)) {
    let best = 0;
    let bestA = Infinity;
    for (let i = 0; i < r.length; i++) {
      const a = tri(r[(i + r.length - 1) % r.length]!, r[i]!, r[(i + 1) % r.length]!);
      if (a < bestA) {
        bestA = a;
        best = i;
      }
    }
    r.splice(best, 1);
  }
  return r;
}

function bbox(ring: readonly P2[]): [number, number, number, number] {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const [x, z] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return [minX, minZ, maxX, maxZ];
}

/** Smallest distance between two rings' boundaries (0 if they cross or one is inside the other's bbox edge). */
function ringGap(a: readonly P2[], b: readonly P2[]): number {
  let best = Infinity;
  const seg = (p: P2, s0: P2, s1: P2): number => {
    const ex = s1[0] - s0[0], ez = s1[1] - s0[1];
    const l2 = ex * ex + ez * ez;
    let t = l2 > 0 ? ((p[0] - s0[0]) * ex + (p[1] - s0[1]) * ez) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(p[0] - (s0[0] + ex * t), p[1] - (s0[1] + ez * t));
  };
  for (const p of a) for (let i = 0; i < b.length; i++) best = Math.min(best, seg(p, b[i]!, b[(i + 1) % b.length]!));
  for (const p of b) for (let i = 0; i < a.length; i++) best = Math.min(best, seg(p, a[i]!, a[(i + 1) % a.length]!));
  return best;
}

interface Hull {
  ring: P2[];
  /** Height of the roof above the terrain (clusters) or absolute roof y (tall). */
  top: number;
  absolute: boolean;
  wall: string;
  roof: string;
  records: number;
}

/** Clusters of non-tall records (union-find over a spatial hash), in a deterministic order. */
function clusterHulls(low: readonly Building[], p: FarParams): Hull[] {
  const GAP = p.clusterGapM;
  const n = low.length;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const boxes = low.map((b) => bbox(b.footprint));
  const CELL = 40;
  const grid = new Map<string, number[]>();
  boxes.forEach((bb, i) => {
    for (let cx = Math.floor((bb[0] - GAP) / CELL); cx <= Math.floor((bb[2] + GAP) / CELL); cx++) {
      for (let cz = Math.floor((bb[1] - GAP) / CELL); cz <= Math.floor((bb[3] + GAP) / CELL); cz++) {
        const k = `${cx},${cz}`;
        let l = grid.get(k);
        if (!l) grid.set(k, (l = []));
        l.push(i);
      }
    }
  });
  for (const list of grid.values()) {
    for (let p = 0; p < list.length; p++) {
      const i = list[p]!;
      for (let q = p + 1; q < list.length; q++) {
        const j = list[q]!;
        const a = boxes[i]!, b = boxes[j]!;
        if (a[0] - GAP > b[2] || b[0] - GAP > a[2] || a[1] - GAP > b[3] || b[1] - GAP > a[3]) continue;
        const ri = find(i), rj = find(j);
        if (ri === rj) continue;
        if (ringGap(low[i]!.footprint, low[j]!.footprint) <= GAP) parent[Math.max(ri, rj)] = Math.min(ri, rj);
      }
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(i);
  }
  const hulls: Hull[] = [];
  for (const r of [...groups.keys()].sort((a, b) => a - b)) {
    const members = groups.get(r)!.map((i) => low[i]!);
    let area = 0;
    let hsum = 0;
    let biggest = members[0]!;
    let biggestA = -1;
    const pts: P2[] = [];
    for (const m of members) {
      const a = Math.abs(signedArea(m.footprint));
      area += a;
      hsum += a * (m.topY - m.baseY);
      if (a > biggestA) {
        biggestA = a;
        biggest = m;
      }
      for (const p of m.footprint) pts.push(p);
    }
    const hull = simplifyConvex(convexHull(pts), members.length === 1 ? p.singleMaxVerts : p.clusterMaxVerts);
    if (hull.length < 3) continue;
    const style = facadeStyle(biggest);
    hulls.push({ ring: hull, top: area > 0 ? hsum / area : biggest.topY - biggest.baseY, absolute: false, wall: style.wall, roof: style.roof, records: members.length });
  }
  return hulls;
}

function emitHull(m: MeshData, h: Hull, ground: (x: number, z: number) => number, skirtM: number): number {
  const n = h.ring.length;
  const g = h.ring.map(([x, z]) => ground(x, z));
  const bottom = Math.min(...g) - skirtM;
  const tops = h.ring.map((_, i) => (h.absolute ? h.top : g[i]! + h.top));
  const wallCol = rgba(h.wall, 0.92);
  const footCol = rgba(h.wall, 0.75);
  const roofCol = rgba(h.roof);
  let tris = 0;
  for (let i = 0; i < n; i++) {
    const a = h.ring[i]!;
    const c = h.ring[(i + 1) % n]!;
    const b0 = m.vertex(a[0], bottom, a[1], footCol);
    const b1 = m.vertex(c[0], bottom, c[1], footCol);
    const t1 = m.vertex(c[0], tops[(i + 1) % n]!, c[1], wallCol);
    const t0 = m.vertex(a[0], tops[i]!, a[1], wallCol);
    const ox = -(c[1] - a[1]);
    const oz = c[0] - a[0];
    m.tri(b0, b1, t1, ox, 0, oz);
    m.tri(b0, t1, t0, ox, 0, oz);
    tris += 2;
  }
  const r = h.ring.map(([x, z], i) => m.vertex(x, tops[i]!, z, roofCol));
  for (let i = 1; i + 1 < n; i++) {
    m.tri(r[0]!, r[i]!, r[i + 1]!, 0, 1, 0);
    tris++;
  }
  return tris;
}

const LAND = "#8f8b82";
const LAND_HIGH = "#8d8f7f";

function emitTerrain(m: MeshData, cell: [number, number, number, number], inp: FarInputs, p: FarParams): number {
  const [bx0, bz0, bx1, bz1] = inp.bounds;
  const x0 = Math.max(cell[0], bx0), z0 = Math.max(cell[1], bz0);
  const x1 = Math.min(cell[2], bx1), z1 = Math.min(cell[3], bz1);
  if (x1 <= x0 || z1 <= z0) return 0;
  const s = p.groundStepM;
  const nx = Math.round((x1 - x0) / s) + 1;
  const nz = Math.round((z1 - z0) / s) + 1;
  const hs: Array<{ h: number; water: boolean } | null> = [];
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) hs.push(inp.terrain(Math.min(x0 + i * s, x1), Math.min(z0 + k * s, z1)));
  const vid = new Int32Array(nx * nz).fill(-1);
  const v = (i: number, k: number): number => {
    const key = k * nx + i;
    if (vid[key]! >= 0) return vid[key]!;
    const t = hs[key]!;
    const h = t.water ? 0 : t.h;
    vid[key] = m.vertex(Math.min(x0 + i * s, x1), h - p.groundDropM, Math.min(z0 + k * s, z1), rgba(h > 40 ? LAND_HIGH : LAND, 0.94 + Math.min(0.1, h / 600)));
    return vid[key]!;
  };
  let tris = 0;
  for (let k = 0; k + 1 < nz; k++) {
    for (let i = 0; i + 1 < nx; i++) {
      const c = [hs[k * nx + i], hs[k * nx + i + 1], hs[(k + 1) * nx + i], hs[(k + 1) * nx + i + 1]];
      if (c.some((q) => q === null) || c.every((q) => q!.water)) continue;
      const a = v(i, k), b = v(i + 1, k), cc = v(i, k + 1), d = v(i + 1, k + 1);
      m.tri(a, cc, b, 0, 1, 0);
      m.tri(b, cc, d, 0, 1, 0);
      tris += 2;
    }
  }
  return tris;
}

export async function buildFarLod(world: string, inp: FarInputs, p: FarParams = FAR_DEFAULTS): Promise<FarCellOut[]> {
  const tall: Hull[] = [];
  const low: Building[] = [];
  for (const b of inp.buildings) {
    if (b.topY - b.baseY >= p.tallM) {
      const style = facadeStyle(b);
      const ring = simplifyConvex(convexHull(b.footprint), p.tallMaxVerts);
      if (ring.length >= 3) tall.push({ ring, top: b.topY, absolute: true, wall: style.wall, roof: style.roof, records: 1 });
    } else {
      low.push(b);
    }
  }
  const hulls = [...clusterHulls(low, p), ...tall];
  const groundAt = (x: number, z: number): number => {
    const t = inp.terrain(x, z);
    return t && !t.water ? t.h : 0;
  };
  // The grid starts at the bounds' north-west corner; a hull belongs to the cell holding its
  // vertex mean (clamped into the grid).
  const [gx0, gz0, gx1, gz1] = inp.bounds;
  const ncx = Math.ceil((gx1 - gx0) / p.cellM);
  const ncz = Math.ceil((gz1 - gz0) / p.cellM);
  const byCell = new Map<number, Hull[]>();
  for (const h of hulls) {
    let sx = 0, sz = 0;
    for (const [x, z] of h.ring) {
      sx += x;
      sz += z;
    }
    const cx = Math.min(ncx - 1, Math.max(0, Math.floor((sx / h.ring.length - gx0) / p.cellM)));
    const cz = Math.min(ncz - 1, Math.max(0, Math.floor((sz / h.ring.length - gz0) / p.cellM)));
    const k = cz * ncx + cx;
    let l = byCell.get(k);
    if (!l) byCell.set(k, (l = []));
    l.push(h);
  }
  const out: FarCellOut[] = [];
  for (let cz = 0; cz < ncz; cz++) {
    for (let cx = 0; cx < ncx; cx++) {
      const box: [number, number, number, number] = [gx0 + cx * p.cellM, gz0 + cz * p.cellM, Math.min(gx1, gx0 + (cx + 1) * p.cellM), Math.min(gz1, gz0 + (cz + 1) * p.cellM)];
      const m = new MeshData();
      let tris = emitTerrain(m, box, inp, p);
      const list = byCell.get(cz * ncx + cx) ?? [];
      let records = 0;
      for (const h of list) {
        tris += emitHull(m, h, groundAt, p.skirtM);
        records += h.records;
      }
      if (m.indices.length === 0) continue;
      const id = `f${cx}_${cz}`;
      const glb = await meshGlb({ world, far: id, cx, cz, bbox: box }, [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2], [
        { name: "far", mesh: m, material: "far", roughness: 0.95 },
      ]);
      out.push({ id, cx, cz, bbox: box, glb, stats: { records, hulls: list.length, triangles: tris } });
    }
  }
  return out;
}
