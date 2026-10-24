// Junction paint for the road graph: an asphalt patch over each intersection box, crosswalks
// laid square across each leg, and stop bars across the controlled approaches.
//
// Why a patch: the glb road ribbons (mesh.ts) run every edge right up to its end node, and the
// road shader paints a dashed centre line along each ribbon. At a junction the ribbons of all
// legs overlap, so their dashes cross inside the box (the "sideways X") and the square ribbon
// ends leave notched corners. The patch is one polygon over the whole box: each leg's kerbs
// out to its mouth, joined at every corner by a kerb return of radius CORNER_RADIUS_M. It
// covers every overlap, so no leg's paint shows inside it.
//
// Each leg is measured along its own centreline from the node. Its exit is where its
// carriageway leaves every other leg's ribbon (sampled on the real polylines, so divided
// boulevards whose carriageways jog out of a median node, like Van Ness Ave, work too). Near
// the junction the leg is then modelled as a straight strip along the centreline's tangent at
// its paint ("the leg line"): crosswalks and stop bars are laid square to that line, and the
// patch's kerbs and kerb returns follow it.
//
// Crosswalks (SF practice, SFMTA): the band starts CROSSWALK_SETBACK_M beyond the exit and is
// CROSSWALK_DEPTH_M deep. "continental" = bars 0.6 m wide, 1.2 m apart, running with the
// traffic; "standard" = two transverse lines 0.3 m wide. Which style:
//   - the node is in DataSF Continental Crosswalks (g9zy-srvv): continental on every leg
//     (the dataset is per intersection: "at least one continental crosswalk");
//   - else a signal (ybh5-27n2) controls the node, or a stop sign (4542-gpa3) controls the
//     leg's approach: standard;
//   - else unmarked (most uncontrolled residential corners in SF have no paint).
// A stop bar (limit line) crosses the approach lanes STOP_BAR_GAP_M behind the crosswalk on
// every approach a signal or a stop sign controls. Pure and deterministic.

import { bearing, type P2 } from "./geom.ts";
import type { RoadEdge, RoadGraph } from "./roads.ts";

export const CORNER_RADIUS_M = 3.5;
export const CROSSWALK_DEPTH_M = 3.0;
/** Gap between the exit from the cross street's carriageway and the crosswalk's inner edge. */
export const CROSSWALK_SETBACK_M = 0.6;
export const STOP_BAR_GAP_M = 1.2;
export const STOP_BAR_M = 0.45;
/** Paint keeps this far off the kerb (the gutter). */
export const GUTTER_M = 0.4;
/** Markings never reach further along a leg than this share of its length. */
const MAX_LEG_SHARE = 0.45;
/** Longest kerb-return tangent (acute corners). */
const MAX_TANGENT_M = 9;
/** Corners wider than this are straight (no kerb return), degrees. */
const FLAT_CORNER_DEG = 165;
/** Legs closer than this (degrees) are one carriageway splitting: no kerb return between them. */
const MERGED_CORNER_DEG = 20;
/** A node this far above or below the ground under it is a deck or a cut: no junction paint. */
const MAX_DECK_M = 1.5;
/** Other legs' ribbons are tested this far from the node. */
const RIBBON_REACH_M = 80;
const EXIT_STEP_M = 0.25;
/** Another leg within this many degrees runs beside this one (a divided street's other half). */
const BESIDE_DEG = 15;
const BESIDE_COS = Math.cos((BESIDE_DEG * Math.PI) / 180);
const ARC_STEPS = 4;

export type CrosswalkStyle = "continental" | "standard";

export interface MarkingFacts {
  /** Nodes listed in Continental Crosswalks. */
  continental: ReadonlySet<string>;
  /** Nodes a traffic signal controls. */
  signals: ReadonlySet<string>;
  /** `${node}|${edge}`: the approach to the node along that edge is stop-controlled. */
  stopApproaches: ReadonlySet<string>;
}

