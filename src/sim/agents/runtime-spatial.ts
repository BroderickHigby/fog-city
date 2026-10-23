import { nearestSidewalkNode, sidewalkNodesWithin } from "./navigation-index.ts";
// Runtime adapter for the pure spatial policies. The caller owns registration and final dodge.
import { Action, DT, sortedIds } from "../contract.ts";
import { AGENT_SPEC, ROBOTAXI_BODY, agentsOf, personIsChild } from "../agents.ts";
import type { AgentState } from "../agents.ts";
import { datan2, dcos, dsin } from "../dmath.ts";
import { hash32 } from "../rng.ts";
import { pathPoint, projectOnPath } from "../roads.ts";
import type { SimSystemContext } from "../system-contract.ts";
import { circleBlocked, meshGroundHeight, nearbyBuildings, segmentBlocked } from "../world.ts";
import type { World } from "../world.ts";
import type { RobotMovementIntent } from "../robots/brain.ts";
import { MAX_AMBIENT_AGENTS, MAX_SIGNIFICANT_AGENTS, planFidelity, prepareFidelityAnchors } from "./fidelity.ts";
import type { FidelityAnchor, FidelityDecision } from "./fidelity.ts";
import { advanceSidewalkRoute, buildFallbackSidewalkGraph, buildSidewalkGraph, shortestSidewalkRoute } from "./navigation.ts";
import type { SidewalkCursor, SidewalkEdge, SidewalkGraph, SidewalkGraphInput, SidewalkRoute, SidewalkTraversal } from "./navigation.ts";
import { IDLE_REACTION, reactToPerception } from "./reactions.ts";
import type { PerceivedStimulus, ReactionState } from "./reactions.ts";

/** One bounded adapter holds all 2,000 significant actors plus 800 ambient actors. */
export const MAX_SPATIAL_WALKERS = MAX_SIGNIFICANT_AGENTS + MAX_AMBIENT_AGENTS;
export const MAX_RUNTIME_PIGEONS = 16;
export const MAX_RUNTIME_DOGS = 8;
export const RUNTIME_LEASH_M = 2.2;
export const MAX_SIDEWALK_JOIN_M = 4;
export const STUCK_RECOVERY_TICKS = 120;

export interface RuntimeRobotMotion { readonly id: number; readonly movement: RobotMovementIntent }
export interface SpatialVehicleBody {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly previousX: number;
  readonly previousZ: number;
  readonly halfLength: number;
  readonly halfWidth: number;
  readonly speed: number;
}

export interface RuntimeWalkerTrack {
  readonly id: number;
  readonly route: SidewalkRoute | null;
  readonly cursor: SidewalkCursor;
  readonly joining: boolean;
  readonly goalKey: string;
  readonly decisions: number;
  readonly phaseTicks: number;
  readonly lastTick: number;
  readonly reaction: ReactionState;
  /** Absent unless measured motion is blocked; old snapshots need no defaults. */
  readonly stalledTicks?: number;
  readonly recovery?: { readonly retryTick: number };
}

export interface RuntimeAnimal {
  readonly id: string;
  readonly kind: "pigeon" | "dog";
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly heading: number;
  readonly speed: number;
  readonly radius: number;
  readonly protected: true;
  readonly wet: false;
  readonly ownerId: number | null;
  readonly leashM: number | null;
  readonly edgeId: string | null;
  readonly distanceM: number;
  readonly direction: 1 | -1;
  readonly phaseTicks: number;
  readonly rng: number;
  readonly reaction: ReactionState;
}

export interface RuntimeSpatialState {
  readonly version: 1;
  readonly walkers: ReadonlyArray<RuntimeWalkerTrack>;
  readonly animals: ReadonlyArray<RuntimeAnimal>;
}

export interface RuntimeSpatialInput {
  readonly context: SimSystemContext;
  readonly actors: ReadonlyArray<AgentState>;
  readonly anchors: ReadonlyArray<FidelityAnchor>;
  /** Build once per static world. Omit only for small/test worlds. */
  readonly navigation?: SidewalkGraph;
  readonly previous?: RuntimeSpatialState;
  readonly robotIntents?: ReadonlyArray<RuntimeRobotMotion>;
  readonly vehicles?: ReadonlyArray<SpatialVehicleBody>;
  readonly significantActorIds?: ReadonlyArray<number>;
  readonly dodgeActorIds?: ReadonlyArray<number>;
  /** Only newly allocated, not-yet-visible bodies may take the optional safe initial snap. */
  readonly freshSpawnIds?: ReadonlyArray<number>;
  readonly animalLimit?: { readonly pigeons: number; readonly dogs: number };
  readonly canCross?: (edgeId: string, tick: number) => boolean;
  readonly fogDensity?: (x: number, z: number) => number;
}

export type SpatialBlock = "building" | "vehicle" | "crosswalk" | "leash" | null;
export interface RuntimeSpatialMetadata {
  readonly id: number;
  readonly fidelity: FidelityDecision["tier"];
  readonly override: boolean;
  readonly movedM: number;
  readonly joining: boolean;
  readonly blockedBy: SpatialBlock;
  readonly reaction: ReactionState["mode"];
}
export interface RuntimeSpatialResult {
  readonly actors: ReadonlyArray<AgentState>;
  readonly animals: ReadonlyArray<RuntimeAnimal>;
  readonly state: RuntimeSpatialState;
  readonly metadata: ReadonlyArray<RuntimeSpatialMetadata>;
}

const compareId = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const square = (value: number): number => value * value;
const distance = (a: { x: number; z: number }, b: { x: number; z: number }): number =>
  Math.sqrt(square(a.x - b.x) + square(a.z - b.z));
function idHash(id: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) value = Math.imul(value ^ id.charCodeAt(i), 0x01000193);
  return value >>> 0;
}

export function createSpatialNavigation(world: World, explicit?: SidewalkGraphInput): SidewalkGraph {
  return explicit ? buildSidewalkGraph(explicit) : world.roads ? buildFallbackSidewalkGraph(world.roads) : buildSidewalkGraph({ nodes: [], edges: [] });
}

function pointSegmentSq(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const length = dx * dx + dz * dz;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / length));
  return square(px - ax - dx * t) + square(pz - az - dz * t);
}

