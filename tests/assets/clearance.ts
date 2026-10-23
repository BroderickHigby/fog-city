// Road clearance for placed landmark models: nothing a model draws may stand in the space a car
// or a walker moves through on a road ribbon the sim lets them use. The sim has no colliders
// for landmark geometry (content/landmarks.json colliders are not read), so anything drawn in
// that space is a solid the player drives straight through.
//
// The space: every roads.json edge's ribbon (its centreline widened to widthM), from road + lo
// to road + hi (by default 0.3 m to 4.5 m), where the road is the sim's ground under it. It is
// cut into short boxes along the edge; each box follows the ground's slope along and across the
// road (an affine shear, so the overlap test stays exact), and every model triangle near it is
// tested against it with the separating axis theorem (Akenine-Moller's triangle-box test). Thin
// parts count: a 0.3 m strut across a lane is a hit, not something between two samples.
//
// Pure maths on the committed files: no Blender, no WebGL, no network.

import { fromModelFrame, groundAt, type ReadTile } from "../../assets/blender/tools/landmark-sites.ts";
import { toLocal } from "../../src/geo/project.ts";
import type { V3 } from "./glb.ts";

export interface RoadEdge {
  id: string;
  name?: string;
  kind: string;
  widthM: number;
  pedestrian?: boolean;
  gradeSeparated?: boolean;
  points: Array<[number, number]>;
}

export interface Placement {
  lat: number;
  lon: number;
  headingDeg: number;
  scale?: number;
}

export interface ClearanceHit {
  edge: string;
  name: string;
  /** Distance along the edge (metres from its first point) of the box's centre. */
  s: number;
  /** World position of the box's centre. */
  x: number;
  z: number;
  /** The triangle's lowest and highest point above the road there (approximate, at the box centre). */
  lowM: number;
  highM: number;
}

interface WorldTri {
  /** World-space vertices (x, y, z): y is absolute (the sim's frame). */
  v: [V3, V3, V3];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
  /** The source triangle in the model frame (for allow-lists). */
  model: readonly [V3, V3, V3];
}

const CELL = 10;

/** Model-frame triangles -> world triangles, as the renderer places them (src/render/landmarks.ts). */
export function placeTriangles(read: ReadTile, l: Placement, tris: ReadonlyArray<readonly [V3, V3, V3]>): WorldTri[] {
  const o = toLocal(l.lat, l.lon);
  const g0 = groundAt(read, o.x, o.z);
  const k = l.scale ?? 1;
  return tris.map((t) => {
    const v = t.map((p) => {
      const [x, z] = fromModelFrame(o, l.headingDeg, p[0] * k, p[2] * k);
      return [x, g0 + p[1] * k, z] as V3;
    }) as [V3, V3, V3];
    return {
      v,
      minX: Math.min(v[0][0], v[1][0], v[2][0]),
      maxX: Math.max(v[0][0], v[1][0], v[2][0]),
      minY: Math.min(v[0][1], v[1][1], v[2][1]),
      maxY: Math.max(v[0][1], v[1][1], v[2][1]),
      minZ: Math.min(v[0][2], v[1][2], v[2][2]),
      maxZ: Math.max(v[0][2], v[1][2], v[2][2]),
      model: t,
    };
  });
}

function gridOf(tris: WorldTri[]): Map<string, WorldTri[]> {
  const grid = new Map<string, WorldTri[]>();
  for (const t of tris) {
    for (let i = Math.floor(t.minX / CELL); i <= Math.floor(t.maxX / CELL); i++) {
      for (let j = Math.floor(t.minZ / CELL); j <= Math.floor(t.maxZ / CELL); j++) {
        const key = `${i},${j}`;
        let list = grid.get(key);
        if (!list) grid.set(key, (list = []));
        list.push(t);
      }
    }
  }
  return grid;
}