export interface JunctionLeg {
  /** Road-graph edge id. */
  edge: string;
  /**
   * The leg line: the point at distance t along the leg (from the node) is node + o + t u,
   * with u = (ux, uz) the unit direction away from the node. o = 0 for a straight leg.
   */
  ux: number;
  uz: number;
  ox: number;
  oz: number;
  /** Half the carriageway width. */
  half: number;
  /** How far along the leg the junction patch reaches. */
  mouth: number;
  /** The crosswalk band [inner, outer] distance along the leg, and its style; null = unmarked. */
  crosswalk: { style: CrosswalkStyle; from: number; to: number } | null;
  /**
   * The stop bar: distance along the leg of its node-side edge, and its lateral extent
   * [v0, v1] across the leg (v = offset along (-uz, ux), the leg's clockwise side).
   */
  stop: { at: number; v0: number; v1: number } | null;
}

export interface Junction {
  /** The road node id; stable across rebuilds (it is the street-network CNN). */
  id: string;
  x: number;
  z: number;
  /** The kind of the junction's most important leg (the patch takes that road's colour). */
  kind: RoadEdge["kind"];
  /** Patch outline, clockwise on the map (compass order), world x/z. */
  ring: P2[];
  /** Legs in clockwise compass order. */
  legs: JunctionLeg[];
}

export interface MarkingStats {
  junctions: number;
  crosswalks: { continental: number; standard: number };
  stopBars: number;
  skipped: { deck: number; freeway: number };
}

interface Leg {
  key: string;
  edge: RoadEdge;
  /** Centreline from the node outward. */
  pts: P2[];
  length: number;
  half: number;
  /** Whether traffic on this leg flows toward / away from the node. */
  inbound: boolean;
  outbound: boolean;
  /** Initial compass bearing (sorting, stop-sign matching). */
  angle: number;
}

/** A leg's line near the junction: node + o + t u. */
interface Line {
  ox: number;
  oz: number;
  ux: number;
  uz: number;
  half: number;
  angle: number;
}

function polylineLength(pts: readonly P2[]): number {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) acc += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
  return acc;
}

/** Point and unit tangent `d` metres along a polyline (clamped to its ends). */
function frameAt(pts: readonly P2[], d: number): { x: number; z: number; tx: number; tz: number } {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l <= 1e-9) continue;
    if (acc + l >= d || i === pts.length - 1) {
      const t = Math.max(0, Math.min(1, (d - acc) / l));
      return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, tx: (b[0] - a[0]) / l, tz: (b[1] - a[1]) / l };
    }
    acc += l;
  }
  const p = pts[0]!;
  return { x: p[0], z: p[1], tx: 1, tz: 0 };
}

/** The first `reach` metres of a polyline. */
function head(pts: readonly P2[], reach: number): P2[] {
  const out: P2[] = [pts[0]!];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (acc + l >= reach) {
      const t = (reach - acc) / l;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      return out;
    }
    out.push(b);
    acc += l;
  }
  return out;
}

/**
 * The unit direction of the piece of a ribbon (half-width `half` along `pts`, pts[0] at the
 * node) that (x, z) is inside, or null: drawn as the glb draws it, square-ended at the node and
 * mitred at bends.
 */
export function ribbonHit(x: number, z: number, pts: readonly P2[], half: number): [number, number] | null {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    const ex = b[0] - a[0], ez = b[1] - a[1];
    const l2 = ex * ex + ez * ez;
    if (l2 <= 1e-12) continue;
    const l = Math.sqrt(l2);
    const t = ((x - a[0]) * ex + (z - a[1]) * ez) / l2;
    if (t < (i === 1 ? 0 : -1e-9) || t > 1 + 1e-9) {
      // Inside the bend between this segment and the previous one.
      if (i > 1 && Math.hypot(x - a[0], z - a[1]) < half) return [ex / l, ez / l];
      continue;
    }
    if (Math.abs((x - a[0]) * ez - (z - a[1]) * ex) / l < half) return [ex / l, ez / l];
  }
  return null;
}

