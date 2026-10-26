// The sidewalk navigation graph (sidewalks.json, schemas/sidewalks.schema.json): where people
// and robots walk. One graph for the whole world, so it is connected across tile seams by
// construction and the sim can hold all of it.
//
// Built from the road graph, procedurally (DataSF publishes sidewalk widths, not walkable
// geometry):
//   * every road edge except freeways and ramps gets a sidewalk on each side, offset from its
//     centreline by half the road width plus SIDEWALK_OFFSET_M (on the pavement, clear of the kerb);
//   * at every road node the incident edges are sorted clockwise; between each neighbouring pair
//     is a corner node where the two sidewalks meet (the intersection of their offset lines, or
//     the midpoint of the two offset points when the lines are near-parallel or meet behind the
//     node);
//   * crossings join the two corners either side of an edge, at every node with 3 or more edges,
//     at nodes with a signal or a marked crosswalk, and across the end of a dead end;
//   * then everything is kept off the carriageway (road-surface.ts): corners on or within
//     SIDEWALK_ROAD_MARGIN_M of any road are dropped, sidewalks are cut where they come that
//     close, a cut where another road crosses the sidewalk's line is bridged by a crossing,
//     corner crossings that end at a dropped corner are carried on to the far side (both
//     carriageways of a divided road), and pieces no corner reaches are dropped.
// Ids: corner `<road node>.<k>` (k counts clockwise from north), sidewalk `<road edge>.L` /
// `<road edge>.R` (left / right of the road edge's a -> b direction) or, when cut, its pieces
// `<road edge>.<side>.<k>` with clip ends `<road edge>.<side>@<k>` and bridges
// `<road edge>.<side>.x<k>`; crossing `<road node>.x<k>`.

import { bearing, r2, type P2 } from "./geom.ts";
import { RoadSurface, trafficEdges } from "./road-surface.ts";
import type { RoadEdge, RoadGraph } from "./roads.ts";

export const SIDEWALK_OFFSET_M = 2;
/** No sidewalk point or corner lies closer than this to any road's kerb line (or inside a road). */
export const SIDEWALK_ROAD_MARGIN_M = 0.5;
/** Sidewalks are checked against the roads every this many metres (at most). */
const SAMPLE_M = 1;
/** A piece of sidewalk cut off on both ends by roads is dropped when shorter than this. */
const MIN_PIECE_M = 3;
/** Gaps up to min(MAX_BRIDGE_M, BRIDGE_PER_WIDTH x the road's width + 4 m) are bridged by a straight crossing (a road crossed at 25 degrees or more). */
const MAX_BRIDGE_M = 45;
const BRIDGE_PER_WIDTH = 2.4;
/** A crossing that ends at a dropped corner is carried on up to this far, within EXTEND_COS of its line. */
const EXTEND_MAX_M = 45;
const EXTEND_COS = Math.cos((20 * Math.PI) / 180);
/** Direction of an edge at a node: from the node to the point this far along it. */
const DIR_SAMPLE_M = 8;
/** Corners further than this many offsets from the node fall back to the midpoint rule. */
const MAX_CORNER_REACH = 3;

export interface WalkNode {
  id: string;
  x: number;
  z: number;
  y: number;
  /** The road node this corner belongs to (a clip end: the nearer end of the road edge it lies along). */
  road: string;
  /** Clip ends only: the road edge whose sidewalk stops here because the next stretch lies on another road. */
  edge?: string;
}

export interface WalkEdge {
  id: string;
  a: string;
  b: string;
  kind: "sidewalk" | "crossing";
  lengthM: number;
  /** The road edge the sidewalk runs along or the crossing crosses. */
  road: string;
  /** Sidewalks: which side of the road edge (relative to its a -> b direction). */
  side?: "L" | "R";
  /** Crossings: a traffic signal controls the node; a crosswalk is painted. */
  signal?: boolean;
  marked?: boolean;
  /** Interior polyline points (local metres) between a and b, when the walk is not straight. */
  points?: P2[];
}

