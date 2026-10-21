// The world's edge as walls: boundary.json (schemas/boundary.schema.json) turned into wall
// segments that player cars and walkers cannot cross.
//
//  - Every outline run (`edges`, land and water) is a wall: beyond the built tiles there is no
//    ground (the sim's ground is 0 there, a 100 m drop at the southern city limit).
//  - Every shore line (`shore`) is a wall: the sea wall of the design (docs/design.md, "Decks,
//    tunnels and water"). Water is a sim boundary until decks and towing exist.
//  - Walls are two-sided: a body never crosses one, from either side. collide.ts follows each
//    point of a body from where it was at the start of the tick and sends it back if its path
//    crossed a wall, so a car that somehow is on the water stays there instead of being thrown
//    onto the bank. Land is on the left of travel along every line (+x east, +z south); the
//    normal (nx, nz) points at it.
//  - Roads over water: where a surface street the road graph lets traffic or people use (never
//    a freeway or a ramp joining one) runs over open water (a bridge, a pier road), the stretch
//    of its centreline over the water, widened to the road's half width plus
//    CORRIDOR_MARGIN_M each side, is a corridor. The shore is cut where a corridor covers it,
//    and the corridor's sides (kerbs) and ends over the water are walls, so a car can drive
//    across the 3rd St bridge or down a pier road, but not off it into the creek. Corridors
//    that overlap (a junction on a bridge, the two halves of a divided road) count as one: no
//    kerb stands inside another corridor. The road surface stays at the water's height until
//    the wave-2 deck schema raises it.
//  - Outline runs are never cut: the world stops there.
//  - A wall acts a little past its ends (WALL_END_M) so an outward corner leaves no slot to slip
//    through; where it meets its neighbour at an inward corner it only overlaps it by
//    JOINT_REACH_M, so it never reaches into the open ground beside the corner.
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

export type WallKind = "land" | "water" | "shore" | "kerb";

/** One straight piece of wall. Land (or the inside of a road corridor) is on the left of a -> b: the normal (nx, nz) points there. */
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
  /** How far the wall acts before a, along its line (WALL_END_M, or JOINT_REACH_M at an inward corner). */
  reachA: number;
  /** How far it acts past b. */
  reachB: number;
}

