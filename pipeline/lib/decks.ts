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
import { boreY, type Bore } from "./tunnels.ts";

/** A deck stands at least this far over a street it crosses (the sim passes bodies under 4.5 m). */
export const DECK_CLEAR_M = 5;
/** The steepest a freeway deck climbs or falls. */
export const FREEWAY_GRADE = 0.06;
/** ...and over water, where it holds its bank height. */
const WATER_GRADE = 0.005;
/** The tightest crest a deck makes (a car at 25 m/s stays on a crest of 64 m or more). */
export const CREST_RADIUS_M = 150;
/** Deck sample spacing. */
export const DECK_STEP_M = 4;
/** Open water longer than this under a freeway is a bridge the world does not model. */
const MAX_WATER_SPAN_M = 400;
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
/** An overpass reaches at least this far either side of the crossing (its crest: radius 100 m or more). */
const OVERPASS_HALF_M = 40;
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
  /** Ramp ends brought down to their street, and the most a lower bound was given up there. */
  anchorsLowered: number;
  anchorShortfallM: number;
  /** Overpass crossings left short of DECK_CLEAR_M over the edge under them, and the worst (metres). */
  overpassShortfalls: number;
  overpassShortfallM: number;
  bridges: string[];
  bascules: string[];
  /** The highest deck over its ground, metres. */
  maxLiftM: number;
}

export interface DeckResult {
  decks: Array<{ tile: string; deck: Deck }>;
  tunnels: Array<{ tile: string; tunnel: Tunnel }>;
  movable: Array<{ tile: string; movable: Movable }>;
  /** The drawn road surface of an edge at arc length s, or null where it is the ground. */
  surface: (edge: string, s: number) => number | null;
  stats: DeckStats;
}

