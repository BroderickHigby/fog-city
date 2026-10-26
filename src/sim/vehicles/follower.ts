import { CAR } from "../car.ts";
import { DT, type SimInput } from "../contract.ts";
import { clamp, datan2, dcos, dsin, wrapAngle } from "../dmath.ts";
import { endNode, lanePath, makePath, pathPoint, projectOnPath, startNode, type Dir, type DirEdge, type Path, type RoadGraph } from "../roads.ts";
import type { World } from "../world.ts";

export interface FollowerBody { x: number; z: number; heading: number; speed: number }
export interface FollowerTarget { x: number; z: number; speed?: number; heading?: number }
export interface FollowerGoal {
  kind: "pursue" | "intercept" | "park-across-lane";
  target: FollowerTarget;
  stopDistance?: number;
  maxSpeed?: number;
  laneHeading?: number;
  /** An authoritative service route can bypass route search. */
  route?: readonly (readonly [number, number])[];
}
export interface FollowerState {
  version: 1;
  route: [number, number][];
  goalX: number; goalZ: number;
  lastX: number; lastZ: number;
  /** Measured world-space travel; never derived from a requested destination. */
  distanceM: number;
  blockedTicks: number;
  reverseTicks: number;
  reversals: number;
}
export interface FollowerResult {
  state: FollowerState;
  input: SimInput;
  status: "driving" | "reversing" | "arrived" | "no-route";
  distanceToGoal: number;
  stopped: boolean;
}
function distance(a: { x: number; z: number }, b: { x: number; z: number }): number {
  const dx = a.x - b.x, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}
export interface FollowerLane { edge: number; dir: Dir; s: number; distance: number }
type Lane = FollowerLane;
/** One drivable lane-0 path, indexed once per road graph. */
interface IndexedLane { edge: number; dir: Dir; path: Path }
interface RouteIndex {
  lanes: IndexedLane[];
  /** Uniform grid over lane geometry: cells[(cx - minCx) * rows + (cz - minCz)] lists lane indices. */
  cells: (number[] | undefined)[];
  minCx: number; minCz: number; cols: number; rows: number;
  /** Per-query visit stamps, so a lane spanning several cells is scored once. */
  stamp: Int32Array; query: number;
  /** Rank of each node's id in ascending id order (the Dijkstra tie break). */
  nodeRank: Int32Array;
  /** Each node's outgoing directed edges, sorted by edge id (stable on ties). */
  outgoing: DirEdge[][];
  /** Nearest-lane results for goals (no heading); exact coordinates key them. */
  goals: Map<string, Lane | null>;
  /** Node routes by from/to; results are immutable once stored. */
  routes: Map<number, readonly DirEdge[] | null>;
}
/** Lane index cell size, metres. */
const LANE_CELL_M = 64;
/** Cache bounds: a full cache is dropped (results never depend on it). */
const GOAL_CACHE = 4096, ROUTE_CACHE = 2048;
const indexes = new WeakMap<RoadGraph, RouteIndex>();
const cellOf = (v: number): number => Math.floor(v / LANE_CELL_M);
function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

function routeIndex(graph: RoadGraph): RouteIndex {
  const cached = indexes.get(graph);
  if (cached) return cached;
  const lanes: IndexedLane[] = [];
  let minCx = Infinity, minCz = Infinity, maxCx = -Infinity, maxCz = -Infinity;
  for (const edge of graph.edges) {
    if (!edge.drivable) continue;
    for (const dir of [1, -1] as const) {
      if (edge.laneCount[dir === 1 ? 0 : 1] === 0 || !edge.laneClear[dir === 1 ? 0 : 1][0]) continue;
      const path = lanePath(edge, dir, 0);
      lanes.push({ edge: edge.index, dir, path });
      for (let i = 0; i < path.xs.length; i++) {
        const cx = cellOf(path.xs[i]!), cz = cellOf(path.zs[i]!);
        minCx = Math.min(minCx, cx); maxCx = Math.max(maxCx, cx); minCz = Math.min(minCz, cz); maxCz = Math.max(maxCz, cz);
      }
    }
  }
  if (!lanes.length) { minCx = minCz = 0; maxCx = maxCz = -1; }
  const cols = maxCx - minCx + 1, rows = maxCz - minCz + 1;
  const cells: (number[] | undefined)[] = new Array(Math.max(0, cols * rows));
  lanes.forEach((lane, index) => {
    const { xs, zs } = lane.path, mark = new Set<number>();
    for (let i = 0; i < xs.length; i++) {
      // Every cell a segment's bounding box touches: a superset of the cells it crosses.
      const j = Math.min(i + 1, xs.length - 1);
      const x0 = cellOf(Math.min(xs[i]!, xs[j]!)), x1 = cellOf(Math.max(xs[i]!, xs[j]!));
      const z0 = cellOf(Math.min(zs[i]!, zs[j]!)), z1 = cellOf(Math.max(zs[i]!, zs[j]!));
      for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
        const key = (cx - minCx) * rows + (cz - minCz);
        if (mark.has(key)) continue;
        mark.add(key); (cells[key] ??= []).push(index);
      }
    }
  });
  const order = graph.nodes.map(node => node.index).sort((a, b) => compareText(graph.nodes[a]!.id, graph.nodes[b]!.id) || a - b);
  const nodeRank = new Int32Array(graph.nodes.length);
  order.forEach((node, rank) => { nodeRank[node] = rank; });
  const outgoing = graph.nodes.map(node => [...node.out].sort((a, b) => compareText(graph.edges[a.edge]!.id, graph.edges[b.edge]!.id)));
  const index: RouteIndex = { lanes, cells, minCx, minCz, cols, rows, stamp: new Int32Array(lanes.length), query: 0, nodeRank, outgoing, goals: new Map(), routes: new Map() };
  indexes.set(graph, index);
  return index;
}