/** A road over water (see the header): its outline, a closed ring with the inside on the left of travel. */
export interface Corridor {
  edgeId: string;
  /** Ring vertices as [x0, z0, x1, z1, ...]; the last vertex joins the first. */
  ring: number[];
  /** Half width of the corridor, metres. */
  halfW: number;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/** The shore lines, indexed for crossing and side queries. */
export interface ShoreIndex {
  /**
   * Segments as [ax, az, bx, bz, nx, nz, nax, naz, nbx, nbz] at SHORE_STRIDE * i: the normal
   * points at land; (nax, naz) and (nbx, nbz) are the normals at its ends, the sum of the two
   * segments' normals where it joins its neighbour, so a point nearest a corner gets the
   * corner's side.
   */
  segs: Float64Array;
  /** cellKey of WALL_CELL_M cells -> indices of the shore segments touching the cell, ascending. */
  cells: Map<number, number[]>;
  /** Open water or not, for points farther than SHORE_SEARCH_M from every shore (the ground's water mask), or null: land. */
  farWater: ((x: number, z: number) => boolean) | null;
}

export interface Walls {
  segments: WallSegment[];
  /** cellKey(cx, cz) of WALL_CELL_M cells -> indices of the segments touching the cell, ascending. */
  cells: Map<number, number[]>;
  /** Stretches of shore cut open by road corridors. */
  gaps: number;
  /** Roads over water (see the header). */
  corridors: Corridor[];
  shore: ShoreIndex;
}

/** A wall acts this far past a free end or an outward corner, so a corner leaves no slot to slip through. */
export const WALL_END_M = 0.5;
/** ... and this far past an inward corner, where its neighbour carries on. */
export const JOINT_REACH_M = 0.05;
/** A road corridor over water reaches this far beyond the road's half width (the sidewalks and a walker on them). */
export const CORRIDOR_MARGIN_M = 3;
/** A kerb carries on this far onto the land where it meets the shore, so the joint leaves no slot. */
export const KERB_OVERLAP_M = 0.5;
/** Beyond this distance from every shore line, the ground's water mask (or else: land) decides. */
export const SHORE_SEARCH_M = 300;
/** Stretches of a road over water closer than this along it are one corridor (a strip of land under a pier road). */
const MERGE_LAND_M = 60;
const WALL_CELL_M = 50;
const KERB_DEFAULT_M = 10;
/** A road crossing the shore at a grazing angle is treated as crossing at this |sin| at least. */
const MIN_CROSS_SIN = 0.25;
const MAX_EXTEND_M = 60;
/** Miter joins on a corridor's sides are at most this many half widths from the centreline. */
const MITER_LIMIT = 2;
/** Turns sharper than this (|cross| of unit directions) count as corners. */
const TURN_EPS = 1e-9;

/** Integer cell coordinates packed into one number (as world.ts cellKey). */
function cellKey(cx: number, cz: number): number {
  return (cx + 1048576) * 2097152 + (cz + 1048576);
}

interface Polyline {
  kind: WallKind;
  closed: boolean;
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
  let isClosed = false;
  if (closed && xs.length > 2) {
    // Store a closed ring without its repeated first point; the last segment joins back to it.
    if (xs[0] === xs[xs.length - 1] && zs[0] === zs[zs.length - 1]) {
      xs.pop();
      zs.pop();
    }
    isClosed = xs.length > 2;
  }
  return { kind, closed: isClosed, xs, zs };
}

/** Number of segments of a polyline (a closed ring has one more, back to its start). */
function segCount(line: Polyline): number {
  const n = line.xs.length;
  return line.closed ? n : n - 1;
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
 * Where segment p0-p1 crosses segment q0-q1: the parameters along each (0..1, ends included)
 * and |sin| of the angle between them; null when they are parallel or apart.
 */
function segCross(
  p0x: number,
  p0z: number,
  p1x: number,
  p1z: number,
  q0x: number,
  q0z: number,
  q1x: number,
  q1z: number,
): { t: number; u: number; sin: number } | null {
  const ex = p1x - p0x;
  const ez = p1z - p0z;
  const fx = q1x - q0x;
  const fz = q1z - q0z;
  const den = ex * fz - ez * fx;
  if (den === 0) return null;
  const qx = q0x - p0x;
  const qz = q0z - p0z;
  const t = (qx * fz - qz * fx) / den;
  const u = (qx * ez - qz * ex) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  const le = Math.sqrt(ex * ex + ez * ez);
  const lf = Math.sqrt(fx * fx + fz * fz);
  return { t, u, sin: (den < 0 ? -den : den) / (le * lf) };
}

// ---------------------------------------------------------------------------------------------
// The shore index and the land/water side of a point.

const SHORE_STRIDE = 10;

function buildShoreIndex(lines: readonly Polyline[], farWater: ((x: number, z: number) => boolean) | null): ShoreIndex {
  const flat: number[] = [];
  const cells = new Map<number, number[]>();
  for (const line of lines) {
    const n = line.xs.length;
    const m = segCount(line);
    // Unit normals of the line's segments (zero-length ones are skipped: polylineOf dropped repeats).
    const nx: number[] = [];
    const nz: number[] = [];
    for (let i = 0; i < m; i++) {
      const dx = line.xs[(i + 1) % n]! - line.xs[i]!;
      const dz = line.zs[(i + 1) % n]! - line.zs[i]!;
      const len = Math.sqrt(dx * dx + dz * dz);
      nx.push(len > 0 ? dz / len : 0);
      nz.push(len > 0 ? -dx / len : 0);
    }
    for (let i = 0; i < m; i++) {
      const ax = line.xs[i]!;
      const az = line.zs[i]!;
      const bx = line.xs[(i + 1) % n]!;
      const bz = line.zs[(i + 1) % n]!;
      if (nx[i] === 0 && nz[i] === 0) continue;
      const prev = i > 0 ? i - 1 : line.closed ? m - 1 : -1;
      const next = i + 1 < m ? i + 1 : line.closed ? 0 : -1;
      const k = flat.length / SHORE_STRIDE;
      flat.push(
        ax,
        az,
        bx,
        bz,
        nx[i]!,
        nz[i]!,
        nx[i]! + (prev >= 0 ? nx[prev]! : 0),
        nz[i]! + (prev >= 0 ? nz[prev]! : 0),
        nx[i]! + (next >= 0 ? nx[next]! : 0),
        nz[i]! + (next >= 0 ? nz[next]! : 0),
      );
      addToCells(cells, k, ax, az, bx, bz, 0);
    }
  }
  return { segs: Float64Array.from(flat), cells, farWater };
}

/**
 * Is (x, z) on the water side of the shore? The side of the nearest shore segment within
 * SHORE_SEARCH_M (land on its left). Where two segments are equally near at their shared
 * corner they agree on the side. Farther than that from every shore, the ground's water mask
 * decides (the shore lines are traced from it), or the point is on land when there is none.
 */
export function onWater(shore: ShoreIndex, x: number, z: number): boolean {
  const s = shore.segs;
  const c0x = Math.floor(x / WALL_CELL_M);
  const c0z = Math.floor(z / WALL_CELL_M);
  const rings = Math.ceil(SHORE_SEARCH_M / WALL_CELL_M);
  let best = Infinity;
  let water = false;
  for (let k = 0; k <= rings; k++) {
    // Everything in ring k is at least (k - 1) cells away from any point of the centre cell.
    if (k > 0 && best <= (k - 1) * WALL_CELL_M * ((k - 1) * WALL_CELL_M)) break;
    for (let cx = c0x - k; cx <= c0x + k; cx++) {
      const edge = cx === c0x - k || cx === c0x + k;
      for (let cz = c0z - k; cz <= c0z + k; cz += edge || k === 0 ? 1 : 2 * k) {
        const l = shore.cells.get(cellKey(cx, cz));
        if (!l) continue;
        for (const i of l) {
          const o = i * SHORE_STRIDE;
          const ax = s[o]!;
          const az = s[o + 1]!;
          const ex = s[o + 2]! - ax;
          const ez = s[o + 3]! - az;
          const len2 = ex * ex + ez * ez;
          let t = ((x - ax) * ex + (z - az) * ez) / len2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const px = ax + ex * t - x;
          const pz = az + ez * t - z;
          const d2 = px * px + pz * pz;
          if (d2 < best) {
            best = d2;
            // Nearest the segment's inside: its own normal; nearest an end: that corner's normal.
            const nOff = t <= 0 ? 6 : t >= 1 ? 8 : 4;
            water = -px * s[o + nOff]! + -pz * s[o + nOff + 1]! < 0;
          }
        }
      }
    }
  }
  if (best <= SHORE_SEARCH_M * SHORE_SEARCH_M) return water;
  return shore.farWater !== null && shore.farWater(x, z);
}

/** Arc parameters along segment a-b (0..1) where it crosses the shore, ascending. */
function shoreCrossings(shore: ShoreIndex, ax: number, az: number, bx: number, bz: number): Array<{ t: number; sin: number }> {
  const out: Array<{ t: number; sin: number }> = [];
  const seen = new Set<number>();
  const s = shore.segs;
  const x0 = Math.floor((ax < bx ? ax : bx) / WALL_CELL_M);
  const x1 = Math.floor((ax > bx ? ax : bx) / WALL_CELL_M);
  const z0 = Math.floor((az < bz ? az : bz) / WALL_CELL_M);
  const z1 = Math.floor((az > bz ? az : bz) / WALL_CELL_M);
  for (let cx = x0; cx <= x1; cx++) {
    for (let cz = z0; cz <= z1; cz++) {
      const l = shore.cells.get(cellKey(cx, cz));
      if (!l) continue;
      for (const i of l) {
        if (seen.has(i)) continue;
        seen.add(i);
        const o = i * SHORE_STRIDE;
        const c = segCross(ax, az, bx, bz, s[o]!, s[o + 1]!, s[o + 2]!, s[o + 3]!);
        if (c) out.push({ t: c.t, sin: c.sin });
      }
    }
  }
  out.sort((p, q) => p.t - q.t || p.sin - q.sin);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Road corridors over water.

interface Line {
  xs: number[];
  zs: number[];
  cum: number[];
  len: number;
}

function lineOf(pts: ReadonlyArray<readonly number[]>): Line {
  const xs: number[] = [];
  const zs: number[] = [];
  for (const p of pts) {
    const x = p[0]!;
    const z = p[1]!;
    if (xs.length > 0 && xs[xs.length - 1] === x && zs[zs.length - 1] === z) continue;
    xs.push(x);
    zs.push(z);
  }
  const cum = [0];
  for (let i = 1; i < xs.length; i++) {
    const dx = xs[i]! - xs[i - 1]!;
    const dz = zs[i]! - zs[i - 1]!;
    cum.push(cum[i - 1]! + Math.sqrt(dx * dx + dz * dz));
  }
  return { xs, zs, cum, len: cum[cum.length - 1]! };
}

/** The point at arc length s, carrying straight on past either end. */
function pointAt(l: Line, s: number): [number, number] {
  const n = l.xs.length;
  let i = 1;
  if (s > 0) while (i < n - 1 && l.cum[i]! < s) i++;
  const s0 = l.cum[i - 1]!;
  const seg = l.cum[i]! - s0;
  const t = (s - s0) / seg;
  return [l.xs[i - 1]! + (l.xs[i]! - l.xs[i - 1]!) * t, l.zs[i - 1]! + (l.zs[i]! - l.zs[i - 1]!) * t];
}

/** The stretch [s0, s1] of a line (either end may lie beyond the line: it carries on straight). */
function subLine(l: Line, s0: number, s1: number): { xs: number[]; zs: number[] } {
  const [x0, z0] = pointAt(l, s0);
  const xs = [x0];
  const zs = [z0];
  for (let i = 1; i < l.xs.length - 1; i++) {
    if (l.cum[i]! > s0 && l.cum[i]! < s1) {
      xs.push(l.xs[i]!);
      zs.push(l.zs[i]!);
    }
  }
  const [x1, z1] = pointAt(l, s1);
  xs.push(x1);
  zs.push(z1);
  return { xs, zs };
}

/** The line offset d to the right of travel (negative: left), mitred at its bends. */
function offsetLine(xs: readonly number[], zs: readonly number[], d: number): { xs: number[]; zs: number[] } {
  const n = xs.length;
  const nx: number[] = [];
  const nz: number[] = [];
  for (let i = 0; i + 1 < n; i++) {
    const dx = xs[i + 1]! - xs[i]!;
    const dz = zs[i + 1]! - zs[i]!;
    const len = Math.sqrt(dx * dx + dz * dz);
    // Right of (ux, uz) is (-uz, ux).
    nx.push(-dz / len);
    nz.push(dx / len);
  }
  const ox: number[] = [];
  const oz: number[] = [];
  for (let i = 0; i < n; i++) {
    let mx: number;
    let mz: number;
    if (i === 0) {
      mx = nx[0]!;
      mz = nz[0]!;
    } else if (i === n - 1) {
      mx = nx[n - 2]!;
      mz = nz[n - 2]!;
    } else {
      const dot = nx[i - 1]! * nx[i]! + nz[i - 1]! * nz[i]!;
      mx = (nx[i - 1]! + nx[i]!) / (1 + dot);
      mz = (nz[i - 1]! + nz[i]!) / (1 + dot);
      const m2 = mx * mx + mz * mz;
      if (!(m2 <= MITER_LIMIT * MITER_LIMIT)) {
        const k = MITER_LIMIT / Math.sqrt(m2 > 0 ? m2 : 1);
        mx *= k;
        mz *= k;
      }
    }
    ox.push(xs[i]! + mx * d);
    oz.push(zs[i]! + mz * d);
  }
  return { xs: ox, zs: oz };
}

function corridorOf(edgeId: string, centre: { xs: number[]; zs: number[] }, halfW: number): Corridor | null {
  // Drop zero-length steps (a stretch can start or end on a vertex).
  const xs: number[] = [];
  const zs: number[] = [];
  for (let i = 0; i < centre.xs.length; i++) {
    const x = centre.xs[i]!;
    const z = centre.zs[i]!;
    if (xs.length > 0) {
      const dx = x - xs[xs.length - 1]!;
      const dz = z - zs[zs.length - 1]!;
      if (dx * dx + dz * dz < 1e-12) continue;
    }
    xs.push(x);
    zs.push(z);
  }
  if (xs.length < 2) return null;
  const right = offsetLine(xs, zs, halfW);
  const left = offsetLine(xs, zs, -halfW);
  // Right side forward, then the left side back: the inside is on the left of travel.
  const ring: number[] = [];
  for (let i = 0; i < right.xs.length; i++) ring.push(right.xs[i]!, right.zs[i]!);
  for (let i = left.xs.length - 1; i >= 0; i--) ring.push(left.xs[i]!, left.zs[i]!);
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    minX = Math.min(minX, ring[i]!);
    maxX = Math.max(maxX, ring[i]!);
    minZ = Math.min(minZ, ring[i + 1]!);
    maxZ = Math.max(maxZ, ring[i + 1]!);
  }
  return { edgeId, ring, halfW, minX, minZ, maxX, maxZ };
}

/**
 * The corridors of the roads over water: every stretch of an opened edge's centreline on the
 * water side of the shore. A stretch that ends where the road crosses the shore carries on
 * onto the land far enough for its sides to reach the shore line (their parts on land are no
 * walls); one that ends at a node over the water carries on one half width past it, so it
 * overlaps the corridor of the road beyond (or, at a dead end, leaves room to stop).
 */
function buildCorridors(roads: RoadsFile, shore: ShoreIndex, opens: (e: RoadsFile["edges"][number]) => boolean): Corridor[] {
  const out: Corridor[] = [];
  if (shore.segs.length === 0) return out;
  const edges = [...roads.edges].sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  // Coarse cells (SHORE_SEARCH_M) holding shore, dilated by one: an edge with no vertex in one
  // is on land (or far out in open water, where no street runs), without a search.
  const coarse = new Set<number>();
  for (const key of shore.cells.keys()) {
    const cx = Math.floor((Math.floor(key / 2097152) - 1048576) * WALL_CELL_M / SHORE_SEARCH_M);
    const cz = Math.floor(((key % 2097152) - 1048576) * WALL_CELL_M / SHORE_SEARCH_M);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) coarse.add(cellKey(cx + dx, cz + dz));
  }
  const nearShore = (x: number, z: number): boolean => coarse.has(cellKey(Math.floor(x / SHORE_SEARCH_M), Math.floor(z / SHORE_SEARCH_M)));
  for (const e of edges) {
    if (!opens(e)) continue;
    const l = lineOf(e.points);
    if (l.xs.length < 2 || l.len <= 0) continue;
    const n = l.xs.length;
    let near = false;
    for (let i = 0; i < n && !near; i++) near = nearShore(l.xs[i]!, l.zs[i]!);
    if (!near) continue;
    // Shore crossings along the centreline, as arc lengths, with the crossing angle.
    const cuts: Array<{ s: number; sin: number }> = [];
    for (let i = 1; i < n; i++) {
      for (const c of shoreCrossings(shore, l.xs[i - 1]!, l.zs[i - 1]!, l.xs[i]!, l.zs[i]!)) {
        cuts.push({ s: l.cum[i - 1]! + c.t * (l.cum[i]! - l.cum[i - 1]!), sin: c.sin });
      }
    }
    cuts.sort((p, q) => p.s - q.s || p.sin - q.sin);
    const bounds: Array<{ s: number; sin: number }> = [{ s: 0, sin: 0 }, ...cuts, { s: l.len, sin: 0 }];
    // Wet pieces between consecutive cuts, merged into stretches.
    const stretches: Array<{ s0: number; sin0: number; s1: number; sin1: number }> = [];
    for (let i = 1; i < bounds.length; i++) {
      const a = bounds[i - 1]!;
      const b = bounds[i]!;
      if (b.s - a.s < 1e-6) continue;
      const [mx, mz] = pointAt(l, (a.s + b.s) / 2);
      if (!onWater(shore, mx, mz)) continue;
      const last = stretches[stretches.length - 1];
      if (last && a.s - last.s1 < MERGE_LAND_M) {
        last.s1 = b.s;
        last.sin1 = b.sin;
      } else stretches.push({ s0: a.s, sin0: a.sin, s1: b.s, sin1: b.sin });
    }
    if (stretches.length === 0) continue;
    const halfW = (e.widthM !== undefined && e.widthM > 0 ? e.widthM : KERB_DEFAULT_M) / 2 + CORRIDOR_MARGIN_M;
    // Onto the land at a shore crossing: far enough that both sides reach the shore line.
    const landward = (sin: number): number => {
      const sn = sin < MIN_CROSS_SIN ? MIN_CROSS_SIN : sin > 1 ? 1 : sin;
      const ext = (halfW * Math.sqrt(1 - sn * sn)) / sn + 2;
      return ext < MAX_EXTEND_M ? ext : MAX_EXTEND_M;
    };
    for (const st of stretches) {
      const e0 = st.s0 <= 0 ? halfW : landward(st.sin0);
      const e1 = st.s1 >= l.len ? halfW : landward(st.sin1);
      const c = corridorOf(e.id, subLine(l, st.s0 - e0, st.s1 + e1), halfW);
      if (c) out.push(c);
    }
  }
  return out;
}

/** Is (x, z) strictly inside the corridor (not on its outline)? */
function insideCorridor(c: Corridor, x: number, z: number): boolean {
  if (x <= c.minX || x >= c.maxX || z <= c.minZ || z >= c.maxZ) return false;
  const r = c.ring;
  const n = r.length / 2;
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = r[2 * i]!;
    const zi = r[2 * i + 1]!;
    const xj = r[2 * j]!;
    const zj = r[2 * j + 1]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    const ex = xi - xj;
    const ez = zi - zj;
    const len2 = ex * ex + ez * ez;
    let t = len2 > 0 ? ((x - xj) * ex + (z - zj) * ez) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = xj + ex * t - x;
    const pz = zj + ez * t - z;
    const d2 = px * px + pz * pz;
    if (d2 < best) best = d2;
  }
  return inside && best > 1e-12;
}

