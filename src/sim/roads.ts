// Static road graph for ambient traffic, robots and (later) GPS routing.
//
// Built once from roads.json (schemas/roads.schema.json) alongside the tile colliders, held
// in World (world.roads), never in SimState and never mutated. Everything here is derived
// geometry: lane centre paths, sidewalk paths, intersection radii and per-area spawn pieces.
//
// Conventions (all distances metres, local frame of src/geo/project.ts):
//  - An edge runs a -> b along `points`. dir = 1 travels a -> b, dir = -1 travels b -> a.
//  - "Right" of a direction (ux, uz) is (-uz, ux): right of north (0,-1) is east (1,0).
//  - Lanes: right-hand traffic. A two-way edge with L lanes has max(1, floor(L/2)) lanes
//    each way, lane k centred (k + 0.5) * laneWidth right of the centreline. A one-way edge
//    has L lanes a -> b spread across the centreline.
//  - Sidewalks: one each side, centred SIDEWALK_OFFSET_M beyond the kerb (half the road
//    width). Walkers keep right: KEEP_RIGHT_M to the right of their walking direction.
//  - Lane and sidewalk paths stop short of each node by the node's radius (so turns happen
//    inside the intersection on connectors, see connector()).

import { clamp, datan2, wrapAngle } from "./dmath.ts";

/** roads.json as written by the pipeline (extra fields are ignored). */
export interface RoadsFile {
  version: number;
  nodes: ReadonlyArray<{ id: string; x: number; z: number; y?: number }>;
  edges: ReadonlyArray<{
    id: string;
    a: string;
    b: string;
    kind: string;
    lanes: number;
    oneway: boolean;
    widthM?: number;
    speedLimitMps?: number;
    name?: string;
    pedestrian?: boolean;
    points: ReadonlyArray<readonly [number, number] | readonly number[]>;
  }>;
}

/** A polyline in travel order with cumulative arc length (cum[0] = 0, cum[n-1] = len). */
export interface Path {
  xs: number[];
  zs: number[];
  cum: number[];
  len: number;
}

export type Dir = 1 | -1;

export interface DirEdge {
  edge: number;
  dir: Dir;
}

export interface RoadEdgeInfo {
  id: string;
  index: number;
  /** Node indices. */
  a: number;
  b: number;
  kind: string;
  lanes: number;
  oneway: boolean;
  widthM: number;
  speedLimitMps: number;
  name: string;
  pedestrian: boolean;
  /** Centreline a -> b. */
  center: Path;
  /** Lanes each way: [a -> b, b -> a]. */
  laneCount: [number, number];
  laneWidthM: number;
  /** Lane centre paths in travel order, trimmed at both nodes: lanePaths[dirIndex(dir)][lane]. */
  lanePaths: [Path[], Path[]];
  /** Lane path keeps a robotaxi clear of every building (checked at build time). */
  laneClear: [boolean[], boolean[]];
  /** Lane is clear by a margin that covers a robotaxi body anywhere on it (see LANE_SAFE_M). */
  laneSafe: [boolean[], boolean[]];
  /** Sidewalk paths in walking order: walkPaths[dirIndex(dir)][sideIndex(side)]; side +1 = right of a -> b. */
  walkPaths: [[Path, Path], [Path, Path]];
  walkClear: [[boolean, boolean], [boolean, boolean]];
  /** Distance of each side's sidewalk line beyond the kerb: [right of a -> b, left]. */
  sidewalkM: [number, number];
  /** Robotaxis may use the edge (not pedestrian-only, not an alley or a one-lane two-way street). */
  drivable: boolean;
  /** People and sidewalk robots may use the edge (no freeways or ramps). */
  walkable: boolean;
}