export interface SidewalkGraph {
  nodes: WalkNode[];
  edges: WalkEdge[];
}

export interface SidewalkStats {
  nodes: number;
  edges: number;
  sidewalks: number;
  crossings: number;
  signalised: number;
  marked: number;
  components: number;
  largestComponentNodes: number;
  /** Corners dropped because they lie on (or within the margin of) a road. */
  cornersOnRoad: number;
  /** Sidewalks cut into pieces, and sidewalks dropped whole, because stretches lie on a road. */
  sidewalksClipped: number;
  sidewalksDropped: number;
  /** Metres of sidewalk removed. */
  clippedM: number;
  /** Straight crossings over a road that cuts a sidewalk's line. */
  bridges: number;
  /** Corner crossings carried on past a dropped corner (divided roads), and dropped with no node beyond. */
  crossingsExtended: number;
  crossingsDropped: number;
  /** Edges in pieces with no corner to reach them from (median fragments), dropped. */
  fragmentsDropped: number;
}

interface Incidence {
  edge: RoadEdge;
  end: "a" | "b";
  dx: number;
  dz: number;
  bearing: number;
  o: number;
  /** Corner index on this incidence's right (looking away from the node) and left. */
  right: number;
  left: number;
}

interface RawWalk {
  id: string;
  a: string;
  b: string;
  road: RoadEdge;
  side: "L" | "R";
  /** Full polyline from corner a to corner b. */
  pts: P2[];
}

interface ClipEnd {
  /** The original corner, when the piece reaches it. */
  corner: string | null;
  p: P2;
  /** Nearer the sidewalk's a end than its b end. */
  nearA: boolean;
}

interface ClipResult {
  whole: boolean;
  /** Pieces in order a -> b; a piece with fewer than 2 points is a corner anchor with no edge. */
  pieces: Array<{ start: ClipEnd; end: ClipEnd; pts: P2[] }>;
  /** Between consecutive pieces: the road to bridge across (null = too long, not bridged). */
  gaps: Array<{ bridge: string | null; lengthM: number }>;
  removedM: number;
}

/**
 * Cut a sidewalk where it lies on a road: sample it every SAMPLE_M (and at every vertex), keep
 * the runs of samples clear of every road by SIDEWALK_ROAD_MARGIN_M. Between two kept samples
 * at most SAMPLE_M apart the line can come at most SAMPLE_M / 2 closer to a road, so a kept
 * stretch never enters a road's surface.
 */