function segmentsTouch(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): boolean {
  const cross = (ux: number, uz: number, vx: number, vz: number): number => ux * vz - uz * vx;
  const abx = bx - ax;
  const abz = bz - az;
  const cdx = dx - cx;
  const cdz = dz - cz;
  const denominator = cross(abx, abz, cdx, cdz);
  if (denominator === 0) return pointSegmentSq(ax, az, cx, cz, dx, dz) === 0 || pointSegmentSq(bx, bz, cx, cz, dx, dz) === 0 ||
    pointSegmentSq(cx, cz, ax, az, bx, bz) === 0 || pointSegmentSq(dx, dz, ax, az, bx, bz) === 0;
  const t = cross(cx - ax, cz - az, cdx, cdz) / denominator;
  const u = cross(cx - ax, cz - az, abx, abz) / denominator;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

function segmentDistanceSq(a: { x: number; z: number }, b: { x: number; z: number }, c: { x: number; z: number }, d: { x: number; z: number }): number {
  if (segmentsTouch(a.x, a.z, b.x, b.z, c.x, c.z, d.x, d.z)) return 0;
  return Math.min(pointSegmentSq(a.x, a.z, c.x, c.z, d.x, d.z), pointSegmentSq(b.x, b.z, c.x, c.z, d.x, d.z),
    pointSegmentSq(c.x, c.z, a.x, a.z, b.x, b.z), pointSegmentSq(d.x, d.z, a.x, a.z, b.x, b.z));
}

/** Capsule versus footprint, including narrow obstacles between the endpoints. */
function buildingBlocks(world: World, from: { x: number; z: number }, to: { x: number; z: number }, radius: number): boolean {
  if (circleBlocked(world, from.x, from.z, radius) || circleBlocked(world, to.x, to.z, radius) ||
    segmentBlocked(world, from.x, from.z, to.x, to.z)) return true;
  const extent = distance(from, to) / 2 + radius;
  for (const building of nearbyBuildings(world, (from.x + to.x) / 2, (from.z + to.z) / 2, extent)) {
    if (building.topY <= building.baseY) continue;
    for (const vertex of building.footprint) {
      if (pointSegmentSq(vertex[0], vertex[1], from.x, from.z, to.x, to.z) < radius * radius) return true;
    }
  }
  return false;
}

function vehicleBlocks(from: { x: number; z: number }, to: { x: number; z: number }, radius: number,
  vehicles: ReadonlyArray<SpatialVehicleBody>, crossing = false): boolean {
  for (const vehicle of vehicles) {
    const envelope = Math.sqrt(square(vehicle.halfLength) + square(vehicle.halfWidth)) + radius +
      (crossing ? 2 + square(Math.abs(vehicle.speed)) / 14 : 0);
    if (segmentDistanceSq(from, to, { x: vehicle.previousX, z: vehicle.previousZ }, vehicle) <= envelope * envelope) return true;
  }
  return false;
}

function blockReason(world: World, from: { x: number; z: number }, to: { x: number; z: number }, radius: number,
  vehicles: ReadonlyArray<SpatialVehicleBody>, crossing = false): SpatialBlock {
  if (buildingBlocks(world, from, to, radius)) return "building";
  return vehicleBlocks(from, to, radius, vehicles, crossing) ? "vehicle" : null;
}

// World collision geometry and graph edges are immutable. Dynamic traffic, signals, and
// fog never enter this cache; graph replacement or a different world gets its own result.
const staticEdgeBlocks = new WeakMap<World, WeakMap<SidewalkEdge, Map<number, boolean>>>();
function edgeBuildingBlocks(world: World, edge: SidewalkEdge, radius: number): boolean {
  let byEdge = staticEdgeBlocks.get(world);
  if (!byEdge) { byEdge = new WeakMap(); staticEdgeBlocks.set(world, byEdge); }
  let byRadius = byEdge.get(edge);
  if (!byRadius) { byRadius = new Map(); byEdge.set(edge, byRadius); }
  const cached = byRadius.get(radius);
  if (cached !== undefined) return cached;
  for (let i = 1; i < edge.path.xs.length; i++) {
    const from = { x: edge.path.xs[i - 1]!, z: edge.path.zs[i - 1]! };
    const to = { x: edge.path.xs[i]!, z: edge.path.zs[i]! };
    if (buildingBlocks(world, from, to, radius)) { byRadius.set(radius, true); return true; }
  }
  byRadius.set(radius, false);
  return false;
}


// A weak component deliberately ignores direction: different labels prove that even the
// directed search cannot reach its target; equal labels still require the normal search.
// Radius is bounded to the finite AGENT_SPEC radii at the private call site.
const staticComponents = new WeakMap<World, WeakMap<SidewalkGraph, Map<number, ReadonlyMap<string, number>>>>();
function staticComponentLabels(world: World, graph: SidewalkGraph, radius: number): ReadonlyMap<string, number> {
  let byGraph = staticComponents.get(world);
  if (!byGraph) { byGraph = new WeakMap(); staticComponents.set(world, byGraph); }
  let byRadius = byGraph.get(graph);
  if (!byRadius) { byRadius = new Map(); byGraph.set(graph, byRadius); }
  const cached = byRadius.get(radius);
  if (cached) return cached;
  const nodeIndex = new Map(graph.nodes.map((node, index) => [node.id, index]));
  const parent = graph.nodes.map((_, index) => index), sizes = graph.nodes.map(() => 1);
  const rootOf = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]!]!;
      index = parent[index]!;
    }
    return index;
  };
  for (const edge of graph.edges) {
    if (edgeBuildingBlocks(world, edge, radius)) continue;
    const a = nodeIndex.get(edge.a), b = nodeIndex.get(edge.b);
    if (a === undefined || b === undefined) continue;
    let ra = rootOf(a), rb = rootOf(b);
    if (ra === rb) continue;
    if (sizes[ra]! < sizes[rb]!) { const swap = ra; ra = rb; rb = swap; }
    parent[rb] = ra;
    sizes[ra] = sizes[ra]! + sizes[rb]!;
  }
  const labels = new Map(graph.nodes.map((node, index) => [node.id, rootOf(index)]));
  byRadius.set(radius, labels);
  return labels;
}

function staticallyConnected(world: World, graph: SidewalkGraph, radius: number, start: string, target: string): boolean {
  if (start === target) return true;
  const labels = staticComponentLabels(world, graph, radius);
  const component = labels.get(start);
  return component !== undefined && labels.get(target) === component;
}

function runtimeVehicles(input: RuntimeSpatialInput): SpatialVehicleBody[] {
  const result = new Map<string, SpatialVehicleBody>();
  for (const id of sortedIds(input.context.state.players)) {
    const current = input.context.state.players[id]!.car;
    const prior = input.context.previous.players[id]?.car ?? current;
    result.set(`player:${id}`, { id: `player:${id}`, x: current.x, z: current.z, previousX: prior.x, previousZ: prior.z,
      halfLength: 2.2, halfWidth: 0.95, speed: current.speed });
  }
  const previous = new Map(agentsOf(input.context.previous).map((actor) => [actor.id, actor]));
  for (const actor of input.actors) {
    if (actor.kind !== "robotaxi") continue;
    const prior = previous.get(actor.id) ?? actor;
    result.set(`agent:${actor.id}`, { id: `agent:${actor.id}`, x: actor.x, z: actor.z, previousX: prior.x, previousZ: prior.z,
      halfLength: ROBOTAXI_BODY.halfLength, halfWidth: ROBOTAXI_BODY.halfWidth, speed: actor.speed });
  }
  for (const vehicle of input.vehicles ?? []) result.set(vehicle.id, vehicle);
  return [...result.keys()].sort(compareId).map((id) => result.get(id)!);
}

