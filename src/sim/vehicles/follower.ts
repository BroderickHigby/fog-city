import { CAR } from "../car.ts";
import { DT, type SimInput } from "../contract.ts";
import { clamp, datan2, dcos, dsin, wrapAngle } from "../dmath.ts";
import { endNode, lanePath, makePath, pathPoint, projectOnPath, startNode, type Dir, type RoadGraph } from "../roads.ts";
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
interface Lane { edge: number; dir: Dir; s: number; distance: number }
function nearestLane(graph: RoadGraph, point: { x: number; z: number }, heading?: number): Lane | null {
  let best: Lane | null = null;
  let score = Infinity;
  for (const edge of graph.edges) {
    if (!edge.drivable) continue;
    for (const dir of [1, -1] as const) {
      if (edge.laneCount[dir === 1 ? 0 : 1] === 0 || !edge.laneClear[dir === 1 ? 0 : 1][0]) continue;
      const path = lanePath(edge, dir, 0), p = projectOnPath(path, point.x, point.z), at = pathPoint(path, p.s);
      const cost = p.dist + (heading === undefined ? 0 : Math.abs(wrapAngle(datan2(at.tx, -at.tz) - heading)) * 2);
      if (cost < score || cost === score && best !== null && edge.id < graph.edges[best.edge]!.id) {
        score = cost; best = { edge: edge.index, dir, s: p.s, distance: p.dist };
      }
    }
  }
  return best;
}
/** Directed Dijkstra search over drivable lane edges, with stable ID tie breaks. */
function nodeRoute(graph: RoadGraph, from: number, to: number): { edge: number; dir: Dir }[] | null {
  const costs = new Map<number, number>([[from, 0]]);
  const previous = new Map<number, { node: number; edge: number; dir: Dir }>();
  const queue: { node: number; cost: number }[] = [{ node: from, cost: 0 }];
  let visits = 0;
  while (queue.length && visits++ < graph.nodes.length * 4) {
    queue.sort((a, b) => a.cost - b.cost || (graph.nodes[a.node]!.id < graph.nodes[b.node]!.id ? -1 : graph.nodes[a.node]!.id > graph.nodes[b.node]!.id ? 1 : 0));
    const current = queue.shift()!;
    if (current.cost !== costs.get(current.node)) continue;
    if (current.node === to) {
      const route: { edge: number; dir: Dir }[] = [];
      let node = to;
      while (node !== from) { const p = previous.get(node)!; route.push({ edge: p.edge, dir: p.dir }); node = p.node; }
      return route.reverse();
    }
    const outgoing = [...graph.nodes[current.node]!.out].sort((a, b) => graph.edges[a.edge]!.id < graph.edges[b.edge]!.id ? -1 : graph.edges[a.edge]!.id > graph.edges[b.edge]!.id ? 1 : 0);
    for (const next of outgoing) {
      const edge = graph.edges[next.edge]!;
      if (!edge.drivable || !edge.laneClear[next.dir === 1 ? 0 : 1][0]) continue;
      const node = endNode(edge, next.dir), cost = current.cost + edge.center.len;
      if (cost >= (costs.get(node) ?? Infinity)) continue;
      costs.set(node, cost); previous.set(node, { node: current.node, edge: next.edge, dir: next.dir }); queue.push({ node, cost });
    }
  }
  return null;
}
function routeTo(world: World, body: FollowerBody, target: FollowerTarget): [number, number][] {
  if (!world.roads) return [[body.x, body.z], [target.x, target.z]];
  const graph = world.roads, first = nearestLane(graph, body, body.heading), last = nearestLane(graph, target);
  if (!first || !last) return [];
  const a = graph.edges[first.edge]!, b = graph.edges[last.edge]!;
  const middle = a.index === b.index && first.dir === last.dir && last.s >= first.s ? [] : nodeRoute(graph, endNode(a, first.dir), startNode(b, last.dir));
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
  const moved = distance(body, { x: previous.lastX, z: previous.lastZ });
  if (moved > 50) throw new Error("Follower observed an unacknowledged teleport");
  const dist = distance(body, target), atGoal = dist <= stopDistance + 0.15, arrived = atGoal && Math.abs(body.speed) < 0.3;
  const blockedTicks = arrived || moved > 0.015 ? 0 : previous.blockedTicks + 1;
  const beginReverse = blockedTicks >= 180 && previous.reverseTicks === 0;
  const reverseTicks = beginReverse ? 90 : Math.max(0, previous.reverseTicks - 1);
  let route = previous.route.map(point => [...point] as [number, number]);
  if (!route.length || distance(target, { x: previous.goalX, z: previous.goalZ }) > 12 || beginReverse || previous.reverseTicks === 1) {
    route = goal.route ? goal.route.map(point => [point[0], point[1]]) : routeTo(world, body, target);
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
  const desired = Math.min(maxSpeed / (1 + Math.abs(error) * 2), Math.sqrt(Math.max(0, 2 * CAR.brakeDecel * (dist - stopDistance))));
  const input: SimInput = reverseTicks > 0
    ? { throttle: body.speed > 0.3 ? 0 : -0.6, steer: -steer, brake: body.speed > 0.3 ? 1 : 0, actions: 0 }
    : { throttle: body.speed < desired - 0.03 ? clamp((desired - body.speed) / 3, 0, 1) : 0, steer, brake: body.speed > desired + 0.5 ? 0.6 : 0, actions: 0 };
  return { state, input, status: reverseTicks > 0 ? "reversing" : "driving", distanceToGoal: dist, stopped };
}
