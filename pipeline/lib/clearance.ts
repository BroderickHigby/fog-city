// Carriageway and path clearance (W-01, W-39, W-43, W-16): no building footprint may wall a
// real street or a public path.
//
// DataSF's footprints (a 2016 snapshot of 2010 LiDAR) and the 2025 centrelines disagree in four
// ways, and each gets its own fix, in this order:
//   1. Towers on a street: a "-tower" record (the LiDAR maximum over a footprint) that a road
//      centreline crosses is not a tower but a structure over the road (the Golden Gate Bridge's
//      approach over Fort Point, a crane over the Transbay pit): the tower record is dropped and
//      its podium stays.
//   2. Redeveloped land: a footprint that a street added or rebuilt after the June 2010 LiDAR
//      crosses for STALE_INSIDE_M or more, on a parcel the 2025 roll does not date before 2010,
//      is gone (Treasure Island, Pier 70, the Presidio Parkway, Hunters Point): dropped. Records
//      added from the 2025 roll or an override (newer.ts) are current and never stale.
//   3. Misregistered centrelines: where buildings stand within the corridor but a clear corridor
//      exists within REREGISTER_MAX_M to one side, the centreline is shifted into it (smoothly,
//      back to the junctions at both ends): the street moves, the houses stay whole.
//   4. What still intrudes is cut out of the footprint: a structure tall enough to have a passage
//      under it (a bridge between buildings, a deck, a hotel over an alley) keeps the piece over
//      the corridor as a span record with an underside (underY) UNDER_CLEAR_M above the road;
//      anything lower loses that piece. The rest of the footprint stays, in one or more records.
// The corridor is the centreline buffered by the clearance radius: a car's half width plus room
// for the lane (CAR_LANE_R on two-way streets of two or more lanes, CAR_R otherwise), WALK_R for
// pedestrian ways. Freeways and ramps are left to the deck layer, tunnel bores to the tunnels.
// An UPROW or PAPER stairway that still runs through a building after step 3 is not a path that
// was ever opened: it is dropped from the graph instead of cutting houses.

import { MIN_AREA_M2, type Building } from "./buildings.ts";
import { cleanRing, dropCollinear, interiorPoint, isSimpleRing, pointInRing, r2, signedArea, simplifyLine, type P2 } from "./geom.ts";
import { bufferPolyline, differencePolys, intersectPolys, polyArea, unionPolys, type Poly } from "./polygon.ts";
import type { RoadEdge, RoadGraph } from "./roads.ts";
import type { RawStreetDate } from "./sources.ts";
import type { Ground } from "./terrain.ts";
import { groundRange } from "./terrace.ts";

/** Corridor radius on two-way streets of two or more lanes: a lane's centre (1.6 m) plus a car's half width. */
export const CAR_LANE_R = 2.6;
/** Corridor radius on one-lane and one-way streets and alleys. */
export const CAR_R = 1.6;
/** Corridor radius on pedestrian ways and stairs. */
export const WALK_R = 0.9;
/** A roof this far above the road blocks it (a lower one is a kerb, a planter, a step). */
export const ROOF_BLOCK_M = 0.5;
/** A span's underside stands this far above the highest road under it (the sim passes agents under 4.5 m). */
export const UNDER_CLEAR_M = 4.6;
/** ...and needs at least this much structure above its underside to be a span rather than a cut. */
export const SPAN_MIN_DEPTH_M = 1.5;
/** Centreline metres inside a footprint that make it stale when the street is newer than the LiDAR. */
export const STALE_INSIDE_M = 5;
/** The LiDAR survey: streets added or altered after this are newer than the footprints. */
export const LIDAR_DATE = "2010-06-01";
/** A centreline moves at most this far sideways (W-01: misregistration is 1 to 3 m). */
export const REREGISTER_MAX_M = 3;

export interface ClearanceStats {
  towersOnStreets: string[];
  staleDropped: string[];
  reregistered: string[];
  spans: string[];
  cut: number;
  /** Stairways (UPROW or PAPER) dropped because they run through buildings. */
  stairsDropped: string[];
  /** Footprint pieces under MIN_AREA_M2 left out after a cut. */
  slivers: number;
}