// ---------------------------------------------------------------------------- triangle vs box

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Does the triangle (v0, v1, v2) overlap the box centred at the origin with half sizes h? (SAT, 13 axes.) */
export function triangleOverlapsBox(v0: V3, v1: V3, v2: V3, h: V3): boolean {
  // the box's face normals
  for (let k = 0; k < 3; k++) {
    if (Math.min(v0[k]!, v1[k]!, v2[k]!) > h[k]! || Math.max(v0[k]!, v1[k]!, v2[k]!) < -h[k]!) return false;
  }
  const e0 = sub(v1, v0);
  const e1 = sub(v2, v1);
  const e2 = sub(v0, v2);
  // the triangle's plane
  const n = cross(e0, e1);
  const r0 = h[0] * Math.abs(n[0]) + h[1] * Math.abs(n[1]) + h[2] * Math.abs(n[2]);
  if (Math.abs(dot(n, v0)) > r0) return false;
  // the nine edge-edge axes
  const axes: V3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (const a of axes) {
    for (const e of [e0, e1, e2]) {
      const ax = cross(a, e);
      if (Math.abs(ax[0]) + Math.abs(ax[1]) + Math.abs(ax[2]) < 1e-12) continue;
      const p0 = dot(ax, v0);
      const p1 = dot(ax, v1);
      const p2 = dot(ax, v2);
      const r = h[0] * Math.abs(ax[0]) + h[1] * Math.abs(ax[1]) + h[2] * Math.abs(ax[2]);
      if (Math.min(p0, p1, p2) > r || Math.max(p0, p1, p2) < -r) return false;
    }
  }
  return true;
}

/**
 * How many closed solids of the mesh contain point p, counted along a ray: each triangle the ray
 * crosses counts +1 where it leaves through the triangle's front (outward) face and -1 where it
 * enters. Meshes open at the bottom (the builders skip faces nobody sees) still count right for
 * a horizontal ray. Moller-Trumbore intersection.
 */
function windingAlong(p: V3, dir: V3, tris: Iterable<WorldTri>): number {
  let w = 0;
  for (const t of tris) {
    const [a, b, c] = t.v;
    const e1 = sub(b, a);
    const e2 = sub(c, a);
    const pv = cross(dir, e2);
    const det = dot(e1, pv);
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const tv = sub(p, a);
    const u = dot(tv, pv) * inv;
    if (u < 0 || u > 1) continue;
    const qv = cross(tv, e1);
    const v = dot(dir, qv) * inv;
    if (v < 0 || u + v > 1) continue;
    if (dot(e2, qv) * inv <= 0) continue;
    w += dot(cross(e1, e2), dir) > 0 ? 1 : -1;
  }
  return w;
}

// Slightly skewed horizontal directions, so a ray never runs exactly along a mesh edge.
const RAYS: V3[] = [
  [1, 0, 0.0137],
  [-1, 0, -0.0119],
  [0.0123, 0, 1],
  [-0.0131, 0, -1],
];
const REACH = 200;

/** True when p is inside a closed solid of the placed mesh (all four horizontal rays agree). */
function insideSolid(p: V3, grid: Map<string, WorldTri[]>): boolean {
  for (const d of RAYS) {
    const seen = new Set<WorldTri>();
    const x1 = p[0] + d[0] * REACH;
    const z1 = p[2] + d[2] * REACH;
    for (let i = Math.floor(Math.min(p[0], x1) / CELL); i <= Math.floor(Math.max(p[0], x1) / CELL); i++) {
      for (let j = Math.floor(Math.min(p[2], z1) / CELL); j <= Math.floor(Math.max(p[2], z1) / CELL); j++) {
        for (const t of grid.get(`${i},${j}`) ?? []) if (t.minY <= p[1] && t.maxY >= p[1]) seen.add(t);
      }
    }
    if (windingAlong(p, d, seen) < 1) return false;
  }
  return true;
}

export interface ClearanceOptions {
  /** Clearance band above the road (metres). Default 0.3 to 4.5. */
  lo?: number;
  hi?: number;
  /** Box length along the road (metres). Default 1. */
  step?: number;
  /** Skip a triangle (an allow-listed part). */
  allow?: (modelTri: readonly [V3, V3, V3]) => boolean;
  /** Only test the ribbon where a car or a walker can be (world x, z); default everywhere. */
  reachable?: (x: number, z: number, e: RoadEdge) => boolean;
}

/**
 * Every place where a placed model's triangles enter the clearance space of a road ribbon.
 * One hit per (edge, box) with the band of the triangles found there.
 */