const isFreeway = (e: RoadEdge): boolean => !!e.gradeSeparated || e.kind === "freeway" || e.kind === "ramp";

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
    roofsCleared: 0, tallConflicts: [], anchorsLowered: 0, anchorShortfallM: 0, overpassShortfalls: 0, overpassShortfallM: 0,
    bridges: [], bascules: [], maxLiftM: 0,
  };
  const edges = [...graph.edges].sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  const fwy = edges.filter(isFreeway);
  const lines = new Map<string, Polyline>(edges.map((e) => [e.id, polyline(e.points)]));
  const boreOf = new Map<string, Bore[]>();
  for (const b of bores) (boreOf.get(b.edge) ?? boreOf.set(b.edge, []).get(b.edge)!).push(b);
  /** The road height in any bore of an edge at arc length s, else null. */
  const inBore = (edge: string, s: number): number | null => {
    for (const b of boreOf.get(edge) ?? []) {
      const y = boreY(b, s);
      if (y !== null) return y;
    }
    return null;
  };

  // ---- Freeway sample graph.
  const X: number[] = [], Z: number[] = [], H: number[] = [], LO: number[] = [], W: number[] = [];
  const pinned: number[] = []; // NaN or the bore's road height
  const adj: number[][] = [], dist: number[][] = [];
  const nodeSample = new Map<string, number>();
  const edgeSamples = new Map<string, { idx: number[]; s: number[] }>();
  const addSample = (x: number, z: number): number => {
    const i = X.length;
    X.push(x); Z.push(z);
    const h = heightAt(x, z);
    H.push(h); LO.push(h);
    W.push(waterAt(x, z) ? 1 : 0);
    pinned.push(NaN);
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
      const y = inBore(e.id, s);
      if (y !== null) {
        pinned[idx[k]!] = y;
        LO[idx[k]!] = y;
      }
    });
  }
  const N = X.length;
  stats.freewaySamples = N;

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
  interface Over { top: RoadEdge; under: RoadEdge; c: Crossing; s: number; half: number; hump: boolean }
  const overs: Over[] = [];
  const ffCross: Crossing[] = [];
  /** Freeway over street: the street's surface there (its ground). */
  const streetUnder: Array<{ c: Crossing; y: number }> = [];
  for (const c of crossings) {
    if (inBore(c.g.id, c.sg) !== null || inBore(c.f.id, c.sf) !== null) continue; // a bore far under
    if (isFreeway(c.f) && isFreeway(c.g)) {
      ffCross.push(c);
      continue;
    }
    const dF = dipAt(c.f, c.sf, c.g.widthM / 2 + APPROACH_M);
    const dG = dipAt(c.g, c.sg, c.f.widthM / 2 + APPROACH_M);
    const moves = (d: number): boolean => d >= CUT_DIP_M || -d >= HUMP_M;
    const still = (d: number): boolean => Math.abs(d) < 1;
    const half = (other: RoadEdge): number => Math.max(other.widthM / 2 + APPROACH_M, OVERPASS_HALF_M);
    if (moves(dG) && still(dF)) overs.push({ top: c.g, under: c.f, c, s: c.sg, half: half(c.f), hump: dG < 0 });
    else if (moves(dF) && still(dG) && !isFreeway(c.f)) overs.push({ top: c.f, under: c.g, c, s: c.sf, half: half(c.g), hump: dF < 0 });
    else if (isFreeway(c.f)) {
      stats.crossingsOver++;
      streetUnder.push({ c, y: heightAt(c.P[0], c.P[1]) });
    }
  }
  // The freeway clears every street under it: the samples within the street's half width (+1 m).
  const clearStreet = (c: Crossing, y: number): void => {
    const pg = lines.get(c.g.id)!;
    for (const i of samplesNear(c.P[0], c.P[1], c.g.widthM / 2 + 30)) {
      if (!Number.isNaN(pinned[i]!)) continue;
      let d = Infinity;
      for (let k = 1; k < pg.pts.length; k++) d = Math.min(d, distToSegment(X[i]!, Z[i]!, pg.pts[k - 1]!, pg.pts[k]!).d);
      if (d <= c.g.widthM / 2 + 1) LO[i] = Math.max(LO[i]!, y + DECK_CLEAR_M);
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
      if (!Number.isNaN(pinned[i]!)) continue;
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

  // ---- Solve: lowest profile over LO with grade and crest limits; bores pinned.
  const Y = new Float64Array(N);
  for (let i = 0; i < N; i++) Y[i] = LO[i]!;
  const grade = (i: number, j: number): number => (W[i] && W[j] ? WATER_GRADE : FREEWAY_GRADE);
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
  solve();

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
  for (let round = 0; round < 2 && ffCross.length; round++) {
    let changed = false;
    for (const c of ffCross) {
      const yf = yAtEdge(c.f, c.sf), yg = yAtEdge(c.g, c.sg);
      const [top, low, yl] = yf >= yg ? [c.f, c.g, yg] : [c.g, c.f, yf];
      upper.add(top.id);
      const pl = lines.get(low.id)!;
      for (const i of samplesNear(c.P[0], c.P[1], low.widthM / 2 + 30)) {
        if (!Number.isNaN(pinned[i]!) || !edgeSamples.get(top.id)!.idx.includes(i)) continue;
        let d = Infinity;
        for (let k = 1; k < pl.pts.length; k++) d = Math.min(d, distToSegment(X[i]!, Z[i]!, pl.pts[k - 1]!, pl.pts[k]!).d);
        if (d <= low.widthM / 2 + 1 && LO[i]! < yl + DECK_CLEAR_M - 1e-6) {
          LO[i] = yl + DECK_CLEAR_M;
          Y[i] = Math.max(Y[i]!, LO[i]!);
          changed = true;
        }
      }
    }
    stats.stacked = upper.size;
    if (!changed) break;
    solve();
  }
  check("stacked");

  // Ramp ends come down to their street: an upper cone (8%) from each anchor.
  {
    const anchors: number[] = [];
    for (const [nid, i] of nodeSample) {
      const surfaceUse = graph.edges.some((e) => !isFreeway(e) && (e.a === nid || e.b === nid));
      if (surfaceUse && Y[i]! > H[i]! + 0.05) anchors.push(i);
    }
    if (anchors.length) {
      const RAMP_GRADE = 0.08;
      const cap = new Float64Array(N).fill(Infinity);
      // Dijkstra on cap (a min-propagation): cap(j) = min(cap(i) + grade d).
      const neg = new Float64Array(N);
      const heap = new Heap(neg);
      for (const i of anchors.sort((a, b) => a - b)) {
        cap[i] = H[i]!;
        neg[i] = -cap[i]!;
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
          const c = cap[i]! + RAMP_GRADE * di[k]!;
          if (c < cap[j]! - 1e-9 && c < Y[j]!) {
            cap[j] = c;
            neg[j] = -c;
            heap.push(j);
          }
        }
      }
      for (let i = 0; i < N; i++) {
        if (cap[i]! < Y[i]! && Number.isNaN(pinned[i]!)) {
          Y[i] = Math.max(cap[i]!, H[i]!);
          stats.anchorShortfallM = Math.max(stats.anchorShortfallM, LO[i]! - Y[i]!);
        }
      }
      stats.anchorsLowered = anchors.length;
    }
  }
  stats.anchorShortfallM = r2(Math.max(0, stats.anchorShortfallM));
  check("anchors");
  for (let i = 0; i < N; i++) if (!Number.isFinite(H[i]!)) throw new Error(`decks: ground at ${X[i]},${Z[i]} is ${H[i]}`);

  // ---- Freeway decks.
  const decks: Array<{ tile: string; deck: Deck }> = [];
  const profiles = new Map<string, (s: number) => number | null>();
  for (const e of fwy) {
    const es = edgeSamples.get(e.id)!;
    // Open water longer than MAX_WATER_SPAN_M is a bridge the world does not model (the Bay
    // Bridge, the Golden Gate Bridge: Assets): no deck there, and no ribbon.
    const open = new Uint8Array(es.idx.length);
    for (let k = 0; k < es.idx.length; k++) {
      if (W[es.idx[k]!] !== 1) continue;
      let k1 = k;
      while (k1 + 1 < es.idx.length && W[es.idx[k1 + 1]!] === 1) k1++;
      if (es.s[k1]! - es.s[k]! > MAX_WATER_SPAN_M) for (let q = k; q <= k1; q++) open[q] = 1;
      k = k1;
    }
    const lifted = es.idx.map((i, k) => !open[k] && (W[i] === 1 || Y[i]! - H[i]! > DECK_MIN_LIFT_M) && Number.isNaN(pinned[i]!));
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
    merged.forEach(([k0, k1], n) => {
      const path: RibbonVertex[] = [];
      for (let k = k0; k <= k1; k++) {
        const i = es.idx[k]!;
        path.push(cmVertex([X[i]!, Math.max(Y[i]!, H[i]!), Z[i]!, e.widthM]));
        stats.maxLiftM = Math.max(stats.maxLiftM, Y[i]! - H[i]!);
      }
      stats.deckSamples += k1 - k0 + 1;
      const id = merged.length === 1 ? e.id : `${e.id}.${n}`;
      for (const piece of splitPieces({ id, path: thinRibbon(path) })) {
        decks.push({ tile: piece.tile, deck: { id: piece.id, kind: e.kind === "ramp" ? "ramp" : "freeway", edge: e.id, layer: upper.has(e.id) ? 2 : 1, path: piece.path } });
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
    const out: RibbonVertex[] = [];
    for (let k = 0; k <= n; k++) {
      const s = s0 + ((s1 - s0) * k) / n;
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
  // under it, or to the top of the embankment it humps over.
  {
    const byTop = new Map<string, Over[]>();
    for (const o of overs) (byTop.get(o.top.id) ?? byTop.set(o.top.id, []).get(o.top.id)!).push(o);
    for (const [id, os] of [...byTop].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const e = os[0]!.top;
      const L = lines.get(id)!.length;
      const wins = os
        .map((o) => {
          const under = o.under;
          const sU = under === o.c.f ? o.c.sf : o.c.sg;
          const yU = isFreeway(under) && edgeSamples.has(under.id) ? (inBore(under.id, sU) ?? yAtEdge(under, sU)) : heightAt(o.c.P[0], o.c.P[1]);
          const target = Math.max(yU + DECK_CLEAR_M, o.hump ? groundOn(e, o.s) : -Infinity);
          return { s: o.s, a: Math.max(0, o.s - o.half), b: Math.min(L, o.s + o.half), target, under: under.id };
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
      spans.forEach((sp, n) => {
        const ya = groundOn(e, sp.a), yb = groundOn(e, sp.b);
        const chord = (s: number): number => ya + ((yb - ya) * (s - sp.a)) / (sp.b - sp.a || 1);
        const bumps = sp.w.map((w) => ({ ...w, h: Math.max(0, w.target - chord(w.s)) }));
        const y = (s: number): number => {
          let up = 0;
          for (const w of bumps) {
            if (s <= w.a || s >= w.b) continue;
            const u = s < w.s ? (s - w.a) / (w.s - w.a || 1) : (w.b - s) / (w.b - w.s || 1);
            up = Math.max(up, (w.h * (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, u))))) / 2);
          }
          return Math.max(chord(s) + up, groundOn(e, s));
        };
        const path = ribbonOf(e, sp.a, sp.b, y);
        const did = spans.length === 1 ? `${id}.o` : `${id}.o${n}`;
        for (const piece of splitPieces({ id: did, path })) decks.push({ tile: piece.tile, deck: { id: piece.id, kind: "overpass", edge: id, layer: 1, path: piece.path } });
        addProfile(id, { s0: sp.a, s1: sp.b, y });
        e.deck = true;
        stats.overpasses.push(did);
        for (const w of bumps) {
          const short = w.target - y(w.s);
          if (short > 0.01) {
            stats.overpassShortfalls++;
            stats.overpassShortfallM = Math.max(stats.overpassShortfallM, r2(short));
          }
        }
      });
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
  return { decks, tunnels, movable, surface, stats };
}