interface Corridor {
  edge: RoadEdge;
  /** The corridor's largest radius along the edge. */
  r: number;
  /** The radius at each 1 m sample (corridorRadii), or null where it is the edge's constant radius. */
  radii: number[] | null;
}

const isNewer = (d: RawStreetDate | undefined, b: Building): boolean => {
  if (!d) return false;
  if ((d.date_added ?? "") >= LIDAR_DATE) return true;
  return (d.date_altered ?? "") >= LIDAR_DATE && !(b.meta.year !== undefined && b.meta.year < 2010);
};

/** The clearance radius of an edge, or 0 when this pass leaves it alone. */
export function corridorRadius(e: RoadEdge): number {
  if (e.gradeSeparated || e.kind === "freeway" || e.kind === "ramp") return 0;
  if (e.pedestrian) return WALK_R;
  return !e.oneway && e.lanes >= 2 ? CAR_LANE_R : CAR_R;
}

/** The sim car's half width and half length (src/sim/car.ts CAR): the body that sweeps a bend. */
const CAR_HALF_W = 0.95;
const CAR_HALF_L = 2.2;
/** A bend's radius is measured from the centreline's turn over this far either side of a sample, metres. */
export const BEND_SPAN_M = 3;
/** At most this much extra corridor on a bend, metres. */
export const BEND_MAX_M = 1.5;

/**
 * Extra corridor on a bend of radius R (metres) of a street's centreline: how far the outer
 * front corner of a car turning about its rear axle (how a car, and its driver, takes a bend:
 * the wheels track the bend and the nose swings out) sweeps beyond the half width it covers on
 * the straight. sqrt((R + w)^2 + L^2) - R - w for a body of half width w and length L.
 */
export function bendWidening(R: number): number {
  if (!(R > 0) || !Number.isFinite(R)) return 0;
  const L = 2 * CAR_HALF_L;
  return Math.min(BEND_MAX_M, Math.hypot(R + CAR_HALF_W, L) - R - CAR_HALF_W);
}

/**
 * The corridor radius at each of an edge's 1 m samples (samples(points, 1) order): r, plus
 * bendWidening of the centreline's local radius (its turn between the chords BEND_SPAN_M before
 * and after the sample). The hairpins of Lombard St (radius 3 to 4 m) get about 1.5 m more; a
 * straight street gets r.
 */
export function corridorRadii(points: readonly P2[], r: number): number[] {
  const pts = samples(points, 1);
  const k = BEND_SPAN_M;
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - k)]!;
    const b = pts[Math.min(pts.length - 1, i + k)]!;
    const ax = p.x - a.x, az = p.z - a.z, bx = b.x - p.x, bz = b.z - p.z;
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    if (la < 0.5 || lb < 0.5) return r;
    const turn = Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz));
    if (turn < 1e-6) return r;
    // Two chords of length la and lb turning by `turn` lie on a circle of radius (la + lb) / 2 / turn.
    return r + bendWidening((la + lb) / 2 / turn);
  });
}

/** Points every `step` metres along a polyline, with their arc length and unit direction. */
function samples(points: readonly P2[], step: number): Array<{ x: number; z: number; s: number; dx: number; dz: number }> {
  const out: Array<{ x: number; z: number; s: number; dx: number; dz: number }> = [];
  let s = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-9) continue;
    const dx = (b[0] - a[0]) / L;
    const dz = (b[1] - a[1]) / L;
    const n = Math.max(1, Math.ceil(L / step));
    for (let k = i === 1 ? 0 : 1; k <= n; k++) out.push({ x: a[0] + dx * ((L * k) / n), z: a[1] + dz * ((L * k) / n), s: s + (L * k) / n, dx, dz });
    s += L;
  }
  return out;
}