/** Parameter intervals (0..1) of segment a-b strictly inside any of the corridors, merged and ascending. */
function insideIntervals(ax: number, az: number, bx: number, bz: number, corridors: readonly Corridor[], skip: Corridor | null): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const minX = ax < bx ? ax : bx;
  const maxX = ax > bx ? ax : bx;
  const minZ = az < bz ? az : bz;
  const maxZ = az > bz ? az : bz;
  for (const c of corridors) {
    if (c === skip || maxX <= c.minX || minX >= c.maxX || maxZ <= c.minZ || minZ >= c.maxZ) continue;
    const ts = [0, 1];
    const r = c.ring;
    const n = r.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const hit = segCross(ax, az, bx, bz, r[2 * j]!, r[2 * j + 1]!, r[2 * i]!, r[2 * i + 1]!);
      if (hit) ts.push(hit.t);
    }
    ts.sort((p, q) => p - q);
    for (let k = 1; k < ts.length; k++) {
      const t0 = ts[k - 1]!;
      const t1 = ts[k]!;
      if (t1 - t0 < 1e-9) continue;
      const tm = (t0 + t1) / 2;
      if (insideCorridor(c, ax + (bx - ax) * tm, az + (bz - az) * tm)) out.push([t0, t1]);
    }
  }
  return mergeIntervals(out);
}

