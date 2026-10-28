// Runway Run: where investors and demos wait. A point is the middle stretch of a clear lane of a
// drivable street (the lane the ambient cars use, so no building is in the way), on the street's
// connected network (a player can drive from one to the other). A point is also kept only if the
// legal drive to it is not much longer than the straight line (a bounded shortest-path search over
// the same graph, one-ways included), so a target across a block of one-way streets is not chosen
// when a near one is on offer. The choice is a pure function of the road graph, the origin and
// the run's own RNG state.

import type { RngState } from "../contract.ts";
import { nextU32 } from "../rng.ts";
import { dirIndex, endNode, pathPoint, projectOnPath, startNode, type Dir, type RoadEdgeInfo, type RoadGraph } from "../roads.ts";

export interface RunwayPoint { x: number; z: number }

const ATTEMPTS = 120;
/** A lane shorter than this has no room for a marker away from its junctions. */
const MIN_LANE_M = 24;
/** Components smaller than this are islands (a dead-end cul-de-sac, a car park). */
const MIN_NETWORK_EDGES = 30;

/** A drive may be this many times the straight line before a target is passed over (relaxed if nothing is left). */
const ROUTE_RATIO = [2, 3, Infinity] as const;

const components = new WeakMap<RoadGraph, { edgeComp: Int32Array; size: number[]; biggest: number }>();

function usable(e: Readonly<RoadEdgeInfo>): boolean {
  return e.drivable && !e.pedestrian && (e.laneClear[0].some(Boolean) || e.laneClear[1].some(Boolean));
}

/** The drivable network's connected pieces (undirected: a driver can reverse). Edge index order, so ids are stable. */
function networkOf(graph: RoadGraph): { edgeComp: Int32Array; size: number[]; biggest: number } {
  const hit = components.get(graph);
  if (hit) return hit;
  const nodeComp = new Int32Array(graph.nodes.length).fill(-1);
  const edgeComp = new Int32Array(graph.edges.length).fill(-1);
  const size: number[] = [];
  const touching: number[][] = graph.nodes.map(() => []);
  graph.edges.forEach((e, i) => { if (usable(e)) { touching[e.a]!.push(i); touching[e.b]!.push(i); } });
  for (let n = 0; n < graph.nodes.length; n++) {
    if (nodeComp[n]! >= 0 || touching[n]!.length === 0) continue;
    const id = size.length;
    size.push(0);
    const stack = [n];
    nodeComp[n] = id;
    while (stack.length) {
      const at = stack.pop()!;
      for (const i of touching[at]!) {
        if (edgeComp[i]! < 0) { edgeComp[i] = id; size[id]!++; }
        const e = graph.edges[i]!;
        const other = e.a === at ? e.b : e.a;
        if (nodeComp[other]! < 0) { nodeComp[other] = id; stack.push(other); }
      }
    }
  }
  let biggest = 0;
  size.forEach((s, i) => { if (s > size[biggest]!) biggest = i; });
  const out = { edgeComp, size, biggest };
  components.set(graph, out);
  return out;
}

/** The connected network the nearest usable street to (x, z) belongs to; a tiny island falls back to the largest network. -1: no street. */
export function networkAt(graph: RoadGraph, x: number, z: number): number {
  const net = networkOf(graph);
  if (net.size.length === 0) return -1;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < graph.edges.length; i++) {
    if (net.edgeComp[i]! < 0) continue;
    const e = graph.edges[i]!;
    // (Cheap reject: the street's ends and middle are all farther than the best so far.)
    const mid = pathPoint(e.center, e.center.len / 2);
    const slack = e.center.len / 2 + 1;
    const dm = Math.sqrt((mid.x - x) * (mid.x - x) + (mid.z - z) * (mid.z - z));
    if (dm - slack > bestD) continue;
    const d = projectOnPath(e.center, x, z).dist;
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best < 0) return -1;
  const comp = net.edgeComp[best]!;
  return net.size[comp]! >= MIN_NETWORK_EDGES ? comp : net.biggest;
}

/**
 * The shortest legal drive, metres, from (x, z) to every node within `limit` (Infinity beyond):
 * from the nearest usable street's two ends, along drivable edges, one-ways one way. Ties break
 * on node index, so the result is the same on every run.
 */