/** A grid of building bounding boxes for point and box queries. */
export class BuildingGrid {
  private cells = new Map<number, number[]>();
  private boxes: Float64Array;
  readonly list: Array<Building | null>;
  constructor(list: Array<Building | null>) {
    this.list = list;
    this.boxes = new Float64Array(list.length * 4);
    list.forEach((b, i) => {
      if (!b) return;
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const [x, z] of b.footprint) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (z < z0) z0 = z;
        if (z > z1) z1 = z;
      }
      this.boxes.set([x0, z0, x1, z1], i * 4);
      for (let cx = Math.floor(x0 / 25); cx <= Math.floor(x1 / 25); cx++) {
        for (let cz = Math.floor(z0 / 25); cz <= Math.floor(z1 / 25); cz++) {
          const k = (cx + 16384) * 32768 + (cz + 16384);
          const l = this.cells.get(k);
          if (l) l.push(i);
          else this.cells.set(k, [i]);
        }
      }
    });
  }
  /** Indices of buildings whose box comes within r of (x, z). */
  near(x: number, z: number, r: number): number[] {
    const out: number[] = [];
    for (let cx = Math.floor((x - r) / 25); cx <= Math.floor((x + r) / 25); cx++) {
      for (let cz = Math.floor((z - r) / 25); cz <= Math.floor((z + r) / 25); cz++) {
        for (const i of this.cells.get((cx + 16384) * 32768 + (cz + 16384)) ?? []) {
          if (!this.list[i]) continue;
          const b = this.boxes;
          if (x < b[i * 4]! - r || x > b[i * 4 + 2]! + r || z < b[i * 4 + 1]! - r || z > b[i * 4 + 3]! + r) continue;
          if (!out.includes(i)) out.push(i);
        }
      }
    }
    return out.sort((p, q) => p - q);
  }
}

/** Distance from (x, z) to a ring's boundary, negative inside. */
function signedDist(x: number, z: number, ring: readonly P2[]): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, az] = ring[j]!;
    const [bx, bz] = ring[i]!;
    const ex = bx - ax, ez = bz - az;
    const L2 = ex * ex + ez * ez;
    let t = L2 > 0 ? ((x - ax) * ex + (z - az) * ez) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x - (ax + ex * t), z - (az + ez * t));
    if (d < best) best = d;
  }
  return pointInRing(x, z, ring) ? -best : best;
}

/** Does building b stand in the way of the road at (x, z)? */
function blocks(b: Building, groundY: number): boolean {
  if (b.topY - groundY <= ROOF_BLOCK_M) return false;
  // A tower starts on its podium's roof: over a passage under its podium it is no obstacle.
  const under = b.underY ?? (b.meta.towerOf !== undefined ? b.meta.podiumTopY : undefined);
  return under === undefined || under < groundY + UNDER_CLEAR_M - 0.05;
}

/**
 * Lateral shift (metres, + = to the left of travel) for each sample that clears the corridor
 * within REREGISTER_MAX_M, smallest first; NaN where no shift clears it; 0 where it is clear.
 */
function shifts(
  pts: ReturnType<typeof samples>,
  r: number,
  grid: BuildingGrid,
  ground: Ground,
): { delta: number[]; blocked: number } {
  const step = 0.1;
  const W = REREGISTER_MAX_M + r;
  const nOff = Math.round((2 * W) / step) + 1;
  const delta: number[] = [];
  let blocked = 0;
  for (const p of pts) {
    const nx = -p.dz;
    const nz = p.dx;
    const g = ground.heightAt(p.x, p.z) ?? 0;
    // Most samples are clear: test the corridor itself before building the cross-section.
    let near = false;
    for (const i of grid.near(p.x, p.z, r + 0.5)) {
      const b = grid.list[i]!;
      if (blocks(b, g) && signedDist(p.x, p.z, b.footprint) < r) {
        near = true;
        break;
      }
    }
    if (!near) {
      delta.push(0);
      continue;
    }
    const cand = grid.near(p.x, p.z, W + 0.5).filter((i) => blocks(grid.list[i]!, g));
    const occ = new Uint8Array(nOff);
    for (let j = 0; j < nOff; j++) {
      const o = -W + j * step;
      const x = p.x + nx * o;
      const z = p.z + nz * o;
      for (const i of cand) {
        if (pointInRing(x, z, grid.list[i]!.footprint)) {
          occ[j] = 1;
          break;
        }
      }
    }
    const free = (lo: number, hi: number): boolean => {
      for (let j = Math.max(0, Math.floor((lo + W) / step)); j <= Math.min(nOff - 1, Math.ceil((hi + W) / step)); j++) if (occ[j]) return false;
      return true;
    };
    blocked++;
    let best = NaN;
    for (let k = 1; k * step <= REREGISTER_MAX_M + 1e-9; k++) {
      for (const sgn of [1, -1]) {
        const d = sgn * k * step;
        if (free(d - r - 0.1, d + r + 0.1)) {
          best = d;
          break;
        }
      }
      if (!Number.isNaN(best)) break;
    }
    delta.push(best);
  }
  return { delta, blocked };
}

