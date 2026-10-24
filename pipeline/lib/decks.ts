// Road decks (W-03, W-07, W-12, W-14): where the bare-earth DEM is not the road surface.
//
// The DEM has no bridges or viaducts: freeways ran on the ground under their viaducts (through
// the streets they cross, into the houses beside them), street bridges dipped into the creeks,
// and streets over a freeway cut dived into the cut (and under an embankment, climbed over it).
// This pass gives every such road a surface of its own:
//
//   Freeways and ramps (one profile over the whole network, so ramps meet their freeways):
//     - Samples every DECK_STEP_M. The profile is the lowest one that stands on or above the
//       ground, DECK_CLEAR_M over every street it crosses, BUILDING_CLEAR_M over every low roof
//       under it, never climbs or falls faster than FREEWAY_GRADE (WATER_GRADE over water, so a
//       bridge holds its bank height across a creek), and rounds every crest to at least
//       CREST_RADIUS_M (no car leaves the deck at speed). In a freeway tunnel (tunnels.ts) the
//       profile is the bore. Where a ramp meets a surface street it comes down to the street.
//     - Where the profile stands more than DECK_MIN_LIFT_M over the ground (or over water) it is
//       a deck (structures.ts): kind freeway or ramp, layer 2 where it crosses over another deck.
//   Grade separations (two edges crossing with no node in common, one over the other): the
//     bare-earth DEM removes the bridge but keeps the cut and the fill, so the edge whose ground
//     dips (CUT_DIP_M: down into the cut under its removed span) or humps (HUMP_M: up its approach
//     embankments) at the crossing is the one on top, and the other runs on through. Its overpass
//     is a deck on the straight line between the ground at either end of its window, raised by a
//     smooth bump to DECK_CLEAR_M over the edge under it (Richland Ave over San Jose Ave, 23rd St
//     over US-101). Where neither moves, a freeway is on a viaduct over the street (its profile,
//     above, clears the street) and two streets are left alone.
//   Street bridges over water (creeks; the piers are land, piers.ts): a deck on the straight line
//     between the banks. The Lefty O'Doul Bridge (3rd St over Mission Creek) is a bascule.
//
// Pure and deterministic: edges in id order, samples in edge order.

import type { Building } from "./buildings.ts";
import { distToSegment, pointInRing, r2, type P2 } from "./geom.ts";
import type { RoadEdge, RoadGraph } from "./roads.ts";
import { cmVertex, splitPieces, type Deck, type Movable, type RibbonVertex, type Tunnel } from "./structures.ts";
import { boreY, PORTAL_COVER_M, PORTAL_FOOT_M, type Bore } from "./tunnels.ts";

/** A deck stands at least this far over a street it crosses (the sim passes bodies under 4.5 m). */
export const DECK_CLEAR_M = 5;
/** The steepest a freeway deck climbs or falls. */
export const FREEWAY_GRADE = 0.06;
/** ...and over water, where it holds its bank height... */
const WATER_GRADE = 0.005;
/** ...at least this far over the water. */
export const WATER_CLEAR_M = 3;
/** The tightest crest a deck makes (a car at 25 m/s stays on a crest of 64 m or more). */
export const CREST_RADIUS_M = 150;
/** Deck sample spacing. */
export const DECK_STEP_M = 4;
/** Open water longer than this under a freeway is a bridge the world does not model. */
const MAX_WATER_SPAN_M = 400;
/** The steepest a ramp comes down to its street. */
export const RAMP_GRADE = 0.08;
/** A road this far over the ground is on a deck. */
export const DECK_MIN_LIFT_M = 0.1;
/** A freeway clears a low roof under it by this much... */
const BUILDING_CLEAR_M = 1;
/** ...when the roof is this low over the ground (a taller building on a freeway is a conflict; Fort
 * Point, 15.7 m, stands under the Golden Gate Bridge's approach). */
const LOW_ROOF_M = 20;
/** A street whose ground dips this far into a freeway's corridor is on an overpass. */
const CUT_DIP_M = 2;
/** A street whose ground rises this far over the edge it crosses climbs embankments to a bridge over it. */
const HUMP_M = 1.5;
/** An overpass reaches at least this far either side of the crossing... */
const OVERPASS_HALF_M = 40;
/** ...and far enough that its crest is no tighter than this (a car at 25 m/s leaves one under 64 m)
 * where its street leaves room, and never tighter than this. */
const OVERPASS_CREST_M = 100;
const OVERPASS_MIN_CREST_M = 25;
/** An approach is read this far past the other road's kerb. */
const APPROACH_M = 12;
/** Street samples for bridges, overpasses and underpasses. */
const STREET_STEP_M = 2;
/** A bridge deck spans its water to the ground this far inland on both banks. */
const BANK_M = 15;
/** The Lefty O'Doul Bridge (3rd St over Mission Creek), lat/lon, and how near a 3rd St bridge must be. */
const LEFTY_ODOUL: [number, number] = [37.7766, -122.3906];
const LEFTY_ODOUL_REACH_M = 200;
/** The bascule leaf opens to this angle, radians (about 70 degrees). */
const BASCULE_OPEN_RAD = 1.22;

export interface DeckStats {
  /** Freeway and ramp samples, and those on a deck. */
  freewaySamples: number;
  deckSamples: number;
  /** Grade separations: a freeway over a street, and the overpasses (an edge over another). */
  crossingsOver: number;
  overpasses: string[];
  /** Freeway-over-freeway crossings that set a deck over another. */
  stacked: number;
  /** Low roofs the freeway clears, and taller buildings on a freeway centreline (left as they are). */
  roofsCleared: number;
  tallConflicts: string[];
  /** Ramp ends brought down to their street, and the most a lower bound was given up to a
   * ramp's or a portal's cone. */
  anchorsLowered: number;
  anchorShortfallM: number;
  /** Streets the freeway cannot clear near a portal or a ramp's foot: they bridge over it. */
  streetsOverPortals: number;
  /** Ramps too short to come down at RAMP_GRADE, with the straight grade they run instead. */
  shortRamps: string[];
  /** Overpass crossings left short of DECK_CLEAR_M over the edge under them, and the worst (metres). */
  overpassShortfalls: number;
  overpassShortfallM: number;
  /** Streets on top of a freeway too near a junction to bridge it smoothly: the freeway bridges over them. */
  overpassesTooTight: number;
  /** Crossings (edge ids, "fxg") where one road passes over the other by less than DECK_CLEAR_M and
   * neither can bridge the other within its chain: the source's geometry contradicts itself. */
  unresolvedCrossings: string[];
  bridges: string[];
  bascules: string[];
  /** The highest deck over its ground, metres. */
  maxLiftM: number;
}

export interface DeckResult {
  decks: Array<{ tile: string; deck: Deck }>;
  tunnels: Array<{ tile: string; tunnel: Tunnel }>;
  movable: Array<{ tile: string; movable: Movable }>;
  /** Every bore: the streets' as tunnels.ts found them, the freeways' as lined here. */
  bores: Bore[];
  /** The drawn road surface of an edge at arc length s, or null where it is the ground. */
  surface: (edge: string, s: number) => number | null;
  stats: DeckStats;
}

const isFreeway = (e: RoadEdge): boolean => !!e.gradeSeparated || e.kind === "freeway" || e.kind === "ramp";
/** A ramp: by class, or by name (the source classes some ramps as freeway: "Hwy 101 Northbound Ramp"). */
const isRamp = (e: RoadEdge): boolean => e.kind === "ramp" || /\bRamp\b/.test(e.name);

interface Polyline {
  pts: readonly P2[];
  cum: number[];
  length: number;
}

function polyline(pts: readonly P2[]): Polyline {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]));
  return { pts, cum, length: cum[cum.length - 1]! };
}

/** The point at arc length s (clamped). */
function pointAt(p: Polyline, s: number): P2 {
  const t = Math.max(0, Math.min(p.length, s));
  let i = 1;
  while (i < p.pts.length - 1 && p.cum[i]! < t) i++;
  const a = p.pts[i - 1]!;
  const b = p.pts[i]!;
  const L = p.cum[i]! - p.cum[i - 1]!;
  const u = L > 0 ? (t - p.cum[i - 1]!) / L : 0;
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
}

/** Arc lengths every `step` (at most) from 0 to the end, both ends included. */
function stations(length: number, step: number): number[] {
  const n = Math.max(1, Math.ceil(length / step));
  const out: number[] = [];
  for (let k = 0; k <= n; k++) out.push((length * k) / n);
  return out;
}

/**
 * The upper convex hull of h over [a, b], sampled every metre (the ends included), as a function
 * of S: the lowest line set that stays on or over every sample (a taut string over the ground).
 * Where h is concave between a and b it is the chord between them.
 */
export function upperHull(a: number, b: number, h: (S: number) => number): (S: number) => number {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const t of stations(Math.max(0, b - a), 1)) {
    const S = a + t;
    const y = h(S);
    // Pop while the last hull vertex lies on or under the line from the one before it to S.
    while (xs.length >= 2) {
      const k = xs.length - 1;
      const x0 = xs[k - 1]!, y0 = ys[k - 1]!, x1 = xs[k]!, y1 = ys[k]!;
      if ((x1 - x0) * (y - y0) - (y1 - y0) * (S - x0) >= 0) {
        xs.pop();
        ys.pop();
      } else break;
    }
    xs.push(S);
    ys.push(y);
  }
  return (S: number): number => {
    if (xs.length === 1 || S <= xs[0]!) return ys[0]!;
    for (let k = 1; k < xs.length; k++) {
      if (S <= xs[k]!) return ys[k - 1]! + ((ys[k]! - ys[k - 1]!) * (S - xs[k - 1]!)) / (xs[k]! - xs[k - 1]! || 1);
    }
    return ys[ys.length - 1]!;
  };
}

/** Proper intersection of segments ab and cd: parameters along each, or null. */
function cross(a: P2, b: P2, c: P2, d: P2): [number, number] | null {
  const rx = b[0] - a[0], rz = b[1] - a[1];
  const sx = d[0] - c[0], sz = d[1] - c[1];
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-12) return null;
  const qx = c[0] - a[0], qz = c[1] - a[1];
  const t = (qx * sz - qz * sx) / den;
  const u = (qx * rz - qz * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [t, u] : null;
}