function perceptions(input: RuntimeSpatialInput, actor: { x: number; z: number }, vehicles: ReadonlyArray<SpatialVehicleBody>): PerceivedStimulus[] {
  const stimuli: PerceivedStimulus[] = [];
  for (const id of sortedIds(input.context.previous.players)) {
    const player = input.context.previous.players[id]!;
    const position = player.mode === "foot" && player.foot ? player.foot : player.car;
    const range = distance(actor, position);
    const seen = range <= 30 && !segmentBlocked(input.context.world, actor.x, actor.z, position.x, position.z);
    const actions = input.context.inputs[id]?.actions ?? 0;
    if ((actions & Action.horn) !== 0 && range <= 40) stimuli.push({ sourceId: id, kind: "horn", x: position.x, z: position.z, seen, heard: true });
    if ((actions & Action.fire) !== 0 && range <= 20) stimuli.push({ sourceId: id, kind: "spray", x: position.x, z: position.z, seen, heard: true });
    if ((actions & Action.scan) !== 0 && range <= 30) stimuli.push({ sourceId: id, kind: "ping", x: position.x, z: position.z, seen, heard: true });
  }
  for (const vehicle of vehicles) {
    if (distance(actor, vehicle) <= 10 && Math.abs(vehicle.speed) > 0.5 &&
      !segmentBlocked(input.context.world, actor.x, actor.z, vehicle.x, vehicle.z)) {
      stimuli.push({ sourceId: vehicle.id, kind: "vehicle", x: vehicle.x, z: vehicle.z, seen: true, heard: false, speedMps: Math.abs(vehicle.speed) });
    }
  }
  return stimuli;
}

interface Projection { edge: SidewalkEdge; s: number; distanceM: number; reverse: boolean }
interface ProjectionIndex {
  readonly walking: ReadonlyArray<SidewalkEdge>;
  readonly byRoad: ReadonlyMap<string, ReadonlyArray<SidewalkEdge>>;
}
const projectionCache = new WeakMap<SidewalkGraph, ProjectionIndex>();
function projectionIndex(graph: SidewalkGraph): ProjectionIndex {
  const cached = projectionCache.get(graph);
  if (cached) return cached;
  const walking: SidewalkEdge[] = [];
  const byRoad = new Map<string, SidewalkEdge[]>();
  for (const edge of graph.edges) {
    if (edge.kind === "crosswalk") continue;
    walking.push(edge);
    if (edge.roadId === null) continue;
    const list = byRoad.get(edge.roadId) ?? [];
    list.push(edge);
    byRoad.set(edge.roadId, list);
  }
  const index = { walking, byRoad };
  projectionCache.set(graph, index);
  return index;
}
function nearestSidewalk(index: ProjectionIndex, actor: { x: number; z: number; heading: number; edge?: string }): Projection | null {
  const matching = actor.edge ? index.byRoad.get(actor.edge) : undefined;
  const candidates = matching && matching.length > 0 ? matching : index.walking;
  let best: Projection | null = null;
  for (const edge of candidates) {
    const projected = projectOnPath(edge.path, actor.x, actor.z);
    const point = pathPoint(edge.path, projected.s);
    const reverse = point.tx * dsin(actor.heading) - point.tz * dcos(actor.heading) < 0;
    if (!best || projected.dist < best.distanceM || (projected.dist === best.distanceM && edge.id < best.edge.id)) {
      best = { edge, s: projected.s, distanceM: projected.dist, reverse };
    }
  }
  return best;
}

function initialTrack(index: ProjectionIndex, actor: AgentState, seed: number, tick: number): RuntimeWalkerTrack {
  const projection = nearestSidewalk(index, actor);
  const base = { id: actor.id, goalKey: "", decisions: 0, phaseTicks: actor.identitySeed === undefined ? hash32(seed, actor.id) % 60 : actor.identitySeed % 60, lastTick: tick, reaction: IDLE_REACTION };
  if (!projection || projection.distanceM > MAX_SIDEWALK_JOIN_M) return { ...base, route: null, cursor: { stepIndex: 0, distanceM: 0 }, joining: true };
  const { edge, reverse } = projection;
  const step = { edgeId: edge.id, from: reverse ? edge.b : edge.a, to: reverse ? edge.a : edge.b, reverse };
  return { ...base, route: { nodeIds: [step.from, step.to], steps: [step], lengthM: edge.path.len },
    cursor: { stepIndex: 0, distanceM: reverse ? edge.path.len - projection.s : projection.s }, joining: projection.distanceM > 1e-6 };
}

function currentPoint(graph: SidewalkGraph, track: RuntimeWalkerTrack): { x: number; z: number } | null {
  return track.route ? advanceSidewalkRoute(graph, track.route, track.cursor, 0).point : null;
}

function traversalBlocked(input: RuntimeSpatialInput, edge: SidewalkEdge, radius: number,
  vehicles: ReadonlyArray<SpatialVehicleBody>, avoidFog: boolean): boolean {
  if (edge.kind === "crosswalk" && input.canCross && !input.canCross(edge.id, input.context.state.tick)) return true;
  if (edgeBuildingBlocks(input.context.world, edge, radius)) return true;
  // Static safety has already passed; these changing inputs are still checked each tick.
  if (!(avoidFog && input.fogDensity) && (edge.kind !== "crosswalk" || vehicles.length === 0)) return false;
  for (let i = 1; i < edge.path.xs.length; i++) {
    const from = { x: edge.path.xs[i - 1]!, z: edge.path.zs[i - 1]! };
    const to = { x: edge.path.xs[i]!, z: edge.path.zs[i]! };
    if ((avoidFog && input.fogDensity && (input.fogDensity(from.x, from.z) > 0.05 || input.fogDensity(to.x, to.z) > 0.05)) ||
      (edge.kind === "crosswalk" && vehicleBlocks(from, to, radius, vehicles, true))) return true;
  }
  return false;
}

function nextErrand(graph: SidewalkGraph, track: RuntimeWalkerTrack, actor: AgentState,
  blocked: (edge: SidewalkEdge) => boolean): RuntimeWalkerTrack {
  if (!track.route || track.cursor.stepIndex < track.route.steps.length) return track;
  const last = track.route.steps[track.route.steps.length - 1];
  const node = track.route.nodeIds[track.route.nodeIds.length - 1]!;
  let options = [...(graph.outgoing.get(node) ?? [])].filter((step) => !blocked(graph.edgeById.get(step.edgeId)!));
  const forward = options.filter((step) => step.edgeId !== last?.edgeId);
  if (forward.length > 0) options = forward;
  options.sort((a, b) => compareId(a.edgeId, b.edgeId));
  if (options.length === 0) return track;
  const step = options[hash32(actor.rng, actor.identitySeed ?? actor.id, track.decisions) % options.length]!;
  return { ...track, route: { nodeIds: [step.from, step.to], steps: [step], lengthM: graph.edgeById.get(step.edgeId)!.path.len },
    cursor: { stepIndex: 0, distanceM: 0 }, decisions: track.decisions + 1, goalKey: "errand" };
}