export interface RoadNodeInfo {
  id: string;
  index: number;
  x: number;
  z: number;
  /** Lane and sidewalk paths stop this far (at least) from the node. */
  radius: number;
  /**
   * cot(half the smallest angle between neighbouring streets), capped at 4. A path offset o
   * from its centreline stops at least o * sharp + 0.5 from the node, so offset paths on the
   * inside of an acute corner end before they cross.
   */
  sharp: number;
  /**
   * Junctions (3+ streets): lanes arriving here stop at least this far from the node, behind
   * the crosswalks (the sidewalk lines of the crossing streets, see SIDEWALK_OFFSET_M), so a
   * robotaxi waiting at the line never stands where people cross. 0 elsewhere.
   */
  stopM: number;
  degree: number;
  /** Compass bearings of every street leaving the node (incoming one-ways included), ascending. */
  bearings: number[];
  /** Every direction of travel leaving this node (one-way edges only a -> b), sorted by edge index then dir. */
  out: DirEdge[];
}

/** A stretch of centreline [s0, s1] of one edge, used to place spawns. */
export interface AreaPiece {
  edge: number;
  s0: number;
  s1: number;
}

/** Road length of one AREA_M x AREA_M cell, split by who may use it. */
export interface AreaRoads {
  key: string;
  ax: number;
  az: number;
  /** Cell centre. */
  cx: number;
  cz: number;
  drive: AreaPiece[];
  /** driveCum[i] = total drive length of pieces [0, i]. */
  driveCum: number[];
  driveLen: number;
  walk: AreaPiece[];
  walkCum: number[];
  walkLen: number;
}

export interface RoadGraph {
  nodes: RoadNodeInfo[];
  edges: RoadEdgeInfo[];
  nodeIndex: Map<string, number>;
  edgeIndex: Map<string, number>;
  /** Areas with any usable road, ascending key order. */
  areas: AreaRoads[];
  areaIndex: Map<string, number>;
}

export const AREA_M = 250;
/**
 * Preferred distance of the sidewalk walking line beyond the kerb (half the road width), then
 * the fallbacks tried in order until the line clears every building. Real sidewalks vary and
 * the road width in roads.json is an estimate, so a street whose buildings stand closer than
 * the estimate gets a line nearer the kerb (at worst 0.75 m inside it, on the parking strip,
 * still clear of the traffic lanes).
 */
export const SIDEWALK_OFFSET_M = 2;
export const SIDEWALK_OFFSETS_M: readonly number[] = [2, 1.5, 1, 0.5, 0, -0.75];
export const KEEP_RIGHT_M = 0.5;
export const MAX_LANE_WIDTH_M = 3.5;
/** Clearance radius a lane path must keep from buildings to count as clear. */
export const LANE_CLEARANCE_M = 1.0;
/**
 * A lane is "safe" when every point within LANE_SAFE_M of its centre line is clear of buildings
 * (sampled every LANE_SAFE_STEP_M, so the sampled clearance must be LANE_SAFE_M plus half a
 * step). A robotaxi body (two circles of radius 0.8 on the line) can never touch a building
 * there, so the per-step building check is skipped on safe lanes.
 */
export const LANE_SAFE_M = 0.85;
export const LANE_SAFE_STEP_M = 3;
export const WALK_CLEARANCE_M = 0.35;
/** Room between the crosswalk and a robotaxi's stop line at junctions. */
export const CROSSWALK_GAP_M = 1.0;

const KIND_DEFAULTS: Record<string, { laneM: number; extraM: number; limit: number }> = {
  freeway: { laneM: 3.6, extraM: 3.0, limit: 22.35 },
  ramp: { laneM: 3.8, extraM: 2.0, limit: 15.65 },
  arterial: { laneM: 3.3, extraM: 4.8, limit: 11.18 },
  collector: { laneM: 3.3, extraM: 4.8, limit: 11.18 },
  residential: { laneM: 3.2, extraM: 4.6, limit: 11.18 },
  alley: { laneM: 4.0, extraM: 0.5, limit: 6.7 },
  other: { laneM: 3.0, extraM: 0.5, limit: 6.7 },
};

export function dirIndex(dir: Dir): 0 | 1 {
  return dir === 1 ? 0 : 1;
}

export function sideIndex(side: number): 0 | 1 {
  return side === 1 ? 0 : 1;
}

export function areaKey(ax: number, az: number): string {
  return `${ax},${az}`;
}