export function clipWalk(w: RawWalk, okA: boolean, okB: boolean, surface: RoadSurface): ClipResult {
  const xs: number[] = [], zs: number[] = [], ss: number[] = [], vi: number[] = [];
  let s = 0;
  for (let i = 1; i < w.pts.length; i++) {
    const p = w.pts[i - 1]!, q = w.pts[i]!;
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const n = Math.max(1, Math.ceil(len / SAMPLE_M));
    for (let j = 0; j < n; j++) {
      const t = j / n;
      xs.push(p[0] + (q[0] - p[0]) * t);
      zs.push(p[1] + (q[1] - p[1]) * t);
      ss.push(s + len * t);
      vi.push(j === 0 ? i - 1 : -1);
    }
    s += len;
  }
  const last = w.pts.length - 1;
  xs.push(w.pts[last]![0]);
  zs.push(w.pts[last]![1]);
  ss.push(s);
  vi.push(last);
  const N = xs.length;
  const total = s;
  const good: boolean[] = [];
  for (let j = 0; j < N; j++) good.push(j === 0 ? okA : j === N - 1 ? okB : surface.clearance(xs[j]!, zs[j]!) >= SIDEWALK_ROAD_MARGIN_M);
  if (good.every((g) => g)) return { whole: true, pieces: [], gaps: [], removedM: 0 };

  const runs: Array<[number, number]> = [];
  for (let j = 0; j < N; ) {
    if (!good[j]) {
      j++;
      continue;
    }
    let k = j;
    while (k + 1 < N && good[k + 1]) k++;
    const anchored = j === 0 || k === N - 1;
    if (anchored || ss[k]! - ss[j]! >= MIN_PIECE_M) runs.push([j, k]);
    j = k + 1;
  }
  const P = (j: number): P2 => (j === 0 ? w.pts[0]! : j === N - 1 ? w.pts[last]! : [r2(xs[j]!), r2(zs[j]!)]);
  const end = (j: number): ClipEnd => ({ corner: j === 0 ? w.a : j === N - 1 ? w.b : null, p: P(j), nearA: ss[j]! <= total / 2 });
  const pieces: ClipResult["pieces"] = [];
  let keptM = 0;
  for (const [j0, j1] of runs) {
    const len = ss[j1]! - ss[j0]!;
    if (len < 1) {
      // A corner with only a stub of clear sidewalk: no edge, but a bridge may start here.
      const c = end(j0 === 0 ? 0 : N - 1);
      pieces.push({ start: c, end: c, pts: [c.p] });
      continue;
    }
    const pts: P2[] = [P(j0)];
    for (let j = j0 + 1; j < j1; j++) if (vi[j]! >= 0) pts.push(w.pts[vi[j]!]!);
    pts.push(P(j1));
    pieces.push({ start: end(j0), end: end(j1), pts });
    keptM += len;
  }
  const gaps: ClipResult["gaps"] = [];
  for (let k = 0; k + 1 < runs.length; k++) {
    const j0 = runs[k]![1], j1 = runs[k + 1]![0];
    let deepest: RoadEdge | null = null;
    let deepC = Infinity;
    let widest = 0;
    for (let j = j0 + 1; j < j1; j++) {
      const n = surface.nearest(xs[j]!, zs[j]!);
      if (n.edge && n.clearance < SIDEWALK_ROAD_MARGIN_M) widest = Math.max(widest, n.edge.widthM);
      if (n.edge && n.clearance < deepC) {
        deepC = n.clearance;
        deepest = n.edge;
      }
    }
    const a = pieces[k]!.end.p, b = pieces[k + 1]!.start.p;
    const lengthM = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const gapM = ss[j1]! - ss[j0]!;
    // Only a road the sidewalk's line crosses (its two ends on opposite sides) is bridged; a
    // sidewalk that dips into a road running alongside and comes back stays cut.
    const ok = deepest !== null && gapM <= Math.min(MAX_BRIDGE_M, BRIDGE_PER_WIDTH * widest + 4) && sideOf(deepest, a) * sideOf(deepest, b) < 0;
    gaps.push({ bridge: ok ? deepest!.id : null, lengthM });
  }
  return { whole: false, pieces, gaps, removedM: total - keptM };
}

/** Which side of the road's centreline the point is on (+1 right of a -> b, -1 left), at the nearest segment. */
function sideOf(e: RoadEdge, p: P2): number {
  let best = Infinity;
  let side = 0;
  for (let i = 1; i < e.points.length; i++) {
    const a = e.points[i - 1]!, b = e.points[i]!;
    const ex = b[0] - a[0], ez = b[1] - a[1];
    const l2 = ex * ex + ez * ez;
    let t = l2 > 0 ? ((p[0] - a[0]) * ex + (p[1] - a[1]) * ez) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(p[0] - a[0] - ex * t, p[1] - a[1] - ez * t);
    if (d < best) {
      best = d;
      side = (p[0] - a[0]) * -ez + (p[1] - a[1]) * ex >= 0 ? 1 : -1;
    }
  }
  return side;
}

export const isWalkable = (e: RoadEdge): boolean => e.kind !== "freeway" && e.kind !== "ramp";