export function clearanceHits(read: ReadTile, l: Placement, tris: ReadonlyArray<readonly [V3, V3, V3]>, edges: ReadonlyArray<RoadEdge>, opt: ClearanceOptions = {}): ClearanceHit[] {
  const lo = opt.lo ?? 0.3;
  const hi = opt.hi ?? 4.5;
  const step = opt.step ?? 1;
  const placed = placeTriangles(read, l, tris).filter((t) => !opt.allow?.(t.model));
  if (placed.length === 0) return [];
  const grid = gridOf(placed);
  let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
  for (const t of placed) {
    bx0 = Math.min(bx0, t.minX); bx1 = Math.max(bx1, t.maxX);
    bz0 = Math.min(bz0, t.minZ); bz1 = Math.max(bz1, t.maxZ);
  }
  const hits: ClearanceHit[] = [];
  for (const e of edges) {
    const half = e.widthM / 2;
    let s0 = 0;
    for (let i = 0; i + 1 < e.points.length; i++) {
      const [ax, az] = e.points[i]!;
      const [cx, cz] = e.points[i + 1]!;
      const len = Math.hypot(cx - ax, cz - az);
      if (len < 1e-6) continue;
      const segOut = Math.max(ax, cx) + half < bx0 || Math.min(ax, cx) - half > bx1 || Math.max(az, cz) + half < bz0 || Math.min(az, cz) - half > bz1;
      if (!segOut) {
        const ux = (cx - ax) / len;
        const uz = (cz - az) / len;
        const vx = -uz;
        const vz = ux;
        const n = Math.max(1, Math.ceil(len / step));
        const L = len / n;
        for (let k = 0; k < n; k++) {
          const t = (k + 0.5) * L;
          const mx = ax + ux * t;
          const mz = az + uz * t;
          const r = L / 2 + half;
          if (mx + r < bx0 || mx - r > bx1 || mz + r < bz0 || mz - r > bz1) continue;
          if (opt.reachable && !opt.reachable(mx, mz, e)) continue;
          const gc = groundAt(read, mx, mz);
          const su = (groundAt(read, mx + ux * L / 2, mz + uz * L / 2) - groundAt(read, mx - ux * L / 2, mz - uz * L / 2)) / L;
          const sv = (groundAt(read, mx + vx * half, mz + vz * half) - groundAt(read, mx - vx * half, mz - vz * half)) / (2 * half);
          const yMin = gc - Math.abs(su) * L / 2 - Math.abs(sv) * half + lo;
          const yMax = gc + Math.abs(su) * L / 2 + Math.abs(sv) * half + hi;
          const hb: V3 = [L / 2, half, (hi - lo) / 2];
          const mid = (lo + hi) / 2;
          let low = Infinity;
          let high = -Infinity;
          const seen = new Set<WorldTri>();
          for (let gi = Math.floor((mx - r) / CELL); gi <= Math.floor((mx + r) / CELL); gi++) {
            for (let gj = Math.floor((mz - r) / CELL); gj <= Math.floor((mz + r) / CELL); gj++) {
              for (const tri of grid.get(`${gi},${gj}`) ?? []) {
                if (seen.has(tri)) continue;
                seen.add(tri);
                if (tri.maxY < yMin || tri.minY > yMax) continue;
                if (tri.maxX < mx - r || tri.minX > mx + r || tri.maxZ < mz - r || tri.minZ > mz + r) continue;
                const loc = tri.v.map((p) => {
                  const dx = p[0] - mx;
                  const dz = p[2] - mz;
                  const u = dx * ux + dz * uz;
                  const v = dx * vx + dz * vz;
                  return [u, v, p[1] - (gc + su * u + sv * v) - mid] as V3;
                }) as [V3, V3, V3];
                if (!triangleOverlapsBox(loc[0], loc[1], loc[2], hb)) continue;
                low = Math.min(low, ...loc.map((p) => p[2] + mid));
                high = Math.max(high, ...loc.map((p) => p[2] + mid));
              }
            }
          }
          // no surface crosses the box: it may still lie wholly inside a solid
          if (low === Infinity && insideSolid([mx, gc + mid, mz], grid)) {
            low = lo;
            high = hi;
          }
          if (low !== Infinity) hits.push({ edge: e.id, name: e.name ?? "", s: Math.round(s0 + t), x: mx, z: mz, lowM: low, highM: high });
        }
      }
      s0 += len;
    }
  }
  return hits;
}

/** Hits grouped into runs along each edge: "c123 Name s 396-402 (7 boxes, 0.0..9.0 m)". */
export function describeHits(hits: ReadonlyArray<ClearanceHit>): string[] {
  const out: string[] = [];
  let run: ClearanceHit[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const a = run[0]!;
    const b = run[run.length - 1]!;
    out.push(`${a.edge} ${a.name} s ${a.s}-${b.s} (${run.length} boxes, ${Math.min(...run.map((h) => h.lowM)).toFixed(1)}..${Math.max(...run.map((h) => h.highM)).toFixed(1)} m above the road)`);
    run = [];
  };
  for (const h of hits) {
    const last = run[run.length - 1];
    if (last && (last.edge !== h.edge || h.s - last.s > 3)) flush();
    run.push(h);
  }
  flush();
  return out;
}