/**
 * The drivable lane nearest a point, scored by distance plus twice any heading misalignment.
 * Exactly the result of scoring every lane (lowest score, then lowest edge id, then the a -> b
 * direction), found by searching grid rings outwards until no unsearched lane can score lower.
 */
export function nearestDrivableLane(graph: RoadGraph, point: { x: number; z: number }, heading?: number): Lane | null {
  const index = routeIndex(graph);
  const key = heading === undefined ? `${point.x},${point.z}` : null;
  if (key !== null && index.goals.has(key)) return index.goals.get(key)!;
  const stamp = ++index.query;
  let best: Lane | null = null, score = Infinity;
  const consider = (cell: number[] | undefined): void => {
    for (const laneIndex of cell ?? []) {
      if (index.stamp[laneIndex] === stamp) continue;
      index.stamp[laneIndex] = stamp;
      const lane = index.lanes[laneIndex]!, p = projectOnPath(lane.path, point.x, point.z), at = pathPoint(lane.path, p.s);
      const cost = p.dist + (heading === undefined ? 0 : Math.abs(wrapAngle(datan2(at.tx, -at.tz) - heading)) * 2);
      const better = best === null || cost < score || cost === score
        && (compareText(graph.edges[lane.edge]!.id, graph.edges[best.edge]!.id) || lane.edge - best.edge || best.dir - lane.dir) < 0;
      if (better) { score = cost; best = { edge: lane.edge, dir: lane.dir, s: p.s, distance: p.dist }; }
    }
  };
  const cx = cellOf(point.x) - index.minCx, cz = cellOf(point.z) - index.minCz;
  const at = (x: number, z: number): number[] | undefined => x >= 0 && z >= 0 && x < index.cols && z < index.rows ? index.cells[x * index.rows + z] : undefined;
  const outside = Math.max(0, -cx, -cz, cx - index.cols + 1, cz - index.rows + 1);
  const last = Math.max(cx, cz, index.cols - 1 - cx, index.rows - 1 - cz);
  for (let r = outside; r <= last; r++) {
    // Every lane not yet scored lies in cells at least r + 1 rings out: at least r cells away.
    if (best !== null && score + 1e-6 < (r - 1) * LANE_CELL_M) break;
    const x0 = Math.max(0, cx - r), x1 = Math.min(index.cols - 1, cx + r);
    for (let x = x0; x <= x1; x++) { consider(at(x, cz - r)); if (r > 0) consider(at(x, cz + r)); }
    const z0 = Math.max(0, cz - r + 1), z1 = Math.min(index.rows - 1, cz + r - 1);
    for (let z = z0; z <= z1; z++) { consider(at(cx - r, z)); if (r > 0) consider(at(cx + r, z)); }
  }
  if (key !== null) {
    if (index.goals.size >= GOAL_CACHE) index.goals.clear();
    index.goals.set(key, best);
  }
  return best;
}
/**
 * Directed Dijkstra over drivable lanes. A binary heap pops the lowest cost, then the lowest
 * node id, which is the order a full sort of the queue gives, so routes and the visit budget
 * match the original search exactly.
 */
