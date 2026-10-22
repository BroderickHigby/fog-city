// Citywide far-LOD: the terrain and every building, heavily simplified and merged per large cell,
// so the renderer can draw the whole skyline and the hills beyond the streaming radius.
//
// Per cell (a square of cellM on a grid anchored at the far box's north-west tile corner) one glb
// with one node "far" and one primitive (one draw call), no normals (three.js shades it flat),
// vertex colours. Its terrain triangles come first: node extras.terrainTriangles counts them.
//
// Terrain (world QA W-17, W-40), per 500 m tile square of the far box:
//   * every tile border is a polyline through the near tiles' own 10 m lattice samples,
//     simplified to borderTolM (Douglas-Peucker on the heights) and keeping every 100 m point,
//     shared exactly by the two squares either side; so where the streaming ring stops at a tile
//     border, the far terrain meets the near ground there (lowered groundDropM, which is more
//     than borderTolM: the far side is never above the near one and no sea shows through);
//   * inside, a lattice of steps[0] (100 m) on a built tile, or the next finer step (50 m) where
//     the coarser one misses the 10 m lattice by more than refineErrorM (the hills); farSteps
//     (250 m, 100 m) on every other tile square; cells along a border are fans through the
//     border's vertices, so there are no T-junction cracks;
//   * samples come from the near tiles' lattice where a candidate tile has one (lakes flattened,
//     piers raised), else the DEM, over the whole far box: the Marin headlands, San Bruno Mountain
//     and every land tile beside a built one;
//   * colours by ground class (landcover.ts) where the cover function gives one.
// Buildings (W-41):
//   * tall records (tallM and up): their own outline, simplified (the convex hull only when the
//     footprint is close to convex), flat roof at their topY;
//   * everything else: records closer than clusterGapM whose heights above the ground differ by at
//     most clusterHeightM merge into a cluster: its convex hull, or the members' own outlines where
//     that hull would stand over another record of a different height; the roof follows the
//     terrain at the members' area-weighted mean height.
// Every hull's walls start skirtM below the lowest ground under it.

import type { Building } from "./buildings.ts";
import { cleanRing, dropCollinear, interiorPoint, isSimpleRing, pointInRing, signedArea, simplifyRing, type P2 } from "./geom.ts";
import { meshGlb } from "./glb.ts";
import { facadeStyle, MeshData, rgba } from "./mesh.ts";
import { largest, unionRings } from "./polygon.ts";
import { ShapeUtils, Vector2 } from "three";

export interface FarParams {
  /** Cell side, metres (a multiple of the tile size). The far box must fit in at most 40 cells. */
  cellM: number;
  /** Interior lattice steps of a streamed (built) tile, coarsest first (each divides 500 and is a multiple of 10)... */
  steps: number[];
  /** ... and of every other tile square (Marin, the Peninsula, land beside the city). */
  farSteps: number[];
  /** A tile takes the next finer step while the coarser one misses its 10 m samples by more than this. */
  refineErrorM: number;
  /** Border polylines of a streamed (built) tile stay within this of the near lattice... */
  borderTolM: number;
  /** ... and every other border (far terrain against far terrain) within this. */
  farBorderTolM: number;
  groundDropM: number;
  /** Records at least this tall (roof above their own ground) keep their own hull. */
  tallM: number;
  /** Records closer than this, and within clusterHeightM of each other's height, merge. */
  clusterGapM: number;
  clusterHeightM: number;
  /**
   * Compare roofs (topY) rather than heights above the ground, and give a cluster a flat roof at
   * its members' mean roof: on a hill a stepped row becomes steps of at most clusterHeightM.
   */
  clusterByRoof: boolean;
  skirtM: number;
  /** Vertex caps (a hull of n vertices costs 3n - 2 triangles). */
  tallMaxVerts: number;
  clusterMaxVerts: number;
  singleMaxVerts: number;
}