/** Whether (x, z) is inside the ribbon of half-width `half` along `pts` (see ribbonHit). */
export function insideRibbon(x: number, z: number, pts: readonly P2[], half: number): boolean {
  return ribbonHit(x, z, pts, half) !== null;
}

function legsAt(nodeId: string, nx: number, nz: number, edges: readonly RoadEdge[]): Leg[] {
  const legs: Leg[] = [];
  for (const e of edges) {
    for (const end of ["a", "b"] as const) {
      if (e[end] !== nodeId) continue;
      const raw = end === "a" ? e.points : [...e.points].reverse();
      // Start exactly at the node (a node sits at the mean of its segments' endpoints).
      const pts: P2[] = [[nx, nz], ...raw.slice(1).map((p) => [p[0], p[1]] as P2)];
      const length = polylineLength(pts);
      if (length < 1) continue;
      const f = frameAt(pts, Math.min(8, length));
      const dx = f.x - nx, dz = f.z - nz;
      if (Math.hypot(dx, dz) < 0.5) continue;
      legs.push({
        key: `${e.id}:${end}`, edge: e, pts, length, half: e.widthM / 2,
        inbound: end === "b" || !e.oneway, outbound: end === "a" || !e.oneway, angle: bearing(dx, dz),
      });
    }
  }
  legs.sort((p, q) => p.angle - q.angle || (p.key < q.key ? -1 : 1));
  return legs;
}

/**
 * How far along leg i its carriageway overlaps any other leg's ribbon: the last cross-section
 * (sampled every EXIT_STEP_M, across the full width) that touches another ribbon.
 */
function exitOf(i: Leg, others: readonly Leg[], reach: number): number {
  const ribbons = others.map((o) => ({ pts: head(o.pts, RIBBON_REACH_M), half: o.half }));
  // Across the width: the kerbs, the paint's edges (GUTTER_M in) and every metre between.
  const vs = [-i.half, -i.half + GUTTER_M, i.half - GUTTER_M, i.half];
  for (let v = Math.ceil(-i.half + GUTTER_M); v < i.half - GUTTER_M; v++) vs.push(v);
  let exit = 0;
  for (let s = 0; s <= reach; s += EXIT_STEP_M) {
    const f = frameAt(i.pts, s);
    const rx = -f.tz, rz = f.tx;
    const hit = vs.some((v) =>
      ribbons.some((r) => {
        const d = ribbonHit(f.x + rx * v, f.z + rz * v, r.pts, r.half - 0.05);
        // A carriageway running alongside (the other half of a divided street) is not a cross
        // street: its overlap never ends, so it does not count.
        return d !== null && Math.abs(d[0] * f.tx + d[1] * f.tz) < BESIDE_COS;
      }),
    );
    if (hit) exit = s + EXIT_STEP_M;
    else if (s > exit + 12) break;
  }
  return Math.min(exit, reach);
}

/** The leg line through the centreline point `d` along the leg, along its tangent there. */
function lineAt(n: { x: number; z: number }, l: Leg, d: number): Line {
  const f = frameAt(l.pts, d);
  return { ox: f.x - f.tx * d - n.x, oz: f.z - f.tz * d - n.z, ux: f.tx, uz: f.tz, half: l.half, angle: bearing(f.tx, f.tz) };
}

const pointOn = (n: { x: number; z: number }, l: Line, t: number, v: number): P2 => [n.x + l.ox + l.ux * t - l.uz * v, n.z + l.oz + l.uz * t + l.ux * v];

/** Clockwise angle from line i to line j, degrees in (0, 360]. */
function gapDeg(i: Line, j: Line): number {
  let g = ((j.angle - i.angle) * 180) / Math.PI;
  while (g <= 0) g += 360;
  return g;
}

interface Corner {
  /** Parameters along line i (its clockwise kerb) and line j (its anticlockwise kerb) where the kerbs cross. */
  ti: number;
  sj: number;
  /** Tangent length of the kerb return. */
  tangent: number;
  flat: boolean;
  merged: boolean;
}

