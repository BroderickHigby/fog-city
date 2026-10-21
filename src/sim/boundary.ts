// The world's edge as walls: boundary.json (schemas/boundary.schema.json) turned into one-sided
// wall segments that player cars and walkers cannot cross.
//
//  - Every outline run (`edges`, land and water) is a wall: beyond the built tiles there is no
//    ground (the sim's ground is 0 there, a 100 m drop at the southern city limit).
//  - Every shore line (`shore`) is a wall: the sea wall of the design (docs/design.md, "Decks,
//    tunnels and water"). Water is a sim boundary until decks and towing exist.
//  - Land is on the left of travel along every line (+x east, +z south), so each segment pushes
//    toward its left normal. A wall only acts on points within WALL_DEPTH_M behind it, so the
//    far side of a pier or a creek never reaches across.
//  - Where a surface street or path crosses a shore line (the 3rd St, 4th St and Illinois St
//    bridges, pier roads), the wall is cut for the road's width plus WALL_GAP_MARGIN_M each
//    side, so the player can drive across like the traffic does. Freeways (gradeSeparated)
//    get no gap: their decks are not modelled, so the Bay Bridge and the Golden Gate approach
//    end at the shore. Outline runs are never cut: the world stops there.
//
// Built once with the world (buildWorld), static, never in SimState. Pure arithmetic only
// (+, -, *, /, sqrt), so every engine builds the same walls.

import type { RoadsFile } from "./roads.ts";

/** boundary.json as written by the pipeline (extra fields are ignored). */
export interface BoundaryFile {
  version: number;
  seaLevelY?: number;
  edges: ReadonlyArray<{ kind: string; closed: boolean; points: ReadonlyArray<readonly number[]> }>;
  shore: ReadonlyArray<{ closed: boolean; points: ReadonlyArray<readonly number[]> }>;
}

export type WallKind = "land" | "water" | "shore";

/** One straight piece of wall. Land is on the left of a -> b: the normal (nx, nz) points there. */
export interface WallSegment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** Unit direction a -> b. */
  ux: number;
  uz: number;
  /** Unit normal toward land (left of travel). */
  nx: number;
  nz: number;
  len: number;
  kind: WallKind;
}

export interface Walls {
  segments: WallSegment[];
  /** cellKey(cx, cz) of WALL_CELL_M cells -> indices of the segments touching the cell, ascending. */
  cells: Map<number, number[]>;
  /** Gaps cut in shore walls for surface roads crossing them. */
  gaps: number;
}

/** Points farther than this behind a wall (on its water side) are not pushed by it. */
export const WALL_DEPTH_M = 3;
/** A wall acts this far past its ends too, so a convex corner leaves no slot to slip through. */
export const WALL_END_M = 0.5;
/** Room beside the kerb at a gap cut for a road crossing the shore. */
export const WALL_GAP_MARGIN_M = 1.5;
const WALL_CELL_M = 50;

/** Integer cell coordinates packed into one number (as world.ts cellKey). */
function cellKey(cx: number, cz: number): number {
  return (cx + 1048576) * 2097152 + (cz + 1048576);
}
/** A road crossing a wall at a grazing angle gets at most this long a gap. */
const MAX_HALF_GAP_M = 40;
const KERB_DEFAULT_M = 10;

interface Polyline {
  kind: WallKind;
  xs: number[];
  zs: number[];
}

function polylineOf(kind: WallKind, closed: boolean, pts: ReadonlyArray<readonly number[]>): Polyline {
  const xs: number[] = [];
  const zs: number[] = [];
  for (const p of pts) {
    const x = p[0]!;
    const z = p[1]!;
    if (xs.length > 0 && xs[xs.length - 1] === x && zs[zs.length - 1] === z) continue;
    xs.push(x);
    zs.push(z);
  }
  if (closed && xs.length > 2 && (xs[0] !== xs[xs.length - 1] || zs[0] !== zs[zs.length - 1])) {
    xs.push(xs[0]!);
    zs.push(zs[0]!);
  }
  return { kind, xs, zs };
}

interface RoadSeg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  halfW: number;
}

/** Surface road centreline segments (not gradeSeparated), bucketed by WALL_CELL_M cells. */
function roadSegments(roads: RoadsFile | null): { segs: RoadSeg[]; cells: Map<number, number[]> } {
  const segs: RoadSeg[] = [];
  const cells = new Map<number, number[]>();
  if (!roads) return { segs, cells };
  const edges = [...roads.edges].sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  for (const e of edges) {
    if (e.gradeSeparated === true) continue;
    const halfW = (e.widthM !== undefined && e.widthM > 0 ? e.widthM : KERB_DEFAULT_M) / 2;
    for (let i = 1; i < e.points.length; i++) {
      const a = e.points[i - 1]!;
      const b = e.points[i]!;
      const s: RoadSeg = { ax: a[0]!, az: a[1]!, bx: b[0]!, bz: b[1]!, halfW };
      if (s.ax === s.bx && s.az === s.bz) continue;
      const k = segs.length;
      segs.push(s);
      addToCells(cells, k, s.ax, s.az, s.bx, s.bz, 0);
    }
  }
  return { segs, cells };
}