function mergeIntervals(list: Array<[number, number]>): Array<[number, number]> {
  list.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const merged: Array<[number, number]> = [];
  for (const g of list) {
    const last = merged[merged.length - 1];
    if (last && g[0] <= last[1]) {
      if (g[1] > last[1]) last[1] = g[1];
    } else merged.push([g[0], g[1]]);
  }
  return merged;
}

/** [0, 1] minus the given merged ascending intervals. */
function complement(cut: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let from = 0;
  for (const [c0, c1] of cut) {
    if (c0 > from) out.push([from, c0]);
    if (c1 > from) from = c1;
  }
  if (from < 1) out.push([from, 1]);
  return out;
}

/** Intersection of two merged ascending interval lists. */
function intersect(a: ReadonlyArray<readonly [number, number]>, b: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const lo = a[i]![0] > b[j]![0] ? a[i]![0] : b[j]![0];
    const hi = a[i]![1] < b[j]![1] ? a[i]![1] : b[j]![1];
    if (hi > lo) out.push([lo, hi]);
    if (a[i]![1] < b[j]![1]) i++;
    else j++;
  }
  return out;
}

/**
 * The parts of a corridor side (segment a-b) over the water: split where it crosses the shore,
 * each piece on the water side kept, carried on KERB_OVERLAP_M onto the land at a crossing.
 */