export function drivableNodeRoute(graph: RoadGraph, from: number, to: number): readonly DirEdge[] | null {
  const index = routeIndex(graph), key = from * graph.nodes.length + to;
  if (index.routes.has(key)) return index.routes.get(key)!;
  const n = graph.nodes.length, rank = index.nodeRank;
  const costs = new Float64Array(n).fill(Infinity), prevNode = new Int32Array(n).fill(-1);
  const prevEdge: (DirEdge | null)[] = new Array(n).fill(null);
  const heapNode: number[] = [], heapCost: number[] = [];
  const less = (i: number, j: number): boolean => heapCost[i]! < heapCost[j]! || heapCost[i] === heapCost[j] && rank[heapNode[i]!]! < rank[heapNode[j]!]!;
  const swap = (i: number, j: number): void => {
    const node = heapNode[i]!, cost = heapCost[i]!;
    heapNode[i] = heapNode[j]!; heapCost[i] = heapCost[j]!; heapNode[j] = node; heapCost[j] = cost;
  };
  const push = (node: number, cost: number): void => {
    let i = heapNode.length; heapNode.push(node); heapCost.push(cost);
    while (i > 0) { const parent = (i - 1) >> 1; if (!less(i, parent)) break; swap(i, parent); i = parent; }
  };
  const pop = (): { node: number; cost: number } => {
    const top = { node: heapNode[0]!, cost: heapCost[0]! }, lastNode = heapNode.pop()!, lastCost = heapCost.pop()!;
    if (heapNode.length) {
      heapNode[0] = lastNode; heapCost[0] = lastCost;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heapNode.length && less(l, m)) m = l;
        if (r < heapNode.length && less(r, m)) m = r;
        if (m === i) break;
        swap(i, m); i = m;
      }
    }
    return top;
  };
  costs[from] = 0; push(from, 0);
  let visits = 0, result: DirEdge[] | null = null;
  while (heapNode.length && visits++ < n * 4) {
    const current = pop();
    if (current.cost !== costs[current.node]) continue;
    if (current.node === to) {
      result = [];
      for (let node = to; node !== from; node = prevNode[node]!) result.push(prevEdge[node]!);
      result.reverse();
      break;
    }
    for (const next of index.outgoing[current.node]!) {
      const edge = graph.edges[next.edge]!;
      if (!edge.drivable || !edge.laneClear[next.dir === 1 ? 0 : 1][0]) continue;
      const node = endNode(edge, next.dir), cost = current.cost + edge.center.len;
      if (cost >= costs[node]!) continue;
      costs[node] = cost; prevNode[node] = current.node; prevEdge[node] = { edge: next.edge, dir: next.dir }; push(node, cost);
    }
  }
  if (index.routes.size >= ROUTE_CACHE) index.routes.clear();
  index.routes.set(key, result);
  return result;
}
/** The polyline a follower drives from its body to a target: lane 0 of the nearest lanes and the shortest drivable route between. */
export function followerRoute(world: World, body: FollowerBody, target: FollowerTarget): [number, number][] {
  if (!world.roads) return [[body.x, body.z], [target.x, target.z]];
  const graph = world.roads, first = nearestDrivableLane(graph, body, body.heading), last = nearestDrivableLane(graph, target);
  if (!first || !last) return [];
  const a = graph.edges[first.edge]!, b = graph.edges[last.edge]!;
  const middle = a.index === b.index && first.dir === last.dir && last.s >= first.s ? [] : drivableNodeRoute(graph, endNode(a, first.dir), startNode(b, last.dir));
  if (!middle) return [];
  const out: [number, number][] = [[body.x, body.z]];
  const append = (edge: number, dir: Dir, from = 0, to?: number): void => {
    const path = lanePath(graph.edges[edge]!, dir, 0), end = to ?? path.len;
    const begin = pathPoint(path, from); out.push([begin.x, begin.z]);
    for (let i = 1; i < path.xs.length; i++) if (path.cum[i]! > from && path.cum[i]! < end) out.push([path.xs[i]!, path.zs[i]!]);
    const point = pathPoint(path, end); out.push([point.x, point.z]);
  };
  if (a.index === b.index && first.dir === last.dir && last.s >= first.s) append(first.edge, first.dir, first.s, last.s);
  else { append(first.edge, first.dir, first.s); for (const edge of middle) append(edge.edge, edge.dir); append(last.edge, last.dir, 0, last.s); }
  out.push([target.x, target.z]);
  return out.filter((point, i) => i === 0 || point[0] !== out[i - 1]![0] || point[1] !== out[i - 1]![1]);
}