function addToCells(cells: Map<number, number[]>, k: number, ax: number, az: number, bx: number, bz: number, pad: number): void {
  const x0 = Math.floor(((ax < bx ? ax : bx) - pad) / WALL_CELL_M);
  const x1 = Math.floor(((ax > bx ? ax : bx) + pad) / WALL_CELL_M);
  const z0 = Math.floor(((az < bz ? az : bz) - pad) / WALL_CELL_M);
  const z1 = Math.floor(((az > bz ? az : bz) + pad) / WALL_CELL_M);
  for (let cx = x0; cx <= x1; cx++) {
    for (let cz = z0; cz <= z1; cz++) {
      const key = cellKey(cx, cz);
      let l = cells.get(key);
      if (!l) cells.set(key, (l = []));
      if (l[l.length - 1] !== k) l.push(k);
    }
  }
}

/**
 * Where the road segment c-d crosses the wall segment a-b: the parameter along a-b (0..1) and
 * |sin| of the crossing angle, or null when they do not cross.
 */
function crossing(ax: number, az: number, bx: number, bz: number, s: RoadSeg): { t: number; sin: number } | null {
  const ex = bx - ax;
  const ez = bz - az;
  const fx = s.bx - s.ax;
  const fz = s.bz - s.az;
  const den = ex * fz - ez * fx;
  if (den === 0) return null;
  const qx = s.ax - ax;
  const qz = s.az - az;
  const t = (qx * fz - qz * fx) / den;
  const u = (qx * ez - qz * ex) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  const le = Math.sqrt(ex * ex + ez * ez);
  const lf = Math.sqrt(fx * fx + fz * fz);
  const sin = (den < 0 ? -den : den) / (le * lf);
  return { t, sin };
}

/** Arc-length intervals [s0, s1] of a shore polyline to leave open for the roads that cross it. */
function gapsFor(line: Polyline, cum: readonly number[], roads: { segs: RoadSeg[]; cells: Map<number, number[]> }): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (roads.segs.length === 0) return out;
  const seen: number[] = [];
  for (let i = 1; i < line.xs.length; i++) {
    const ax = line.xs[i - 1]!;
    const az = line.zs[i - 1]!;
    const bx = line.xs[i]!;
    const bz = line.zs[i]!;
    const len = cum[i]! - cum[i - 1]!;
    if (len <= 0) continue;
    seen.length = 0;
    const x0 = Math.floor((ax < bx ? ax : bx) / WALL_CELL_M);
    const x1 = Math.floor((ax > bx ? ax : bx) / WALL_CELL_M);
    const z0 = Math.floor((az < bz ? az : bz) / WALL_CELL_M);
    const z1 = Math.floor((az > bz ? az : bz) / WALL_CELL_M);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const l = roads.cells.get(cellKey(cx, cz));
        if (!l) continue;
        for (const k of l) {
          if (seen.includes(k)) continue;
          seen.push(k);
          const s = roads.segs[k]!;
          const c = crossing(ax, az, bx, bz, s);
          if (!c) continue;
          const sin = c.sin < 0.25 ? 0.25 : c.sin;
          let half = (s.halfW + WALL_GAP_MARGIN_M) / sin;
          if (half > MAX_HALF_GAP_M) half = MAX_HALF_GAP_M;
          const at = cum[i - 1]! + c.t * len;
          out.push([at - half, at + half]);
        }
      }
    }
  }
  out.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const merged: Array<[number, number]> = [];
  for (const g of out) {
    const last = merged[merged.length - 1];
    if (last && g[0] <= last[1]) {
      if (g[1] > last[1]) last[1] = g[1];
    } else merged.push([g[0], g[1]]);
  }
  return merged;
}

function pushSegment(segs: WallSegment[], kind: WallKind, ax: number, az: number, bx: number, bz: number): void {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 1e-6) return;
  const ux = dx / len;
  const uz = dz / len;
  // Left of travel: right of (ux, uz) is (-uz, ux), so left is (uz, -ux).
  segs.push({ ax, az, bx, bz, ux, uz, nx: uz, nz: -ux, len, kind });
}