/** Blocked samples along an edge's corridor (any blocking footprint closer than r). */
function blockedSamples(points: readonly P2[], r: number, grid: BuildingGrid, ground: Ground, skip?: (s: number) => boolean): number {
  let n = 0;
  for (const p of samples(points, 1)) {
    if (skip?.(p.s)) continue;
    const g = ground.heightAt(p.x, p.z) ?? 0;
    for (const i of grid.near(p.x, p.z, r + 0.5)) {
      const b = grid.list[i]!;
      if (blocks(b, g) && signedDist(p.x, p.z, b.footprint) < r) {
        n++;
        break;
      }
    }
  }
  return n;
}

/** Shift an edge's centreline to clear its corridor where a small sideways move does. */
function reregister(e: RoadEdge, r: number, grid: BuildingGrid, ground: Ground): P2[] | null {
  const pts = samples(e.points, 1);
  const len = pts.length ? pts[pts.length - 1]!.s : 0;
  if (len < 4) return null;
  const { delta, blocked } = shifts(pts, r, grid, ground);
  if (blocked === 0) return null;
  const unfixable = delta.filter((d) => Number.isNaN(d)).length;
  if (unfixable > blocked / 2) return null;
  // Dilate (keep the strongest shift within 4 m), then smooth (8 m each way), then taper to the
  // junctions at both ends over 12 m (or half the edge).
  const raw = delta.map((d) => (Number.isNaN(d) ? 0 : d));
  const dil = raw.map((_, i) => {
    let best = 0;
    for (let k = Math.max(0, i - 4); k <= Math.min(raw.length - 1, i + 4); k++) if (Math.abs(raw[k]!) > Math.abs(best)) best = raw[k]!;
    return best;
  });
  const sm = dil.map((_, i) => {
    let s = 0;
    let w = 0;
    for (let k = Math.max(0, i - 8); k <= Math.min(dil.length - 1, i + 8); k++) {
      const wk = 9 - Math.abs(k - i);
      s += dil[k]! * wk;
      w += wk;
    }
    return s / w;
  });
  const taper = Math.min(12, len / 2);
  const out: P2[] = pts.map((p, i) => {
    const s = p.s;
    const t = Math.min(1, s / taper, (len - s) / taper);
    const w = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
    const d = sm[i]! * w;
    // Shift along the centreline's direction over the samples 3 m either side, so the shifted
    // line turns smoothly at the source polyline's corners (no kinks for sidewalks to miter).
    const a = pts[Math.max(0, i - 3)]!, b = pts[Math.min(pts.length - 1, i + 3)]!;
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    const dx = L > 1e-6 ? (b.x - a.x) / L : p.dx, dz = L > 1e-6 ? (b.z - a.z) / L : p.dz;
    return [p.x - dz * d, p.z + dx * d];
  });
  out[0] = [e.points[0]![0], e.points[0]![1]];
  out[out.length - 1] = [e.points[e.points.length - 1]![0], e.points[e.points.length - 1]![1]];
  const simple = simplifyLine(out, 0.05).map(([x, z]) => [r2(x), r2(z)] as P2);
  const before = blocked;
  const after = blockedSamples(simple, r, grid, ground);
  return after < before ? simple : null;
}