function routeForIntent(world: World, graph: SidewalkGraph, track: RuntimeWalkerTrack, actor: AgentState, intent: RobotMovementIntent,
  radius: number, blocked: (edge: SidewalkEdge) => boolean): RuntimeWalkerTrack {
  if (!track.route || intent.kind === "hold" || intent.kind === "errand") return track;
  const destination = (intent.kind === "pursue" || intent.kind === "repair") ? intent.destination : intent.toward;
  let target = (intent.kind === "pursue" || intent.kind === "repair") ? nearestSidewalkNode(graph, destination ?? actor) ?? undefined : undefined;
  if (intent.kind === "flee") {
    let best = Infinity;
    for (const node of sidewalkNodesWithin(graph, actor, 100)) {
      let score = destination ? distance(node, destination) : distance(node, actor);
      if (intent.from) score -= distance(node, intent.from) * 2;
      if (!target || score < best || (score === best && node.id < target.id)) { target = node; best = score; }
    }
  }
  if (!target) return track;
  const goalKey = `${intent.kind}:${target.id}`;
  if (track.goalKey === goalKey && track.cursor.stepIndex < track.route.steps.length) return track;
  const current = track.route.steps[track.cursor.stepIndex];
  const start = current?.to ?? track.route.nodeIds[track.route.nodeIds.length - 1]!;
  if (!staticallyConnected(world, graph, radius, start, target.id)) return track;
  const tail = shortestSidewalkRoute(graph, start, target.id, (edge) => blocked(edge));
  if (!tail) return track;
  const steps: SidewalkTraversal[] = current ? [current, ...tail.steps] : [...tail.steps];
  const route: SidewalkRoute = { nodeIds: current ? [current.from, ...tail.nodeIds] : tail.nodeIds, steps,
    lengthM: tail.lengthM + (current ? graph.edgeById.get(current.edgeId)!.path.len : 0) };
  return { ...track, route, cursor: { stepIndex: 0, distanceM: current ? track.cursor.distanceM : 0 }, goalKey };
}

function limitedTarget(from: { x: number; z: number }, target: { x: number; z: number }, maxDistance: number): { x: number; z: number } {
  const length = distance(from, target);
  if (length <= maxDistance || length === 0) return { x: target.x, z: target.z };
  return { x: from.x + (target.x - from.x) * maxDistance / length, z: from.z + (target.z - from.z) * maxDistance / length };
}

function clearStall(track: RuntimeWalkerTrack): RuntimeWalkerTrack {
  if (track.stalledTicks === undefined) return track;
  const { stalledTicks: _stalled, ...rest } = track;
  return rest;
}
function clearRecovery(track: RuntimeWalkerTrack): RuntimeWalkerTrack {
  const clean = clearStall(track);
  if (clean.recovery === undefined) return clean;
  const { recovery: _recovery, ...rest } = clean;
  return rest;
}
function observeProgress(track: RuntimeWalkerTrack, requested: boolean, moved: number, run: boolean,
  cadence: number, eligible: boolean, tick: number): RuntimeWalkerTrack {
  if (!eligible || moved > 1e-6 || !requested) return clearStall(track);
  if (!run || track.recovery) return track;
  const stalledTicks = Math.min(STUCK_RECOVERY_TICKS, (track.stalledTicks ?? 0) + (track.stalledTicks === undefined ? 1 : cadence));
  const step = track.route?.steps[track.cursor.stepIndex];
  return stalledTicks < STUCK_RECOVERY_TICKS || !step ? { ...track, stalledTicks } :
    { ...clearStall(track), recovery: { retryTick: tick } };
}

/** Retreat only along the current connected edge; then route around the obstruction. */
function recoverWalker(world: World, graph: SidewalkGraph, actor: AgentState, track: RuntimeWalkerTrack,
  travel: number, vehicles: readonly SpatialVehicleBody[], blocked: (edge: SidewalkEdge) => boolean, tick: number):
  { track: RuntimeWalkerTrack; target: { x: number; z: number } } {
  const hold = { x: actor.x, z: actor.z }, recovery = track.recovery!;
  const occupied = currentPoint(graph, track);
  if (track.joining || !occupied || distance(actor, occupied) > 1e-4) return { track: clearRecovery(track), target: hold };
  const step = track.route?.steps[track.cursor.stepIndex], edge = step && graph.edgeById.get(step.edgeId);
  if (!step || !edge || !track.route) return { track: clearRecovery(track), target: hold };
  const unavailable = (candidate: SidewalkEdge): boolean => blocked(candidate) || candidate.path.xs.some((x, index) => index > 0 &&
    blockReason(world, { x: candidate.path.xs[index - 1]!, z: candidate.path.zs[index - 1]! },
      { x, z: candidate.path.zs[index]! }, AGENT_SPEC[actor.kind].radius, vehicles) !== null);
  if (!unavailable(edge)) return { track: clearRecovery(track), target: hold };
  if (track.cursor.distanceM > 1e-6) {
    const along = Math.max(0, track.cursor.distanceM - travel), point = pathPoint(edge.path, step.reverse ? edge.path.len - along : along);
    if (blockReason(world, actor, point, AGENT_SPEC[actor.kind].radius, vehicles)) return { track, target: hold };
    return { track: { ...track, cursor: { ...track.cursor, distanceM: along } }, target: point };
  }
  if (tick < recovery.retryTick) return { track, target: hold };
  const goal = track.route.nodeIds[track.route.nodeIds.length - 1]!;
  const route = shortestSidewalkRoute(graph, step.from, goal, (candidate) => candidate.id === edge.id || unavailable(candidate));
  if (route) return { track: { ...clearRecovery(track), route, cursor: { stepIndex: 0, distanceM: 0 }, goalKey: "", decisions: track.decisions + 1 }, target: hold };
  return { track: { ...track, recovery: { ...recovery, retryTick: Math.min(Number.MAX_SAFE_INTEGER, tick + 60) } }, target: hold };
}

function validTrack(graph: SidewalkGraph, track: RuntimeWalkerTrack): boolean {
  return track.route !== null && track.route.steps.every((step) => graph.edgeById.has(step.edgeId));
}