function length(pts: readonly P2[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
  return s;
}

/** Unit direction from the node end of the edge to the point DIR_SAMPLE_M along it. */
function directionAt(e: RoadEdge, end: "a" | "b"): [number, number] {
  const pts = end === "a" ? e.points : [...e.points].reverse();
  const p0 = pts[0]!;
  let target = pts[pts.length - 1]!;
  let s = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
    if (s + seg >= DIR_SAMPLE_M) {
      const t = (DIR_SAMPLE_M - s) / seg;
      target = [pts[i - 1]![0] + (pts[i]![0] - pts[i - 1]![0]) * t, pts[i - 1]![1] + (pts[i]![1] - pts[i - 1]![1]) * t];
      break;
    }
    s += seg;
  }
  let dx = target[0] - p0[0];
  let dz = target[1] - p0[1];
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return [1, 0];
  dx /= len;
  dz /= len;
  return [dx, dz];
}

/** Right of travel on a north-up map (+x east, +z south) is (-dz, dx). */
const rightOf = (dx: number, dz: number): [number, number] => [-dz, dx];

/** Unit direction from p to q ([1, 0] when they coincide). */
function unit(p: P2, q: P2): [number, number] {
  const dx = q[0] - p[0], dz = q[1] - p[1];
  const len = Math.hypot(dx, dz);
  return len < 1e-9 ? [1, 0] : [dx / len, dz / len];
}

/**
 * Offset polyline: each point moved `o` to the right (o > 0) or left (o < 0) of travel. On the
 * inside of a bend the point is mitred (moved to where the two offset segments meet, up to
 * 3 |o| out), so the offset never comes closer than |o| to the centreline there.
 */
function offsetPolyline(pts: readonly P2[], o: number): P2[] {
  const out: P2[] = [];
  const sgn = o < 0 ? -1 : 1;
  const ao = Math.abs(o);
  for (let i = 0; i < pts.length; i++) {
    const d1 = unit(pts[Math.max(0, i - 1)]!, pts[i === 0 ? 1 : i]!);
    const d2 = unit(pts[i === pts.length - 1 ? i - 1 : i]!, pts[Math.min(pts.length - 1, i + 1)]!);
    const n1 = rightOf(d1[0], d1[1]).map((v) => v * sgn) as [number, number];
    const n2 = rightOf(d2[0], d2[1]).map((v) => v * sgn) as [number, number];
    let nx = n1[0] + n2[0], nz = n1[1] + n2[1];
    const nl = Math.hypot(nx, nz);
    if (nl < 1e-9) {
      nx = n1[0];
      nz = n1[1];
    } else {
      nx /= nl;
      nz /= nl;
    }
    // Inside of the bend: the next segment turns toward this side.
    const inside = i > 0 && i < pts.length - 1 && d2[0] * n1[0] + d2[1] * n1[1] > 1e-9;
    const cosHalf = nx * n1[0] + nz * n1[1];
    const m = inside ? ao / Math.max(cosHalf, 1 / 3) : ao;
    out.push([pts[i]![0] + nx * m, pts[i]![1] + nz * m]);
  }
  return out;
}

