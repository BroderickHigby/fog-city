import type { CombatActor, TargetCombat } from "../combat-contract.ts";
import type { RobotMovementIntent } from "../robots/brain.ts";
import { pathPoint, projectOnPath } from "../roads.ts";
import { circleBlocked, segmentBlocked, type World } from "../world.ts";
import { buildFallbackSidewalkGraph, buildSidewalkGraph, shortestSidewalkRoute, type SidewalkEdge, type SidewalkGraph } from "./navigation.ts";
import { nearestSidewalkNode } from "./navigation-index.ts";

export const REPAIR_KIOSK_RADIUS_M = 4;
const JOIN_RADIUS_M = 4;
export interface RepairTravelDecision {
  readonly status: "inactive" | "pending" | "travelling" | "arrived";
  readonly reason: "not-required" | "unsupported-follower" | "inactive-body" | "missing-kiosk" | "no-safe-route" | null;
  readonly kioskId: string | null;
  readonly movement: RobotMovementIntent | null;
}
const graphs = new WeakMap<World, SidewalkGraph>();
const clearEdges = new WeakMap<World, WeakMap<SidewalkGraph, Map<string, boolean>>>();
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const distance = (a: { x: number; z: number }, b: { x: number; z: number }): number => {
  const dx = a.x - b.x, dz = a.z - b.z; return Math.sqrt(dx * dx + dz * dz);
};
const hold = (): RobotMovementIntent => ({ kind: "hold", face: null, avoidFog: false });

function graphOf(world: World): SidewalkGraph {
  let graph = graphs.get(world);
  if (!graph) {
    graph = world.roads ? buildFallbackSidewalkGraph(world.roads) : buildSidewalkGraph({ nodes: [], edges: [] });
    graphs.set(world, graph);
  }
  return graph;
}
function clearSegment(world: World, from: { x: number; z: number }, to: { x: number; z: number }, radius: number): boolean {
  if (segmentBlocked(world, from.x, from.z, to.x, to.z)) return false;
  const length = distance(from, to), steps = Math.max(1, Math.ceil(length / 0.5));
  for (let index = 0; index <= steps; index++) {
    const fraction = index / steps;
    if (circleBlocked(world, from.x + (to.x - from.x) * fraction, from.z + (to.z - from.z) * fraction, radius)) return false;
  }
  return true;
}
function edgeClear(world: World, graph: SidewalkGraph, edge: SidewalkEdge, radius: number): boolean {
  let byGraph = clearEdges.get(world);
  if (!byGraph) { byGraph = new WeakMap(); clearEdges.set(world, byGraph); }
  let cache = byGraph.get(graph);
  if (!cache) { cache = new Map(); byGraph.set(graph, cache); }
  const key = `${edge.id}:${radius}`, old = cache.get(key);
  if (old !== undefined) return old;
  let clear = true;
  for (let index = 1; index < edge.path.xs.length && clear; index++) clear = clearSegment(world,
    { x: edge.path.xs[index - 1]!, z: edge.path.zs[index - 1]! }, { x: edge.path.xs[index]!, z: edge.path.zs[index]! }, radius);
  cache.set(key, clear);
  return clear;
}

/** Travel depends on combat's actual repair flag and authored kiosks. Arrival never
 * clears rust or completes a repair; that acknowledgement belongs to combat/gameplay.
 */
export function repairTravel(world: World, actor: Readonly<CombatActor>, target: Readonly<TargetCombat> | undefined, navigation?: SidewalkGraph): RepairTravelDecision {
  if (actor.kind !== "robot" || actor.firmware !== "good" || target?.repair !== true) return { status: "inactive", reason: "not-required", kioskId: null, movement: null };
  if (![actor.x, actor.y, actor.z, actor.radius].every(Number.isFinite) || actor.radius <= 0) throw new RangeError("Invalid repair traveller");
  if (target.phase !== "active" || actor.protected || actor.occupied) return { status: "pending", reason: "inactive-body", kioskId: null, movement: hold() };
  if (!["footman", "trundle", "patrol"].includes(actor.model ?? "")) return { status: "pending", reason: "unsupported-follower", kioskId: null, movement: hold() };
  const kiosks = (world.gameplay?.anchors ?? []).filter(anchor => anchor.kind === "repair-kiosk" && anchor.id && [anchor.x, anchor.y, anchor.z].every(Number.isFinite)).sort((a, b) => compare(a.id, b.id));
  if (!kiosks.length) return { status: "pending", reason: "missing-kiosk", kioskId: null, movement: hold() };
  const arrived = kiosks.filter(kiosk => distance(actor, kiosk) <= REPAIR_KIOSK_RADIUS_M && clearSegment(world, actor, kiosk, actor.radius))
    .sort((a, b) => distance(actor, a) - distance(actor, b) || compare(a.id, b.id))[0];
  if (arrived) return { status: "arrived", reason: null, kioskId: arrived.id, movement: hold() };
  const graph = navigation ?? graphOf(world);
  const starts: { nodeId: string; cost: number }[] = [];
  for (const edge of graph.edges) {
    const projection = projectOnPath(edge.path, actor.x, actor.z);
    if (projection.dist > JOIN_RADIUS_M || !edgeClear(world, graph, edge, actor.radius) || !clearSegment(world, actor, pathPoint(edge.path, projection.s), actor.radius)) continue;
    if (graph.outgoing.get(edge.a)?.some(step => step.edgeId === edge.id && !step.reverse)) starts.push({ nodeId: edge.b, cost: projection.dist + edge.path.len - projection.s });
    if (graph.outgoing.get(edge.b)?.some(step => step.edgeId === edge.id && step.reverse)) starts.push({ nodeId: edge.a, cost: projection.dist + projection.s });
  }
  const choices: { kioskId: string; x: number; z: number; cost: number }[] = [];
  for (const kiosk of kiosks) {
    const node = nearestSidewalkNode(graph, kiosk);
    if (!node || distance(node, kiosk) > REPAIR_KIOSK_RADIUS_M || !clearSegment(world, node, kiosk, actor.radius)) continue;
    for (const start of starts) {
      const route = shortestSidewalkRoute(graph, start.nodeId, node.id, edge => !edgeClear(world, graph, edge, actor.radius));
      if (route) choices.push({ kioskId: kiosk.id, x: kiosk.x, z: kiosk.z, cost: start.cost + route.lengthM + distance(node, kiosk) });
    }
  }
  choices.sort((a, b) => a.cost - b.cost || compare(a.kioskId, b.kioskId));
  const choice = choices[0];
  if (!choice) return { status: "pending", reason: "no-safe-route", kioskId: null, movement: hold() };
  return { status: "travelling", reason: null, kioskId: choice.kioskId,
    movement: { kind: "repair", kioskId: choice.kioskId, destination: { x: choice.x, z: choice.z }, stopDistance: REPAIR_KIOSK_RADIUS_M, avoidFog: false } };
}