function actorWithPose(actor: AgentState, base: AgentState, target: { x: number; z: number }, graph: SidewalkGraph,
  track: RuntimeWalkerTrack, blocked: SpatialBlock, elapsed = DT): AgentState {
  const moved = distance(base, target);
  const step = track.route?.steps[track.cursor.stepIndex];
  const edge = step ? graph.edgeById.get(step.edgeId) : undefined;
  const result = { ...actor, x: target.x, z: target.z,
    heading: moved > 1e-9 ? datan2(target.x - base.x, -(target.z - base.z)) : base.heading,
    speed: moved / elapsed, mode: blocked ? "wait" as const : actor.mode };
  if (edge?.roadId && step) {
    result.edge = edge.roadId;
    result.dir = step.reverse ? -1 : 1;
    result.s = track.cursor.distanceM;
    result.conn = null;
    result.node = "";
  }
  return result;
}

function validateInput(input: RuntimeSpatialInput): void {
  if (!Number.isSafeInteger(input.context.state.tick) || input.context.state.tick < 0 ||
    !Number.isSafeInteger(input.context.previous.tick) || input.context.previous.tick < 0 ||
    input.context.previous.tick > input.context.state.tick) throw new Error("Invalid spatial tick");
  if (input.actors.filter((actor) => actor.kind !== "robotaxi").length > MAX_SPATIAL_WALKERS) throw new Error("Spatial walker capacity exceeded");
  const ids = new Set<number>();
  for (const actor of input.actors) {
    if (ids.has(actor.id) || !Number.isSafeInteger(actor.id) || ![actor.x, actor.y, actor.z, actor.heading, actor.speed, actor.vmax, actor.rng].every(Number.isFinite)) {
      throw new Error("Invalid spatial actor");
    }
    ids.add(actor.id);
  }
  for (const actor of agentsOf(input.context.previous)) {
    if (![actor.x, actor.y, actor.z, actor.heading].every(Number.isFinite)) throw new Error("Invalid prior spatial actor");
  }
  const vehicleIds = new Set<string>();
  for (const vehicle of input.vehicles ?? []) {
    if (vehicleIds.has(vehicle.id) || ![vehicle.x, vehicle.z, vehicle.previousX, vehicle.previousZ, vehicle.halfLength, vehicle.halfWidth, vehicle.speed].every(Number.isFinite) ||
      vehicle.halfLength < 0 || vehicle.halfWidth < 0) throw new Error("Invalid spatial vehicle");
    vehicleIds.add(vehicle.id);
  }
  const finitePoint = (point: { x: number; z: number } | null): boolean => point === null || [point.x, point.z].every(Number.isFinite);
  for (const { movement } of input.robotIntents ?? []) {
    if (((movement.kind === "pursue" || movement.kind === "repair") && (!movement.destination || !finitePoint(movement.destination) || !Number.isFinite(movement.stopDistance) || movement.stopDistance < 0)) ||
      (movement.kind === "repair" && (typeof movement.kioskId !== "string" || movement.kioskId.length === 0)) ||
      (movement.kind === "flee" && (!finitePoint(movement.from) || !finitePoint(movement.toward))) ||
      (movement.kind === "hold" && !finitePoint(movement.face))) throw new Error("Invalid robot spatial intent");
  }
  const previous = input.previous;
  if (!previous) return;
  if (previous.version !== 1 || previous.walkers.length > MAX_SPATIAL_WALKERS ||
    previous.animals.length > MAX_RUNTIME_DOGS + MAX_RUNTIME_PIGEONS) throw new Error("Invalid spatial state capacity");
  const trackIds = new Set<number>();
  for (const track of previous.walkers) {
    if (trackIds.has(track.id) || !Number.isSafeInteger(track.phaseTicks) || track.phaseTicks < 0 || track.phaseTicks >= 60 ||
      !Number.isSafeInteger(track.decisions) || track.decisions < 0 || !Number.isSafeInteger(track.lastTick) || track.lastTick < 0 ||
      track.lastTick > input.context.state.tick || !Number.isSafeInteger(track.cursor.stepIndex) || track.cursor.stepIndex < 0 ||
      !Number.isFinite(track.cursor.distanceM) || track.cursor.distanceM < 0 ||
      (track.route && (track.cursor.stepIndex > track.route.steps.length || !Number.isFinite(track.route.lengthM))) ||
      !Number.isSafeInteger(track.reaction.untilTick) || track.reaction.untilTick < 0 || !finitePoint(track.reaction.source)) {
      throw new Error("Invalid spatial walker state");
    }
    if ((track.stalledTicks !== undefined && (!Number.isSafeInteger(track.stalledTicks) || track.stalledTicks < 1 || track.stalledTicks > STUCK_RECOVERY_TICKS)) ||
      (track.recovery && (!Number.isSafeInteger(track.recovery.retryTick) || track.recovery.retryTick < 0))) throw new Error("Invalid walker recovery state");
    trackIds.add(track.id);
  }
  const animalIds = new Set<string>();
  for (const animal of previous.animals) {
    if (animalIds.has(animal.id) || ![animal.x, animal.y, animal.z, animal.heading, animal.speed, animal.radius, animal.distanceM, animal.rng].every(Number.isFinite) ||
      !Number.isSafeInteger(animal.phaseTicks) || animal.phaseTicks < 0 || animal.phaseTicks >= 60 ||
      animal.radius <= 0 || animal.protected !== true || animal.wet !== false ||
      (animal.kind === "dog" && (!Number.isSafeInteger(animal.ownerId) || animal.leashM !== RUNTIME_LEASH_M)) ||
      !Number.isSafeInteger(animal.reaction.untilTick) || animal.reaction.untilTick < 0 || !finitePoint(animal.reaction.source)) {
      throw new Error("Invalid runtime animal state");
    }
    animalIds.add(animal.id);
  }
}

/**
 * Replace only route corrections or authoritative motion overrides. An already legal legacy
 * move is retained exactly; every override starts at the previous tick's body, never at the
 * already-moved candidate. This avoids advancing a walker twice in one sim tick.
 */