export function buildSidewalks(
  graph: RoadGraph,
  heightAt: (x: number, z: number) => number,
  signalNodes: ReadonlySet<string>,
  crosswalkNodes: ReadonlySet<string>,
): { graph: SidewalkGraph; stats: SidewalkStats } {
  const nodePos = new Map(graph.nodes.map((n) => [n.id, n]));
  const edges = graph.edges.filter(isWalkable);
  const incidences = new Map<string, Incidence[]>();
  const add = (node: string, inc: Incidence): void => {
    let l = incidences.get(node);
    if (!l) incidences.set(node, (l = []));
    l.push(inc);
  };
  for (const e of edges) {
    for (const end of ["a", "b"] as const) {
      const [dx, dz] = directionAt(e, end);
      add(end === "a" ? e.a : e.b, { edge: e, end, dx, dz, bearing: bearing(dx, dz), o: e.widthM / 2 + SIDEWALK_OFFSET_M, right: -1, left: -1 });
    }
  }

  let walkNodes: WalkNode[] = [];
  const walkEdges: WalkEdge[] = [];
  const rawCrossings: WalkEdge[] = [];
  /** Where each corner crossing sits: its road node, the incidence it crosses, the node's corner count. */
  const crossAt = new Map<WalkEdge, { node: string; k: number; n: number }>();
  const cornerId = (node: string, k: number): string => `${node}.${k}`;
  const cornerXZ = new Map<string, P2>();
  const addCorner = (node: string, k: number, x: number, z: number): void => {
    const id = cornerId(node, k);
    const p: P2 = [r2(x), r2(z)];
    cornerXZ.set(id, p);
    walkNodes.push({ id, x: p[0], z: p[1], y: r2(heightAt(p[0], p[1])), road: node });
  };

  for (const node of [...incidences.keys()].sort()) {
    const incs = incidences.get(node)!;
    incs.sort((p, q) => p.bearing - q.bearing || (p.edge.id < q.edge.id ? -1 : p.edge.id > q.edge.id ? 1 : p.end < q.end ? -1 : 1));
    const n = incs.length;
    const np = nodePos.get(node)!;
    const px = np.x;
    const pz = np.z;
    if (n === 1) {
      const i = incs[0]!;
      const [rx, rz] = rightOf(i.dx, i.dz);
      addCorner(node, 0, px + rx * i.o, pz + rz * i.o);
      addCorner(node, 1, px - rx * i.o, pz - rz * i.o);
      i.right = 0;
      i.left = 1;
    } else {
      for (let k = 0; k < n; k++) {
        const i = incs[k]!;
        const j = incs[(k + 1) % n]!;
        // Sector from i (clockwise) to j: bounded by i's right side and j's left side.
        const [rix, riz] = rightOf(i.dx, i.dz);
        const [rjx, rjz] = rightOf(j.dx, j.dz);
        const P: P2 = [px + rix * i.o, pz + riz * i.o];
        const Q: P2 = [px - rjx * j.o, pz - rjz * j.o];
        const cross = i.dx * j.dz - i.dz * j.dx;
        let c: P2 = [(P[0] + Q[0]) / 2, (P[1] + Q[1]) / 2];
        if (Math.abs(cross) > 0.17) {
          // P + t*di = Q + s*dj
          const wx = Q[0] - P[0];
          const wz = Q[1] - P[1];
          const t = (wx * j.dz - wz * j.dx) / cross;
          const s = (wx * i.dz - wz * i.dx) / cross;
          const reach = MAX_CORNER_REACH * Math.max(i.o, j.o);
          const cand: P2 = [P[0] + i.dx * t, P[1] + i.dz * t];
          if (t >= 0 && s >= 0 && Math.hypot(cand[0] - px, cand[1] - pz) <= reach) c = cand;
        }
        addCorner(node, k, c[0], c[1]);
        i.right = k;
        j.left = k;
      }
    }

    // Crossings at real intersections, signals, crosswalks and dead ends.
    const signal = signalNodes.has(node);
    const painted = crosswalkNodes.has(node) || signal;
    if (n === 1 || n >= 3 || signal || crosswalkNodes.has(node)) {
      incs.forEach((i, k) => {
        if (n === 1 && k > 0) return;
        const a = cornerId(node, i.left);
        const b = cornerId(node, i.right);
        const pa = cornerXZ.get(a)!;
        const pb = cornerXZ.get(b)!;
        const e: WalkEdge = { id: `${node}.x${k}`, a, b, kind: "crossing", lengthM: r2(Math.hypot(pb[0] - pa[0], pb[1] - pa[1])), road: i.edge.id };
        if (n > 1 && signal) e.signal = true;
        if (n > 1 && painted) e.marked = true;
        rawCrossings.push(e);
        crossAt.set(e, { node, k, n });
      });
    }
  }

  // Sidewalks along each walkable edge, as full polylines from corner to corner.
  const incOf = (node: string, e: RoadEdge, end: "a" | "b"): Incidence => incidences.get(node)!.find((i) => i.edge === e && i.end === end)!;
  const rawWalks: RawWalk[] = [];
  for (const e of edges) {
    const ia = incOf(e.a, e, "a");
    const ib = incOf(e.b, e, "b");
    const L = length(e.points);
    const cum: number[] = [0];
    for (let i = 1; i < e.points.length; i++) cum.push(cum[i - 1]! + Math.hypot(e.points[i]![0] - e.points[i - 1]![0], e.points[i]![1] - e.points[i - 1]![1]));
    const o = e.widthM / 2 + SIDEWALK_OFFSET_M;
    for (const side of ["R", "L"] as const) {
      // Right of a -> b: starts at a's corner on the right, ends at b's corner on its left.
      const a = cornerId(e.a, side === "R" ? ia.right : ia.left);
      const b = cornerId(e.b, side === "R" ? ib.left : ib.right);
      const pa = cornerXZ.get(a)!;
      const pb = cornerXZ.get(b)!;
      const na = nodePos.get(e.a)!;
      const nb = nodePos.get(e.b)!;
      const sa = Math.max(0, (pa[0] - na.x) * ia.dx + (pa[1] - na.z) * ia.dz);
      const sb = Math.max(0, (pb[0] - nb.x) * ib.dx + (pb[1] - nb.z) * ib.dz);
      const off = offsetPolyline(e.points, side === "R" ? o : -o);
      const interior: P2[] = [];
      for (let i = 1; i < e.points.length - 1; i++) {
        if (cum[i]! > sa + 1 && cum[i]! < L - sb - 1) interior.push([r2(off[i]![0]), r2(off[i]![1])]);
      }
      rawWalks.push({ id: `${e.id}.${side}`, a, b, road: e, side, pts: [pa, ...interior, pb] });
    }
  }

  // Keep everything off the carriageway: no corner, and no stretch of sidewalk, within
  // SIDEWALK_ROAD_MARGIN_M of any road's kerb line (or inside it). Divided roads are the usual
  // case: one carriageway's inner sidewalk lies on the other carriageway.
  const surface = new RoadSurface(trafficEdges(graph.edges));
  const clear = (x: number, z: number): boolean => surface.clearance(x, z) >= SIDEWALK_ROAD_MARGIN_M;
  const cornerOk = new Map<string, boolean>();
  for (const [id, p] of cornerXZ) cornerOk.set(id, clear(p[0], p[1]));
  const clipNodes: WalkNode[] = [];
  let sidewalksClipped = 0, sidewalksDropped = 0;
  const bridgeIds = new Set<string>();
  let clippedM = 0;
  for (const w of rawWalks) {
    const r = clipWalk(w, cornerOk.get(w.a)!, cornerOk.get(w.b)!, surface);
    clippedM += r.removedM;
    if (r.whole) {
      const e: WalkEdge = { id: w.id, a: w.a, b: w.b, kind: "sidewalk", lengthM: r2(length(w.pts)), road: w.road.id, side: w.side };
      if (w.pts.length > 2) e.points = w.pts.slice(1, -1);
      walkEdges.push(e);
      continue;
    }
    if (r.pieces.length === 0) sidewalksDropped++;
    else sidewalksClipped++;
    let nClip = 0;
    const nodeFor = (end: ClipEnd): string => {
      if (end.corner) return end.corner;
      const id = `${w.id}@${nClip++}`;
      clipNodes.push({ id, x: end.p[0], z: end.p[1], y: r2(heightAt(end.p[0], end.p[1])), road: end.nearA ? w.road.a : w.road.b, edge: w.road.id });
      return id;
    };
    const ends: Array<{ start: string; end: string }> = [];
    r.pieces.forEach((pc, k) => {
      const start = nodeFor(pc.start);
      const end = pc.pts.length >= 2 ? nodeFor(pc.end) : start;
      ends.push({ start, end });
      if (pc.pts.length < 2) return;
      const e: WalkEdge = { id: `${w.id}.${k}`, a: start, b: end, kind: "sidewalk", lengthM: r2(length(pc.pts)), road: w.road.id, side: w.side };
      if (pc.pts.length > 2) e.points = pc.pts.slice(1, -1);
      walkEdges.push(e);
    });
    // A short gap is another road crossing the sidewalk's line (under a freeway, a slip lane):
    // walk straight across it.
    r.gaps.forEach((g, k) => {
      if (g.bridge === null) return;
      const from = ends[k]!.end, to = ends[k + 1]!.start;
      if (from === to) return;
      walkEdges.push({ id: `${w.id}.x${k}`, a: from, b: to, kind: "crossing", lengthM: r2(g.lengthM), road: g.bridge });
      bridgeIds.add(`${w.id}.x${k}`);
    });
  }

  // Crossings that end at a corner on another road (the median side of a divided road) are
  // extended straight on to the first node beyond it, so they cross both carriageways.
  const live = new Set<string>();
  for (const e of walkEdges) {
    live.add(e.a);
    live.add(e.b);
  }
  const pos = new Map<string, P2>(cornerXZ);
  for (const n of clipNodes) pos.set(n.id, [n.x, n.z]);
  const grid = new Map<string, string[]>();
  const G = 25;
  for (const id of [...live].sort()) {
    const p = pos.get(id)!;
    const k = `${Math.floor(p[0] / G)},${Math.floor(p[1] / G)}`;
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(id);
  }
  const beyond = (from: string, via: P2): string | null => {
    const p = pos.get(from)!;
    const dx = via[0] - p[0], dz = via[1] - p[1];
    const d = Math.hypot(dx, dz);
    if (d < 1e-6) return null;
    let best: string | null = null;
    let bestD = Infinity;
    for (let cx = Math.floor((p[0] - EXTEND_MAX_M) / G); cx <= Math.floor((p[0] + EXTEND_MAX_M) / G); cx++) {
      for (let cz = Math.floor((p[1] - EXTEND_MAX_M) / G); cz <= Math.floor((p[1] + EXTEND_MAX_M) / G); cz++) {
        for (const id of grid.get(`${cx},${cz}`) ?? []) {
          if (id === from) continue;
          const q = pos.get(id)!;
          const vx = q[0] - p[0], vz = q[1] - p[1];
          const dist = Math.hypot(vx, vz);
          const proj = (vx * dx + vz * dz) / d;
          if (dist > EXTEND_MAX_M || proj <= d || proj < EXTEND_COS * dist) continue;
          if (dist < bestD - 1e-9 || (Math.abs(dist - bestD) <= 1e-9 && best !== null && id < best)) {
            best = id;
            bestD = dist;
          }
        }
      }
    }
    return best;
  };
  let crossingsExtended = 0, crossingsDropped = 0;
  const pairs = new Map<string, WalkEdge>();
  for (const c of rawCrossings) {
    const okA = cornerOk.get(c.a)!, okB = cornerOk.get(c.b)!;
    let e: WalkEdge = c;
    if (!okA || !okB) {
      let target = okA ? beyond(c.a, cornerXZ.get(c.b)!) : okB ? beyond(c.b, cornerXZ.get(c.a)!) : null;
      // Carriageways that meet at one node (the end of a median): the dropped corner is in the
      // wedge between them, so cross the next arm too, to the corner after it.
      const at = crossAt.get(c)!;
      if (target === null && (okA || okB) && at.n >= 3) {
        const next = okA ? cornerId(at.node, (at.k + 1) % at.n) : cornerId(at.node, (at.k - 2 + 2 * at.n) % at.n);
        const from = okA ? c.a : c.b;
        const p = cornerXZ.get(from)!, q = cornerXZ.get(next)!;
        if (next !== from && cornerOk.get(next) && live.has(next) && Math.hypot(q[0] - p[0], q[1] - p[1]) <= EXTEND_MAX_M) target = next;
      }
      if (target === null) {
        crossingsDropped++;
        continue;
      }
      const from = okA ? c.a : c.b;
      const p = pos.get(from)!, q = pos.get(target)!;
      e = { ...c, a: from, b: target, lengthM: r2(Math.hypot(q[0] - p[0], q[1] - p[1])) };
      crossingsExtended++;
    }
    const k = e.a < e.b ? `${e.a}|${e.b}` : `${e.b}|${e.a}`;
    const prev = pairs.get(k);
    if (prev) {
      // Both carriageways' crossings extended onto each other: one crossing.
      if (e.signal) prev.signal = true;
      if (e.marked) prev.marked = true;
      continue;
    }
    pairs.set(k, e);
  }
  for (const e of pairs.values()) walkEdges.push(e);

  // Nodes: corners off the road and clip ends that something still uses.
  const used = new Set<string>();
  for (const e of walkEdges) {
    used.add(e.a);
    used.add(e.b);
  }
  const cornersOnRoad = [...cornerOk.values()].filter((v) => !v).length;
  walkNodes = [...walkNodes.filter((n) => cornerOk.get(n.id) && used.has(n.id)), ...clipNodes.filter((n) => used.has(n.id))];

  // Pieces left in a median with no corner to reach them from are dropped.
  const pre = components(walkNodes, walkEdges);
  const reachable = new Set<string>();
  for (const n of walkNodes) if (n.edge === undefined) reachable.add(pre.find(n.id));
  const fragments = walkEdges.filter((e) => !reachable.has(pre.find(e.a))).length;
  walkNodes = walkNodes.filter((n) => reachable.has(pre.find(n.id)));
  const edgesOut = walkEdges.filter((e) => reachable.has(pre.find(e.a)));
  const sidewalks = edgesOut.filter((e) => e.kind === "sidewalk").length;
  const crossings = edgesOut.length - sidewalks;
  const signalised = edgesOut.filter((e) => e.signal).length;
  const marked = edgesOut.filter((e) => e.marked).length;

  walkNodes.sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  edgesOut.sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));

  // Connectivity (undirected) for the report and tests.
  const { find } = components(walkNodes, edgesOut);
  const sizes = new Map<string, number>();
  for (const nd of walkNodes) {
    const r = find(nd.id);
    sizes.set(r, (sizes.get(r) ?? 0) + 1);
  }
  return {
    graph: { nodes: walkNodes, edges: edgesOut },
    stats: {
      nodes: walkNodes.length,
      edges: edgesOut.length,
      sidewalks,
      crossings,
      signalised,
      marked,
      components: sizes.size,
      largestComponentNodes: Math.max(0, ...sizes.values()),
      cornersOnRoad,
      sidewalksClipped,
      sidewalksDropped,
      clippedM: Math.round(clippedM),
      bridges: edgesOut.filter((e) => bridgeIds.has(e.id)).length,
      crossingsExtended,
      crossingsDropped,
      fragmentsDropped: fragments,
    },
  };
}

/** Undirected connected components (union-find with path compression). */
function components(nodes: readonly WalkNode[], edges: readonly WalkEdge[]): { find: (id: string) => string } {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) {
      const nx = parent.get(c)!;
      parent.set(c, r);
      c = nx;
    }
    return r;
  };
  for (const nd of nodes) parent.set(nd.id, nd.id);
  for (const e of edges) {
    const ra = find(e.a), rb = find(e.b);
    if (ra !== rb) parent.set(ra, rb);
  }
  return { find };
}