function wetIntervals(shore: ShoreIndex, ax: number, az: number, bx: number, bz: number): Array<[number, number]> {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len <= 0) return [];
  const ts = [0, ...shoreCrossings(shore, ax, az, bx, bz).map((c) => c.t), 1];
  const over = KERB_OVERLAP_M / len;
  const out: Array<[number, number]> = [];
  for (let k = 1; k < ts.length; k++) {
    const t0 = ts[k - 1]!;
    const t1 = ts[k]!;
    if (t1 - t0 < 1e-9) continue;
    const tm = (t0 + t1) / 2;
    if (!onWater(shore, ax + dx * tm, az + dz * tm)) continue;
    const lo = k > 1 ? t0 - over : t0;
    const hi = k < ts.length - 1 ? t1 + over : t1;
    out.push([lo < 0 ? 0 : lo, hi > 1 ? 1 : hi]);
  }
  return mergeIntervals(out);
}

// ---------------------------------------------------------------------------------------------
// Walls.

function pushSegment(segs: WallSegment[], kind: WallKind, ax: number, az: number, bx: number, bz: number, reachA: number, reachB: number): void {
  const dx = bx - ax;
  const dz = bz - az;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 1e-6) return;
  const ux = dx / len;
  const uz = dz / len;
  // Left of travel: right of (ux, uz) is (-uz, ux), so left is (uz, -ux).
  segs.push({ ax, az, bx, bz, ux, uz, nx: uz, nz: -ux, len, kind, reachA, reachB });
}