export function stepRuntimeSpatial(input: RuntimeSpatialInput): RuntimeSpatialResult {
  validateInput(input);
  const anchors = prepareFidelityAnchors(input.anchors);
  if (anchors !== input.anchors) input = { ...input, anchors };
  const graph = input.navigation ?? createSpatialNavigation(input.context.world);
  const vehicles = runtimeVehicles(input);
  const previousActors = new Map(agentsOf(input.context.previous).map((actor) => [actor.id, actor]));
  const tracks = new Map((input.previous?.walkers ?? []).map((track) => [track.id, track]));
  const intents = new Map((input.robotIntents ?? []).map((intent) => [intent.id, intent.movement]));
  if (intents.size !== (input.robotIntents?.length ?? 0)) throw new Error("Duplicate robot spatial intent");
  const significant = new Set(input.significantActorIds ?? []);
  const dodging = new Set(input.dodgeActorIds ?? []);
  const fresh = new Set(input.freshSpawnIds ?? []);
  const dogsByOwner = new Map<number, RuntimeAnimal[]>();
  for (const animal of input.previous?.animals ?? []) {
    if (animal.kind !== "dog" || animal.ownerId === null) continue;
    const dogs = dogsByOwner.get(animal.ownerId) ?? [];
    dogs.push(animal);
    dogsByOwner.set(animal.ownerId, dogs);
  }
  // Shared within this tick: walkers on the same crossing see one authoritative query.
  // Cache by body radius and simulation mode; abstract travel has no dynamic vehicles.
  const blockedEdges = new Map<string, boolean>();
  const staticVehicles: ReadonlyArray<SpatialVehicleBody> = [];
  const edgeBlocked = (edge: SidewalkEdge, radius: number, avoidFog: boolean, abstract: boolean): boolean => {
    const key = `${radius}|${avoidFog ? 1 : 0}|${abstract ? 1 : 0}|${edge.id}`;
    const cached = blockedEdges.get(key);
    if (cached !== undefined) return cached;
    const blocked = traversalBlocked(input, edge, radius, abstract ? staticVehicles : vehicles, avoidFog);
    blockedEdges.set(key, blocked);
    return blocked;
  };
  let projections: ProjectionIndex | null = null;
  const beginTrack = (actor: AgentState): RuntimeWalkerTrack => {
    projections ??= projectionIndex(graph);
    return initialTrack(projections, actor, input.context.state.seed, input.context.previous.tick);
  };
  const metadata: RuntimeSpatialMetadata[] = [];
  const nextTracks: RuntimeWalkerTrack[] = [];
  const actors = [...input.actors].sort((a, b) => a.id - b.id).map((actor): AgentState => {
    if (actor.kind === "robotaxi") return actor;
    const base = previousActors.get(actor.id) ?? actor;
    let track = tracks.get(actor.id);
    if (!track || (track.route !== null && !validTrack(graph, track))) track = beginTrack(base);
    let point = currentPoint(graph, track);
    if (point && !track.joining && distance(point, base) > 1e-4) {
      const rejoined = beginTrack(base);
      track = { ...rejoined, phaseTicks: track.phaseTicks, decisions: track.decisions, reaction: track.reaction };
      point = currentPoint(graph, track);
    }
    if (track.joining || fresh.has(actor.id) || !previousActors.has(actor.id)) track = clearRecovery(track);
    const fidelity = planFidelity({ id: String(actor.id), x: base.x, z: base.z, significant: significant.has(actor.id), phaseTicks: track.phaseTicks }, input.anchors, input.context.state.tick);
    if (track.route === null && (fidelity.tier === "full" || fidelity.tier === "active") &&
      input.context.state.tick % 60 === track.phaseTicks) {
      const joined = beginTrack(base);
      track = { ...joined, phaseTicks: track.phaseTicks, decisions: track.decisions, reaction: track.reaction };
      point = currentPoint(graph, track);
    }
    if (dodging.has(actor.id) || actor.dodge !== null || base.dodge !== null || actor.mode === "dive" || actor.mode === "recover") {
      nextTracks.push({ ...clearRecovery(track), joining: true });
      metadata.push({ id: actor.id, fidelity: fidelity.tier, override: false, movedM: distance(base, actor), joining: true, blockedBy: null, reaction: track.reaction.mode });
      return actor;
    }
    const radius = AGENT_SPEC[actor.kind].radius;
    const intent = intents.get(actor.id) ?? { kind: "errand" as const, avoidFog: false };
    if (fidelity.tier === "abstract") {
      let target = { x: base.x, z: base.z };
      const elapsed = Math.max(DT, (input.context.state.tick - track.lastTick) * DT);
      const beforeAbstract = track;
      let blockedBy: SpatialBlock = null;
      const wasRecovering = track.recovery !== undefined;
      const blocked = (edge: SidewalkEdge): boolean => edgeBlocked(edge, radius, intent.avoidFog, true);
      const stop = (intent.kind === "pursue" || intent.kind === "repair") && distance(base, intent.destination) <= intent.stopDistance;
      if (fidelity.run && !wasRecovering && !track.joining && intent.kind !== "hold" && intent.kind !== "errand") {
        track = routeForIntent(input.context.world, graph, track, base, intent, radius, blocked);
      }
      const requested = intent.kind !== "hold" && !stop && actor.vmax > 0 && track.route !== null && !track.joining &&
        (track.cursor.stepIndex < track.route.steps.length || intent.kind === "errand");
      if (stop || intent.kind === "hold" || actor.vmax <= 0 || track.joining) {
        track = { ...clearRecovery(track), lastTick: input.context.state.tick };
      }
      if (fidelity.run && wasRecovering && requested) {
        const recovered = recoverWalker(input.context.world, graph, base, track, Math.max(0, actor.vmax) * elapsed, staticVehicles,
          blocked, input.context.state.tick);
        track = { ...recovered.track, lastTick: input.context.state.tick }; target = recovered.target;
      } else if (fidelity.run && requested && !wasRecovering && track.route) {
        let remaining = Math.max(0, actor.vmax) * elapsed;
        for (let hop = 0; hop < 64 && remaining > 1e-9; hop++) {
          if (intent.kind === "errand") track = nextErrand(graph, track, actor, blocked);
          if (track.cursor.stepIndex === track.route!.steps.length) break;
          const advanced = advanceSidewalkRoute(graph, track.route!, track.cursor, remaining, blocked);
          target = advanced.point;
          remaining -= advanced.movedM;
          track = { ...track, cursor: advanced.cursor };
          if (!advanced.finished || advanced.blockedEdgeId !== null || intent.kind !== "errand") break;
        }
        track = { ...track, lastTick: input.context.state.tick };
      }
      for (const dog of dogsByOwner.get(actor.id) ?? []) {
        if (distance(dog, target) > RUNTIME_LEASH_M) {
          target = base;
          blockedBy = "leash";
          track = { ...beforeAbstract, lastTick: input.context.state.tick };
        }
      }
      if (blockedBy === "leash") track = clearRecovery(track);
      track = observeProgress(track, requested && !wasRecovering, distance(base, target), fidelity.run, fidelity.cadenceTicks,
        intent.kind !== "hold" && blockedBy !== "leash" && previousActors.has(actor.id) && !fresh.has(actor.id), input.context.state.tick);
      const output = { ...actorWithPose(actor, base, target, graph, track, blockedBy, elapsed), y: meshGroundHeight(input.context.world, target.x, target.z) };
      nextTracks.push(track);
      metadata.push({ id: actor.id, fidelity: "abstract", override: distance(actor, output) > 1e-7,
        movedM: distance(base, output), joining: track.joining, blockedBy, reaction: track.reaction.mode });
      return output;
    }
    const blockedEdge = (edge: SidewalkEdge): boolean => edgeBlocked(edge, radius, intent.avoidFog, false);
    let target: { x: number; z: number } = base;
    let proposedTrack = track;
    let blockedBy: SpatialBlock = null;
    let requestedMotion = false;
    const wasRecovering = track.recovery !== undefined;
    const atIntentGoal = (intent.kind === "pursue" || intent.kind === "repair") && distance(base, intent.destination) <= intent.stopDistance;
    if (wasRecovering && atIntentGoal) proposedTrack = clearRecovery(track);
    else if (wasRecovering) {
      const allowed = intent.kind !== "hold" && actor.vmax > 0 && fidelity.run &&
        (intent.kind !== "errand" || track.reaction.untilTick <= input.context.state.tick || track.reaction.mode === "idle");
      if (allowed) {
        const recovered = recoverWalker(input.context.world, graph, base, track, Math.max(0, actor.vmax) * DT, vehicles, blockedEdge, input.context.state.tick);
        target = recovered.target; proposedTrack = recovered.track;
      }
    } else if (track.route && point && fidelity.tier !== "despawn") {
      if (track.joining) {
        requestedMotion = actor.vmax > 0 && distance(base, point) > 1e-6;
        const safeSnap = fresh.has(actor.id) && !previousActors.has(actor.id) && !blockReason(input.context.world, base, point, radius, vehicles);
        target = safeSnap ? point : limitedTarget(base, point, Math.max(0, actor.vmax) * DT);
        proposedTrack = { ...track, joining: distance(target, point) > 1e-6 };
      } else if (intent.kind !== "hold") {
        track = intent.kind === "errand" ? nextErrand(graph, track, actor, blockedEdge) : routeForIntent(input.context.world, graph, track, base, intent, radius, blockedEdge);
        const stop = (intent.kind === "pursue" || intent.kind === "repair") && distance(base, intent.destination) <= intent.stopDistance;
        const travelBudget = stop ? 0 : intent.kind === "errand" ? Math.min(distance(base, actor), Math.max(0, actor.vmax) * DT) : Math.max(0, actor.vmax) * DT;
        requestedMotion = !stop && actor.vmax > 0 && (travelBudget > 1e-6 || intent.kind === "errand" && actor.mode === "go");
        if (track.route) {
          requestedMotion &&= track.cursor.stepIndex < track.route.steps.length;
          const advanced = advanceSidewalkRoute(graph, track.route, track.cursor, travelBudget, (edge) => blockedEdge(edge));
          target = advanced.point;
          if (advanced.blockedEdgeId) blockedBy = "crosswalk";
          proposedTrack = { ...track, cursor: advanced.cursor };
        }
      }
    } else if (!track.route && fidelity.tier !== "despawn" && intent.kind === "errand") {
      target = actor;
      requestedMotion = distance(base, actor) > 1e-6;
    }
    // Ordinary errands may react to sensed activity. A hold, pursuit or flee intent
    // remains authoritative, including a hold imposed by combat.
    const allowReaction = intent.kind === "errand";
    const stimuli = fidelity.run && allowReaction ? perceptions(input, base, vehicles) : [];
    const reaction = reactToPerception({ actor: { id: String(actor.id), kind: actor.kind === "person" ? "person" : "good-robot", x: base.x, z: base.z, wet: false,
      child: actor.kind === "person" && personIsChild(actor.id, actor.identitySeed) },
      state: track.reaction, stimuli, tick: input.context.state.tick, dodgeOverrideActive: false,
      routineVelocity: { vx: (target.x - base.x) / DT, vz: (target.z - base.z) / DT } });
    if (allowReaction) {
      const reacted = { x: base.x + reaction.movement.vx * DT, z: base.z + reaction.movement.vz * DT };
      if (distance(reacted, target) > 1e-6) {
        // Clamp only a changed reaction: the original target may be an authorized fresh snap.
        proposedTrack = { ...clearRecovery(track), joining: true };
        target = limitedTarget(base, reacted, Math.max(0, actor.vmax) * DT);
      }
    }
    proposedTrack = { ...proposedTrack, reaction: reaction.state, lastTick: input.context.state.tick };
    if (intent.kind === "hold") { target = base; proposedTrack = { ...track, reaction: reaction.state }; }
    const candidateBlock = blockReason(input.context.world, base, target, radius, vehicles);
    if (candidateBlock) { target = base; blockedBy = candidateBlock; proposedTrack = { ...track, reaction: reaction.state }; }
    for (const dog of dogsByOwner.get(actor.id) ?? []) {
      if (distance(dog, target) > RUNTIME_LEASH_M) {
        target = base; blockedBy = "leash"; proposedTrack = { ...track, reaction: reaction.state };
      }
    }
    const intentionalHold = intent.kind === "hold" || actor.vmax <= 0 || blockedBy === "leash" ||
      (allowReaction && reaction.state.mode !== "idle" && reaction.state.untilTick > input.context.state.tick);
    if (intentionalHold) proposedTrack = clearRecovery(proposedTrack);
    proposedTrack = observeProgress(proposedTrack, requestedMotion && !wasRecovering, distance(base, target), fidelity.run, fidelity.cadenceTicks,
      !intentionalHold && previousActors.has(actor.id) && !fresh.has(actor.id), input.context.state.tick);
    // Preserve the exact incoming object for a legal legacy move, not a second projection step.
    const override = distance(target, actor) > 1e-7;
    const output = override ? actorWithPose(actor, base, target, graph, proposedTrack, blockedBy) : actor;
    let result = output;
    if (override) result = { ...output, y: meshGroundHeight(input.context.world, target.x, target.z) };
    if (intent.kind === "hold") result = { ...result, speed: 0,
      ...(intent.face && distance(base, intent.face) > 1e-9 ? { heading: datan2(intent.face.x - base.x, -(intent.face.z - base.z)) } : {}) };
    proposedTrack = { ...proposedTrack, lastTick: input.context.state.tick };
    nextTracks.push(proposedTrack);
    metadata.push({ id: actor.id, fidelity: fidelity.tier, override, movedM: distance(base, result), joining: proposedTrack.joining, blockedBy, reaction: reaction.state.mode });
    return result;
  });
  const animals = stepAnimals(input, graph, actors, vehicles);
  return { actors, animals, state: { version: 1, walkers: nextTracks, animals }, metadata };
}