/** The corner between line i and the next line j clockwise: i's kerb v = +half meets j's kerb v = -half. */
function corner(i: Line, j: Line): Corner {
  const g = gapDeg(i, j);
  if (g < MERGED_CORNER_DEG) return { ti: 0, sj: 0, tangent: 0, flat: false, merged: true };
  if (g > FLAT_CORNER_DEG) return { ti: 0, sj: 0, tangent: 0, flat: true, merged: false };
  // o_i + half_i r_i + t u_i = o_j - half_j r_j + s u_j, r = (-uz, ux).
  const cx = j.ox - j.half * -j.uz - (i.ox + i.half * -i.uz);
  const cz = j.oz - j.half * j.ux - (i.oz + i.half * i.ux);
  const det = i.ux * -j.uz - i.uz * -j.ux;
  const t = (cx * -j.uz - cz * -j.ux) / det;
  const s = (i.ux * cz - i.uz * cx) / det;
  const tangent = Math.min(MAX_TANGENT_M, CORNER_RADIUS_M / Math.tan((g * Math.PI) / 360));
  return { ti: t, sj: s, tangent, flat: false, merged: false };
}

/** The kerb return round corner c from line i at t = a to line j at s = b (a quadratic Bézier). */
function returnArc(n: { x: number; z: number }, i: Line, j: Line, c: Corner, a: number, b: number): P2[] {
  const p0 = pointOn(n, i, a, i.half);
  const p1 = pointOn(n, j, b, -j.half);
  const ctl = pointOn(n, i, c.ti, i.half);
  const out: P2[] = [];
  for (let k = 0; k <= ARC_STEPS; k++) {
    const t = k / ARC_STEPS;
    const w0 = (1 - t) * (1 - t), w1 = 2 * (1 - t) * t, w2 = t * t;
    out.push([w0 * p0[0] + w1 * ctl[0] + w2 * p1[0], w0 * p0[1] + w1 * ctl[1] + w2 * p1[1]]);
  }
  return out;
}

const r2 = (v: number): number => Math.round(v * 100) / 100;
const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;

const KIND_RANK: Record<RoadEdge["kind"], number> = { freeway: 0, ramp: 1, arterial: 2, collector: 3, residential: 4, other: 5, alley: 6 };