/** A pose change larger than this between two ticks is a relocation, not driving. */
export const TELEPORT_M = 50;

export function createFollowerState(body: FollowerBody): FollowerState {
  return { version: 1, route: [], goalX: body.x, goalZ: body.z, lastX: body.x, lastZ: body.z, distanceM: 0, blockedTicks: 0, reverseTicks: 0, reversals: 0 };
}
/** Pure controller: the caller applies these controls through normal vehicle physics/clearance. */
export function stepVehicleFollower(world: World, body: FollowerBody, previous: Readonly<FollowerState>, goal: FollowerGoal): FollowerResult {
  if (![body.x, body.z, body.heading, body.speed, goal.target.x, goal.target.z].every(Number.isFinite)) throw new Error("Follower poses must be finite");
  const maxSpeed = clamp(goal.maxSpeed ?? 10, 1, 25), stopDistance = clamp(goal.stopDistance ?? 2, 0.5, 30);
  let target = { ...goal.target };
  if (goal.kind === "intercept") {
    const lead = clamp(distance(body, target) / Math.max(maxSpeed, 1), 0, 4);
    const advance = (target.speed ?? 0) * lead, heading = target.heading ?? 0;
    target = { ...target, x: target.x + dsin(heading) * advance, z: target.z - dcos(heading) * advance };
  }
  // A body that jumped more than TELEPORT_M since the last tick was relocated by its owner
  // (a respawn, a correction or a loaded save): start afresh from where it is now, without
  // counting the jump as travel or as progress, instead of failing the tick.
  const jump = distance(body, { x: previous.lastX, z: previous.lastZ }), teleported = jump > TELEPORT_M;
  const moved = teleported ? 0 : jump;
  const dist = distance(body, target), atGoal = dist <= stopDistance + 0.15, arrived = atGoal && Math.abs(body.speed) < 0.3;
  const blockedTicks = arrived || teleported || moved > 0.015 ? 0 : previous.blockedTicks + 1;
  const beginReverse = blockedTicks >= 180 && previous.reverseTicks === 0;
  const reverseTicks = beginReverse ? 90 : teleported ? 0 : Math.max(0, previous.reverseTicks - 1);
  let route = previous.route.map(point => [...point] as [number, number]);
  if (teleported || !route.length || distance(target, { x: previous.goalX, z: previous.goalZ }) > 12 || beginReverse || previous.reverseTicks === 1) {
    route = goal.route ? goal.route.map(point => [point[0], point[1]]) : followerRoute(world, body, target);
    if (goal.kind === "park-across-lane" && route.length > 1) {
      const heading = (goal.laneHeading ?? target.heading ?? 0) + 1.5707963267948966;
      route.splice(route.length - 1, 0, [target.x - dsin(heading) * 10, target.z + dcos(heading) * 10]);
    }
  }
  const state: FollowerState = { version: 1, route, goalX: target.x, goalZ: target.z, lastX: body.x, lastZ: body.z,
    distanceM: previous.distanceM + moved, blockedTicks: beginReverse ? 0 : blockedTicks, reverseTicks, reversals: previous.reversals + (beginReverse ? 1 : 0) };
  const stopped = Math.abs(body.speed) < 0.3;
  if (atGoal || !route.length) return { state, input: { throttle: 0, steer: 0, brake: 1, actions: 0 }, status: arrived ? "arrived" : atGoal ? "driving" : "no-route", distanceToGoal: dist, stopped };
  const path = makePath(route.map(p => p[0]), route.map(p => p[1]));
  const projection = projectOnPath(path, body.x, body.z);
  const look = pathPoint(path, projection.s + 3 + Math.abs(body.speed) * 0.6);
  const error = wrapAngle(datan2(look.x - body.x, -(look.z - body.z)) - body.heading);
  const steer = clamp(error * 1.8, -1, 1);
  const desired = Math.min(maxSpeed / (1 + Math.abs(error) * 2), Math.sqrt(Math.max(0, 2 * CAR.brakeDecel * 0.65 * (dist - stopDistance))));
  const input: SimInput = reverseTicks > 0
    ? { throttle: body.speed > 0.3 ? 0 : -0.6, steer: -steer, brake: body.speed > 0.3 ? 1 : 0, actions: 0 }
    : { throttle: body.speed < desired - 0.03 ? clamp((desired - body.speed) / 3, 0, 1) : 0, steer, brake: body.speed > desired + 0.15 ? 1 : 0, actions: 0 };
  return { state, input, status: reverseTicks > 0 ? "reversing" : "driving", distanceToGoal: dist, stopped };
}