/** A small max-heap of sample indices keyed by value (ties: lower index first). */
class Heap {
  private a: number[] = [];
  private readonly key: Float64Array;
  constructor(key: Float64Array) {
    this.key = key;
  }
  get size(): number {
    return this.a.length;
  }
  private before(i: number, j: number): boolean {
    const ki = this.key[i]!, kj = this.key[j]!;
    return ki > kj || (ki === kj && i < j);
  }
  push(i: number): void {
    const a = this.a;
    a.push(i);
    let c = a.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (!this.before(a[c]!, a[p]!)) break;
      [a[c], a[p]] = [a[p]!, a[c]!];
      c = p;
    }
  }
  pop(): number {
    const a = this.a;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let p = 0;
      for (;;) {
        const l = 2 * p + 1, r = l + 1;
        let m = p;
        if (l < a.length && this.before(a[l]!, a[m]!)) m = l;
        if (r < a.length && this.before(a[r]!, a[m]!)) m = r;
        if (m === p) break;
        [a[m], a[p]] = [a[p]!, a[m]!];
        p = m;
      }
    }
    return top;
  }
}

/**
 * Drop ribbon vertices the straight line between their neighbours keeps within THIN_XZ_M across
 * and THIN_Y_M in height (Douglas-Peucker): a viaduct's even grade needs few vertices.
 */
const THIN_XZ_M = 0.05;
const THIN_Y_M = 0.01;
export function thinRibbon(path: readonly RibbonVertex[]): RibbonVertex[] {
  if (path.length <= 2) return path.slice();
  const keep = new Uint8Array(path.length);
  keep[0] = 1;
  keep[path.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, path.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    const a = path[i0]!, b = path[i1]!;
    const ex = b[0] - a[0], ez = b[2] - a[2];
    const L2 = ex * ex + ez * ez;
    let worst = 1;
    let at = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const v = path[i]!;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((v[0] - a[0]) * ex + (v[2] - a[2]) * ez) / L2)) : 0;
      const dxz = Math.hypot(v[0] - (a[0] + ex * t), v[2] - (a[2] + ez * t));
      const dy = Math.abs(v[1] - (a[1] + (b[1] - a[1]) * t));
      const dw = Math.abs(v[3] - (a[3] + (b[3] - a[3]) * t));
      const r = Math.max(dxz / THIN_XZ_M, dy / THIN_Y_M, dw / THIN_XZ_M);
      if (r > worst) {
        worst = r;
        at = i;
      }
    }
    if (at >= 0) {
      keep[at] = 1;
      stack.push([i0, at], [at, i1]);
    }
  }
  return path.filter((_, i) => keep[i] === 1);
}