/** One junction's paint and patch. */
function junctionAt(n: { id: string; x: number; z: number }, legs: readonly Leg[], facts: MarkingFacts): { legs: JunctionLeg[]; ring: P2[] } {
  const m = legs.length;
  const reach = legs.map((l) => l.length * MAX_LEG_SHARE);
  const exits = legs.map((l, k) => exitOf(l, legs.filter((o) => o !== l), reach[k]!));

  // Paint along each leg, then the leg line through the paint.
  const paint = legs.map((l, k) => {
    const marked = l.edge.kind !== "alley";
    const controlled = facts.signals.has(n.id) || facts.stopApproaches.has(`${n.id}|${l.edge.id}`);
    const style: CrosswalkStyle | null = !marked ? null : facts.continental.has(n.id) ? "continental" : controlled ? "standard" : null;
    const others = legs.filter((o) => o !== l).map((o) => ({ pts: head(o.pts, RIBBON_REACH_M), half: o.half }));
    // Lay the paint beyond the exit; where the leg bends, the straight leg line can still clip
    // a cross street, so step it out until every painted corner is clear.
    for (let shift = 0; ; shift += 0.5) {
      const from = exits[k]! + CROSSWALK_SETBACK_M + shift;
      const to = from + CROSSWALK_DEPTH_M;
      const crosswalk = style && to <= reach[k]! ? { style, from: r2(from), to: r2(to) } : null;
      let stop: JunctionLeg["stop"] = null;
      if (marked && controlled && l.inbound) {
        const at = (crosswalk ? to : from) + STOP_BAR_GAP_M;
        // Approach lanes are on the leg's anticlockwise side (v < 0) of a two-way street.
        const v0 = -l.half + GUTTER_M;
        const v1 = l.outbound ? -0.15 : l.half - GUTTER_M;
        if (at + STOP_BAR_M <= reach[k]! && v1 > v0) stop = { at: r2(at), v0: r2(v0), v1: r2(v1) };
      }
      const end = stop ? stop.at + STOP_BAR_M : crosswalk ? crosswalk.to : exits[k]!;
      const line = lineAt(n, l, Math.min(l.length, crosswalk ? (from + to) / 2 : (exits[k]! + end) / 2 + 1));
      const rects: Array<[number, number, number, number]> = [];
      if (crosswalk) rects.push([crosswalk.from, crosswalk.to, -l.half + GUTTER_M, l.half - GUTTER_M]);
      if (stop) rects.push([stop.at, stop.at + STOP_BAR_M, stop.v0, stop.v1]);
      const clear = rects.every(([t0, t1, v0, v1]) =>
        [[t0, v0], [t0, v1], [t1, v0], [t1, v1], [(t0 + t1) / 2, (v0 + v1) / 2]].every(([t, v]) => {
          const p = pointOn(n, line, t!, v!);
          return others.every((o) => {
            const d = ribbonHit(p[0], p[1], o.pts, o.half - 0.05);
            return d === null || Math.abs(d[0] * line.ux + d[1] * line.uz) >= BESIDE_COS;
          });
        }),
      );
      if (clear || (!crosswalk && !stop)) return { crosswalk, stop, end, line };
    }
  });

  const corners = paint.map((p, k) => corner(p.line, paint[(k + 1) % m]!.line));
  const mouths = paint.map((p, k) => {
    const cw = corners[k]!, acw = corners[(k + m - 1) % m]!;
    const returns = Math.max(cw.flat || cw.merged ? 0 : cw.ti + cw.tangent, acw.flat || acw.merged ? 0 : acw.sj + acw.tangent);
    return Math.min(reach[k]!, Math.max(returns, p.end, exits[k]!));
  });

  // Outline: for each leg, across its mouth (anticlockwise kerb to clockwise kerb), back along
  // its clockwise kerb to the kerb return, round the return, out along the next leg.
  const ring: P2[] = [];
  for (let k = 0; k < m; k++) {
    const li = paint[k]!.line, lj = paint[(k + 1) % m]!.line;
    const mi = mouths[k]!, mj = mouths[(k + 1) % m]!;
    ring.push(pointOn(n, li, mi, -li.half), pointOn(n, li, mi, li.half));
    const c = corners[k]!;
    if (c.merged) continue;
    if (c.flat) {
      ring.push(pointOn(n, li, Math.min(mi, 0), li.half), pointOn(n, lj, Math.min(mj, 0), -lj.half));
      continue;
    }
    const a = Math.max(c.ti, Math.min(mi, c.ti + c.tangent));
    const b = Math.max(c.sj, Math.min(mj, c.sj + c.tangent));
    ring.push(...returnArc(n, li, lj, c, a, b));
  }
  const out = paint.map((p, k): JunctionLeg => ({
    edge: legs[k]!.edge.id,
    ux: r4(p.line.ux), uz: r4(p.line.uz), ox: r2(p.line.ox), oz: r2(p.line.oz),
    half: r2(legs[k]!.half), mouth: r2(mouths[k]!), crosswalk: p.crosswalk, stop: p.stop,
  }));
  return { legs: out, ring };
}

/**
 * Junction paint for every road node where three or more drivable legs meet at grade.
 * `groundAt` gives the terrain height (to skip decks); nodes are taken in id order.
 */