export const FAR_DEFAULTS: FarParams = {
  cellM: 3500,
  steps: [100, 50],
  farSteps: [250, 100],
  refineErrorM: 10,
  borderTolM: 0.4,
  farBorderTolM: 4,
  groundDropM: 0.5,
  tallM: 30,
  clusterGapM: 3,
  clusterHeightM: 5,
  clusterByRoof: false,
  skirtM: 3,
  tallMaxVerts: 6,
  clusterMaxVerts: 4,
  singleMaxVerts: 4,
};
export const FAR_CELL_M = FAR_DEFAULTS.cellM;
const TILE_M = 500;
const LATTICE_M = 10;

export interface FarCellOut {
  id: string;
  cx: number;
  cz: number;
  bbox: [number, number, number, number];
  glb: Uint8Array;
  stats: { records: number; hulls: number; triangles: number; terrainTriangles: number };
}

export interface FarInputs {
  buildings: readonly Building[];
  /** Ground at a 10 m lattice point: the near tiles' lattice where a candidate tile has one, else the DEM; null where nothing covers it. */
  sample: (x: number, z: number) => { h: number; water: boolean } | null;
  /** The ground class at a lattice point (landcover.ts), for colours; absent: one land colour. */
  cover?: (x: number, z: number, h: number, water: boolean) => string;
  /** The far box, tile-aligned [minX, minZ, maxX, maxZ]. */
  bounds: readonly [number, number, number, number];
  /** Tiles the renderer streams in ("ix,iz"): their borders keep the near lattice to borderTolM. */
  nearTiles?: ReadonlySet<string>;
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

/**
 * A footprint's outline for the far layer, at most `max` vertices: its convex hull when that adds
 * under 15% to its area, else the ring simplified (Douglas-Peucker, the tolerance doubled until
 * it fits) and kept simple; never a ring that leaves out the footprint's interior point.
 */
export function farOutline(ring: readonly P2[], max: number): P2[] {
  const area = Math.abs(signedArea(ring));
  const hull = convexHull(ring);
  if (Math.abs(signedArea(hull)) <= 1.15 * area || ring.length <= 3) return simplifyConvex(hull, max);
  const ip = interiorPoint(ring);
  for (let tol = 0.5; tol < 64; tol *= 2) {
    const r = dropCollinear(cleanRing(simplifyRing(ring, tol)), 0.01);
    if (r.length > max) continue;
    if (r.length >= 3 && isSimpleRing(r) && pointInRing(ip[0], ip[1], r) && Math.abs(signedArea(r)) >= 0.5 * area) return signedArea(r) > 0 ? r.reverse() : r;
  }
  return simplifyConvex(hull, max);
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

/** Smallest distance between two rings' boundaries. */
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

export interface Hull {
  ring: P2[];
  /** Height of the roof above the terrain (clusters) or absolute roof y (tall). */
  top: number;
  absolute: boolean;
  wall: string;
  roof: string;
  records: number;
}

const heightOf = (b: Building): number => b.topY - b.baseY;
/** A far outline grows to at most this many vertices to cover its members before falling back to its convex hull. */
const OUTLINE_MAX_VERTS = 12;

/** Records indexed on a grid, for "which records stand at this point". */
class PointIndex {
  private cells = new Map<number, number[]>();
  private readonly list: readonly Building[];
  private readonly pts: P2[];
  constructor(list: readonly Building[]) {
    this.list = list;
    this.pts = list.map((b) => interiorPoint(b.footprint));
    this.pts.forEach(([x, z], i) => {
      const k = (Math.floor(x / 50) + 4096) * 8192 + Math.floor(z / 50) + 4096;
      (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push(i);
    });
  }
  /** Records whose interior point lies inside the ring. */
  inside(ring: readonly P2[]): Building[] {
    const [x0, z0, x1, z1] = bbox(ring);
    const out: Building[] = [];
    for (let cx = Math.floor(x0 / 50); cx <= Math.floor(x1 / 50); cx++) {
      for (let cz = Math.floor(z0 / 50); cz <= Math.floor(z1 / 50); cz++) {
        for (const i of this.cells.get((cx + 4096) * 8192 + cz + 4096) ?? []) {
          const [x, z] = this.pts[i]!;
          if (pointInRing(x, z, ring)) out.push(this.list[i]!);
        }
      }
    }
    return out;
  }
}

/** Clusters of non-tall records (union-find over a spatial hash), in a deterministic order. */
export function clusterHulls(low: readonly Building[], p: FarParams, all: readonly Building[] = low): Hull[] {
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
  const heights = low.map((b) => (p.clusterByRoof ? b.topY : heightOf(b)));
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
    for (let a = 0; a < list.length; a++) {
      const i = list[a]!;
      for (let q = a + 1; q < list.length; q++) {
        const j = list[q]!;
        if (Math.abs(heights[i]! - heights[j]!) > p.clusterHeightM) continue;
        const A = boxes[i]!, B = boxes[j]!;
        if (A[0] - GAP > B[2] || B[0] - GAP > A[2] || A[1] - GAP > B[3] || B[1] - GAP > A[3]) continue;
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
  const index = new PointIndex(all);
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
      hsum += a * (p.clusterByRoof ? m.topY : heightOf(m));
      if (a > biggestA) {
        biggestA = a;
        biggest = m;
      }
      for (const q of m.footprint) pts.push(q);
    }
    const top = area > 0 ? hsum / area : p.clusterByRoof ? biggest.topY : heightOf(biggest);
    const style = facadeStyle(biggest);
    const push = (ring: P2[], records: number): void => {
      if (ring.length >= 3) hulls.push({ ring, top, absolute: p.clusterByRoof, wall: style.wall, roof: style.roof, records });
    };
    const levelOf = (o: Building): number => (p.clusterByRoof ? o.topY : heightOf(o));
    // A hull leaves out none of its members' interior points: its vertex cap grows until it does.
    const covering = (ring: readonly P2[], of: readonly Building[]): boolean =>
      of.every((m) => {
        const ip = interiorPoint(m.footprint);
        return pointInRing(ip[0], ip[1], ring);
      });
    if (members.length === 1) {
      let ring = farOutline(members[0]!.footprint, p.singleMaxVerts);
      for (let cap = p.singleMaxVerts + 2; !covering(ring, members) && cap <= p.singleMaxVerts + 8; cap += 2) ring = farOutline(members[0]!.footprint, cap);
      push(ring, 1);
      continue;
    }
    // The cluster's convex hull, unless it would stand over a record that is not a member and
    // differs in height (a courtyard house inside an L of taller rows): then the members' union,
    // part by part.
    const full = convexHull(pts);
    let hull = simplifyConvex(full, p.clusterMaxVerts);
    for (let cap = p.clusterMaxVerts + 2; !covering(hull, members) && cap < full.length + 2; cap += 2) hull = simplifyConvex(full, cap);
    const ids = new Set(members.map((m) => m.id));
    const covers = index.inside(hull).some((o) => !ids.has(o.id) && Math.abs(levelOf(o) - top) > p.clusterHeightM);
    if (!covers) {
      push(hull, members.length);
      continue;
    }
    let parts;
    try {
      parts = unionRings(members.map((m) => m.footprint));
    } catch {
      parts = null;
    }
    const outline = (ring: readonly P2[], of: readonly Building[], cap0: number): P2[] => {
      let r = farOutline(ring, cap0);
      for (let cap = cap0 + 2; !covering(r, of) && cap <= OUTLINE_MAX_VERTS; cap += 2) r = farOutline(ring, cap);
      if (covering(r, of)) return r;
      // Still leaving a member out: the part's convex hull, simplified while it covers them all.
      const h = convexHull(ring);
      for (let cap = OUTLINE_MAX_VERTS; cap < h.length; cap += 4) {
        const c = simplifyConvex(h, cap);
        if (covering(c, of)) return c;
      }
      return h;
    };
    if (!parts) {
      for (const m of members) push(outline(m.footprint, [m], p.singleMaxVerts), 1);
      continue;
    }
    const sorted = [...parts].sort((a, b) => Math.abs(signedArea(b.outer)) - Math.abs(signedArea(a.outer)));
    const placed = new Set<string>();
    for (const part of sorted) {
      const ring = cleanRing(part.outer);
      if (ring.length < 3) continue;
      const inPart = members.filter((m) => {
        if (placed.has(m.id)) return false;
        const ip = interiorPoint(m.footprint);
        return pointInRing(ip[0], ip[1], ring);
      });
      for (const m of inPart) placed.add(m.id);
      push(outline(ring, inPart, p.clusterMaxVerts), inPart.length);
    }
    for (const m of members) if (!placed.has(m.id)) push(outline(m.footprint, [m], p.singleMaxVerts), 1);
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
  const convex = isConvex(h.ring);
  if (convex) {
    for (let i = 1; i + 1 < n; i++) {
      m.tri(r[0]!, r[i]!, r[i + 1]!, 0, 1, 0);
      tris++;
    }
  } else {
    for (const [i0, i1, i2] of ShapeUtils.triangulateShape(h.ring.map(([x, z]) => new Vector2(x, z)), [])) {
      m.tri(r[i0!]!, r[i1!]!, r[i2!]!, 0, 1, 0);
      tris++;
    }
  }
  return tris;
}

function isConvex(ring: readonly P2[]): boolean {
  let sign = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!, c = ring[(i + 2) % ring.length]!;
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cr) < 1e-9) continue;
    const s = Math.sign(cr);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

// ---------------------------------------------------------------- terrain

const LAND = "#8f8b82";
const LAND_HIGH = "#8d8f7f";

/** Far-terrain colours by ground class (landcover.ts); "o" is land outside the city's data. */
export const FAR_COVER_COLOURS: Record<string, string> = {
  g: "#7d9256",
  f: "#5a7343",
  s: "#cdbd96",
  w: "#5f7a87",
  lake: "#5f7a87",
  o: "#8f8f72",
};

function terrainColour(h: number, cls: string | undefined): [number, number, number, number] {
  if (cls === undefined || cls === "u") return rgba(h > 40 ? LAND_HIGH : LAND, 0.94 + Math.min(0.1, h / 600));
  const c = /[0-9]/.test(cls) ? FAR_COVER_COLOURS.lake! : FAR_COVER_COLOURS[cls] ?? LAND;
  return rgba(c, 0.94 + Math.min(0.08, h / 800));
}

interface Sample {
  h: number;
  water: boolean;
}

/** A tile border: its kept points as (offset along the border in metres, height). */
type Border = Array<[number, number]>;

/** Douglas-Peucker on a border's 51 samples (10 m apart), keeping every `every`-th sample (10: each 100 m point). */
export function simplifyBorder(hs: readonly number[], tol: number, every = 10): Border {
  const keep = new Uint8Array(hs.length);
  for (let i = 0; i < hs.length; i += every) keep[i] = 1;
  keep[hs.length - 1] = 1;
  const dp = (a: number, b: number): void => {
    if (b - a < 2) return;
    let best = -1, bestD = tol;
    for (let i = a + 1; i < b; i++) {
      const t = (i - a) / (b - a);
      const d = Math.abs(hs[i]! - (hs[a]! + (hs[b]! - hs[a]!) * t));
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0) return;
    keep[best] = 1;
    dp(a, best);
    dp(best, b);
  };
  let a = 0;
  for (let i = 1; i < hs.length; i++) {
    if (!keep[i]) continue;
    dp(a, i);
    a = i;
  }
  const out: Border = [];
  for (let i = 0; i < hs.length; i++) if (keep[i]) out.push([i * LATTICE_M, hs[i]!]);
  return out;
}

/** Height of a border polyline at offset s (linear between kept points). */
function borderAt(b: Border, s: number): number {
  for (let i = 1; i < b.length; i++) {
    if (s <= b[i]![0] + 1e-9) {
      const [s0, h0] = b[i - 1]!;
      const [s1, h1] = b[i]!;
      return h0 + ((h1 - h0) * (s - s0)) / (s1 - s0 || 1);
    }
  }
  return b[b.length - 1]![1];
}

/** The terrain of one far cell: every tile square of the far box inside it. */
class TerrainBuilder {
  private readonly inp: FarInputs;
  private readonly p: FarParams;
  private readonly borders = new Map<string, Border | null>();
  private readonly samples = new Map<number, Sample | null>();
  constructor(inp: FarInputs, p: FarParams) {
    this.inp = inp;
    this.p = p;
  }

  sample(x: number, z: number): Sample | null {
    const k = (Math.round(x / LATTICE_M) + 65536) * 131072 + Math.round(z / LATTICE_M) + 65536;
    if (this.samples.has(k)) return this.samples.get(k)!;
    const s = this.inp.sample(x, z);
    const v = s ? { h: s.water ? 0 : s.h, water: s.water } : null;
    this.samples.set(k, v);
    return v;
  }

  /** A tile border: horizontal ("h", the north edge of tile ix, iz) or vertical ("v", its west edge). */
  border(kind: "h" | "v", ix: number, iz: number): Border | null {
    const key = `${kind}${ix},${iz}`;
    if (this.borders.has(key)) return this.borders.get(key)!;
    const hs: number[] = [];
    for (let i = 0; i <= TILE_M / LATTICE_M; i++) {
      const s = kind === "h" ? this.sample(ix * TILE_M + i * LATTICE_M, iz * TILE_M) : this.sample(ix * TILE_M, iz * TILE_M + i * LATTICE_M);
      if (!s) {
        this.borders.set(key, null);
        return null;
      }
      hs.push(s.h);
    }
    const near = this.inp.nearTiles;
    const a = kind === "h" ? `${ix},${iz - 1}` : `${ix - 1},${iz}`;
    const fine = !near || near.has(a) || near.has(`${ix},${iz}`);
    const b = fine ? simplifyBorder(hs, this.p.borderTolM, 10) : simplifyBorder(hs, this.p.farBorderTolM, 25);
    this.borders.set(key, b);
    return b;
  }

  /** The interior step for a tile: the coarsest that keeps its 10 m samples within refineErrorM. */
  step(ix: number, iz: number): number {
    const x0 = ix * TILE_M, z0 = iz * TILE_M;
    const n10 = TILE_M / LATTICE_M;
    const near = this.inp.nearTiles;
    const steps = !near || near.has(`${ix},${iz}`) ? this.p.steps : this.p.farSteps;
    for (const s of steps) {
      const r = s / LATTICE_M;
      let ok = true;
      for (let k = 0; k <= n10 && ok; k++) {
        for (let i = 0; i <= n10 && ok; i++) {
          const ci = Math.min(Math.floor(i / r), n10 / r - 1), ck = Math.min(Math.floor(k / r), n10 / r - 1);
          const tx = (i - ci * r) / r, tz = (k - ck * r) / r;
          const h = (gi: number, gk: number): number => this.sample(x0 + gi * LATTICE_M, z0 + gk * LATTICE_M)?.h ?? 0;
          const b = (h(ci * r, ck * r) * (1 - tx) + h((ci + 1) * r, ck * r) * tx) * (1 - tz) + (h(ci * r, (ck + 1) * r) * (1 - tx) + h((ci + 1) * r, (ck + 1) * r) * tx) * tz;
          if (Math.abs(b - h(i, k)) > this.p.refineErrorM) ok = false;
        }
      }
      if (ok) return s;
    }
    return steps[steps.length - 1]!;
  }

  /** Emit one tile square's terrain into the mesh. Returns triangles. */
  tile(m: MeshData, vid: Map<string, number>, ix: number, iz: number): number {
    const x0 = ix * TILE_M, z0 = iz * TILE_M;
    const N = this.border("h", ix, iz), S = this.border("h", ix, iz + 1);
    const W = this.border("v", ix, iz), E = this.border("v", ix + 1, iz);
    if (!N || !S || !W || !E) return 0;
    const st = this.step(ix, iz);
    const n = TILE_M / st;
    const drop = this.p.groundDropM;
    const cover = this.inp.cover;
    const vertex = (x: number, z: number, h: number, water: boolean): number => {
      const key = `${Math.round(x * 100)},${Math.round(z * 100)}`;
      const got = vid.get(key);
      if (got !== undefined) return got;
      const cls = cover ? cover(x, z, h, water) : water ? "w" : undefined;
      const id = m.vertex(x, (water ? 0 : h) - drop, z, water ? rgba(FAR_COVER_COLOURS.w!) : terrainColour(h, cls));
      vid.set(key, id);
      return id;
    };
    // A point on the tile's border takes the border polyline's height; inside, the lattice's.
    const at = (x: number, z: number): { h: number; water: boolean } => {
      const onN = z === z0, onS = z === z0 + TILE_M, onW = x === x0, onE = x === x0 + TILE_M;
      const s = this.sample(x, z);
      const water = s?.water ?? false;
      if (onN) return { h: borderAt(N, x - x0), water };
      if (onS) return { h: borderAt(S, x - x0), water };
      if (onW) return { h: borderAt(W, z - z0), water };
      if (onE) return { h: borderAt(E, z - z0), water };
      if (s) return s;
      return { h: 0, water: true };
    };
    let tris = 0;
    for (let k = 0; k < n; k++) {
      for (let i = 0; i < n; i++) {
        const ax = x0 + i * st, az = z0 + k * st, bx = ax + st, bz = az + st;
        // The cell's boundary, clockwise from its north-west corner (east along the north side, ...).
        const ring: P2[] = [[ax, az]];
        const extras = (b: Border, from: number, to: number, toXZ: (s: number) => P2): void => {
          const lo = Math.min(from, to), hi = Math.max(from, to);
          const pts = b.filter(([s]) => s > lo + 1e-9 && s < hi - 1e-9).map(([s]) => toXZ(s));
          if (from > to) pts.reverse();
          ring.push(...pts);
        };
        if (k === 0) extras(N, ax - x0, bx - x0, (s) => [x0 + s, z0]);
        ring.push([bx, az]);
        if (i === n - 1) extras(E, az - z0, bz - z0, (s) => [x0 + TILE_M, z0 + s]);
        ring.push([bx, bz]);
        if (k === n - 1) extras(S, bx - x0, ax - x0, (s) => [x0 + s, z0 + TILE_M]);
        ring.push([ax, bz]);
        if (i === 0) extras(W, bz - z0, az - z0, (s) => [x0, z0 + s]);
        const pts = ring.map(([x, z]) => ({ x, z, ...at(x, z) }));
        if (pts.every((q) => q.water)) continue;
        const ids = pts.map((q) => vertex(q.x, q.z, q.h, q.water));
        if (ring.length === 4) {
          // Split along the (i+1, k)-(i, k+1) diagonal, as the near ground is.
          m.tri(ids[0]!, ids[3]!, ids[1]!, 0, 1, 0);
          m.tri(ids[1]!, ids[3]!, ids[2]!, 0, 1, 0);
          tris += 2;
          continue;
        }
        const cx = ax + st / 2, cz = az + st / 2;
        const onLattice = cx % LATTICE_M === 0 && cz % LATTICE_M === 0;
        let c = onLattice ? this.sample(cx, cz) : null;
        if (!c) {
          const hs = [pts[0]!, pts.find((q) => q.x === bx && q.z === az)!, pts.find((q) => q.x === bx && q.z === bz)!, pts.find((q) => q.x === ax && q.z === bz)!];
          c = { h: (hs[0]!.h + hs[1]!.h + hs[2]!.h + hs[3]!.h) / 4, water: hs.every((q) => q.water) };
        }
        const ci = vertex(cx, cz, c.h, c.water);
        for (let q = 0; q < ids.length; q++) {
          m.tri(ci, ids[q]!, ids[(q + 1) % ids.length]!, 0, 1, 0);
          tris++;
        }
      }
    }
    return tris;
  }
}

/** Every building's far hull: tall records alone, the rest in clusters (see the file comment). */
export function farHulls(buildings: readonly Building[], p: FarParams = FAR_DEFAULTS): Hull[] {
  const tall: Hull[] = [];
  const low: Building[] = [];
  const index = new PointIndex(buildings);
  for (const b of buildings) {
    if (heightOf(b) >= p.tallM) {
      const style = facadeStyle(b);
      // A tall record's outline never stands over another record's interior point that its own
      // footprint does not cover (the neighbour would pop by the height difference): it takes
      // more vertices until it does not, at worst its own footprint.
      const intrudes = (ring: readonly P2[]): boolean =>
        index.inside(ring).some((o) => {
          if (o.id === b.id) return false;
          const ip = interiorPoint(o.footprint);
          return !pointInRing(ip[0], ip[1], b.footprint) && Math.abs(o.topY - b.topY) > p.clusterHeightM;
        });
      let ring = farOutline(b.footprint, p.tallMaxVerts);
      for (let cap = p.tallMaxVerts + 2; intrudes(ring) && cap <= OUTLINE_MAX_VERTS; cap += 2) ring = farOutline(b.footprint, cap);
      if (intrudes(ring)) ring = signedArea(b.footprint) > 0 ? [...b.footprint].reverse() : [...b.footprint];
      if (ring.length >= 3) tall.push({ ring, top: b.topY, absolute: true, wall: style.wall, roof: style.roof, records: 1 });
    } else {
      low.push(b);
    }
  }
  return [...clusterHulls(low, p, buildings), ...tall];
}

export async function buildFarLod(world: string, inp: FarInputs, p: FarParams = FAR_DEFAULTS): Promise<FarCellOut[]> {
  const hulls = farHulls(inp.buildings, p);
  const terrain = new TerrainBuilder(inp, p);
  const groundAt = (x: number, z: number): number => {
    // Bilinear on the 10 m lattice samples (water at 0).
    const gx = Math.floor(x / LATTICE_M), gz = Math.floor(z / LATTICE_M);
    const tx = x / LATTICE_M - gx, tz = z / LATTICE_M - gz;
    const h = (i: number, k: number): number => terrain.sample(i * LATTICE_M, k * LATTICE_M)?.h ?? 0;
    return (h(gx, gz) * (1 - tx) + h(gx + 1, gz) * tx) * (1 - tz) + (h(gx, gz + 1) * (1 - tx) + h(gx + 1, gz + 1) * tx) * tz;
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
      const vid = new Map<string, number>();
      let terrainTris = 0;
      for (let iz = Math.round(box[1] / TILE_M); iz < Math.round(box[3] / TILE_M); iz++) {
        for (let ix = Math.round(box[0] / TILE_M); ix < Math.round(box[2] / TILE_M); ix++) terrainTris += terrain.tile(m, vid, ix, iz);
      }
      let tris = terrainTris;
      const list = byCell.get(cz * ncx + cx) ?? [];
      let records = 0;
      for (const h of list) {
        tris += emitHull(m, h, groundAt, p.skirtM);
        records += h.records;
      }
      if (m.indices.length === 0) continue;
      const id = `f${cx}_${cz}`;
      const glb = await meshGlb({ world, far: id, cx, cz, bbox: box }, [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2], [
        { name: "far", mesh: m, material: "far", roughness: 0.95, extras: { terrainTriangles: terrainTris } },
      ]);
      out.push({ id, cx, cz, bbox: box, glb, stats: { records, hulls: list.length, triangles: tris, terrainTriangles: terrainTris } });
    }
  }
  return out;
}