export function areaOf(x: number, z: number): { ax: number; az: number; key: string } {
  const ax = Math.floor(x / AREA_M);
  const az = Math.floor(z / AREA_M);
  return { ax, az, key: areaKey(ax, az) };
}

// ---------------------------------------------------------------- paths

export function makePath(xs: number[], zs: number[]): Path {
  const cum = [0];
  for (let i = 1; i < xs.length; i++) {
    const dx = xs[i]! - xs[i - 1]!;
    const dz = zs[i]! - zs[i - 1]!;
    cum.push(cum[i - 1]! + Math.sqrt(dx * dx + dz * dz));
  }
  return { xs, zs, cum, len: cum[cum.length - 1]! };
}

export interface PathPoint {
  x: number;
  z: number;
  /** Unit tangent in travel direction. */
  tx: number;
  tz: number;
}

/** Point and tangent at arc length s (clamped to the path). */
export function pathPoint(p: Path, s: number): PathPoint {
  const n = p.xs.length;
  if (n === 1 || p.len <= 0) return { x: p.xs[0]!, z: p.zs[0]!, tx: 0, tz: -1 };
  const t = clamp(s, 0, p.len);
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (p.cum[mid]! <= t) lo = mid;
    else hi = mid;
  }
  const seg = p.cum[hi]! - p.cum[lo]!;
  const f = seg > 0 ? (t - p.cum[lo]!) / seg : 0;
  const dx = p.xs[hi]! - p.xs[lo]!;
  const dz = p.zs[hi]! - p.zs[lo]!;
  const l = Math.sqrt(dx * dx + dz * dz);
  return {
    x: p.xs[lo]! + dx * f,
    z: p.zs[lo]! + dz * f,
    tx: l > 0 ? dx / l : 0,
    tz: l > 0 ? dz / l : -1,
  };
}

/** Closest point of a path to (x, z): arc length s, signed lateral d (+ = right of travel), distance. */
export function projectOnPath(p: Path, x: number, z: number): { s: number; d: number; dist: number } {
  let best = { s: 0, d: 0, dist: Infinity };
  for (let i = 0; i + 1 < p.xs.length; i++) {
    const ax = p.xs[i]!;
    const az = p.zs[i]!;
    const ex = p.xs[i + 1]! - ax;
    const ez = p.zs[i + 1]! - az;
    const l2 = ex * ex + ez * ez;
    let t = l2 > 0 ? ((x - ax) * ex + (z - az) * ez) / l2 : 0;
    t = clamp(t, 0, 1);
    const px = ax + ex * t;
    const pz = az + ez * t;
    const dist = Math.sqrt((x - px) * (x - px) + (z - pz) * (z - pz));
    if (dist < best.dist) {
      const l = Math.sqrt(l2);
      // right of (ex, ez) is (-ez, ex)
      const side = l > 0 ? ((x - px) * -ez + (z - pz) * ex) / l : 0;
      best = { s: p.cum[i]! + t * l, d: side, dist };
    }
  }
  if (p.xs.length === 1) {
    const dist = Math.sqrt((x - p.xs[0]!) * (x - p.xs[0]!) + (z - p.zs[0]!) * (z - p.zs[0]!));
    best = { s: 0, d: 0, dist };
  }
  return best;
}

function dedupe(points: ReadonlyArray<readonly number[]>): { xs: number[]; zs: number[] } {
  const xs: number[] = [];
  const zs: number[] = [];
  for (const p of points) {
    const x = p[0]!;
    const z = p[1]!;
    const n = xs.length;
    if (n > 0 && Math.abs(xs[n - 1]! - x) < 1e-6 && Math.abs(zs[n - 1]! - z) < 1e-6) continue;
    xs.push(x);
    zs.push(z);
  }
  if (xs.length === 1) {
    xs.push(xs[0]!);
    zs.push(zs[0]!);
  }
  return { xs, zs };
}