export function buildMarkings(graph: RoadGraph, facts: MarkingFacts, groundAt: (x: number, z: number) => number): { junctions: Junction[]; stats: MarkingStats } {
  const byNode = edgesByNode(graph);
  const stats: MarkingStats = { junctions: 0, crosswalks: { continental: 0, standard: 0 }, stopBars: 0, skipped: { deck: 0, freeway: 0 } };
  const junctions: Junction[] = [];
  const nodes = [...graph.nodes].sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  for (const n of nodes) {
    const edges = byNode.get(n.id);
    if (!edges) continue;
    const legs = legsAt(n.id, n.x, n.z, edges);
    if (legs.length < 3) continue;
    if (legs.some((l) => l.edge.kind === "freeway" || l.edge.kind === "ramp" || l.edge.gradeSeparated || l.edge.bridge)) {
      stats.skipped.freeway++;
      continue;
    }
    if (Math.abs(n.y - groundAt(n.x, n.z)) > MAX_DECK_M) {
      stats.skipped.deck++;
      continue;
    }
    const j = junctionAt(n, legs, facts);
    for (const l of j.legs) {
      if (l.crosswalk) stats.crosswalks[l.crosswalk.style]++;
      if (l.stop) stats.stopBars++;
    }
    const kind = [...legs].sort((p, q) => KIND_RANK[p.edge.kind] - KIND_RANK[q.edge.kind])[0]!.edge.kind;
    const ring: P2[] = [];
    for (const p of j.ring) {
      const q: P2 = [r2(p[0]), r2(p[1])];
      const last = ring[ring.length - 1];
      if (!last || Math.hypot(q[0] - last[0], q[1] - last[1]) > 0.05) ring.push(q);
    }
    if (ring.length > 2 && Math.hypot(ring[0]![0] - ring[ring.length - 1]![0], ring[0]![1] - ring[ring.length - 1]![1]) <= 0.05) ring.pop();
    junctions.push({ id: n.id, x: n.x, z: n.z, kind, ring, legs: j.legs });
    stats.junctions++;
  }
  return { junctions, stats };
}

function edgesByNode(graph: RoadGraph): Map<string, RoadEdge[]> {
  const byNode = new Map<string, RoadEdge[]>();
  for (const e of graph.edges) {
    if (e.pedestrian) continue;
    for (const id of e.a === e.b ? [e.a] : [e.a, e.b]) {
      let l = byNode.get(id);
      if (!l) byNode.set(id, (l = []));
      l.push(e);
    }
  }
  return byNode;
}

/** Stop-controlled approaches from DataSF Stop Signs rows: `${node}|${edge}`. */
export function stopApproaches(
  rows: ReadonlyArray<{ cnn?: string; street?: string; st_facing?: string }>,
  graph: RoadGraph,
): { approaches: Set<string>; matched: number; unmatched: number } {
  const facing: Record<string, number> = { NB: 0, EB: 90, SB: 180, WB: 270 };
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const byNode = edgesByNode(graph);
  const approaches = new Set<string>();
  let matched = 0, unmatched = 0;
  for (const r of rows) {
    const dir = facing[(r.st_facing ?? "").toUpperCase()];
    const id = r.cnn ? `n${Math.round(Number(r.cnn))}` : "";
    const n = nodes.get(id);
    const edges = byNode.get(id);
    if (dir === undefined || !n || !edges) {
      unmatched++;
      continue;
    }
    const street = (r.street ?? "").trim().toUpperCase();
    let best: { key: string; score: number } | null = null;
    for (const l of legsAt(id, n.x, n.z, edges)) {
      if (!l.inbound) continue;
      // Traffic on this leg travels toward the node: heading = leg bearing + 180°.
      const travel = ((l.angle * 180) / Math.PI + 180) % 360;
      let off = Math.abs(travel - dir) % 360;
      if (off > 180) off = 360 - off;
      if (off > 75) continue;
      const named = street !== "" && l.edge.name.toUpperCase().startsWith(street);
      const score = off - (named ? 90 : 0);
      if (!best || score < best.score) best = { key: `${id}|${l.edge.id}`, score };
    }
    if (best) {
      approaches.add(best.key);
      matched++;
    } else unmatched++;
  }
  return { approaches, matched, unmatched };
}