/**
 * The corridor of an edge near a box, as polygons (only the part of the centreline near it):
 * the centreline buffered by `r`, and where `radii` widens it on a bend, a disc of the wider
 * radius at each 1 m sample there.
 */
function corridorNear(e: RoadEdge, r: number, box: [number, number, number, number], skip?: (s: number) => boolean, radii: readonly number[] | null = null): Poly[] {
  let rMax = r;
  for (const q of radii ?? []) if (q > rMax) rMax = q;
  const pad = rMax + 2;
  const pts = samples(e.points, 1);
  const runs: P2[][] = [];
  const discs: Array<{ p: P2; r: number }> = [];
  let cur: P2[] | null = null;
  pts.forEach((p, k) => {
    const inBox = p.x >= box[0] - pad && p.x <= box[2] + pad && p.z >= box[1] - pad && p.z <= box[3] + pad && !skip?.(p.s);
    if (inBox) {
      if (!cur) runs.push((cur = []));
      cur.push([p.x, p.z]);
      const rk = radii?.[k] ?? r;
      if (rk > r + 0.01) discs.push({ p: [p.x, p.z], r: rk });
    } else cur = null;
  });
  const polys: Poly[] = [];
  for (const run of runs) {
    if (run.length === 1) run.push([run[0]![0] + 0.01, run[0]![1]]);
    polys.push(...bufferPolyline(simplifyLine(run, 0.02), r));
  }
  for (const d of discs) polys.push(...bufferPolyline([d.p, [d.p[0] + 0.01, d.p[1]]], d.r));
  return polys;
}

/** Split a polygon with holes into hole-free pieces (cut through each hole's centre). */
function noHoles(p: Poly): P2[][] {
  if (p.holes.length === 0) return [p.outer];
  const h = p.holes[0]!;
  const c = interiorPoint(h);
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of p.outer) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  const halves: P2[][] = [
    [[x0 - 1, z0 - 1], [c[0], z0 - 1], [c[0], z1 + 1], [x0 - 1, z1 + 1]],
    [[c[0], z0 - 1], [x1 + 1, z0 - 1], [x1 + 1, z1 + 1], [c[0], z1 + 1]],
  ];
  const out: P2[][] = [];
  for (const half of halves) {
    for (const q of intersectPolys(half, [p])) out.push(...noHoles(q));
  }
  return out;
}

const cleanPiece = (ring: P2[]): P2[] | null => {
  let r = dropCollinear(cleanRing(ring), 0.01);
  if (r.length < 3 || !isSimpleRing(r) || Math.abs(signedArea(r)) < MIN_AREA_M2) return null;
  if (signedArea(r) > 0) r = [...r].reverse();
  return r;
};

export interface ClearanceOptions {
  /** True where this pass must leave an edge alone (inside a tunnel bore). */
  skip?: (edge: string, s: number) => boolean;
  /** Edges never re-registered (tunnels: their bores are fixed to the portals). */
  keepCentreline?: ReadonlySet<string>;
  /** Stairways from layers otherwise excluded (UPROW, PAPER): dropped if they run through buildings. */
  optionalStairs?: ReadonlySet<string>;
  /**
   * Records that still stand (overrides.json standing): never stale in step 2. A record split
   * after the override (terraces: "<id>-s<n>") counts as its source record.
   */
  standing?: ReadonlySet<string>;
}

/**
 * Clear every street and path corridor. Mutates the graph's edge points (re-registration) and
 * edge list (stairways dropped), returns the new building list (sorted by id).
 */