function roadCosts(graph: RoadGraph, x: number, z: number, limit: number): Float64Array {
  const cost = new Float64Array(graph.nodes.length).fill(Infinity);
  const net = networkOf(graph);
  let best = -1;
  let bestD = Infinity;
  let bestS = 0;
  for (let i = 0; i < graph.edges.length; i++) {
    if (net.edgeComp[i]! < 0) continue;
    const e = graph.edges[i]!;
    const mid = pathPoint(e.center, e.center.len / 2);
    if (Math.sqrt((mid.x - x) * (mid.x - x) + (mid.z - z) * (mid.z - z)) - e.center.len / 2 - 1 > bestD) continue;
    const p = projectOnPath(e.center, x, z);
    if (p.dist < bestD) { bestD = p.dist; best = i; bestS = p.s; }
  }
  if (best < 0) return cost;
  const heap: Array<[number, number]> = [];
  const less = (a: [number, number], b: [number, number]): boolean => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  const push = (c: number, n: number): void => {
    cost[n] = c;
    const item: [number, number] = [c, n];
    let at = heap.length;
    heap.push(item);
    while (at > 0) { const up = (at - 1) >> 1; if (!less(item, heap[up]!)) break; heap[at] = heap[up]!; at = up; }
    heap[at] = item;
  };
  const e0 = graph.edges[best]!;
  push(bestD + bestS, e0.a);
  if (bestD + e0.center.len - bestS < cost[e0.b]!) push(bestD + e0.center.len - bestS, e0.b);
  while (heap.length) {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length) {
      let at = 0;
      for (;;) {
        let child = 2 * at + 1;
        if (child >= heap.length) break;
        if (child + 1 < heap.length && less(heap[child + 1]!, heap[child]!)) child++;
        if (!less(heap[child]!, last)) break;
        heap[at] = heap[child]!; at = child;
      }
      heap[at] = last;
    }
    const [c, n] = top;
    if (c !== cost[n] || c > limit) continue;
    for (const out of graph.nodes[n]!.out) {
      const e = graph.edges[out.edge]!;
      if (net.edgeComp[out.edge]! < 0 || (out.dir === -1 && e.oneway)) continue;
      const to = endNode(e, out.dir);
      const next = c + e.center.len;
      if (next < cost[to]! && next <= limit) push(next, to);
    }
  }
  return cost;
}

/**
 * A point `minM`..`maxM` (straight line) from `from`, on a clear lane of network `network`
 * (-1: any). Tries random spots; if the ring is empty the ring widens a little at a time, up to
 * the whole network, so a small world still gets a target. Returns null only when the world has
 * no usable street. `rng` advances.
 */
export function pickPoint(graph: RoadGraph, from: Readonly<RunwayPoint>, minM: number, maxM: number, network: number, rng: RngState): { point: RunwayPoint; rng: RngState } | null {
  const net = networkOf(graph);
  if (net.size.length === 0) return null;
  const pool: number[] = [];
  for (let i = 0; i < graph.edges.length; i++) {
    if (net.edgeComp[i]! < 0 || (network >= 0 && net.edgeComp[i] !== network) || graph.edges[i]!.center.len < MIN_LANE_M) continue;
    pool.push(i);
  }
  if (pool.length === 0) return null;
  const cost = roadCosts(graph, from.x, from.z, maxM * ROUTE_RATIO[1] + 200);
  // First look for a point whose drive is at most 2x the straight line, then 3x, then any; if the
  // ring is empty, open it (nearer, then farther) so a small world still gets a target.
  const plan: ReadonlyArray<readonly [number, number, number]> = [
    [minM, maxM, ROUTE_RATIO[0]], [minM, maxM, ROUTE_RATIO[1]], [minM, maxM, ROUTE_RATIO[2]],
    [Math.max(40, minM * 0.6), maxM * 1.6, ROUTE_RATIO[2]], [40, maxM * 2.6, ROUTE_RATIO[2]],
  ];
  let r = rng;
  let nearest: { point: RunwayPoint; gap: number } | null = null;
  for (const [lo, hi, ratio] of plan) {
    // Edges whose middle is near enough the ring to hold a point in it.
    const near: number[] = [];
    for (const i of pool) {
      const e = graph.edges[i]!;
      const mid = pathPoint(e.center, e.center.len / 2);
      const d = Math.sqrt((mid.x - from.x) * (mid.x - from.x) + (mid.z - from.z) * (mid.z - from.z));
      const reach = e.center.len / 2 + 8;
      if (d + reach >= lo && d - reach <= hi) near.push(i);
    }
    if (near.length === 0) continue;
    for (let a = 0; a < ATTEMPTS; a++) {
      let u: number;
      [u, r] = nextU32(r);
      const e = graph.edges[near[u % near.length]!]!;
      const dirs: Dir[] = [];
      if (e.laneClear[0].some(Boolean)) dirs.push(1);
      if (e.laneClear[1].some(Boolean)) dirs.push(-1);
      [u, r] = nextU32(r);
      const dir = dirs[u % dirs.length]!;
      const lanes: number[] = [];
      e.laneClear[dirIndex(dir)].forEach((ok, k) => { if (ok) lanes.push(k); });
      [u, r] = nextU32(r);
      const path = e.lanePaths[dirIndex(dir)][lanes[u % lanes.length]!]!;
      if (path.len < MIN_LANE_M) continue;
      [u, r] = nextU32(r);
      // The middle half of the lane: clear of the junction at either end.
      const along = path.len * (0.25 + 0.5 * (u / 4294967296));
      const p = pathPoint(path, along);
      const d = Math.sqrt((p.x - from.x) * (p.x - from.x) + (p.z - from.z) * (p.z - from.z));
      const point = { x: Math.round(p.x * 100) / 100, z: Math.round(p.z * 100) / 100 };
      if (d >= lo && d <= hi) {
        // The drive there: to this lane's first junction, then along the lane.
        const drive = cost[startNode(e, dir)]! + along;
        if (ratio === Infinity || drive <= ratio * d) return { point, rng: r };
      }
      const gap = d < lo ? lo - d : d - hi;
      if (!nearest || gap < nearest.gap) nearest = { point, gap };
    }
  }
  return nearest ? { point: nearest.point, rng: r } : null;
}