/**
 * Emit the kept pieces of a polyline's segments (keep(i) -> ascending [t0, t1] pieces of
 * segment i) as walls. A piece that meets the next one at an inward corner of the land (a
 * right turn; land is on the left) reaches only JOINT_REACH_M past it; free ends and outward
 * corners reach WALL_END_M.
 */
function emitLine(segs: WallSegment[], line: Polyline, keep: (i: number) => Array<[number, number]>): void {
  const n = line.xs.length;
  const m = segCount(line);
  if (m < 1) return;
  const pieces: Array<Array<[number, number]>> = [];
  for (let i = 0; i < m; i++) pieces.push(keep(i));
  const dir = (i: number): [number, number] => {
    const dx = line.xs[(i + 1) % n]! - line.xs[i]!;
    const dz = line.zs[(i + 1) % n]! - line.zs[i]!;
    const len = Math.sqrt(dx * dx + dz * dz);
    return len > 0 ? [dx / len, dz / len] : [0, 0];
  };
  // Is the joint at the end of segment i (into segment i + 1) intact and inward?
  const tightJoint = (i: number): boolean => {
    const j = i + 1 < m ? i + 1 : line.closed ? 0 : -1;
    if (j < 0) return false;
    const pi = pieces[i]!;
    const pj = pieces[j]!;
    if (pi.length === 0 || pj.length === 0 || pi[pi.length - 1]![1] < 1 || pj[0]![0] > 0) return false;
    const [ux, uz] = dir(i);
    const [vx, vz] = dir(j);
    // A left turn (cross < 0 with +x east, +z south) is an outward corner of the land.
    return !(ux * vz - uz * vx < -TURN_EPS);
  };
  for (let i = 0; i < m; i++) {
    const ax = line.xs[i]!;
    const az = line.zs[i]!;
    const bx = line.xs[(i + 1) % n]!;
    const bz = line.zs[(i + 1) % n]!;
    const prev = i > 0 ? i - 1 : line.closed ? m - 1 : -1;
    const startTight = prev >= 0 && tightJoint(prev);
    const endTight = tightJoint(i);
    for (const [t0, t1] of pieces[i]!) {
      const rA = t0 === 0 && startTight ? JOINT_REACH_M : WALL_END_M;
      const rB = t1 === 1 && endTight ? JOINT_REACH_M : WALL_END_M;
      pushSegment(
        segs,
        line.kind,
        t0 === 0 ? ax : ax + (bx - ax) * t0,
        t0 === 0 ? az : az + (bz - az) * t0,
        t1 === 1 ? bx : ax + (bx - ax) * t1,
        t1 === 1 ? bz : az + (bz - az) * t1,
        rA,
        rB,
      );
    }
  }
}