function animalSpawnClear(input: RuntimeSpatialInput, point: { x: number; z: number }, radius: number, actors: ReadonlyArray<AgentState>,
  vehicles: ReadonlyArray<SpatialVehicleBody>, animals: ReadonlyArray<RuntimeAnimal>): boolean {
  return blockReason(input.context.world, point, point, radius, vehicles) === null &&
    !actors.some((actor) => actor.kind !== "robotaxi" && distance(point, actor) < radius + AGENT_SPEC[actor.kind].radius) &&
    !animals.some((animal) => distance(point, animal) < radius + animal.radius);
}

const animalEdgeOrder = new WeakMap<SidewalkGraph, readonly SidewalkEdge[]>();
function orderedAnimalEdges(graph: SidewalkGraph): readonly SidewalkEdge[] {
  let ordered = animalEdgeOrder.get(graph);
  if (!ordered) {
    ordered = [...graph.edges].sort((a, b) => compareId(a.id, b.id));
    animalEdgeOrder.set(graph, ordered);
  }
  return ordered;
}

function stepAnimals(input: RuntimeSpatialInput, graph: SidewalkGraph, actors: ReadonlyArray<AgentState>, vehicles: ReadonlyArray<SpatialVehicleBody>): RuntimeAnimal[] {
  const limits = input.animalLimit ?? { pigeons: MAX_RUNTIME_PIGEONS, dogs: MAX_RUNTIME_DOGS };
  if (![limits.pigeons, limits.dogs].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    limits.pigeons > MAX_RUNTIME_PIGEONS || limits.dogs > MAX_RUNTIME_DOGS) throw new Error("Invalid runtime animal limit");
  const owners = actors.filter((actor) => actor.kind === "person").sort((a, b) => a.id - b.id);
  const ownerById = new Map(owners.map((actor) => [actor.id, actor]));
  let animals = [...(input.previous?.animals ?? [])].filter((animal) => animal.kind === "pigeon" || ownerById.has(animal.ownerId!));
  animals = animals.filter((animal) => planFidelity({ ...animal, significant: false }, input.anchors, input.context.state.tick).tier !== "despawn");
  animals.sort((a, b) => compareId(a.id, b.id));
  const pigeons = animals.filter((animal) => animal.kind === "pigeon").slice(0, limits.pigeons);
  const dogs = animals.filter((animal) => animal.kind === "dog").slice(0, limits.dogs);
  animals = [...pigeons, ...dogs];
  for (const owner of owners) {
    if (animals.filter((animal) => animal.kind === "dog").length >= limits.dogs) break;
    const id = `dog:${input.context.state.seed}:${owner.id}`;
    if (animals.some((animal) => animal.id === id)) continue;
    if (planFidelity({ id, x: owner.x, z: owner.z, significant: false }, input.anchors, input.context.state.tick).tier === "despawn") continue;
    for (const side of [1, -1]) {
      const x = owner.x + dcos(owner.heading) * 0.9 * side;
      const z = owner.z + dsin(owner.heading) * 0.9 * side;
      if (!animalSpawnClear(input, { x, z }, 0.2, actors, vehicles, animals)) continue;
      animals.push({ id, kind: "dog", x, z, y: meshGroundHeight(input.context.world, x, z), heading: owner.heading, speed: 0, radius: 0.2,
        protected: true, wet: false, ownerId: owner.id, leashM: RUNTIME_LEASH_M, edgeId: null, distanceM: 0, direction: 1,
        phaseTicks: hash32(input.context.state.seed, owner.id, 17) % 60, rng: hash32(input.context.state.seed, owner.id, 23), reaction: IDLE_REACTION });
      break;
    }
  }
  let pigeonCount = pigeons.length;
  // Preserve the canonical full-graph edge index in each ID, but do no graph work once full.
  const edges = pigeonCount < limits.pigeons ? orderedAnimalEdges(graph) : [];
  for (let edgeIndex = 0; edgeIndex < edges.length && pigeonCount < limits.pigeons; edgeIndex++) {
    const edge = edges[edgeIndex]!;
    if (edge.kind !== "sidewalk") continue;
    // Graph order is canonical; indexing avoids unbounded escaped junction IDs in live actor keys.
    const id = `pigeon:${input.context.state.seed}:${edgeIndex}`;
    if (animals.some((animal) => animal.id === id)) continue;
    const point = pathPoint(edge.path, edge.path.len / 2);
    if (planFidelity({ id, x: point.x, z: point.z, significant: false }, input.anchors, input.context.state.tick).tier === "despawn" ||
      !animalSpawnClear(input, point, 0.15, actors, vehicles, animals)) continue;
    const seed = hash32(input.context.state.seed, idHash(edge.id), edge.path.len | 0);
    animals.push({ id, kind: "pigeon", x: point.x, z: point.z, y: meshGroundHeight(input.context.world, point.x, point.z), heading: datan2(point.tx, -point.tz),
      speed: 0, radius: 0.15, protected: true, wet: false, ownerId: null, leashM: null, edgeId: edge.id, distanceM: edge.path.len / 2,
      direction: 1, phaseTicks: seed % 60, rng: seed, reaction: IDLE_REACTION });
    pigeonCount++;
  }
  return animals.sort((a, b) => compareId(a.id, b.id)).map((animal) => {
    const owner = animal.ownerId === null ? undefined : ownerById.get(animal.ownerId);
    const next = { ...animal };
    let target = { x: animal.x, z: animal.z };
    if (owner) {
      target = limitedTarget(animal, { x: owner.x + dcos(owner.heading) * 0.9, z: owner.z + dsin(owner.heading) * 0.9 }, 1.8 * DT);
      // An external final-dodge displacement must be resolved with the paired owner by core.
      if (distance(animal, owner) > RUNTIME_LEASH_M + 1e-8) return { ...animal, speed: 0 };
    } else if (animal.edgeId && (input.context.state.tick + animal.phaseTicks) % 180 >= 60) {
      const edge = graph.edgeById.get(animal.edgeId);
      if (edge) {
        let along = animal.distanceM + animal.direction * 0.6 * DT;
        if (along >= edge.path.len || along <= 0) { next.direction = animal.direction === 1 ? -1 : 1; along = Math.max(0, Math.min(edge.path.len, along)); }
        next.distanceM = along;
        target = limitedTarget(animal, pathPoint(edge.path, along), 0.6 * DT);
      }
    }
    const result = reactToPerception({ actor: { id: animal.id, kind: animal.kind, x: animal.x, z: animal.z, wet: false,
      ...(owner ? { leash: { ownerId: String(owner.id), ownerX: owner.x, ownerZ: owner.z, lengthM: RUNTIME_LEASH_M } } : {}) },
      state: animal.reaction, stimuli: perceptions(input, animal, vehicles), tick: input.context.state.tick,
      dodgeOverrideActive: owner !== undefined && ((input.dodgeActorIds ?? []).includes(owner.id) || owner.dodge !== null || owner.mode === "dive" || owner.mode === "recover"),
      routineVelocity: { vx: (target.x - animal.x) / DT, vz: (target.z - animal.z) / DT } });
    target = { x: animal.x + result.movement.vx * DT, z: animal.z + result.movement.vz * DT };
    if (blockReason(input.context.world, animal, target, animal.radius, vehicles)) target = animal;
    const moved = distance(animal, target);
    return { ...next, x: target.x, z: target.z, y: meshGroundHeight(input.context.world, target.x, target.z),
      heading: moved > 1e-9 ? datan2(target.x - animal.x, -(target.z - animal.z)) : animal.heading,
      speed: moved / DT, reaction: result.state, wet: false as const };
  });
}