/** Offset a polyline `offset` metres to the right of its travel direction (mitred joins). */
export function offsetPath(xs: readonly number[], zs: readonly number[], offset: number): Path {
  const n = xs.length;
  const rx: number[] = [];
  const rz: number[] = [];
  for (let i = 0; i + 1 < n; i++) {
    const dx = xs[i + 1]! - xs[i]!;
    const dz = zs[i + 1]! - zs[i]!;
    const l = Math.sqrt(dx * dx + dz * dz);
    rx.push(l > 0 ? -dz / l : 1);
    rz.push(l > 0 ? dx / l : 0);
  }
  const ox: number[] = [];
  const oz: number[] = [];
  for (let i = 0; i < n; i++) {
    let mx: number;
    let mz: number;
    let scale = 1;
    if (i === 0) {
      mx = rx[0]!;
      mz = rz[0]!;
    } else if (i === n - 1) {
      mx = rx[n - 2]!;
      mz = rz[n - 2]!;
    } else {
      mx = rx[i - 1]! + rx[i]!;
      mz = rz[i - 1]! + rz[i]!;
      const ml = Math.sqrt(mx * mx + mz * mz);
      if (ml < 1e-6) {
        mx = rx[i]!;
        mz = rz[i]!;
      } else {
        mx /= ml;
        mz /= ml;
        scale = 1 / Math.max(0.4, mx * rx[i]! + mz * rz[i]!);
      }
    }
    ox.push(xs[i]! + mx * offset * scale);
    oz.push(zs[i]! + mz * offset * scale);
  }
  return makePath(ox, oz);
}

/** The part of a path between arc lengths s0 and s1 (kept at least minLen long, centred, when it would vanish). */
export function subPath(p: Path, s0: number, s1: number, minLen = 0.3): Path {
  let a = clamp(s0, 0, p.len);
  let b = clamp(s1, 0, p.len);
  if (b - a < minLen) {
    const mid = clamp((a + b) / 2, 0, p.len);
    const h = Math.min(minLen, p.len) / 2;
    a = clamp(mid - h, 0, p.len);
    b = clamp(mid + h, 0, p.len);
  }
  const xs: number[] = [];
  const zs: number[] = [];
  const pa = pathPoint(p, a);
  xs.push(pa.x);
  zs.push(pa.z);
  for (let i = 0; i < p.xs.length; i++) {
    const c = p.cum[i]!;
    if (c > a + 1e-9 && c < b - 1e-9) {
      xs.push(p.xs[i]!);
      zs.push(p.zs[i]!);
    }
  }
  const pb = pathPoint(p, b);
  xs.push(pb.x);
  zs.push(pb.z);
  return makePath(xs, zs);
}

// ---------------------------------------------------------------- connectors

/**
 * A turn / crossing / U-turn from (x0, z0) heading (t0x, t0z) to (x3, z3) heading (t3x, t3z), as
 * the 8 numbers of a cubic Bezier [x0, z0, x1, z1, x2, z2, x3, z3]. When the two rays meet ahead
 * of both ends the handles point at the meeting point (`tight` 0.55 ~ circular arc, 1 = hug the
 * corner); otherwise the handle length approximates a circular arc from the turn angle.
 */
export function connector(
  x0: number,
  z0: number,
  t0x: number,
  t0z: number,
  x3: number,
  z3: number,
  t3x: number,
  t3z: number,
  tight = 0.56,
): number[] {
  const dx = x3 - x0;
  const dz = z3 - z0;
  const chord = Math.sqrt(dx * dx + dz * dz);
  const cross = t0x * t3z - t0z * t3x;
  if (Math.abs(cross) > 1e-3 && chord > 1e-6) {
    const t = (dx * t3z - t3x * dz) / cross;
    const u = (t0x * dz - dx * t0z) / cross;
    if (t > 0.05 && u > 0.05 && t < 4 * chord && u < 4 * chord) {
      return [x0, z0, x0 + t0x * t * tight, z0 + t0z * t * tight, x3 - t3x * u * tight, z3 - t3z * u * tight, x3, z3];
    }
  }
  const cosT = clamp(t0x * t3x + t0z * t3z, -1, 1);
  const c = (chord * (2 / 3)) / (1 + Math.sqrt((1 + cosT) / 2));
  return [x0, z0, x0 + t0x * c, z0 + t0z * c, x3 - t3x * c, z3 - t3z * c, x3, z3];
}