export interface WallOptions {
  /** Open water or not at a point far from every shore line (the ground's water mask); without it such points are land. */
  water?: (x: number, z: number) => boolean;
  /**
   * Which road edges get a corridor where they run over water: the road graph's drivable or
   * walkable edges (buildWorld passes them). Default: every edge that is not gradeSeparated.
   */
  opens?: (edge: RoadsFile["edges"][number]) => boolean;
}

/** Build the walls of a world from its boundary.json and (for the roads over water) its roads.json. */
export function buildWalls(boundary: BoundaryFile, roads: RoadsFile | null, options: WallOptions = {}): Walls {
  const outline: Polyline[] = boundary.edges.map((e) => polylineOf(e.kind === "land" ? "land" : "water", e.closed, e.points));
  const shoreLines: Polyline[] = boundary.shore.map((s) => polylineOf("shore", s.closed, s.points));
  const shore = buildShoreIndex(shoreLines, options.water ?? null);
  const opens = options.opens ?? ((e: RoadsFile["edges"][number]) => e.gradeSeparated !== true);
  const corridors = roads ? buildCorridors(roads, shore, opens) : [];
  const segments: WallSegment[] = [];
  for (const line of outline) emitLine(segments, line, () => [[0, 1]]);
  let gaps = 0;
  for (const line of shoreLines) {
    const n = line.xs.length;
    const m = segCount(line);
    const cut: Array<Array<[number, number]>> = [];
    for (let i = 0; i < m; i++) cut.push(insideIntervals(line.xs[i]!, line.zs[i]!, line.xs[(i + 1) % n]!, line.zs[(i + 1) % n]!, corridors, null));
    // Count each run of cut shore once.
    for (let i = 0; i < m; i++) {
      const prev = i > 0 ? cut[i - 1]! : line.closed ? cut[m - 1]! : [];
      const prevCutAtEnd = prev.length > 0 && prev[prev.length - 1]![1] >= 1;
      cut[i]!.forEach(([c0], k) => {
        if (k > 0 || c0 > 0 || !prevCutAtEnd) gaps++;
      });
    }
    emitLine(segments, line, (i) => complement(cut[i]!));
  }
  for (const c of corridors) {
    const xs: number[] = [];
    const zs: number[] = [];
    for (let i = 0; i < c.ring.length; i += 2) {
      xs.push(c.ring[i]!);
      zs.push(c.ring[i + 1]!);
    }
    const ring: Polyline = { kind: "kerb", closed: true, xs, zs };
    const n = xs.length;
    emitLine(segments, ring, (i) => {
      const ax = xs[i]!;
      const az = zs[i]!;
      const bx = xs[(i + 1) % n]!;
      const bz = zs[(i + 1) % n]!;
      return intersect(wetIntervals(shore, ax, az, bx, bz), complement(insideIntervals(ax, az, bx, bz, corridors, c)));
    });
  }
  const cells = new Map<number, number[]>();
  segments.forEach((s, k) => addToCells(cells, k, s.ax, s.az, s.bx, s.bz, WALL_END_M));
  return { segments, cells, gaps, corridors, shore };
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
 * the wall's reach along it (reachA before a, reachB past b); else null.
 */
export function wallSide(w: Readonly<WallSegment>, x: number, z: number): number | null {
  const ox = x - w.ax;
  const oz = z - w.az;
  const t = ox * w.ux + oz * w.uz;
  if (t < -w.reachA || t > w.len + w.reachB) return null;
  return ox * w.nx + oz * w.nz;
}

/**
 * Which side of the wall a point moving from (x0, z0) to (x1, z1) must stay on: the side it
 * started on (+1 land, -1 water) when its path crossed the wall within the wall's reach, else
 * the side it ends on. 0 when the wall is out of reach of the end point.
 */
export function wallKeepSide(w: Readonly<WallSegment>, x0: number, z0: number, x1: number, z1: number): number {
  const ox = x1 - w.ax;
  const oz = z1 - w.az;
  const t = ox * w.ux + oz * w.uz;
  if (t < -w.reachA || t > w.len + w.reachB) return 0;
  const d1 = ox * w.nx + oz * w.nz;
  const d0 = (x0 - w.ax) * w.nx + (z0 - w.az) * w.nz;
  const s0 = d0 < 0 ? -1 : 1;
  const s1 = d1 < 0 ? -1 : 1;
  if (s0 === s1) return s0;
  // The path crosses the wall's line here: is that within the wall's reach?
  const k = d0 / (d0 - d1);
  const cx = x0 + (x1 - x0) * k - w.ax;
  const cz = z0 + (z1 - z0) * k - w.az;
  const along = cx * w.ux + cz * w.uz;
  return along >= -w.reachA && along <= w.len + w.reachB ? s0 : s1;
}

/**
 * How far along the wall's land normal a circle of radius r that moved from (x0, z0) to (x, z)
 * must move to be r clear of the wall on the side it keeps (wallKeepSide); 0 when clear.
 */
export function circleWallPush(w: Readonly<WallSegment>, x0: number, z0: number, x: number, z: number, r: number): number {
  const side = wallKeepSide(w, x0, z0, x, z);
  if (side === 0) return 0;
  const d = (x - w.ax) * w.nx + (z - w.az) * w.nz;
  const gap = side * d;
  return gap >= r ? 0 : side * (r - gap);
}

/** Distance from (x, z) to the wall segment itself (its ends, no reach). */
function distToWall(w: Readonly<WallSegment>, x: number, z: number): number {
  const ox = x - w.ax;
  const oz = z - w.az;
  let t = ox * w.ux + oz * w.uz;
  t = t < 0 ? 0 : t > w.len ? w.len : t;
  const px = ox - w.ux * t;
  const pz = oz - w.uz * t;
  return Math.sqrt(px * px + pz * pz);
}

/** Does a circle overlap any wall (for spawn and exit checks)? */
export function circleHitsWall(walls: Walls | null, x: number, z: number, r: number): boolean {
  if (!walls) return false;
  for (const k of wallsNear(walls, x, z, r + WALL_END_M)) if (distToWall(walls.segments[k]!, x, z) < r) return true;
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
    if (along >= -w.reachA && along <= w.len + w.reachB) return true;
  }
  return false;
}

/** Is (x, z) inside one of the world's road corridors over water? */
export function inCorridor(walls: Walls, x: number, z: number): boolean {
  for (const c of walls.corridors) if (insideCorridor(c, x, z)) return true;
  return false;
}