export function buildDecks(
  graph: RoadGraph,
  buildings: readonly Building[],
  heightAt: (x: number, z: number) => number,
  waterAt: (x: number, z: number) => boolean,
  bores: readonly Bore[],
  toLocal: (lat: number, lon: number) => { x: number; z: number },
): DeckResult {
  const stats: DeckStats = {
    freewaySamples: 0, deckSamples: 0, crossingsOver: 0, overpasses: [], stacked: 0,
    roofsCleared: 0, tallConflicts: [], anchorsLowered: 0, anchorShortfallM: 0, streetsOverPortals: 0, shortRamps: [], overpassShortfalls: 0, overpassShortfallM: 0, overpassesTooTight: 0, unresolvedCrossings: [],
    bridges: [], bascules: [], maxLiftM: 0,
  };
  const edges = [...graph.edges].sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  const fwy = edges.filter(isFreeway);
  const lines = new Map<string, Polyline>(edges.map((e) => [e.id, polyline(e.points)]));
  // The bores tunnels.ts found are zones here: on a freeway, the road through one is free of the
  // ground over it, and runs straight between the profile the rest of the network sets at its
  // ends (a portal can open onto a viaduct); the bore is where that line is under the hill.
  // Other bores (streets) are final as found.
  const zoneOf = new Map<string, Bore[]>();
  for (const b of bores) (zoneOf.get(b.edge) ?? zoneOf.set(b.edge, []).get(b.edge)!).push(b);
  const boreOf = new Map<string, Bore[]>();
  for (const b of bores) if (!isFreeway(graph.edges.find((e) => e.id === b.edge)!)) (boreOf.get(b.edge) ?? boreOf.set(b.edge, []).get(b.edge)!).push(b);
  /** A zone's line at arc length s of an edge, else null. */
  const inZone = (edge: string, s: number): number | null => {
    for (const b of zoneOf.get(edge) ?? []) {
      const y = boreY(b, s);
      if (y !== null) return y;
    }
    return null;
  };
  /** The road height in any (final) bore of an edge at arc length s, else null. */
  const inBore = (edge: string, s: number): number | null => {
    for (const b of boreOf.get(edge) ?? []) {
      const y = boreY(b, s);
      if (y !== null) return y;
    }
    return null;
  };

  // ---- Freeway sample graph.
  const X: number[] = [], Z: number[] = [], H: number[] = [], LO: number[] = [], W: number[] = [];
  const pinned: number[] = []; // NaN or the bore's road height (set once the zones are lined)
  const zone: number[] = []; // 1 in a freeway bore's zone
  const adj: number[][] = [], dist: number[][] = [];
  const nodeSample = new Map<string, number>();
  const edgeSamples = new Map<string, { idx: number[]; s: number[] }>();
  const addSample = (x: number, z: number): number => {
    const i = X.length;
    X.push(x); Z.push(z);
    const h = heightAt(x, z);
    const wet = waterAt(x, z);
    H.push(h); LO.push(wet ? Math.max(h, WATER_CLEAR_M) : h);
    W.push(wet ? 1 : 0);
    pinned.push(NaN);
    zone.push(0);
    adj.push([]); dist.push([]);
    return i;
  };
  const link = (i: number, j: number): void => {
    if (i === j || adj[i]!.includes(j)) return;
    const d = Math.hypot(X[i]! - X[j]!, Z[i]! - Z[j]!);
    adj[i]!.push(j); dist[i]!.push(d);
    adj[j]!.push(i); dist[j]!.push(d);
  };
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const e of fwy) {
    const pl = lines.get(e.id)!;
    const st = stations(pl.length, DECK_STEP_M);
    const idx: number[] = [];
    st.forEach((s, k) => {
      if (k === 0 || k === st.length - 1) {
        const nid = k === 0 ? e.a : e.b;
        let i = nodeSample.get(nid);
        if (i === undefined) {
          const n = nodeById.get(nid)!;
          i = addSample(n.x, n.z);
          nodeSample.set(nid, i);
        }
        idx.push(i);
      } else {
        const [x, z] = pointAt(pl, s);
        idx.push(addSample(x, z));
      }
    });
    for (let k = 1; k < idx.length; k++) link(idx[k - 1]!, idx[k]!);
    edgeSamples.set(e.id, { idx, s: st });
    st.forEach((s, k) => {
      if (inZone(e.id, s) !== null) zone[idx[k]!] = 1;
    });
  }
  const N = X.length;
  stats.freewaySamples = N;
  // A sample beside the water holds the clearance too (the deck between it and the water's edge).
  for (const e of fwy) {
    const { idx } = edgeSamples.get(e.id)!;
    idx.forEach((i, k) => {
      if (!W[i] && ((k > 0 && W[idx[k - 1]!]) || (k + 1 < idx.length && W[idx[k + 1]!]))) LO[i] = Math.max(LO[i]!, WATER_CLEAR_M);
    });
  }
  // A ramp that joins its freeway inside a bore's zone (the Yerba Buena Island on-ramp) has a
  // zone of its own from that node out, as far as the hill stands over a ramp climbing from the
  // zone's line there at RAMP_GRADE.
  const rampZones: Array<{ e: RoadEdge; ks: number[]; name: string }> = [];
  for (const e of fwy) {
    if (!isRamp(e) || zoneOf.has(e.id)) continue;
    const es = edgeSamples.get(e.id)!;
    for (const end of [0, es.idx.length - 1]) {
      const i = es.idx[end]!;
      if (!zone[i] || !adj[i]!.every((j) => zone[j] || es.idx.includes(j))) continue;
      // The zone's line at the node, from a mainline edge through it.
      let y0: number | null = null, name = "";
      for (const m of fwy) {
        if (m === e || isRamp(m)) continue;
        const ms = edgeSamples.get(m.id)!;
        const k = ms.idx.indexOf(i);
        if (k < 0) continue;
        y0 = inZone(m.id, ms.s[k]!);
        name = zoneOf.get(m.id)![0]!.name;
        if (y0 !== null) break;
      }
      if (y0 === null) continue;
      const ks: number[] = [end];
      const dir = end === 0 ? 1 : -1;
      for (let k = end + dir; k >= 0 && k < es.idx.length; k += dir) {
        const d = Math.abs(es.s[k]! - es.s[end]!);
        if (H[es.idx[k]!]! <= y0 + RAMP_GRADE * d + DECK_MIN_LIFT_M) break;
        ks.push(k);
        zone[es.idx[k]!] = 1;
      }
      if (ks.length > 1) rampZones.push({ e, ks, name });
    }
  }
  // The ground the solve reads: none in a zone.
  const G = new Float64Array(N);
  for (let i = 0; i < N; i++) G[i] = zone[i] ? -Infinity : H[i]!;

  // A grid of freeway samples (for crossings and building clearance).
  const SC = 25;
  const sKey = (cx: number, cz: number): number => (cx + 4096) * 8192 + cz + 4096;
  const sGrid = new Map<number, number[]>();
  for (let i = 0; i < N; i++) {
    const k = sKey(Math.floor(X[i]! / SC), Math.floor(Z[i]! / SC));
    (sGrid.get(k) ?? sGrid.set(k, []).get(k)!).push(i);
  }
  const samplesNear = (x: number, z: number, r: number): number[] => {
    const out: number[] = [];
    for (let cx = Math.floor((x - r) / SC); cx <= Math.floor((x + r) / SC); cx++) {
      for (let cz = Math.floor((z - r) / SC); cz <= Math.floor((z + r) / SC); cz++) {
        for (const i of sGrid.get(sKey(cx, cz)) ?? []) if (Math.hypot(X[i]! - x, Z[i]! - z) <= r) out.push(i);
      }
    }
    return out.sort((a, b) => a - b);
  };

  // ---- Grade separations: two edges whose centrelines cross with no node in common, one over
  // the other. (Pairs of freeways are stacked below; stairs never.)
  interface Crossing { f: RoadEdge; g: RoadEdge; P: P2; sf: number; sg: number }
  const crossings: Crossing[] = [];
  {
    const GC = 50;
    const segGrid = new Map<number, Array<[RoadEdge, number]>>();
    const usable = edges.filter((e) => !e.stairs);
    for (const g of usable) {
      for (let i = 1; i < g.points.length; i++) {
        const a = g.points[i - 1]!, b = g.points[i]!;
        for (let cx = Math.floor(Math.min(a[0], b[0]) / GC); cx <= Math.floor(Math.max(a[0], b[0]) / GC); cx++) {
          for (let cz = Math.floor(Math.min(a[1], b[1]) / GC); cz <= Math.floor(Math.max(a[1], b[1]) / GC); cz++) {
            const k = sKey(cx, cz);
            (segGrid.get(k) ?? segGrid.set(k, []).get(k)!).push([g, i]);
          }
        }
      }
    }
    const seen = new Set<string>();
    for (const f of usable) {
      const pf = lines.get(f.id)!;
      for (let i = 1; i < f.points.length; i++) {
        const a = f.points[i - 1]!, b = f.points[i]!;
        const cand: Array<[RoadEdge, number]> = [];
        const inCand = new Set<string>();
        for (let cx = Math.floor(Math.min(a[0], b[0]) / GC); cx <= Math.floor(Math.max(a[0], b[0]) / GC); cx++) {
          for (let cz = Math.floor(Math.min(a[1], b[1]) / GC); cz <= Math.floor(Math.max(a[1], b[1]) / GC); cz++) {
            for (const c of segGrid.get(sKey(cx, cz)) ?? []) {
              const k = `${c[0].id}#${c[1]}`;
              if (!inCand.has(k)) {
                inCand.add(k);
                cand.push(c);
              }
            }
          }
        }
        for (const [g, j] of cand) {
          // Each pair once: the freeway first when there is one, else by id.
          if (g === f || g.a === f.a || g.a === f.b || g.b === f.a || g.b === f.b) continue;
          if (isFreeway(g) !== isFreeway(f) ? !isFreeway(f) : g.id < f.id) continue;
          const c = g.points[j - 1]!, d = g.points[j]!;
          const t = cross(a, b, c, d);
          if (!t) continue;
          const P: P2 = [a[0] + (b[0] - a[0]) * t[0], a[1] + (b[1] - a[1]) * t[0]];
          const key = `${f.id}|${g.id}|${Math.round(P[0])},${Math.round(P[1])}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const pg = lines.get(g.id)!;
          crossings.push({ f, g, P, sf: pf.cum[i - 1]! + t[0] * (pf.cum[i]! - pf.cum[i - 1]!), sg: pg.cum[j - 1]! + t[1] * (pg.cum[j]! - pg.cum[j - 1]!) });
        }
      }
    }
  }

  // Which of the two is on top. The bare-earth DEM removes the bridge, not the cut or the fill:
  // the edge that dips (its bridge's span was removed, down into the cut below) or humps (the
  // approach embankments of a bridge over the other) at the crossing is the one on top; the
  // other runs on through. Both running through: a freeway over a street is a viaduct (its
  // bare-earth profile is the city under it); two streets are left alone.
  /** How far an edge's ground at arc length s dips (+) or humps (-) against the line across `half` metres either side. */
  const dipAt = (e: RoadEdge, s: number, half: number): number => {
    const pl = lines.get(e.id)!;
    const a = Math.max(0, s - half), b = Math.min(pl.length, s + half);
    if (b - a < half) return 0;
    const [ax, az] = pointAt(pl, a), [bx, bz] = pointAt(pl, b), [px, pz] = pointAt(pl, s);
    const chord = heightAt(ax, az) + ((heightAt(bx, bz) - heightAt(ax, az)) * (s - a)) / (b - a);
    return chord - heightAt(px, pz);
  };
  // Street chains: same-named surface edges through nodes no other road meets (the source splits
  // a street mid-block). An overpass reaches along its chain, never through a junction.
  const degree = new Map<string, number>();
  for (const e of graph.edges) for (const n of [e.a, e.b]) degree.set(n, (degree.get(n) ?? 0) + 1);
  const outOfA = new Map<string, RoadEdge[]>();
  for (const e of edges) if (!isFreeway(e)) (outOfA.get(e.a) ?? outOfA.set(e.a, []).get(e.a)!).push(e);
  const chainNext = (e: RoadEdge): RoadEdge | undefined => {
    if (degree.get(e.b) !== 2) return undefined;
    const o = (outOfA.get(e.b) ?? []).filter((q) => q.name === e.name && q.b !== e.a);
    return o.length === 1 ? o[0] : undefined;
  };
  const chainPrev = new Map<RoadEdge, RoadEdge>();
  for (const e of edges) {
    if (isFreeway(e)) continue;
    const n = chainNext(e);
    if (n) chainPrev.set(n, e);
  }
  interface Chain { edges: RoadEdge[]; starts: number[]; L: number }
  const chainCache = new Map<string, Chain>();
  const chainOf = (e: RoadEdge): Chain => {
    const hit = chainCache.get(e.id);
    if (hit) return hit;
    let first = e;
    for (let q = chainPrev.get(first), n = 0; q && q !== e && n < 1000; q = chainPrev.get(q), n++) first = q;
    const list: RoadEdge[] = [];
    for (let q: RoadEdge | undefined = first; q && !list.includes(q); q = chainNext(q)) list.push(q);
    if (!list.includes(e)) list.splice(0, list.length, e);
    const starts: number[] = [];
    let L = 0;
    for (const q of list) {
      starts.push(L);
      L += lines.get(q.id)!.length;
    }
    const ch = { edges: list, starts, L };
    for (const q of list) chainCache.set(q.id, ch);
    return ch;
  };
  const chainPoint = (ch: Chain, S: number): P2 => {
    let k = ch.edges.length - 1;
    while (k > 0 && ch.starts[k]! > S) k--;
    return pointAt(lines.get(ch.edges[k]!.id)!, S - ch.starts[k]!);
  };
  const chainGround = (ch: Chain, S: number): number => {
    const [x, z] = chainPoint(ch, S);
    return heightAt(x, z);
  };
  /**
   * Whether a street can bridge over a road at arc length s within its chain: its crest no tighter
   * than a car at 1.3 times the street's speed limit keeps its wheels on (OVERPASS_CREST_M where
   * the chain leaves room, which the plan prefers).
   */
  const crestFor = (e: RoadEdge): number => Math.max(OVERPASS_MIN_CREST_M, (1.3 * e.speedLimitMps) ** 2 / 9.81);
  const fits = (top: RoadEdge, s: number, yUnder: number, half0: number): boolean => {
    const ch = chainOf(top);
    const S = ch.starts[ch.edges.indexOf(top)]! + s;
    const a = Math.max(0, S - half0), b = Math.min(ch.L, S + half0);
    const chord = chainGround(ch, a) + ((chainGround(ch, b) - chainGround(ch, a)) * (S - a)) / (b - a || 1);
    const h = Math.max(0, yUnder + DECK_CLEAR_M - chord);
    return Math.PI * Math.sqrt((h * crestFor(top)) / 2) <= Math.min(S, ch.L - S) + 1;
  };
  interface Over { top: RoadEdge; under: RoadEdge; c: Crossing; s: number; half: number; hump: boolean }
  const overs: Over[] = [];
  const ffCross: Crossing[] = [];
  /** Freeway over street: the street's surface there (its ground). */
  const streetUnder: Array<{ c: Crossing; y: number }> = [];
  const pending: Crossing[] = [];
  const overZone: Crossing[] = [];
  for (const c of crossings) {
    // A bore's zone far under (if the freeway's zone turns out open there, below, the street
    // bridges over it).
    if (inZone(c.g.id, c.sg) !== null || inZone(c.f.id, c.sf) !== null) {
      if (isFreeway(c.f) && !isFreeway(c.g) && inZone(c.g.id, c.sg) === null) overZone.push(c);
      continue;
    }
    if (isFreeway(c.f) && isFreeway(c.g)) {
      ffCross.push(c);
      continue;
    }
    const dF = dipAt(c.f, c.sf, c.g.widthM / 2 + APPROACH_M);
    const dG = dipAt(c.g, c.sg, c.f.widthM / 2 + APPROACH_M);
    const moves = (d: number): boolean => d >= CUT_DIP_M || -d >= HUMP_M;
    const still = (d: number): boolean => Math.abs(d) < 1;
    const half = (other: RoadEdge): number => Math.max(other.widthM / 2 + APPROACH_M, OVERPASS_HALF_M);
    // A street too near a junction to bridge over smoothly leaves a freeway to bridge over it
    // instead (two streets: left as they are).
    const yP = heightAt(c.P[0], c.P[1]);
    if (moves(dG) && still(dF)) {
      if (fits(c.g, c.sg, yP, half(c.f))) overs.push({ top: c.g, under: c.f, c, s: c.sg, half: half(c.f), hump: dG < 0 });
      else if (isFreeway(c.f)) {
        pending.push(c);
        stats.overpassesTooTight++;
      }
    } else if (moves(dF) && still(dG) && !isFreeway(c.f)) {
      if (fits(c.f, c.sf, yP, half(c.g))) overs.push({ top: c.f, under: c.g, c, s: c.sf, half: half(c.g), hump: dF < 0 });
    } else if (isFreeway(c.f)) pending.push(c);
  }
  // Two streets: never a street over itself (a loop the source draws), and one order per pair of
  // streets (the source's carriageways can disagree): the crossing the DEM shows most clearly wins.
  {
    const strength = (o: Over): number => {
      const d = dipAt(o.top, o.s, o.under.widthM / 2 + APPROACH_M);
      return Math.abs(d);
    };
    const pairKey = (a: string, b: string): string => `${a}|${b}`;
    const best = new Map<string, { o: Over; w: number }>();
    for (const o of overs) {
      if (isFreeway(o.under)) continue;
      const k = o.top.name < o.under.name ? pairKey(o.top.name, o.under.name) : pairKey(o.under.name, o.top.name);
      const w = strength(o);
      const cur = best.get(k);
      if (!cur || w > cur.w) best.set(k, { o, w });
    }
    for (let i = overs.length - 1; i >= 0; i--) {
      const o = overs[i]!;
      if (isFreeway(o.under)) continue;
      if (chainOf(o.top) === chainOf(o.under) || o.top.name === o.under.name) {
        overs.splice(i, 1);
        continue;
      }
      const k = o.top.name < o.under.name ? pairKey(o.top.name, o.under.name) : pairKey(o.under.name, o.top.name);
      if (best.get(k)!.o.top.name !== o.top.name) overs.splice(i, 1);
    }
  }
  // A street on top of one carriageway is on top of its twin too (and of any freeway its
  // overpass window reaches): one bridge carries the street over both.
  {
    const windows = new Map<string, Array<[number, number]>>();
    for (const o of overs) (windows.get(o.top.id) ?? windows.set(o.top.id, []).get(o.top.id)!).push([o.s - o.half, o.s + o.half]);
    for (const c of pending) {
      const half0 = Math.max(c.f.widthM / 2 + APPROACH_M, OVERPASS_HALF_M);
      if ((windows.get(c.g.id) ?? []).some(([a, b]) => c.sg >= a && c.sg <= b) && fits(c.g, c.sg, heightAt(c.P[0], c.P[1]), half0)) {
        overs.push({ top: c.g, under: c.f, c, s: c.sg, half: half0, hump: false });
        continue;
      }
      stats.crossingsOver++;
      streetUnder.push({ c, y: heightAt(c.P[0], c.P[1]) });
    }
  }
  // The freeway clears every street under it: the samples within the street's half width (+1 m).
  const clearStreet = (c: Crossing, y: number): void => {
    const pg = lines.get(c.g.id)!;
    for (const i of samplesNear(c.P[0], c.P[1], c.g.widthM / 2 + 30)) {
      if (zone[i]) continue; // a street over a bore's zone is over the tunnel
      let d = Infinity;
      for (let k = 1; k < pg.pts.length; k++) d = Math.min(d, distToSegment(X[i]!, Z[i]!, pg.pts[k - 1]!, pg.pts[k]!).d);
      if (d <= c.g.widthM / 2 + 1) LO[i] = Math.max(LO[i]!, y + DECK_CLEAR_M + 0.05);
    }
  };
  for (const { c, y } of streetUnder) clearStreet(c, y);

  // ---- Low roofs under a freeway; taller buildings there are conflicts.
  {
    const BC = 25;
    const bGrid = new Map<number, number[]>();
    buildings.forEach((b, bi) => {
      if (b.meta.towerOf !== undefined) return;
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const [x, z] of b.footprint) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
        z0 = Math.min(z0, z); z1 = Math.max(z1, z);
      }
      for (let cx = Math.floor(x0 / BC); cx <= Math.floor(x1 / BC); cx++) {
        for (let cz = Math.floor(z0 / BC); cz <= Math.floor(z1 / BC); cz++) {
          const k = sKey(cx, cz);
          (bGrid.get(k) ?? bGrid.set(k, []).get(k)!).push(bi);
        }
      }
    });
    const tall = new Set<string>();
    for (let i = 0; i < N; i++) {
      if (zone[i]) continue;
      for (const bi of bGrid.get(sKey(Math.floor(X[i]! / BC), Math.floor(Z[i]! / BC))) ?? []) {
        const b = buildings[bi]!;
        if (!pointInRing(X[i]!, Z[i]!, b.footprint)) continue;
        if (b.underY !== undefined) continue;
        if (b.topY - H[i]! <= LOW_ROOF_M) {
          if (LO[i]! < b.topY + BUILDING_CLEAR_M) {
            LO[i] = b.topY + BUILDING_CLEAR_M;
            stats.roofsCleared++;
          }
        } else tall.add(b.id);
      }
    }
    stats.tallConflicts = [...tall].sort();
  }

  // ---- Upper bounds. A ramp comes down to its street at RAMP_GRADE (a cone from each anchor, a
  // ramp's node on a surface street, along the ramp's own samples up to its gore, a node on a
  // mainline, which the cone never moves), unless the ground forces it higher. A lower bound
  // over a cone (a street or a roof too near a ramp's foot to clear) gives way to it: the road
  // stays drivable, and a street it no longer clears bridges over it instead (below).
  const rampSample = new Uint8Array(N);
  const mainSample = new Uint8Array(N);
  for (const e of fwy) for (const i of edgeSamples.get(e.id)!.idx) (isRamp(e) ? rampSample : mainSample)[i] = 1;
  /** A link along a ramp (not at its gore). */
  const rampLink = (i: number, j: number): boolean => rampSample[i] === 1 && rampSample[j] === 1 && mainSample[i] === 0 && mainSample[j] === 0;
  /** The lowest of the sources' cones at every sample, and which source it is (-1: none). */
  const coneFrom = (sources: ReadonlyArray<[number, number]>, rampsOnly: boolean): { cap: Float64Array; src: Int32Array } => {
    const cap = new Float64Array(N).fill(Infinity);
    const src = new Int32Array(N).fill(-1);
    const neg = new Float64Array(N);
    const heap = new Heap(neg);
    for (const [i, c] of sources) {
      if (c >= cap[i]!) continue;
      cap[i] = c;
      src[i] = i;
      neg[i] = -c;
      heap.push(i);
    }
    const done = new Uint8Array(N);
    while (heap.size) {
      const i = heap.pop();
      if (done[i]) continue;
      done[i] = 1;
      const ai = adj[i]!, di = dist[i]!;
      for (let k = 0; k < ai.length; k++) {
        const j = ai[k]!;
        if (!Number.isNaN(pinned[j]!)) continue;
        if (rampsOnly && (!rampSample[j] || mainSample[j])) continue;
        const c = cap[i]! + (rampLink(i, j) ? RAMP_GRADE : FREEWAY_GRADE) * di[k]!;
        if (c < cap[j]! - 1e-9) {
          cap[j] = c;
          src[j] = src[i]!;
          neg[j] = -c;
          heap.push(j);
        }
      }
    }
    return { cap, src };
  };
  const cone = (sources: ReadonlyArray<[number, number]>, rampsOnly: boolean): Float64Array => coneFrom(sources, rampsOnly).cap;
  const UB = new Float64Array(N);
  const anchors: Array<[number, number]> = [];
  {
    for (const [nid, i] of nodeSample) {
      const surfaceUse = graph.edges.some((e) => !isFreeway(e) && (e.a === nid || e.b === nid));
      if (surfaceUse && rampSample[i] && !mainSample[i] && Number.isNaN(pinned[i]!)) anchors.push([i, H[i]!]);
    }
    anchors.sort((p, q) => p[0] - q[0]);
    const capA = cone(anchors, true);
    // A cone never goes under what the ground forces: the lowest grade-limited profile over the
    // ground (none in a zone).
    const forced = new Float64Array(N);
    for (let i = 0; i < N; i++) forced[i] = G[i]!;
    {
      const heap = new Heap(forced);
      for (let i = 0; i < N; i++) heap.push(i);
      const done = new Uint8Array(N);
      while (heap.size) {
        const i = heap.pop();
        if (done[i]) continue;
        done[i] = 1;
        const ai = adj[i]!, di = dist[i]!;
        for (let k = 0; k < ai.length; k++) {
          const j = ai[k]!;
          if (done[j]) continue;
          const g = W[i] && W[j] ? WATER_GRADE : rampLink(i, j) ? RAMP_GRADE : FREEWAY_GRADE;
          const cand = forced[i]! - g * di[k]!;
          if (cand > forced[j]! + 1e-9) {
            forced[j] = cand;
            heap.push(j);
          }
        }
      }
    }
    // A freeway under a street on top (the DEM kept the street's cut or embankment) stays on its
    // ground there: the street's bridge clears it, not the other way round.
    const underSrc: Array<[number, number]> = [];
    for (const o of overs) {
      if (!isFreeway(o.under)) continue;
      const pt = lines.get(o.top.id)!;
      for (const i of samplesNear(o.c.P[0], o.c.P[1], o.top.widthM / 2 + 30)) {
        if (!edgeSamples.get(o.under.id)!.idx.includes(i)) continue;
        let d = Infinity;
        for (let k = 1; k < pt.pts.length; k++) d = Math.min(d, distToSegment(X[i]!, Z[i]!, pt.pts[k - 1]!, pt.pts[k]!).d);
        if (d <= o.top.widthM / 2 + 1) underSrc.push([i, H[i]! + DECK_MIN_LIFT_M]);
      }
    }
    // ...and comes down to it no steeper than it may climb (a cone).
    underSrc.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const under = cone(underSrc, false);
    for (let i = 0; i < N; i++) UB[i] = Math.max(forced[i]!, Math.min(capA[i]!, under[i]!));
    stats.anchorsLowered = anchors.length;
  }
  /** A sample's effective lower bound: its own, under its cone, never under the ground (in a zone, none). */
  const bound = (i: number): number => {
    if (!Number.isNaN(pinned[i]!)) return pinned[i]!;
    if (zone[i]) return -Infinity;
    if (LO[i]! > UB[i]!) stats.anchorShortfallM = Math.max(stats.anchorShortfallM, LO[i]! - Math.max(UB[i]!, G[i]!));
    return Math.max(G[i]!, Math.min(LO[i]!, UB[i]!));
  };

  // ---- Solve: lowest profile over the bounds with grade and crest limits; bores pinned.
  const Y = new Float64Array(N);
  for (let i = 0; i < N; i++) Y[i] = bound(i);
  const grade = (i: number, j: number): number => (W[i] && W[j] ? WATER_GRADE : rampLink(i, j) ? RAMP_GRADE : FREEWAY_GRADE);
  const dilate = (): void => {
    const heap = new Heap(Y);
    for (let i = 0; i < N; i++) heap.push(i);
    const done = new Uint8Array(N);
    while (heap.size) {
      const i = heap.pop();
      if (done[i]) continue;
      done[i] = 1;
      const ai = adj[i]!, di = dist[i]!;
      for (let k = 0; k < ai.length; k++) {
        const j = ai[k]!;
        if (done[j] || !Number.isNaN(pinned[j]!)) continue;
        const cand = Y[i]! - grade(i, j) * di[k]!;
        if (cand > Y[j]! + 1e-9) {
          Y[j] = cand;
          heap.push(j);
        }
      }
    }
  };
  // Through-pairs at every sample: neighbours on opposite sides (within 30 degrees of straight).
  const pairs: Array<Array<[number, number, number, number]>> = [];
  for (let i = 0; i < N; i++) {
    const out: Array<[number, number, number, number]> = [];
    const ai = adj[i]!, di = dist[i]!;
    for (let p = 0; p < ai.length; p++) {
      for (let q = p + 1; q < ai.length; q++) {
        const j = ai[p]!, k = ai[q]!;
        if (di[p]! < 0.5 || di[q]! < 0.5) continue;
        const ux = (X[j]! - X[i]!) / (di[p]! || 1), uz = (Z[j]! - Z[i]!) / (di[p]! || 1);
        const vx = (X[k]! - X[i]!) / (di[q]! || 1), vz = (Z[k]! - Z[i]!) / (di[q]! || 1);
        if (ux * vx + uz * vz < -Math.cos(Math.PI / 6)) out.push([j, k, di[p]!, di[q]!]);
      }
    }
    pairs.push(out);
  }
  const smoothCrests = (): void => {
    for (let sweep = 0; sweep < 400; sweep++) {
      let worst = 0;
      const order = sweep % 2 === 0 ? 1 : -1;
      for (let n = 0; n < N; n++) {
        const i = order > 0 ? n : N - 1 - n;
        // A bore (pinned) is its own straight line: crests are rounded on the open road only.
        if (!Number.isNaN(pinned[i]!)) continue;
        for (const [j, k, dj, dk] of pairs[i]!) {
          if (!Number.isNaN(pinned[j]!) || !Number.isNaN(pinned[k]!)) continue;
          const interp = (dk * Y[j]! + dj * Y[k]!) / (dj + dk);
          const excess = Y[i]! - interp - (dj * dk) / (2 * CREST_RADIUS_M);
          if (excess <= 1e-4) continue;
          worst = Math.max(worst, excess);
          // Raise the lower neighbour first, then the other, each at most to the crest's own
          // height: the profile never rises above its highest bound, so the sweeps converge.
          let left = excess;
          const [lo1, d1, lo2, d2] = Y[j]! <= Y[k]! ? [j, dk, k, dj] : [k, dj, j, dk];
          const r1 = Math.min((left * (dj + dk)) / d1, Math.max(0, Y[i]! - Y[lo1]!));
          Y[lo1] = Y[lo1]! + r1;
          left -= (r1 * d1) / (dj + dk);
          if (left > 1e-6) {
            const r2v = Math.min((left * (dj + dk)) / d2, Math.max(0, Y[i]! - Y[lo2]!));
            Y[lo2] = Y[lo2]! + r2v;
          }
        }
      }
      if (worst < 1e-3) break;
    }
  };
  const check = (what: string): void => {
    for (let i = 0; i < N; i++) {
      if (what === "bounds" && zone[i]) continue; // no bound in a zone until the dilation reaches it
      if (!Number.isFinite(Y[i]!) || Y[i]! > Math.max(LO[i]!, H[i]!) + 200) throw new Error(`decks: ${what}: sample ${i} at ${X[i]},${Z[i]} y ${Y[i]} (lo ${LO[i]}, ground ${H[i]}, pinned ${pinned[i]})`);
    }
  };
  const solve = (): void => {
    check("bounds");
    for (let round = 0; round < 3; round++) {
      dilate();
      check("dilate");
      smoothCrests();
      check("crests");
    }
    dilate();
  };

  // Freeway over freeway: the higher one clears the lower by DECK_CLEAR_M; solve again.
  const yAtEdge = (e: RoadEdge, s: number): number => {
    const es = edgeSamples.get(e.id)!;
    let k = 1;
    while (k < es.s.length - 1 && es.s[k]! < s) k++;
    const s0 = es.s[k - 1]!, s1 = es.s[k]!;
    const u = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
    return Y[es.idx[k - 1]!]! + (Y[es.idx[k]!]! - Y[es.idx[k - 1]!]!) * u;
  };
  const upper = new Set<string>(); // edges carried over another deck somewhere
  const stack = (): void => {
    upper.clear();
    for (let round = 0; round < 2 && ffCross.length; round++) {
      let changed = false;
      for (const c of ffCross) {
        const yf = yAtEdge(c.f, c.sf), yg = yAtEdge(c.g, c.sg);
        const [top, low, yl] = yf >= yg ? [c.f, c.g, yg] : [c.g, c.f, yf];
        upper.add(top.id);
        const pl = lines.get(low.id)!;
        for (const i of samplesNear(c.P[0], c.P[1], low.widthM / 2 + 30)) {
          if (zone[i] || !Number.isNaN(pinned[i]!) || !edgeSamples.get(top.id)!.idx.includes(i)) continue;
          let d = Infinity;
          for (let k = 1; k < pl.pts.length; k++) d = Math.min(d, distToSegment(X[i]!, Z[i]!, pl.pts[k - 1]!, pl.pts[k]!).d);
          if (d <= low.widthM / 2 + 1 && LO[i]! < yl + DECK_CLEAR_M - 1e-6) {
            LO[i] = yl + DECK_CLEAR_M;
            Y[i] = Math.max(Y[i]!, bound(i));
            changed = true;
          }
        }
      }
      stats.stacked = upper.size;
      if (!changed) break;
      solve();
    }
  };


  /**
   * Between a covered station (cover over PORTAL_FOOT_M) and an open one, the arc length where
   * the cover comes down to zero (bisection on the ground's continuous profile, to 1 cm).
   */
  const footBetween = (cover: (s: number) => number, sIn: number, sOut: number): number => {
    if (cover(sOut) >= 0) return sOut;
    let a = sIn, b = sOut;
    for (let n = 0; n < 12; n++) {
      const m = (a + b) / 2;
      if (cover(m) > 0) a = m;
      else b = m;
    }
    return (a + b) / 2;
  };
  /** A node sample inside a bore of one of its edges. */
  const boreAtNode = (i: number): boolean => {
    for (const e of fwy) {
      const es = edgeSamples.get(e.id)!;
      const k = es.idx.indexOf(i);
      if (k >= 0 && (k === 0 || k === es.idx.length - 1) && inBore(e.id, es.s[k]!) !== null) return true;
    }
    return false;
  };
  // ---- Bores. Each freeway zone's road runs straight between the profile at its ends (the line
  // is over the dilation's V through the zone, so every bound still holds); it is a bore where the
  // line is under the hill, the run around its deepest cover out to where the cover falls under
  // PORTAL_FOOT_M (its portals); elsewhere in the zone it is a deck, or on the ground.
  const finalBores: Bore[] = [];
  const streetBores = new Map([...boreOf].map(([k, v]) => [k, v.slice()]));
  const lineZones = (): boolean => {
    finalBores.length = 0;
    boreOf.clear();
    for (const [k, v] of streetBores) boreOf.set(k, v.slice());
    const edgeById = new Map(graph.edges.map((e) => [e.id, e]));
    const fz = bores.filter((b) => isFreeway(edgeById.get(b.edge)!));
    const len = (b: Bore): number => lines.get(b.edge)!.length;
    const nextOf = (b: Bore): Bore | undefined =>
      b.s1 >= len(b) - 0.02 ? fz.find((q) => q !== b && q.name === b.name && q.s0 <= 0.02 && edgeById.get(q.edge)!.a === edgeById.get(b.edge)!.b) : undefined;
    const hasPrev = new Set<Bore>();
    for (const b of fz) {
      const n = nextOf(b);
      if (n) hasPrev.add(n);
    }
    const lined = new Set<Bore>();
    for (const first of fz) {
      if (hasPrev.has(first) || lined.has(first)) continue;
      const parts: Array<{ b: Bore; e: RoadEdge; off: number }> = [];
      let off = 0;
      for (let q: Bore | undefined = first; q && !lined.has(q); q = nextOf(q)) {
        lined.add(q);
        parts.push({ b: q, e: edgeById.get(q.edge)!, off });
        off += q.s1 - q.s0;
      }
      const L = off;
      const last = parts[parts.length - 1]!;
      const ya = yAtEdge(parts[0]!.e, parts[0]!.b.s0), yb = yAtEdge(last.e, last.b.s1);
      const line = (S: number): number => ya + ((yb - ya) * S) / (L || 1);
      for (const { b, e, off: o } of parts) {
        const es = edgeSamples.get(e.id)!;
        es.s.forEach((sk, k) => {
          const i = es.idx[k]!;
          if (!zone[i] || sk < b.s0 - 0.02 || sk > b.s1 + 0.02) return;
          Y[i] = line(Math.min(L, Math.max(0, o + sk - b.s0)));
          pinned[i] = Y[i]!;
        });
      }
      // The bore: around the deepest cover, out to the portals' feet.
      const at = (S: number): P2 => {
        let n = parts.length - 1;
        while (n > 0 && parts[n]!.off > S) n--;
        const p = parts[n]!;
        return pointAt(lines.get(p.e.id)!, p.b.s0 + Math.min(S - p.off, p.b.s1 - p.b.s0));
      };
      const st = stations(L, 1);
      const cover = st.map((S) => {
        const [x, z] = at(S);
        return heightAt(x, z) - line(S);
      });
      let deep = 0;
      cover.forEach((c, k) => {
        if (c > cover[deep]!) deep = k;
      });
      if (cover[deep]! <= PORTAL_COVER_M) continue;
      let k0 = deep, k1 = deep;
      while (k0 > 0 && cover[k0 - 1]! > PORTAL_FOOT_M) k0--;
      while (k1 < st.length - 1 && cover[k1 + 1]! > PORTAL_FOOT_M) k1++;
      // Each portal where the hill comes down to the line, between the stations either side.
      const coverS = (S: number): number => {
        const [x, z] = at(S);
        return heightAt(x, z) - line(S);
      };
      const S0 = k0 > 0 ? footBetween(coverS, st[k0]!, st[k0 - 1]!) : st[k0]!;
      const S1 = k1 < st.length - 1 ? footBetween(coverS, st[k1]!, st[k1 + 1]!) : st[k1]!;
      for (const { b, e, off: o } of parts) {
        const a = Math.max(S0, o), z = Math.min(S1, o + b.s1 - b.s0);
        if (z - a < 1) continue;
        finalBores.push({ edge: e.id, name: b.name, s0: r2(b.s0 + a - o), s1: r2(b.s0 + z - o), y0: r2(line(a)), y1: r2(line(z)) });
      }
    }
    // Ramp zones: straight from the node (on its freeway's line) to the profile past the zone.
    for (const { e, ks, name } of rampZones) {
      const es = edgeSamples.get(e.id)!;
      const dir = ks[0] === 0 ? 1 : -1;
      const kN = ks[0]!, kOut = Math.min(es.idx.length - 1, Math.max(0, ks[ks.length - 1]! + dir));
      const yN = Y[es.idx[kN]!]!, yO = Y[es.idx[kOut]!]!;
      const sN = es.s[kN]!, sO = es.s[kOut]!;
      const line = (s: number): number => yN + ((yO - yN) * (s - sN)) / (sO - sN || 1);
      for (const k of ks.slice(1)) {
        const i = es.idx[k]!;
        Y[i] = line(es.s[k]!);
        pinned[i] = Y[i]!;
      }
      // The bore runs from the node out to its portal's foot.
      const pl = lines.get(e.id)!;
      let sP = sN;
      const coverAt = (sq: number): number => {
        const [x, z] = pointAt(pl, sq);
        return heightAt(x, z) - line(sq);
      };
      for (let q = 1; q <= Math.abs(sO - sN); q++) {
        const sq = sN + dir * q;
        if (coverAt(sq) <= PORTAL_FOOT_M) {
          // The portal: where the hill comes down to the line between the two stations.
          sP = footBetween(coverAt, sP, sq);
          break;
        }
        sP = sq;
      }
      if (Math.abs(sP - sN) < 1) continue;
      const [s0, s1] = sN < sP ? [sN, sP] : [sP, sN];
      finalBores.push({ edge: e.id, name, s0: r2(s0), s1: r2(s1), y0: r2(line(s0)), y1: r2(line(s1)) });
    }
    finalBores.sort((p, q) => (p.edge < q.edge ? -1 : p.edge > q.edge ? 1 : p.s0 - q.s0));
    for (const b of finalBores) (boreOf.get(b.edge) ?? boreOf.set(b.edge, []).get(b.edge)!).push(b);
    for (const e of fwy) {
      if (boreOf.has(e.id)) e.tunnel = true;
      else delete e.tunnel;
    }
    // Outside the bores a zone is open road again: on the ground or over it, solved again with
    // the bores fixed.
    let opened = false;
    for (const e of fwy) {
      const es = edgeSamples.get(e.id)!;
      es.idx.forEach((i, k) => {
        if (!zone[i]) return;
        const inside = inBore(e.id, es.s[k]!) !== null;
        // A node: in a bore if any of its edges has it in one.
        if (inside || (Number.isNaN(pinned[i]!) === false && boreAtNode(i))) return;
        zone[i] = 0;
        G[i] = H[i]!;
        pinned[i] = NaN;
        opened = true;
      });
    }
    return opened;
  };

  // Solve, stack, line the zones; where a zone opened up, solve again from the bounds with the
  // smaller zones (a hill a zone no longer bores through changes the profile at its neighbours).
  solve();
  for (let pass = 0; pass < 3; pass++) {
    if (pass > 0) {
      for (let i = 0; i < N; i++) pinned[i] = NaN;
      for (let i = 0; i < N; i++) Y[i] = bound(i);
      solve();
    }
    stack();
    check("stacked");
    const opened = lineZones();
    if (opened) {
      for (let i = 0; i < N; i++) Y[i] = Math.max(Y[i]!, bound(i));
      solve();
    }
    if (!opened) break;
  }

  // The cones hold over the crest rounding too.
  for (let i = 0; i < N; i++) if (Number.isNaN(pinned[i]!)) Y[i] = Math.max(G[i]!, Math.min(Y[i]!, UB[i]!));
  // A knee a cone leaves is rounded by lowering (never under the ground): a lowered crest never
  // steepens a grade.
  for (let sweep = 0; sweep < 400; sweep++) {
    let worst = 0;
    for (let n = 0; n < N; n++) {
      const i = sweep % 2 === 0 ? n : N - 1 - n;
      if (!Number.isNaN(pinned[i]!)) continue;
      for (const [j, k, dj, dk] of pairs[i]!) {
        const interp = (dk * Y[j]! + dj * Y[k]!) / (dj + dk);
        const excess = Y[i]! - interp - (dj * dk) / (2 * CREST_RADIUS_M);
        if (excess <= 1e-4 || Y[i]! <= G[i]! + 1e-6) continue;
        // Never so low that a neighbour over it is then too steep above it.
        let floor = G[i]!;
        const ai = adj[i]!, di = dist[i]!;
        for (let q = 0; q < ai.length; q++) floor = Math.max(floor, Y[ai[q]!]! - grade(i, ai[q]!) * di[q]!);
        const y = Math.max(floor, Y[i]! - excess);
        if (y >= Y[i]! - 1e-6) continue;
        worst = Math.max(worst, Y[i]! - y);
        Y[i] = y;
      }
    }
    if (worst < 1e-3) break;
  }
  // A ramp the source draws too short to come down from its gore at RAMP_GRADE runs the straight
  // line from its street to its gore instead (steeper; the Sterling St on-ramp to the Bay Bridge).
  {
    const fromAnchor = coneFrom(anchors, true);
    const gores: Array<[number, number]> = [];
    for (let i = 0; i < N; i++) if (mainSample[i] && adj[i]!.some((j) => rampSample[j] && !mainSample[j])) gores.push([i, 0]);
    const fromGore = coneFrom(gores, true);
    const short = new Map<string, number>();
    for (let j = 0; j < N; j++) {
      const a = fromAnchor.src[j]!, g = fromGore.src[j]!;
      if (a < 0 || g < 0 || !rampSample[j] || mainSample[j]) continue;
      const dA = (fromAnchor.cap[j]! - H[a]!) / RAMP_GRADE, dG = fromGore.cap[j]! / RAMP_GRADE;
      const need = (Y[g]! - H[a]!) / (dA + dG || 1);
      if (need <= RAMP_GRADE + 1e-6) continue;
      Y[j] = Math.max(G[j]!, H[a]! + need * dA);
      for (const e of fwy) if (edgeSamples.get(e.id)!.idx.includes(j)) short.set(e.id, Math.max(short.get(e.id) ?? 0, need));
    }
    stats.shortRamps = [...short].sort((p, q) => (p[0] < q[0] ? -1 : 1)).map(([id, g]) => `${id} ${(g * 100).toFixed(1)}%`);
  }
  // A street the freeway no longer clears (a portal or a ramp's foot is too near) bridges over
  // the freeway instead: an overpass, like a street over a cut.
  const open = overZone.filter((c) => inBore(c.f.id, c.sf) === null).map((c) => ({ c, y: heightAt(c.P[0], c.P[1]), counted: false }));
  for (const { c, y, counted } of [...streetUnder.map((q) => ({ ...q, counted: true })), ...open]) {
    const yF = yAtEdge(c.f, c.sf);
    if (yF >= y + DECK_CLEAR_M - 0.05) continue;
    const half0 = Math.max(c.f.widthM / 2 + APPROACH_M, OVERPASS_HALF_M);
    if (!fits(c.g, c.sg, yF, half0)) continue; // the crossing check below lists it
    overs.push({ top: c.g, under: c.f, c, s: c.sg, half: half0, hump: false });
    if (counted) stats.crossingsOver--;
    stats.streetsOverPortals++;
  }
  stats.anchorShortfallM = r2(Math.max(0, stats.anchorShortfallM));
  check("anchors");
  for (let i = 0; i < N; i++) if (!Number.isFinite(H[i]!)) throw new Error(`decks: ground at ${X[i]},${Z[i]} is ${H[i]}`);

  // ---- Freeway decks.
  const decks: Array<{ tile: string; deck: Deck }> = [];
  const profiles = new Map<string, (s: number) => number | null>();
  for (const e of fwy) {
    const es = edgeSamples.get(e.id)!;
    // Open water longer than MAX_WATER_SPAN_M, or running out to where the road leaves the world
    // (a dead end over the water), is a bridge the world does not model (the Bay Bridge, the
    // Golden Gate Bridge: Assets): no deck there, and no ribbon.
    const open = new Uint8Array(es.idx.length);
    const last = es.idx.length - 1;
    for (let k = 0; k < es.idx.length; k++) {
      if (W[es.idx[k]!] !== 1) continue;
      let k1 = k;
      while (k1 + 1 < es.idx.length && W[es.idx[k1 + 1]!] === 1) k1++;
      const deadEnd = (k === 0 && adj[es.idx[0]!]!.length === 1) || (k1 === last && adj[es.idx[last]!]!.length === 1);
      if (deadEnd || es.s[k1]! - es.s[k]! > MAX_WATER_SPAN_M) for (let q = k; q <= k1; q++) open[q] = 1;
      k = k1;
    }
    const lifted = es.idx.map((i, k) => !open[k] && (W[i] === 1 || Y[i]! - H[i]! > DECK_MIN_LIFT_M) && inBore(e.id, es.s[k]!) === null);
    const runs: Array<[number, number]> = [];
    for (let k = 0; k < lifted.length; k++) {
      if (!lifted[k]) continue;
      const k0 = k;
      while (k + 1 < lifted.length && lifted[k + 1]) k++;
      runs.push([Math.max(0, k0 - 1), Math.min(lifted.length - 1, k + 1)]);
    }
    // Merge runs that touch after widening.
    const merged: Array<[number, number]> = [];
    for (const r of runs) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    }
    /** A run's end in a bore (sample k, next to the run's sample kIn): the deck ends at the portal. */
    const portal = (k: number, kIn: number): RibbonVertex => {
      const s = es.s[k]!;
      for (const b of boreOf.get(e.id) ?? []) {
        if (boreY(b, s) === null) continue;
        const sp = es.s[kIn]! < s ? b.s0 : b.s1;
        const [x, z] = pointAt(lines.get(e.id)!, sp);
        return cmVertex([x, boreY(b, sp)!, z, e.widthM]);
      }
      // A node another edge's bore ends at (a portal at a junction): the bore's height there.
      const i = es.idx[k]!;
      return cmVertex([X[i]!, Y[i]!, Z[i]!, e.widthM]);
    };
    merged.forEach(([k0, k1], n) => {
      const path: RibbonVertex[] = [];
      for (let k = k0; k <= k1; k++) {
        const i = es.idx[k]!;
        if (inBore(e.id, es.s[k]!) !== null) {
          path.push(portal(k, k === k0 ? k0 + 1 : k1 - 1));
          continue;
        }
        path.push(cmVertex([X[i]!, Math.max(Y[i]!, H[i]!), Z[i]!, e.widthM]));
        stats.maxLiftM = Math.max(stats.maxLiftM, Y[i]! - H[i]!);
      }
      stats.deckSamples += k1 - k0 + 1;
      const id = merged.length === 1 ? e.id : `${e.id}.${n}`;
      for (const piece of splitPieces({ id, path: thinRibbon(path) })) {
        decks.push({ tile: piece.tile, deck: { id: piece.id, kind: isRamp(e) ? "ramp" : "freeway", edge: e.id, layer: upper.has(e.id) ? 2 : 1, path: piece.path } });
      }
    });
    if (merged.length) e.deck = true;
    profiles.set(e.id, (s) => {
      const yb = inBore(e.id, s);
      if (yb !== null) return yb;
      // On the ground (no deck), the ribbon drapes on the ground mesh as any street does.
      let k = 1;
      while (k < es.s.length - 1 && es.s[k]! < s) k++;
      if (open[k - 1] && open[k]) return null;
      const y = yAtEdge(e, s);
      const [x, z] = pointAt(lines.get(e.id)!, s);
      return waterAt(x, z) || y - heightAt(x, z) > DECK_MIN_LIFT_M ? y : null;
    });
  }
  stats.maxLiftM = r2(stats.maxLiftM);

  // ---- Street structures: overpasses (grade separations) and bridges (water).
  const tunnels: Array<{ tile: string; tunnel: Tunnel }> = [];
  const streetProfiles = new Map<string, Array<{ s0: number; s1: number; y: (s: number) => number }>>();
  const addProfile = (id: string, p: { s0: number; s1: number; y: (s: number) => number }): void => {
    (streetProfiles.get(id) ?? streetProfiles.set(id, []).get(id)!).push(p);
  };
  const ribbonOf = (e: RoadEdge, s0: number, s1: number, y: (s: number) => number): RibbonVertex[] => {
    const pl = lines.get(e.id)!;
    const n = Math.max(1, Math.ceil((s1 - s0) / STREET_STEP_M));
    const at: number[] = [];
    for (let k = 0; k <= n; k++) at.push(s0 + ((s1 - s0) * k) / n);
    // The centreline's own bends too: stations every STREET_STEP_M alone cut a sharp bend's
    // corner, so the deck the sim stands on fell short of the ribbon the tile draws round it
    // (Geneva Ave's overpass over I-280: 5 m of drawn deck over the ground beside it; W-09).
    for (let i = 1; i < pl.pts.length - 1; i++) {
      const c = pl.cum[i]!;
      if (c > s0 + 0.05 && c < s1 - 0.05) at.push(c);
    }
    at.sort((p, q) => p - q);
    const out: RibbonVertex[] = [];
    let last = -Infinity;
    for (const s of at) {
      if (s - last < 0.05) continue;
      last = s;
      const [x, z] = pointAt(pl, s);
      out.push(cmVertex([x, y(s), z, e.widthM]));
    }
    return out;
  };
  const groundAt = ([x, z]: P2): number => heightAt(x, z);
  const groundOn = (e: RoadEdge, s: number): number => {
    const [x, z] = pointAt(lines.get(e.id)!, s);
    return heightAt(x, z);
  };
  // Overpasses: on the edge on top, the straight line between the ground at the ends of its
  // window(s) round each crossing, raised by a smooth (cosine) bump to DECK_CLEAR_M over the edge
  // under it, or to the top of the embankment it humps over. A window is wide enough that its
  // crest is no tighter than OVERPASS_CREST_M.
  {
    interface Span { id: string; e: RoadEdge; a: number; b: number; y: (s: number) => number; bumps: Array<{ s: number; target: number }> }
    const plan = (prev: Span[] = []): Span[] => {
      /** A street's surface at arc length s from the previous plan's overpasses, else its ground. */
      const streetSurface = (e: RoadEdge, s: number, P: P2): number => {
        for (const sp of prev) if (sp.e.id === e.id && s >= sp.a && s <= sp.b) return sp.y(s);
        return heightAt(P[0], P[1]);
      };
      const pieces: Array<Omit<Span, "id">> = [];
      const byChain = new Map<Chain, Over[]>();
      for (const o of overs) {
        const ch = chainOf(o.top);
        (byChain.get(ch) ?? byChain.set(ch, []).get(ch)!).push(o);
      }
      for (const [ch, os] of [...byChain].sort((p, q) => (p[0].edges[0]!.id < q[0].edges[0]!.id ? -1 : 1))) {
        const L = ch.L;
        for (let pass = 0; pass < 2; pass++) {
          const wins = os
            .map((o) => {
              const under = o.under;
              const sU = under === o.c.f ? o.c.sf : o.c.sg;
              const yU = isFreeway(under) && edgeSamples.has(under.id) ? (inBore(under.id, sU) ?? yAtEdge(under, sU)) : streetSurface(under, sU, o.c.P);
              const S = ch.starts[ch.edges.indexOf(o.top)]! + o.s;
              const target = Math.max(yU + DECK_CLEAR_M, o.hump ? chainGround(ch, S) : -Infinity);
              return { o, s: S, a: Math.max(0, S - o.half), b: Math.min(L, S + o.half), target };
            })
            .sort((p, q) => p.a - q.a || p.s - q.s);
          // Merge overlapping windows into spans.
          const spans: Array<{ a: number; b: number; w: typeof wins }> = [];
          for (const w of wins) {
            const last = spans[spans.length - 1];
            if (last && w.a <= last.b) {
              last.b = Math.max(last.b, w.b);
              last.w.push(w);
            } else spans.push({ a: w.a, b: w.b, w: [w] });
          }
          let widened = false;
          const made: Array<Omit<Span, "id">> = [];
          for (const sp of spans) {
            const ya = chainGround(ch, sp.a), yb = chainGround(ch, sp.b);
            const chord = (S: number): number => ya + ((yb - ya) * (S - sp.a)) / (sp.b - sp.a || 1);
            // Never under the ground's upper hull across the span (the chord where the ground under
            // it is concave): over a cut (a freeway's trench) the deck leaves each lip of the cut
            // on the line between the lips, never first following the ground over a lip and down
            // into the cut to meet the chord between the ends (a sudden fall at the deck's start
            // that threw a turning car off its side into the cut; W-22). The hull is at or over
            // the chord and the ground, so the deck only ever rises where it applies.
            const hull = upperHull(sp.a, sp.b, (S) => chainGround(ch, S));
            const bumps = sp.w.map((w) => ({ ...w, h: Math.max(0, w.target - chord(w.s)) }));
            for (const w of bumps) {
              const need = Math.PI * Math.sqrt((w.h * OVERPASS_CREST_M) / 2);
              if (pass === 0 && w.o.half < need - 0.5) {
                w.o.half = need;
                widened = true;
              }
            }
            const y = (S: number): number => {
              let up = 0;
              for (const w of bumps) {
                if (S <= w.a || S >= w.b) continue;
                const u = S < w.s ? (S - w.a) / (w.s - w.a || 1) : (w.b - S) / (w.b - w.s || 1);
                up = Math.max(up, (w.h * (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, u))))) / 2);
              }
              return Math.max(chord(S) + up, hull(S), chainGround(ch, S));
            };
            // One piece per edge of the chain the span covers.
            ch.edges.forEach((e, k) => {
              const e0 = ch.starts[k]!, e1 = e0 + lines.get(e.id)!.length;
              const a = Math.max(sp.a, e0), b = Math.min(sp.b, e1);
              if (b - a < 0.5) return;
              made.push({
                e, a: a - e0, b: b - e0, y: (s: number) => y(e0 + s),
                bumps: bumps.filter((w) => w.s >= a && w.s <= b).map((w) => ({ s: w.s - e0, target: w.target })),
              });
            });
          }
          if (pass === 1 || !widened) {
            pieces.push(...made);
            break;
          }
        }
      }
      // Ids per edge: <edge>.o, or <edge>.o<n> where an edge has several.
      const count = new Map<string, number>();
      for (const p of pieces) count.set(p.e.id, (count.get(p.e.id) ?? 0) + 1);
      const seen = new Map<string, number>();
      const out: Span[] = pieces
        .sort((p, q) => (p.e.id < q.e.id ? -1 : p.e.id > q.e.id ? 1 : p.a - q.a))
        .map((p) => {
          const n = seen.get(p.e.id) ?? 0;
          seen.set(p.e.id, n + 1);
          return { ...p, id: count.get(p.e.id) === 1 ? `${p.e.id}.o` : `${p.e.id}.o${n}` };
        });
      return out;
    };
    // Every crossing where a structure (an overpass, a freeway deck) passes over the other road by
    // less than DECK_CLEAR_M (a neighbouring crossing's bridge, a trench's chord, a ramp's foot):
    // the street on top bridges over it properly, where its chain leaves room; else the crossing
    // is listed unresolved (the source's geometry contradicts itself there).
    let spans = plan();
    spans = plan(spans); // a street under a street that is itself raised elsewhere
    const inOvers = new Set(overs.map((o) => o.c));
    const unresolved = new Set<string>();
    // Rounds that add bridges, then one that only lists what is left.
    for (let round = 0; round <= 6; round++) {
      const last = round === 6;
      if (last) unresolved.clear();
      const spanY = (e: RoadEdge, s: number): number | null => {
        for (const sp of spans) if (sp.e.id === e.id && s >= sp.a && s <= sp.b) return sp.y(s);
        return null;
      };
      const surf = (e: RoadEdge, s: number, P: P2): number => (isFreeway(e) && edgeSamples.has(e.id) ? yAtEdge(e, s) : (spanY(e, s) ?? heightAt(P[0], P[1])));
      let added = false;
      for (const c of crossings) {
        if ((!last && inOvers.has(c)) || inBore(c.f.id, c.sf) !== null || inBore(c.g.id, c.sg) !== null) continue;
        if (isFreeway(c.f) && isFreeway(c.g)) continue; // stacked above
        const yf = surf(c.f, c.sf, c.P), yg = surf(c.g, c.sg, c.P);
        const fTop = yf >= yg;
        const top = fTop ? c.f : c.g, under = fTop ? c.g : c.f;
        const sT = fTop ? c.sf : c.sg, sU = fTop ? c.sg : c.sf;
        const yT = Math.max(yf, yg), yU = Math.min(yf, yg);
        if (yT - yU >= DECK_CLEAR_M - 0.05) continue;
        // Both on the ground: a crossing the DEM has at grade (no structure to fix).
        const raised = isFreeway(top) ? yT - heightAt(c.P[0], c.P[1]) > DECK_MIN_LIFT_M : spanY(top, sT) !== null;
        if (!raised) continue;
        // The street bridges over: the top one if it is a street, else the street under the freeway.
        const [st, ss, other] = isFreeway(top) ? [under, sU, top] : [top, sT, under];
        if (isFreeway(st) || st.name === other.name || chainOf(st) === (isFreeway(other) ? null : chainOf(other))) {
          unresolved.add(`${c.f.id}x${c.g.id}`);
          continue;
        }
        const half0 = Math.max(other.widthM / 2 + APPROACH_M, OVERPASS_HALF_M);
        if (last || !fits(st, ss, Math.max(yT, yU), half0)) {
          unresolved.add(`${c.f.id}x${c.g.id}`);
          continue;
        }
        overs.push({ top: st, under: other, c, s: ss, half: half0, hump: false });
        inOvers.add(c);
        unresolved.delete(`${c.f.id}x${c.g.id}`);
        added = true;
      }
      if (last) break;
      if (!added) round = 5; // straight to the listing round
      else spans = plan(plan(spans));
    }
    stats.unresolvedCrossings = [...unresolved].sort();
    for (const sp of spans) {
      const path = ribbonOf(sp.e, sp.a, sp.b, sp.y);
      for (const piece of splitPieces({ id: sp.id, path })) decks.push({ tile: piece.tile, deck: { id: piece.id, kind: "overpass", edge: sp.e.id, layer: 1, path: piece.path } });
      addProfile(sp.e.id, { s0: sp.a, s1: sp.b, y: sp.y });
      sp.e.deck = true;
      stats.overpasses.push(sp.id);
      for (const w of sp.bumps) {
        const short = w.target - sp.y(w.s);
        if (short > 0.01) {
          stats.overpassShortfalls++;
          stats.overpassShortfallM = Math.max(stats.overpassShortfallM, r2(short));
        }
      }
    }
  }

  // Bridges over water: chains of same-named surface edges through nodes no other street meets
  // (the source splits some bridges mid-span), each water run spanned on the straight line
  // between the ground BANK_M inland of it on both sides.
  const movable: Array<{ tile: string; movable: Movable }> = [];
  {
    const surfaceEdges = edges.filter((e) => !isFreeway(e) && !e.pedestrian);
    const degree = new Map<string, number>();
    for (const e of graph.edges) for (const n of [e.a, e.b]) degree.set(n, (degree.get(n) ?? 0) + 1);
    const outOf = new Map<string, RoadEdge[]>();
    for (const e of surfaceEdges) (outOf.get(e.a) ?? outOf.set(e.a, []).get(e.a)!).push(e);
    const next = (e: RoadEdge): RoadEdge | undefined => {
      if (degree.get(e.b) !== 2) return undefined;
      const o = (outOf.get(e.b) ?? []).filter((q) => q.name === e.name && q.b !== e.a);
      return o.length === 1 ? o[0] : undefined;
    };
    const prevOf = new Map<RoadEdge, RoadEdge>();
    for (const e of surfaceEdges) {
      const n = next(e);
      if (n) prevOf.set(n, e);
    }
    const done = new Set<RoadEdge>();
    const lefty = toLocal(LEFTY_ODOUL[0], LEFTY_ODOUL[1]);
    const leftyBox: { best: { d: number; deckId: string; tile: string; hinge: [[number, number], [number, number]] } | null } = { best: null };
    for (const seed of edges) {
      if (isFreeway(seed) || !seed.bridge || seed.pedestrian || done.has(seed)) continue;
      // The whole chain through the seed.
      let first = seed;
      for (let q = prevOf.get(first); q && q !== seed && !done.has(q); q = prevOf.get(q)) first = q;
      const chain: RoadEdge[] = [];
      for (let q: RoadEdge | undefined = first; q && !chain.includes(q); q = next(q)) chain.push(q);
      for (const q of chain) done.add(q);
      const starts: number[] = [];
      let L = 0;
      for (const q of chain) {
        starts.push(L);
        L += lines.get(q.id)!.length;
      }
      const at = (S: number): P2 => {
        let k = chain.length - 1;
        while (k > 0 && starts[k]! > S) k--;
        return pointAt(lines.get(chain[k]!.id)!, S - starts[k]!);
      };
      const st = stations(L, STREET_STEP_M);
      const wet = st.map((S) => {
        const [x, z] = at(S);
        return waterAt(x, z);
      });
      let n = 0;
      for (let k = 0; k < st.length; k++) {
        if (!wet[k]) continue;
        let k1 = k;
        while (k1 + 1 < st.length && wet[k1 + 1]) k1++;
        const A = Math.max(0, st[k]! - BANK_M), B = Math.min(L, st[k1]! + BANK_M);
        k = k1;
        if (B - A < 4) continue;
        const [ax, az] = at(A), [bx, bz] = at(B);
        // A dead end over water holds the other bank's height.
        let y0 = heightAt(ax, az), y1 = heightAt(bx, bz);
        if (waterAt(ax, az)) y0 = y1;
        if (waterAt(bx, bz)) y1 = y0;
        const yb = (S: number): number => Math.max(y0 + ((y1 - y0) * (S - A)) / (B - A || 1), groundAt(at(S)));
        // Per edge of the chain: its share of the deck, with the chain's heights.
        chain.forEach((q, i) => {
          const e0 = starts[i]!, e1 = i + 1 < chain.length ? starts[i + 1]! : L;
          const a = Math.max(A, e0), b = Math.min(B, e1);
          if (b - a < 1) return;
          const yq = (s: number): number => yb(e0 + s);
          const path = ribbonOf(q, a - e0, b - e0, yq);
          const did = `${q.id}.b${n}`;
          const pieces = splitPieces({ id: did, path });
          for (const piece of pieces) decks.push({ tile: piece.tile, deck: { id: piece.id, kind: "bridge", edge: q.id, layer: 1, path: piece.path } });
          addProfile(q.id, { s0: a - e0, s1: b - e0, y: yq });
          q.deck = true;
          stats.bridges.push(did);
          if (q.name === "3rd St") {
            const mid = at((A + B) / 2);
            const d = Math.hypot(mid[0] - lefty.x, mid[1] - lefty.z);
            const leaf = pieces.find((p) => p.path.some((v) => Math.hypot(v[0] - mid[0], v[2] - mid[1]) < STREET_STEP_M));
            if (leaf && d <= LEFTY_ODOUL_REACH_M && (!leftyBox.best || d < leftyBox.best.d)) {
              // The leaf is the piece over the water's middle; it hinges on the line across the
              // road at the bridge's first bank.
              const [hx, hz] = at(A), [nx2, nz2] = at(A + STREET_STEP_M);
              const Lh = Math.hypot(nx2 - hx, nz2 - hz) || 1;
              const px = (-(nz2 - hz) / Lh) * (q.widthM / 2), pz = ((nx2 - hx) / Lh) * (q.widthM / 2);
              leftyBox.best = { d, deckId: leaf.id, tile: leaf.tile, hinge: [[r2(hx - px), r2(hz - pz)], [r2(hx + px), r2(hz + pz)]] };
            }
          }
        });
        n++;
      }
    }
    const leftyBest = leftyBox.best;
    if (leftyBest) {
      movable.push({ tile: leftyBest.tile, movable: { id: "lefty-odoul-bascule", kind: "bascule", deck: leftyBest.deckId, hinge: leftyBest.hinge, openRad: BASCULE_OPEN_RAD } });
      stats.bascules.push(leftyBest.deckId);
    }
  }

  const surface = (edge: string, s: number): number | null => {
    const f = profiles.get(edge);
    if (f) return f(s);
    for (const p of streetProfiles.get(edge) ?? []) if (s >= p.s0 && s <= p.s1) return p.y(s);
    return null;
  };
  stats.overpasses.sort();
  stats.bridges.sort();
  const allBores = [...bores.filter((b) => !isFreeway(graph.edges.find((e) => e.id === b.edge)!)), ...finalBores].sort((p, q) =>
    p.edge < q.edge ? -1 : p.edge > q.edge ? 1 : p.s0 - q.s0,
  );
  return { decks, tunnels, movable, surface, bores: allBores, stats };
}