/** Build the walls of a world from its boundary.json and (for the gaps) its roads.json. */
export function buildWalls(boundary: BoundaryFile, roads: RoadsFile | null): Walls {
  const lines: Polyline[] = [];
  for (const e of boundary.edges) lines.push(polylineOf(e.kind === "land" ? "land" : "water", e.closed, e.points));
  for (const s of boundary.shore) lines.push(polylineOf("shore", s.closed, s.points));
  const road = roadSegments(roads);
  const segments: WallSegment[] = [];
  let gaps = 0;
  for (const line of lines) {
    const n = line.xs.length;
    if (n < 2) continue;
    const cum: number[] = [0];
    for (let i = 1; i < n; i++) {
      const dx = line.xs[i]! - line.xs[i - 1]!;
      const dz = line.zs[i]! - line.zs[i - 1]!;
      cum.push(cum[i - 1]! + Math.sqrt(dx * dx + dz * dz));
    }
    const open = line.kind === "shore" ? gapsFor(line, cum, road) : [];
    gaps += open.length;
    let g = 0;
    for (let i = 1; i < n; i++) {
      const s0 = cum[i - 1]!;
      const s1 = cum[i]!;
      const len = s1 - s0;
      if (len <= 0) continue;
      const ax = line.xs[i - 1]!;
      const az = line.zs[i - 1]!;
      const bx = line.xs[i]!;
      const bz = line.zs[i]!;
      // Walk this segment's stretch [s0, s1], skipping the gaps that overlap it.
      while (g < open.length && open[g]![1] <= s0) g++;
      let from = s0;
      for (let k = g; k < open.length && open[k]![0] < s1; k++) {
        const [g0, g1] = open[k]!;
        if (g0 > from) {
          const t0 = (from - s0) / len;
          const t1 = (g0 - s0) / len;
          pushSegment(segments, line.kind, ax + (bx - ax) * t0, az + (bz - az) * t0, ax + (bx - ax) * t1, az + (bz - az) * t1);
        }
        if (g1 > from) from = g1;
      }
      if (from < s1) {
        if (from === s0) pushSegment(segments, line.kind, ax, az, bx, bz);
        else {
          const t0 = (from - s0) / len;
          pushSegment(segments, line.kind, ax + (bx - ax) * t0, az + (bz - az) * t0, bx, bz);
        }
      }
    }
  }
  const cells = new Map<number, number[]>();
  segments.forEach((s, k) => addToCells(cells, k, s.ax, s.az, s.bx, s.bz, WALL_END_M));
  return { segments, cells, gaps };
}

/** Indices of the wall segments whose cells overlap the square of half-size r around (x, z), ascending. */
export function wallsNear(walls: Walls, x: number, z: number, r: number): number[] {
  const out: number[] = [];
  const cx0 = Math.floor((x - r) / WALL_CELL_M);
  const cx1 = Math.floor((x + r) / WALL_CELL_M);
  const cz0 = Math.floor((z - r) / WALL_CELL_M);
  const cz1 = Math.floor((z + r) / WALL_CELL_M);
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cz = cz0; cz <= cz1; cz++) {
      const l = walls.cells.get(cellKey(cx, cz));
      if (!l) continue;
      for (const k of l) if (!out.includes(k)) out.push(k);
    }
  }
  if (out.length > 1) out.sort((p, q) => p - q);
  return out;
}

/**
 * Signed distance of (x, z) from the wall's line, + on the land side, when the point is within
 * the wall's reach along it (WALL_END_M past either end); else null.
 */
export function wallSide(w: Readonly<WallSegment>, x: number, z: number): number | null {
  const ox = x - w.ax;
  const oz = z - w.az;
  const t = ox * w.ux + oz * w.uz;
  if (t < -WALL_END_M || t > w.len + WALL_END_M) return null;
  return ox * w.nx + oz * w.nz;
}

/**
 * How far a circle of radius r at (x, z) must move along the wall's land normal to clear it
 * (0 when clear), for a walker. Points deeper than WALL_DEPTH_M behind the wall are left alone.
 */
export function circleWallDepth(w: Readonly<WallSegment>, x: number, z: number, r: number): number {
  const d = wallSide(w, x, z);
  if (d === null || d >= r || d <= -WALL_DEPTH_M) return 0;
  return r - d;
}

/** Does a circle overlap any wall (for spawn and exit checks)? */
export function circleHitsWall(walls: Walls | null, x: number, z: number, r: number): boolean {
  if (!walls) return false;
  for (const k of wallsNear(walls, x, z, r + WALL_END_M)) if (circleWallDepth(walls.segments[k]!, x, z, r) > 0) return true;
  return false;
}

/** Does the segment from (ax, az) to (bx, bz) cross from one side of a wall to the other? */
export function segmentCrossesWall(walls: Walls | null, ax: number, az: number, bx: number, bz: number): boolean {
  if (!walls) return false;
  const mx = (ax + bx) / 2;
  const mz = (az + bz) / 2;
  const hx = ax > bx ? ax - bx : bx - ax;
  const hz = az > bz ? az - bz : bz - az;
  const r = (hx > hz ? hx : hz) / 2 + WALL_END_M;
  for (const k of wallsNear(walls, mx, mz, r)) {
    const w = walls.segments[k]!;
    const da = (ax - w.ax) * w.nx + (az - w.az) * w.nz;
    const db = (bx - w.ax) * w.nx + (bz - w.az) * w.nz;
    if ((da < 0) === (db < 0)) continue;
    const t = da / (da - db);
    const px = ax + (bx - ax) * t;
    const pz = az + (bz - az) * t;
    const along = (px - w.ax) * w.ux + (pz - w.az) * w.uz;
    if (along >= -WALL_END_M && along <= w.len + WALL_END_M) return true;
  }
  return false;
}