export function clearCorridors(
  buildings: readonly Building[],
  graph: RoadGraph,
  dates: readonly RawStreetDate[] | undefined,
  ground: Ground,
  opts: ClearanceOptions = {},
): { buildings: Building[]; stats: ClearanceStats } {
  const skip = opts.skip;
  const stats: ClearanceStats = { towersOnStreets: [], staleDropped: [], reregistered: [], spans: [], cut: 0, stairsDropped: [], slivers: 0 };
  const dateOf = new Map((dates ?? []).map((d) => [d.cnn, d]));
  const list: Array<Building | null> = buildings.map((b) => b);
  const index = new Map<string, number>(buildings.map((b, i) => [b.id, i]));
  let grid = new BuildingGrid(list);
  const drop = (i: number): void => {
    const b = list[i];
    if (!b) return;
    list[i] = null;
    if (b.meta.tower) {
      const t = index.get(b.meta.tower);
      if (t !== undefined) list[t] = null;
    }
  };
  const skipFor = (e: RoadEdge): ((s: number) => boolean) | undefined => (skip ? (s: number) => skip(e.id, s) : undefined);

  // ---- 1. Towers that are a freeway deck (or a bridge) over a building: the LiDAR maximum over
  // a footprint that a freeway crosses is the deck, not a tower (the Golden Gate Bridge's south
  // approach over Fort Point). The tower record goes, the podium stays. Surface streets that pass
  // under a real tower are handled by spans below.
  for (const e of graph.edges) {
    if (!e.gradeSeparated || opts.keepCentreline?.has(e.id)) continue;
    const sk = skipFor(e);
    for (const p of samples(e.points, 1)) {
      if (sk?.(p.s)) continue;
      for (const i of grid.near(p.x, p.z, 0.5)) {
        const b = list[i];
        if (!b || !pointInRing(p.x, p.z, b.footprint)) continue;
        const towerIdx = b.meta.towerOf !== undefined ? i : b.meta.tower !== undefined ? index.get(b.meta.tower) : undefined;
        if (towerIdx === undefined || !list[towerIdx]) continue;
        const t = list[towerIdx]!;
        stats.towersOnStreets.push(t.id);
        list[towerIdx] = null;
        const podium = index.get(t.meta.towerOf!);
        if (podium !== undefined && list[podium]) {
          const pm = { ...list[podium]!.meta };
          delete pm.tower;
          list[podium] = { ...list[podium]!, meta: pm };
        }
      }
    }
  }
  grid = new BuildingGrid(list);

  // ---- 2. Footprints on land a newer street was built across. A record the newer-buildings pass
  // or an override added (meta.outline: a 2025 parcel or a hand-checked block) is current, never
  // stale: what of it stands in a corridor is cut or spanned in step 4 like any other record.
  const isAdded = (b: Building): boolean => b.meta.outline !== undefined || (b.meta.towerOf !== undefined && list[index.get(b.meta.towerOf) ?? -1]?.meta.outline !== undefined);
  const standing = opts.standing ?? new Set<string>();
  const stands = (id: string | undefined): boolean => id !== undefined && standing.has(id.replace(/-(tower|s\d+)$/, ""));
  const isStanding = (b: Building): boolean => stands(b.id) || stands(b.meta.towerOf);
  for (const e of graph.edges) {
    if (corridorRadius(e) === 0) continue;
    const d = dateOf.get(e.cnn);
    if (!d || ((d.date_added ?? "") < LIDAR_DATE && (d.date_altered ?? "") < LIDAR_DATE)) continue;
    const inside = new Map<number, number>();
    for (const p of samples(e.points, 1)) {
      for (const i of grid.near(p.x, p.z, 0)) if (list[i] && pointInRing(p.x, p.z, list[i]!.footprint)) inside.set(i, (inside.get(i) ?? 0) + 1);
    }
    for (const [i, n] of inside) {
      const b = list[i];
      if (!b || n < STALE_INSIDE_M || !isNewer(d, b) || isAdded(b) || isStanding(b)) continue;
      // A podium's tower goes with it; a tower alone takes its podium (both are the old building).
      if (b.meta.towerOf !== undefined) {
        const pi = index.get(b.meta.towerOf);
        if (pi !== undefined && list[pi]) {
          stats.staleDropped.push(list[pi]!.id);
          drop(pi);
        }
      }
      if (list[i]) {
        stats.staleDropped.push(b.id);
        drop(i);
      }
    }
  }
  grid = new BuildingGrid(list);

  // ---- 3. Re-register misregistered centrelines.
  for (const e of graph.edges) {
    const r = corridorRadius(e);
    if (r === 0 || opts.keepCentreline?.has(e.id)) continue;
    const moved = reregister(e, r, grid, ground);
    if (moved) {
      e.points = moved;
      stats.reregistered.push(e.id);
    }
  }

  // ---- 3b. Stairways from layers otherwise excluded that still run through buildings.
  const stairsDropped = new Set<string>();
  for (const e of graph.edges) {
    if (!opts.optionalStairs?.has(e.id)) continue;
    let inside = 0;
    for (const p of samples(e.points, 1)) {
      const g = ground.heightAt(p.x, p.z) ?? 0;
      for (const i of grid.near(p.x, p.z, 0)) if (list[i] && blocks(list[i]!, g) && pointInRing(p.x, p.z, list[i]!.footprint)) inside++;
    }
    if (inside > 2) stairsDropped.add(e.id);
  }
  if (stairsDropped.size) {
    graph.edges = graph.edges.filter((e) => !stairsDropped.has(e.id));
    stats.stairsDropped = [...stairsDropped].sort();
    const used = new Set<string>();
    for (const e of graph.edges) {
      used.add(e.a);
      used.add(e.b);
    }
    graph.nodes = graph.nodes.filter((n) => used.has(n.id));
  }

  // ---- 4. Spans and cuts for whatever still stands in a corridor.
  // Streets get their bend widening here (corridorRadii); paths keep WALK_R.
  const corridorsOf = new Map<number, Corridor[]>();
  for (const e of graph.edges) {
    const r = corridorRadius(e);
    if (r === 0) continue;
    const radii = e.pedestrian ? null : corridorRadii(e.points, r);
    const sk = skipFor(e);
    const hit = new Set<number>();
    samples(e.points, 1).forEach((p, k) => {
      if (sk?.(p.s)) return;
      const rk = radii?.[k] ?? r;
      const g = ground.heightAt(p.x, p.z) ?? 0;
      for (const i of grid.near(p.x, p.z, rk + 0.5)) {
        const b = list[i];
        if (!b || hit.has(i) || !blocks(b, g)) continue;
        if (signedDist(p.x, p.z, b.footprint) < rk) hit.add(i);
      }
    });
    let rMax = r;
    for (const q of radii ?? []) if (q > rMax) rMax = q;
    for (const i of hit) {
      let l = corridorsOf.get(i);
      if (!l) corridorsOf.set(i, (l = []));
      l.push({ edge: e, r: rMax, radii });
    }
  }
  const used = new Map<string, number>();
  for (const b of buildings) {
    const m = /^(.*)-[sb](\d+)$/.exec(b.id);
    if (m) used.set(m[1]!, Math.max(used.get(m[1]!) ?? 0, Number(m[2])));
  }
  const next = (base: string): number => {
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return n;
  };
  const added: Building[] = [];
  for (const i of [...corridorsOf.keys()].sort((a, b) => a - b)) {
    const b = list[i];
    if (!b) continue;
    // A tower is never cut into pieces (they would be needles): one low enough to wall a street
    // is the LiDAR seeing over the street, and goes; its podium stays.
    if (b.meta.towerOf !== undefined) {
      stats.towersOnStreets.push(b.id);
      list[i] = null;
      const pi = index.get(b.meta.towerOf);
      if (pi !== undefined && list[pi]) {
        const pm = { ...list[pi]!.meta };
        delete pm.tower;
        list[pi] = { ...list[pi]!, meta: pm };
      }
      continue;
    }
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [x, z] of b.footprint) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    let inPolys: Poly[];
    let outPolys: Poly[];
    try {
      const corr = unionPolys(corridorsOf.get(i)!.flatMap((c) => corridorNear(c.edge, corridorRadius(c.edge), [x0, z0, x1, z1], skipFor(c.edge), c.radii)));
      inPolys = intersectPolys(b.footprint, corr);
      outPolys = differencePolys(b.footprint, corr);
    } catch {
      continue;
    }
    const inArea = inPolys.reduce((s, p) => s + polyArea(p), 0);
    if (inArea < 0.01) continue;
    // Through: some corridor centreline enters and leaves the footprint (a passage under it).
    const through = corridorsOf.get(i)!.some((c) => {
      const ss = samples(c.edge.points, 1);
      const ins = ss.map((p) => pointInRing(p.x, p.z, b.footprint));
      const first = ins.indexOf(true);
      const last = ins.lastIndexOf(true);
      return first > 0 && last >= 0 && last < ins.length - 1;
    });
    // The highest road under the span or beside it (a body on a slope beside the span must pass too).
    let roadMax = Math.max(...inPolys.map((p) => groundRange(p.outer, ground)?.max ?? -Infinity));
    for (const c of corridorsOf.get(i)!) {
      for (const p of samples(c.edge.points, 1)) {
        if (p.x < x0 - c.r - 1 || p.x > x1 + c.r + 1 || p.z < z0 - c.r - 1 || p.z > z1 + c.r + 1) continue;
        if (signedDist(p.x, p.z, b.footprint) > c.r + 1) continue;
        roadMax = Math.max(roadMax, ground.heightAt(p.x, p.z) ?? -Infinity);
      }
    }
    const underY = r2(roadMax + UNDER_CLEAR_M);
    const spanOk = (through || polyArea({ outer: b.footprint, holes: [] }) - inArea < MIN_AREA_M2) && b.topY - underY >= SPAN_MIN_DEPTH_M;
    const base = b.meta.pieceOf ?? b.id;
    const pieces: P2[][] = [];
    for (const p of outPolys) for (const r of noHoles(p)) {
      const c = cleanPiece(r);
      if (c) pieces.push(c);
      else stats.slivers++;
    }
    pieces.sort((p, q) => Math.abs(signedArea(q)) - Math.abs(signedArea(p)));
    const remake = (ring: P2[], id: string, piece?: "strip" | "span"): Building => {
      const at = interiorPoint(ring);
      const gr = groundRange(ring, ground);
      const g = ground.heightAt(at[0], at[1]) ?? b.baseY;
      const baseY = Math.floor(g * 100) / 100;
      const meta = { ...b.meta, footY: Math.min(baseY, Math.floor(((gr?.min ?? baseY) - 0.05) * 100) / 100) };
      if (piece) {
        meta.pieceOf = base;
        meta.piece = piece;
        delete meta.tower;
      }
      return { id, tile: b.tile, footprint: ring, baseY, topY: b.topY, meta };
    };
    if (pieces.length === 0 && !spanOk) {
      drop(i);
      stats.cut++;
      continue;
    }
    if (pieces.length > 0) {
      list[i] = remake(pieces[0]!, b.id);
      if (b.meta.pieceOf) list[i]!.meta.pieceOf = b.meta.pieceOf;
      for (const p of pieces.slice(1)) added.push(remake(p, `${base}-s${next(base)}`, "strip"));
    } else {
      list[i] = null;
    }
    stats.cut++;
    if (spanOk) {
      for (const p of inPolys) {
        for (const r of noHoles(p)) {
          const c = cleanPiece(r);
          if (!c) continue;
          const span = remake(c, pieces.length === 0 && !list[i] ? b.id : `${base}-b${next(base)}`, "span");
          span.underY = underY;
          span.meta.footY = underY;
          if (span.id === b.id) {
            delete span.meta.pieceOf;
            delete span.meta.piece;
            list[i] = span;
          } else added.push(span);
          stats.spans.push(span.id);
        }
      }
    }
  }
  const out = [...list.filter((b): b is Building => b !== null), ...added];
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  stats.towersOnStreets.sort();
  stats.staleDropped = [...new Set(stats.staleDropped)].sort();
  return { buildings: out, stats };
}