const CONN_SAMPLES = 8;

/** Sampled polyline of a connector (CONN_SAMPLES segments). */
export function connectorPath(cp: readonly number[]): Path {
  const xs: number[] = [];
  const zs: number[] = [];
  for (let i = 0; i <= CONN_SAMPLES; i++) {
    const u = i / CONN_SAMPLES;
    const v = 1 - u;
    const b0 = v * v * v;
    const b1 = 3 * v * v * u;
    const b2 = 3 * v * u * u;
    const b3 = u * u * u;
    xs.push(b0 * cp[0]! + b1 * cp[2]! + b2 * cp[4]! + b3 * cp[6]!);
    zs.push(b0 * cp[1]! + b1 * cp[3]! + b2 * cp[5]! + b3 * cp[7]!);
  }
  return makePath(xs, zs);
}

// ---------------------------------------------------------------- lanes

/** Lane centre offset, metres right of the travel direction. */
export function laneOffset(e: RoadEdgeInfo, dir: Dir, lane: number): number {
  const n = e.laneCount[dirIndex(dir)];
  if (e.oneway) return e.laneWidthM * (lane + 0.5 - n / 2);
  return e.laneWidthM * (lane + 0.5);
}

/** Sidewalk walking-line offset, metres right of the walking direction, for side (+1 = right of a -> b). */
export function walkOffset(e: RoadEdgeInfo, dir: Dir, side: number, beyondKerb = e.sidewalkM[sideIndex(side)]): number {
  return dir * side * (e.widthM / 2 + beyondKerb) + KEEP_RIGHT_M;
}

export function lanePath(e: RoadEdgeInfo, dir: Dir, lane: number): Path {
  const list = e.lanePaths[dirIndex(dir)];
  return list[clamp(lane, 0, list.length - 1)]!;
}

export function walkPath(e: RoadEdgeInfo, dir: Dir, side: number): Path {
  return e.walkPaths[dirIndex(dir)][sideIndex(side)];
}

/** Node a direction of travel ends at. */
export function endNode(e: RoadEdgeInfo, dir: Dir): number {
  return dir === 1 ? e.b : e.a;
}

export function startNode(e: RoadEdgeInfo, dir: Dir): number {
  return dir === 1 ? e.a : e.b;
}

// ---------------------------------------------------------------- build

/** Building queries the graph builder needs (world.ts supplies them). */
export interface BuildingQuery {
  /** Does a circle of radius r at (x, z) touch any building? */
  blocked: (x: number, z: number, r: number) => boolean;
}

function pathClear(p: Path, r: number, q: BuildingQuery | null): boolean {
  if (!q) return true;
  const n = Math.max(1, Math.ceil(p.len / 3));
  for (let i = 0; i <= n; i++) {
    const pt = pathPoint(p, (p.len * i) / n);
    if (q.blocked(pt.x, pt.z, r)) return false;
  }
  return true;
}

/**
 * Two clearances of a lane at once, sampled every LANE_SAFE_STEP_M: usable (no building within
 * `usable` of any sample) and safe (none within `safe`). Stops at the first unusable sample.
 */
function laneFlags(p: Path, usable: number, safe: number, q: BuildingQuery | null): { clear: boolean; safe: boolean } {
  if (!q) return { clear: true, safe: true };
  const n = Math.max(1, Math.ceil(p.len / LANE_SAFE_STEP_M));
  let isSafe = true;
  for (let i = 0; i <= n; i++) {
    const pt = pathPoint(p, (p.len * i) / n);
    if (isSafe && !q.blocked(pt.x, pt.z, safe)) continue;
    isSafe = false;
    if (q.blocked(pt.x, pt.z, usable)) return { clear: false, safe: false };
  }
  return { clear: true, safe: isSafe };
}

function travelPoints(center: Path, dir: Dir): { xs: number[]; zs: number[] } {
  if (dir === 1) return { xs: center.xs.slice(), zs: center.zs.slice() };
  return { xs: center.xs.slice().reverse(), zs: center.zs.slice().reverse() };
}

export function buildRoadGraph(file: RoadsFile, blocked: BuildingQuery | null = null): RoadGraph {
  const rawNodes = [...file.nodes].sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  const nodeIndex = new Map<string, number>();
  const nodes: RoadNodeInfo[] = rawNodes.map((n, index) => {
    nodeIndex.set(n.id, index);
    return { id: n.id, index, x: n.x, z: n.z, radius: 0, sharp: 0, stopM: 0, degree: 0, bearings: [], out: [] };
  });

  const rawEdges = [...file.edges]
    .filter((e) => nodeIndex.has(e.a) && nodeIndex.has(e.b) && e.points.length >= 2)
    .sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));

  // Pass 1: centrelines, widths, lane layout and node degrees.
  interface Proto {
    raw: (typeof rawEdges)[number];
    center: Path;
    widthM: number;
    laneCount: [number, number];
    laneWidthM: number;
  }
  const protos: Proto[] = rawEdges.map((raw) => {
    const { xs, zs } = dedupe(raw.points as ReadonlyArray<readonly number[]>);
    const center = makePath(xs, zs);
    const d = KIND_DEFAULTS[raw.kind] ?? KIND_DEFAULTS.other!;
    const lanes = Math.max(1, Math.round(raw.lanes));
    const widthM = raw.widthM !== undefined && raw.widthM > 0 ? raw.widthM : lanes * d.laneM + d.extraM;
    const perDir = Math.max(1, Math.floor(lanes / 2));
    const laneCount: [number, number] = raw.oneway ? [lanes, 0] : [perDir, perDir];
    const laneWidthM = Math.min(MAX_LANE_WIDTH_M, widthM / (raw.oneway ? lanes : 2 * perDir));
    return { raw, center, widthM, laneCount, laneWidthM };
  });

  const incident: number[][] = nodes.map(() => []);
  protos.forEach((p, i) => {
    incident[nodeIndex.get(p.raw.a)!]!.push(i);
    if (p.raw.b !== p.raw.a) incident[nodeIndex.get(p.raw.b)!]!.push(i);
  });

  // Unit direction of an edge leaving node n.
  const leaving = (ei: number, n: number): [number, number] => {
    const c = protos[ei]!.center;
    const atA = nodeIndex.get(protos[ei]!.raw.a) === n;
    const m = c.xs.length;
    const [x0, z0, x1, z1] = atA
      ? [c.xs[0]!, c.zs[0]!, c.xs[1]!, c.zs[1]!]
      : [c.xs[m - 1]!, c.zs[m - 1]!, c.xs[m - 2]!, c.zs[m - 2]!];
    const l = Math.sqrt((x1 - x0) * (x1 - x0) + (z1 - z0) * (z1 - z0));
    return l > 0 ? [(x1 - x0) / l, (z1 - z0) / l] : [0, -1];
  };

  for (const n of nodes) {
    const inc = incident[n.index]!;
    n.degree = inc.length;
    let halfW = 0;
    for (const ei of inc) halfW = Math.max(halfW, protos[ei]!.widthM / 2);
    const dirs = inc.map((ei) => leaving(ei, n.index)).sort((p, q) => datan2(p[0], -p[1]) - datan2(q[0], -q[1]));
    let sharp = 0;
    if (dirs.length >= 2) {
      for (let i = 0; i < dirs.length; i++) {
        const [ax, az] = dirs[i]!;
        const [bx, bz] = dirs[(i + 1) % dirs.length]!;
        // Angle from a clockwise to b; only gaps under 180 degrees form an inside corner.
        const cos = ax * bx + az * bz;
        const sin = ax * bz - az * bx;
        if (dirs.length === 2 && i === 1) continue;
        const sinAbs = Math.abs(sin);
        const cot = sinAbs < 1e-6 ? (cos > 0 ? 4 : 0) : (1 + cos) / sinAbs;
        sharp = Math.max(sharp, Math.min(4, cot));
      }
    }
    n.sharp = sharp;
    n.bearings = dirs.map(([dx, dz]) => datan2(dx, -dz));
    if (inc.length >= 3) {
      n.radius = Math.min(15, halfW + 1.5);
      n.stopM = (halfW + SIDEWALK_OFFSET_M + KEEP_RIGHT_M + WALK_CLEARANCE_M) * clamp(sharp, 1, 1.5) + CROSSWALK_GAP_M;
    }
    else if (inc.length === 2) {
      const [ax, az] = dirs[0]!;
      const [bx, bz] = dirs[1]!;
      n.radius = ax * bx + az * bz < -0.94 ? 0.5 : Math.min(15, halfW + 1);
    } else n.radius = 2.5;
  }

  // Pass 2: lane and sidewalk paths.
  const edges: RoadEdgeInfo[] = protos.map((p, index) => {
    const raw = p.raw;
    const a = nodeIndex.get(raw.a)!;
    const b = nodeIndex.get(raw.b)!;
    const kind = raw.kind;
    const pedestrian = raw.pedestrian === true;
    const lanes = Math.max(1, Math.round(raw.lanes));
    const drivable = !pedestrian && kind !== "alley" && (raw.oneway || lanes >= 2) && p.widthM >= 5;
    const walkable = kind !== "freeway" && kind !== "ramp";
    const d = KIND_DEFAULTS[kind] ?? KIND_DEFAULTS.other!;
    const info: RoadEdgeInfo = {
      id: raw.id,
      index,
      a,
      b,
      kind,
      lanes,
      oneway: raw.oneway,
      widthM: p.widthM,
      speedLimitMps: raw.speedLimitMps !== undefined && raw.speedLimitMps > 0 ? raw.speedLimitMps : d.limit,
      name: raw.name ?? "",
      pedestrian,
      center: p.center,
      laneCount: p.laneCount,
      laneWidthM: p.laneWidthM,
      lanePaths: [[], []],
      laneClear: [[], []],
      laneSafe: [[], []],
      walkPaths: [
        [p.center, p.center],
        [p.center, p.center],
      ],
      walkClear: [
        [false, false],
        [false, false],
      ],
      sidewalkM: [SIDEWALK_OFFSET_M, SIDEWALK_OFFSET_M],
      drivable,
      walkable,
    };
    const trimFor = (node: number, offset: number): number => {
      const nd = nodes[node]!;
      return Math.min(Math.max(nd.radius, Math.abs(offset) * nd.sharp + 0.5), p.center.len * 0.45);
    };
    // Lanes also stop behind the crosswalks at junctions.
    const laneTrim = (node: number, offset: number): number =>
      Math.min(Math.max(trimFor(node, offset), nodes[node]!.stopM), p.center.len * 0.45);
    for (const dir of [1, -1] as const) {
      const di = dirIndex(dir);
      const { xs, zs } = travelPoints(p.center, dir);
      const s0n = startNode(info, dir);
      const e0n = endNode(info, dir);
      for (let k = 0; k < p.laneCount[di]; k++) {
        const off = laneOffset(info, dir, k);
        const full = offsetPath(xs, zs, off);
        const lp = subPath(full, laneTrim(s0n, off), full.len - laneTrim(e0n, off));
        info.lanePaths[di].push(lp);
        const flags = drivable ? laneFlags(lp, LANE_CLEARANCE_M, LANE_SAFE_M + LANE_SAFE_STEP_M / 2, blocked) : null;
        info.laneClear[di].push(flags !== null && flags.clear);
        info.laneSafe[di].push(flags !== null && flags.safe);
      }
    }
    // Sidewalks: the first line (from SIDEWALK_OFFSETS_M) that is clear of buildings both ways.
    for (const side of [1, -1] as const) {
      const si = sideIndex(side);
      for (let k = 0; k < SIDEWALK_OFFSETS_M.length; k++) {
        const beyond = SIDEWALK_OFFSETS_M[k]!;
        const both: Path[] = [];
        let clear = walkable;
        for (const dir of [1, -1] as const) {
          const { xs, zs } = travelPoints(p.center, dir);
          const off = walkOffset(info, dir, side, beyond);
          const full = offsetPath(xs, zs, off);
          const wp = subPath(full, trimFor(startNode(info, dir), off), full.len - trimFor(endNode(info, dir), off));
          both.push(wp);
          clear = clear && pathClear(wp, WALK_CLEARANCE_M, blocked);
        }
        if (clear || k === 0) {
          info.walkPaths[0][si] = both[0]!;
          info.walkPaths[1][si] = both[1]!;
          info.walkClear[0][si] = clear;
          info.walkClear[1][si] = clear;
          info.sidewalkM[si] = beyond;
        }
        if (clear || !walkable) break;
      }
    }
    return info;
  });

  const edgeIndex = new Map<string, number>();
  for (const e of edges) edgeIndex.set(e.id, e.index);
  for (const e of edges) {
    nodes[e.a]!.out.push({ edge: e.index, dir: 1 });
    if (!e.oneway) nodes[e.b]!.out.push({ edge: e.index, dir: -1 });
  }
  for (const n of nodes) n.out.sort((p, q) => p.edge - q.edge || q.dir - p.dir);

  // Areas: split every centreline into <= 20 m pieces, bucket by piece midpoint.
  const buckets = new Map<string, { ax: number; az: number; drive: AreaPiece[]; walk: AreaPiece[] }>();
  for (const e of edges) {
    const canDrive = e.drivable && (e.laneClear[0].some(Boolean) || e.laneClear[1].some(Boolean));
    const canWalk = e.walkable && (e.walkClear[0].some(Boolean) || e.walkClear[1].some(Boolean));
    if (!canDrive && !canWalk) continue;
    const n = Math.max(1, Math.ceil(e.center.len / 20));
    for (let i = 0; i < n; i++) {
      const s0 = (e.center.len * i) / n;
      const s1 = (e.center.len * (i + 1)) / n;
      const m = pathPoint(e.center, (s0 + s1) / 2);
      const { ax, az, key } = areaOf(m.x, m.z);
      let bkt = buckets.get(key);
      if (!bkt) buckets.set(key, (bkt = { ax, az, drive: [], walk: [] }));
      if (canDrive) bkt.drive.push({ edge: e.index, s0, s1 });
      if (canWalk) bkt.walk.push({ edge: e.index, s0, s1 });
    }
  }
  const areas: AreaRoads[] = [...buckets.keys()].sort().map((key) => {
    const bkt = buckets.get(key)!;
    const cum = (list: AreaPiece[]): number[] => {
      let t = 0;
      return list.map((pc) => (t += pc.s1 - pc.s0));
    };
    const driveCum = cum(bkt.drive);
    const walkCum = cum(bkt.walk);
    return {
      key,
      ax: bkt.ax,
      az: bkt.az,
      cx: (bkt.ax + 0.5) * AREA_M,
      cz: (bkt.az + 0.5) * AREA_M,
      drive: bkt.drive,
      driveCum,
      driveLen: driveCum.length ? driveCum[driveCum.length - 1]! : 0,
      walk: bkt.walk,
      walkCum,
      walkLen: walkCum.length ? walkCum[walkCum.length - 1]! : 0,
    };
  });
  const areaIndex = new Map<string, number>();
  areas.forEach((ar, i) => areaIndex.set(ar.key, i));

  return { nodes, edges, nodeIndex, edgeIndex, areas, areaIndex };
}

/**
 * Are two points around a node on the same street corner, i.e. does no street leave the
 * node between their bearings (along the shorter way round)?
 */
export function sameCorner(n: Readonly<RoadNodeInfo>, ax: number, az: number, bx: number, bz: number): boolean {
  const ta = datan2(ax - n.x, -(az - n.z));
  const d = wrapAngle(datan2(bx - n.x, -(bz - n.z)) - ta);
  for (const b of n.bearings) {
    const t = wrapAngle(b - ta);
    if (d > 0 ? t > 1e-9 && t < d : t < -1e-9 && t > d) return false;
  }
  return true;
}
