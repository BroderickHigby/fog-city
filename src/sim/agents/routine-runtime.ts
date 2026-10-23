import { nearestSidewalkNode } from "./navigation-index.ts";
import { routineSpawnCandidates } from "./routine-spawn.ts";
import { Action, DT, TICK_HZ, sortedIds, type PlayerState } from "../contract.ts";
import { carCircles, stepCar } from "../car.ts";
import { agentCircles } from "../agents.ts";
import { boxBlocked, boxCrossedWall, type Circle } from "../collide.ts";
import { datan2, dcos, dsin, clamp, wrapAngle } from "../dmath.ts";
import { isGameplayId, type ThreatSpawnRequest } from "../gameplay-contract.ts";
import type { CombatActor, AttackRequest, RobotModel } from "../combat-contract.ts";
import { movementLimit } from "../combat/system.ts";
import type { SimSystemContext } from "../system-contract.ts";
import { circleBlocked, meshGroundHeight, segmentBlocked, type World } from "../world.ts";
import { lanePath, walkPath, pathPoint, projectOnPath, type Path } from "../roads.ts";
import { createFinaleState, stepFinale, finaleFootfallClear, type FinaleEffect, type FinaleLandingAck, type FinaleRoute, type FinaleState } from "../robots/finale.ts";
import { robotAgentId, type RobotLocomotion } from "../robots/runtime.ts";
import { agentRuntimeSession, runtimeGameMinute, type RuntimePhysicalBody } from "./runtime-state.ts";
import {
  allocateSwarm, conferenceDensity, createBoxInState, createCalendarRoutines,
  createDroneState, createRecruitState, createRobotBodyState, createTheftState, createTidyState,
  parrotFlock, patrolTerms, signSpinnerPose, stepBoxIn, stepCalendarRoutines, stepDrone,
  stepRecruits, stepRobotBody, stepTheft, stepTidy,
  type BoxInState, type CalendarRoutineState, type DroneState, type RecruitState, type RobotBodyState,
  type RoutineActor, type RoutineMotion, type RoutinePoint, type TheftState, type TidyState, type RobotEmote,
} from "./routines.ts";
import { buildFallbackSidewalkGraph, shortestSidewalkRoute, type SidewalkGraph } from "./navigation.ts";
import { createAssociateTransportState, stepAssociateTransport, type AssociateRiderBinding, type AssociateTransportState } from "./associate-transport.ts";
import { planTransportRoadRoute, type RecruitTaxiRoute } from "./recruit-transport.ts";
import { deriveWalkerPatrolRoute } from "./walker-route.ts";

// Twenty-four players can each have the six baseline roles and an eight-unit swarm.
// The shared significant population budget still caps all later-wave bodies together.
export const MAX_ROUTINE_BODIES = 512;
export const ROGUE_TAXI_ARRIVAL_M = 1;
export const ROGUE_TAXI_TURN_RATE = 1.2;
const MAX_PENDING_EFFECTS = 128;
type Role = "drone" | "patrol" | "tidy" | "sign-spinner" | "associate" | "thief" | "rogue-taxi" | "parrot";
interface TravelPlan { goal: RoutinePoint; points: RoutinePoint[]; index: number }
interface SpecialState {
  body: RuntimePhysicalBody; role: Role; ownerId: string; plan: TravelPlan | null;
  drone: DroneState | null; boxIn: BoxInState | null; tidy: TidyState | null;
  theft: TheftState | null; stolenOwnerId: string | null; carryingHeapId: string | null;
  attackSequence: number; nextTermsTick: number;
  theftRoute?: RecruitTaxiRoute | null;
  nextPlanTick?: number;
  planGoal?: RoutinePoint;
  patrolGoal?: RoutinePoint;
}
interface ControlledBody { playerId: string; model: "footman" | "trundle"; state: RobotBodyState }
interface FinaleRuntime { body: RuntimePhysicalBody; route: FinaleRoute; state: FinaleState; landingId: string | null; applied: string[] }
export interface RoutineRuntimeEffect {
  id: string; kind: string; actorId: string; playerId: string; targetId: string;
  position: RoutinePoint | null; amount: number;
}
export interface RoutineRuntimeState {
  version: 1; tick: number; initializedOwners: string[]; calendar: CalendarRoutineState;
  specials: SpecialState[]; recruits: { playerId: string; state: RecruitState }[];
  controlled: ControlledBody[]; finales: FinaleRuntime[];
  eventCursors: { key: string; sequence: number }[]; threatReceipts: string[];
  pendingEffects: RoutineRuntimeEffect[];
  swarms?: { playerId: string; threat: number; lastRequestTick: number }[];
  associateTransport?: AssociateTransportState;
  spawnRetries?: { key: string; nextTick: number }[];
  threatSpawnQueue?: { id: string; role: Role; playerId: string; remaining: number }[];
}
export interface RoutineRuntimeOptions {
  bodies: readonly RuntimePhysicalBody[]; actors: readonly CombatActor[]; nextActorId: number;
  reputations?: Readonly<Record<string, number>>;
  recruitOffers?: Readonly<Record<string, { playerId: string; offeredTick: number }>>;
  convertedIds?: readonly string[];
  threatRequests?: readonly ThreatSpawnRequest[];
  effectAcks?: readonly string[];
  /** Body owners report rides and restoration only after applying the physical action. */
  recruitObservations?: Readonly<Record<string, { boardedSequence?: number; restored?: boolean }>>;
  actorDistricts?: Readonly<Record<string, string>>;
  conferenceCenter?: RoutinePoint;
  remainingSignificantCapacity?: number;
  threatLevels?: Readonly<Record<string, number>>;
  /** Transport owns these actors' motion until they physically disembark. */
  boundActorIds?: readonly string[];
  carriedBodies?: readonly RuntimePhysicalBody[];
  /** Authored, connected threat-five Walker patrol. No route means no implicit boss. */
  walkerRoute?: FinaleRoute;
  /** Optional deterministic warm-up budget for controlled fixtures; production defaults4. */
  spawnBudget?: number;
}
export type RoutineActorMetadata = Partial<CombatActor> & {
  readonly robotEmote?: RobotEmote;
  readonly robotTells?: readonly string[];
  readonly honking?: boolean;
};
export interface RoutineRuntimeStep {
  state: RoutineRuntimeState; bodies: RuntimePhysicalBody[]; nextActorId: number;
  actorMetadata: Record<string, RoutineActorMetadata>; attackRequests: AttackRequest[]; finaleWeakPoints: CombatActor[];
  effects: RoutineRuntimeEffect[]; playerOverrides: Record<string, PlayerState>; restoreIds: number[];
  diagnostics: string[]; conference: ReturnType<typeof conferenceDensity> & { center?: RoutinePoint; radiusM?: number };
  swarmAssignments: { actorId: string; playerId: string; role: "melee" | "ranged" }[];
  swarmSuppressedIds: string[];
  associateRiderBindings: AssociateRiderBinding[];
}

const cmp = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const d2 = (a: { x: number; z: number }, b: { x: number; z: number }): number => (((a.x - b.x)) * ((a.x - b.x))) + (((a.z - b.z)) * ((a.z - b.z)));
const p3 = (a: RoutinePoint): RoutinePoint => ({ x: a.x, y: a.y, z: a.z });
const roleModel = (role: Role): string => role === "thief" ? "footman" : role === "rogue-taxi" ? "robotaxi" : role;
const roleKind = (role: Role): RuntimePhysicalBody["kind"] => role === "associate" ? "person" : role === "parrot" ? "animal" : role === "rogue-taxi" ? "vehicle" : "robot";
const airborne = (role: Role): boolean => role === "drone" || role === "parrot";
function bodyActor(body: RuntimePhysicalBody): RoutineActor {
  return { id: body.id, kind: body.kind, x: body.x, y: body.y, z: body.z, heading: body.heading, speed: body.speed, operational: body.operational !== false, firmware: body.firmware ?? "none" };
}
function combatActor(actor: CombatActor, state: SimSystemContext["state"]): RoutineActor {
  const target = state.ext.combat?.targets[actor.id];
  return { ...actor, operational: !target || target.phase === "active", firmware: actor.firmware };
}
function copyBody(body: RuntimePhysicalBody): RuntimePhysicalBody {
  return { ...body, previousX: body.x, previousZ: body.z, previousHeading: body.heading, dodge: body.dodge ? { ...body.dodge } : null };
}
function preserveBody(body: RuntimePhysicalBody): RuntimePhysicalBody {
  return { ...body, dodge: body.dodge ? { ...body.dodge } : null };
}
function validPoint(value: unknown): value is RoutinePoint {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return [p.x, p.y, p.z].every(n => typeof n === "number" && Number.isFinite(n) && Math.abs(n) < 1e7);
}
const graphCache = new WeakMap<World, SidewalkGraph | null>();
function graphFor(world: World): SidewalkGraph | null {
  if (graphCache.has(world)) return graphCache.get(world)!;
  const graph = world.roads ? buildFallbackSidewalkGraph(world.roads) : null;
  graphCache.set(world, graph);
  return graph;
}
function districtFor(world: World, at: { x: number; z: number }): string {
  let bestDistance = 500 * 500, bestId = "", district = "unknown";
  for (const anchor of world.gameplay?.anchors ?? []) {
    const distance = d2(anchor, at);
    if (distance <= bestDistance && (distance < bestDistance || !bestId || cmp(anchor.id, bestId) < 0)) {
      bestDistance = distance; bestId = anchor.id; district = anchor.districtId;
    }
  }
  return district;
}
function safeSpot(world: World, body: RuntimePhysicalBody, at: RoutinePoint, all: readonly RuntimePhysicalBody[], actors: readonly CombatActor[]): boolean {
  if (!validPoint(at)) return false;
  const selfRadius = body.kind === "vehicle" ? Math.sqrt(body.halfLength * body.halfLength + body.halfWidth * body.halfWidth) : body.radius;
  if (body.kind === "vehicle") {
    const box = { x: at.x, z: at.z, heading: body.heading, hl: body.halfLength, hw: body.halfWidth };
    if (circleBlocked(world, at.x, at.z, selfRadius) || boxBlocked(world, box, at.y) || boxCrossedWall(world, box, { x: body.x, z: body.z, heading: body.heading })) return false;
  } else if (circleBlocked(world, at.x, at.z, body.radius)) return false;
  for (const other of all) {
    if (other.id === body.id || Math.abs(other.y - at.y) >= Math.max(other.height, body.height)) continue;
    const limit = selfRadius + (other.kind === "vehicle" ? Math.sqrt(((other.halfLength) * (other.halfLength)) + ((other.halfWidth) * (other.halfWidth))) : other.radius) + 0.2;
    if (d2(other, at) < ((limit) * (limit))) return false;
  }
  for (const other of actors) {
    if (other.id === body.id || Math.abs(other.y - at.y) >= Math.max(other.height, body.height)) continue;
    const otherRadius = other.model === "robotaxi" ? 2.4 : other.radius;
    if (d2(other, at) < (selfRadius + otherRadius + 0.2) * (selfRadius + otherRadius + 0.2)) return false;
  }
  return true;
}
function directMove(world: World, body: RuntimePhysicalBody, goal: RoutinePoint, speed: number, all: readonly RuntimePhysicalBody[], actors: readonly CombatActor[], fly = false): RuntimePhysicalBody {
  if (body.dodge) return { ...body, speed: 0 };
  const requestedSpeed = body.kind === "vehicle" ? Math.min(Math.max(0, speed), Math.max(0, body.speed) + 6 * DT) : Math.max(0, speed);
  const distance = Math.sqrt(d2(body, goal)), travel = Math.min(distance, requestedSpeed * DT);
  if (travel === 0) return { ...body, speed: 0 };
  const at = { x: body.x + (goal.x - body.x) / distance * travel, z: body.z + (goal.z - body.z) / distance * travel, y: 0 };
  at.y = fly ? body.y + clamp(goal.y - body.y, -3 * DT, 3 * DT) : meshGroundHeight(world, at.x, at.z);
  if (segmentBlocked(world, body.x, body.z, at.x, at.z) || !safeSpot(world, body, at, all, actors)) return { ...body, speed: 0 };
  return { ...body, ...at, speed: travel / DT, heading: datan2(goal.x - body.x, body.z - goal.z) };
}
function routePoints(world: World, graph: SidewalkGraph | null, body: RuntimePhysicalBody, goal: RoutinePoint): RoutinePoint[] | null {
  if (!graph || graph.nodes.length === 0) return null;
  const start = nearestSidewalkNode(graph, body)!, end = nearestSidewalkNode(graph, goal)!;
  if (segmentBlocked(world, body.x, body.z, start.x, start.z)) return null;
  const route = shortestSidewalkRoute(graph, start.id, end.id, edge => edge.kind === "stairs");
  if (!route) return null;
  const points: RoutinePoint[] = [{ x: start.x, y: meshGroundHeight(world, start.x, start.z), z: start.z }];
  for (const step of route.steps) {
    const edge = graph.edgeById.get(step.edgeId)!;
    const indices = Array.from({ length: edge.path.xs.length }, (_, i) => step.reverse ? edge.path.xs.length - 1 - i : i);
    for (const i of indices) points.push({ x: edge.path.xs[i]!, z: edge.path.zs[i]!, y: meshGroundHeight(world, edge.path.xs[i]!, edge.path.zs[i]!) });
  }
  if (!segmentBlocked(world, end.x, end.z, goal.x, goal.z)) points.push(p3(goal));
  return points.length <= 2048 ? points : null;
}
function moveSpecial(world: World, graph: SidewalkGraph | null, special: SpecialState, motion: RoutineMotion, all: readonly RuntimePhysicalBody[], actors: readonly CombatActor[], tick: number): SpecialState {
  const body = special.body;
  if (motion.kind === "hold" || motion.speedMps <= 0) return { ...special, body: { ...body, speed: 0 } };
  if (airborne(special.role)) return { ...special, body: directMove(world, body, motion.target, motion.speedMps, all, actors, true) };
  let plan = special.plan;
  if (!plan || d2(plan.goal, motion.target) > 9 || plan.index >= plan.points.length) {
    if ((special.nextPlanTick ?? 0) > tick && special.planGoal && d2(special.planGoal, motion.target) <= 9) return { ...special, body: { ...body, speed: 0 } };
    const points = routePoints(world, graph, body, motion.target);
    plan = points ? { goal: p3(motion.target), points, index: 0 } : null;
    special = { ...special, planGoal: p3(motion.target), nextPlanTick: points ? tick : tick + TICK_HZ };
  }
  if (!plan) return { ...special, body: { ...body, speed: 0 }, plan: null };
  while (plan.index < plan.points.length - 1 && d2(body, plan.points[plan.index]!) < 0.25) plan = { ...plan, index: plan.index + 1 };
  return { ...special, plan, body: directMove(world, body, plan.points[plan.index]!, motion.speedMps, all, actors) };
}
function spawn(world: World, id: number, role: Role, ownerId: string, near: RoutinePoint, bodies: readonly RuntimePhysicalBody[], actors: readonly CombatActor[]): SpecialState | null {
  const kind = roleKind(role), hl = kind === "vehicle" ? 2.2 : role === "patrol" ? 0.7 : 0.35;
  const body: RuntimePhysicalBody = { id: `agent:${id}`, numericId: id, kind, model: roleModel(role), ...p3(near), previousX: near.x, previousZ: near.z, heading: 0, previousHeading: 0, speed: 0, radius: kind === "vehicle" ? 1.1 : 0.4, halfLength: hl, halfWidth: kind === "vehicle" ? 0.95 : 0.35, height: role === "drone" || role === "parrot" ? 0.5 : 1.6, dodge: null };
  body.firmware = role === "tidy" ? "good" : role === "associate" || role === "parrot" ? "none" : "bad";
  body.operational = true;
  const candidates = routineSpawnCandidates(world, near, kind === "vehicle" ? "vehicle" : "walking", role === "drone" ? 6 : role === "parrot" ? 7 : 0);
  const at = candidates.find(p => safeSpot(world, body, p, bodies, actors));
  if (!at) return null;
  return { body: { ...body, ...at, previousX: at.x, previousZ: at.z, district: districtFor(world, at) }, role, ownerId, plan: null,
    drone: role === "drone" ? createDroneState() : null, boxIn: role === "rogue-taxi" ? createBoxInState() : null,
    tidy: role === "tidy" ? createTidyState() : null, theft: role === "thief" ? createTheftState() : null,
    stolenOwnerId: null, carryingHeapId: null, attackSequence: 0, nextTermsTick: 0 };
}
function observedPlayer(context: SimSystemContext, playerId: string): RoutineActor | null {
  const player = context.state.players[playerId];
  if (!player) return null;
  const body = player.mode === "foot" && player.foot ? player.foot : player.car;
  return { id: playerId, kind: "player", ...body, firmware: "none", operational: true };
}
function protectedBodies(context: SimSystemContext, actors: readonly CombatActor[], bodies: readonly RuntimePhysicalBody[]): { id: string; kind: "person" | "animal"; x: number; z: number; radius: number }[] {
  const found = new Map<string, { id: string; kind: "person" | "animal"; x: number; z: number; radius: number }>();
  for (const a of actors) if (a.kind === "person" || a.kind === "animal" || a.kind === "player") found.set(a.id, { id: a.id, kind: a.kind === "animal" ? "animal" : "person", x: a.x, z: a.z, radius: a.radius });
  for (const a of context.state.ext.agents?.list ?? []) if (a.kind === "person") found.set(`agent:${a.id}`, { id: `agent:${a.id}`, kind: "person", x: a.x, z: a.z, radius: 0.35 });
  for (const b of bodies) if (b.kind === "person" || b.kind === "animal") found.set(b.id, { id: b.id, kind: b.kind, x: b.x, z: b.z, radius: b.radius });
  for (const b of bodies) if (["bus", "recruit-taxi", "associate-car", "associate-scooter"].includes(b.model)) found.set(b.id, { id: b.id, kind: "person", x: b.x, z: b.z, radius: Math.sqrt(b.halfLength * b.halfLength + b.halfWidth * b.halfWidth) });
  for (const id of sortedIds(context.state.players)) {
    const player = context.state.players[id]!;
    const at = player.mode === "foot" && player.foot ? player.foot : player.car;
    found.set(`player:${id}`, { id: `player:${id}`, kind: "person", x: at.x, z: at.z, radius: player.mode === "foot" ? 0.35 : 2.4 });
  }
  return [...found.values()].sort((a, b) => cmp(a.id, b.id));
}
/** Authored foot geometry cannot shrink the Walker's physical 4 by 2 m half-extents. */
export function routineFinaleBodyClear(kind: "walker" | "elizabeth", point: { x: number; z: number }, people: readonly { x: number; z: number; radius: number }[], travel = 0): boolean {
  if (kind !== "walker") return true;
  return people.every(body => { const radius = 4.5 + body.radius + travel; return d2(body, point) > radius * radius; });
}
function reputation(options: RoutineRuntimeOptions, playerId: string): number { return options.reputations?.[playerId] ?? 0; }
function effect(id: string, kind: string, actorId: string, playerId = "", targetId = "", position: RoutinePoint | null = null, amount = 0): RoutineRuntimeEffect {
  return { id, kind, actorId, playerId, targetId, position, amount };
}
export function createRoutineRuntime(tick = 0): RoutineRuntimeState {
  if (!Number.isSafeInteger(tick) || tick < 0) throw new RangeError("Invalid routine runtime tick");
  return { version: 1, tick, initializedOwners: [], calendar: createCalendarRoutines(), specials: [], recruits: [], controlled: [], finales: [], eventCursors: [], threatReceipts: [], pendingEffects: [] };
}

/** Called before the final clearance pass. No action here licenses later movement. */
export function stepRoutineRuntime(context: SimSystemContext, previous: RoutineRuntimeState, options: RoutineRuntimeOptions): RoutineRuntimeStep {
  const tick = context.state.tick, session = agentRuntimeSession(context.state);
  if (previous.version !== 1 || tick !== context.previous.tick + 1 || previous.tick !== context.previous.tick || !Number.isSafeInteger(options.nextActorId) || options.nextActorId < 0 || options.bodies.length > 2800 || options.actors.length > 4096 || previous.specials.length > MAX_ROUTINE_BODIES) throw new Error("Invalid routine runtime context");
  if (new Set(options.bodies.map(b => b.id)).size !== options.bodies.length || new Set(options.actors.map(a => a.id)).size !== options.actors.length) throw new Error("Duplicate routine runtime actor");
  if (options.remainingSignificantCapacity !== undefined && (!Number.isSafeInteger(options.remainingSignificantCapacity) || options.remainingSignificantCapacity < 0)) throw new RangeError("Invalid significant capacity");
  const boundIds = new Set(options.boundActorIds ?? []), externallyMoved = new Set<string>();
  const ownBody = (old: RuntimePhysicalBody): RuntimePhysicalBody => {
    const carried = options.carriedBodies?.find(b => b.id === old.id);
    const current = carried ?? options.bodies.find(b => b.id === old.id) ?? old;
    if (carried || current.x !== old.x || current.y !== old.y || current.z !== old.z) { externallyMoved.add(old.id); return preserveBody(current); }
    return copyBody(current);
  };
  const state: RoutineRuntimeState = { ...previous, tick, initializedOwners: [...previous.initializedOwners], specials: previous.specials.map(s => ({ ...s, body: ownBody(s.body), plan: s.plan ? { ...s.plan, points: s.plan.points.map(p3), goal: p3(s.plan.goal) } : null })), recruits: previous.recruits.map(r => ({ ...r })), controlled: previous.controlled.map(c => ({ ...c })), finales: previous.finales.map(f => ({ ...f, body: ownBody(f.body), applied: [...f.applied] })), eventCursors: previous.eventCursors.map(e => ({ ...e })), threatReceipts: [...previous.threatReceipts], pendingEffects: previous.pendingEffects.filter(e => !options.effectAcks?.includes(e.id)).map(e => ({ ...e, position: e.position ? p3(e.position) : null })) };
  let nextActorId = options.nextActorId;
  let remainingCapacity = options.remainingSignificantCapacity ?? 2000;
  if (options.spawnBudget !== undefined && (!Number.isSafeInteger(options.spawnBudget) || options.spawnBudget < 0 || options.spawnBudget > 128)) throw new RangeError("Invalid routine spawn budget");
  let spawnBudget = options.spawnBudget ?? 4;
  state.spawnRetries = (previous.spawnRetries ?? []).filter(retry => retry.nextTick > tick).map(retry => ({ ...retry }));
  state.threatSpawnQueue = (previous.threatSpawnQueue ?? []).filter(job => context.state.players[job.playerId]).map(job => ({ ...job }));
  const priorRuntime = context.previous.ext.agents as unknown as { runtime?: { effectState?: {
    bindings?: { heapId: string; tidyId: string }[];
    carClaims?: { actorId: string; carId: string; sequence: number; tick: number }[];
    landingReceipts?: FinaleLandingAck[];
  } } } | undefined;
  const physicalReceipts = priorRuntime?.runtime?.effectState;
  const actorMetadata: Record<string, RoutineActorMetadata> = {}, attackRequests: AttackRequest[] = [], finaleWeakPoints: CombatActor[] = [], playerOverrides: Record<string, PlayerState> = {}, restoreIds: number[] = [], diagnostics: string[] = [];
  const swarmAssignments: RoutineRuntimeStep["swarmAssignments"] = [], swarmSuppressedIds: string[] = [];
  let associateRiderBindings: AssociateRiderBinding[] = [];
  state.swarms = (previous.swarms ?? []).map(s => ({ ...s })).filter(s => playersInState(context).includes(s.playerId) && tick - s.lastRequestTick <= 120 * TICK_HZ);
  const ownIds = new Set([...state.specials.map(s => s.body.id), ...state.finales.map(f => f.body.id)]);
  let bodies = options.bodies.filter(b => !ownIds.has(b.id)).map(preserveBody);
  const actors = options.actors.map(a => ({ ...a }));
  const players = sortedIds(context.state.players);
  const queue = (e: RoutineRuntimeEffect): void => {
    if (!state.pendingEffects.some(p => p.id === e.id)) {
      if (state.pendingEffects.length >= MAX_PENDING_EFFECTS) { diagnostics.push("routine-effect-capacity"); return; }
      state.pendingEffects.push(e);
    }
  };
  const addSpecial = (role: Role, ownerId: string): SpecialState | null => {
    const key = `${ownerId}/${role}`;
    const owner = observedPlayer(context, ownerId);
    if (!owner || state.specials.length >= MAX_ROUTINE_BODIES || nextActorId >= Number.MAX_SAFE_INTEGER || remainingCapacity <= 0 || spawnBudget <= 0 || state.spawnRetries!.some(retry => retry.key === key)) return null;
    spawnBudget--;
    const created = spawn(context.world, nextActorId, role, ownerId, owner, [...bodies, ...state.specials.map(s => s.body)], actors);
    if (created) { state.specials.push(created); nextActorId++; remainingCapacity--; }
    else { diagnostics.push(`no-safe-spawn:${role}:${ownerId}`); state.spawnRetries!.push({ key, nextTick: tick + TICK_HZ }); }
    return created;
  };
  if (!session || session.wave < 3) return { state, bodies: options.bodies.map(preserveBody), nextActorId, actorMetadata, attackRequests, finaleWeakPoints, swarmAssignments, swarmSuppressedIds, associateRiderBindings, effects: [], playerOverrides, restoreIds, diagnostics, conference: { badRateMultiplier: 1, lanyardCrowd: false } };
  const graph = graphFor(context.world);
  const initialRoles = ["drone", "patrol", "tidy", "sign-spinner", "associate", "thief"] as const;
  for (const id of players) if (!state.initializedOwners.includes(id)) {
    for (const role of initialRoles) if (!state.specials.some(s => s.ownerId === id && s.role === role)) addSpecial(role, id);
    if (initialRoles.every(role => state.specials.some(s => s.ownerId === id && s.role === role))) state.initializedOwners.push(id);
  }
  for (const request of [...(options.threatRequests ?? [])].sort((a, b) => a.requestTick - b.requestTick || cmp(a.id, b.id))) {
    if (request.kind === "van" || request.requestTick > tick || request.requestTick < tick - 1200 || state.threatReceipts.includes(request.id) || !players.includes(request.playerId)) continue;
    if (state.threatReceipts.length >= 512) { diagnostics.push("routine-threat-history-capacity"); break; }
    state.threatReceipts.push(request.id);
    if (request.kind === "swarm" && request.threat >= 4) {
      const existing = state.swarms.find(s => s.playerId === request.playerId);
      if (existing) { existing.threat = request.threat; existing.lastRequestTick = tick; }
      else state.swarms.push({ playerId: request.playerId, threat: request.threat, lastRequestTick: tick });
    }
    const role = request.kind === "taxi" ? "rogue-taxi" : request.kind === "drone" ? "drone" : "patrol";
    state.threatSpawnQueue.push({ id: request.id, role, playerId: request.playerId, remaining: Math.min(8, request.unitCount) });
  }
  for (const job of state.threatSpawnQueue) while (job.remaining > 0 && spawnBudget > 0) {
    if (!addSpecial(job.role, job.playerId)) break;
    job.remaining--;
  }
  state.threatSpawnQueue = state.threatSpawnQueue.filter(job => job.remaining > 0);
  const accepted = new Map<string, Set<string>>();
  const automaticWalkerEvents: { kind: string; tick: number; playerId: string; payload: { sequence: number; kind: string; route: FinaleRoute } }[] = [];
  if (session.wave >= 8) for (const playerId of players) {
    const level = options.threatLevels?.[playerId] ?? Math.max(0, ...(options.threatRequests ?? []).filter(r => r.playerId === playerId).map(r => r.threat));
    if (level < 5 || state.finales.length + automaticWalkerEvents.length >= 2 || state.eventCursors.some(c => c.key === `agents.finale.start/${playerId}`)) continue;
    const derived = options.walkerRoute ? null : deriveWalkerPatrolRoute(context.world, observedPlayer(context, playerId)!, protectedBodies(context, actors, [...bodies, ...state.specials.map(s => s.body)]));
    const route = options.walkerRoute ?? derived?.route;
    if (!route) { diagnostics.push(derived?.diagnostic ?? "walker-needs-safe-patrol-route"); continue; }
    automaticWalkerEvents.push({ kind: "agents.finale.start", tick, playerId, payload: { sequence: 0, kind: "walker", route: { ...route, id: `${route.id}:${playerId}` } } });
  }
  for (const e of [...context.events, ...automaticWalkerEvents]) {
    if (!["agents.recruit", "agents.robot-body.start", "agents.finale.start"].includes(e.kind)) continue;
    const payload = e.payload && typeof e.payload === "object" && !Array.isArray(e.payload) ? e.payload as Record<string, unknown> : null;
    if (!e.playerId || !players.includes(e.playerId) || !payload || !Number.isSafeInteger(payload.sequence) || Number(payload.sequence) < 0 || e.tick !== tick) { diagnostics.push(`invalid-event:${e.kind}`); continue; }
    const key = `${e.kind}/${e.playerId}`, prior = state.eventCursors.find(c => c.key === key);
    if (prior && Number(payload.sequence) <= prior.sequence) continue;
    if (!prior && state.eventCursors.length >= 72) { diagnostics.push("routine-event-cursor-capacity"); continue; }
    if (prior) prior.sequence = Number(payload.sequence); else state.eventCursors.push({ key, sequence: Number(payload.sequence) });
    if (e.kind === "agents.recruit") {
      if (!isGameplayId(payload.actorId)) { diagnostics.push("invalid-recruit-id"); continue; }
      const list = accepted.get(e.playerId) ?? new Set<string>(); list.add(payload.actorId); accepted.set(e.playerId, list);
    } else if (e.kind === "agents.robot-body.start") {
      if (session.wave < 7 || (payload.model !== "footman" && payload.model !== "trundle") || state.controlled.some(c => c.playerId === e.playerId) || context.state.players[e.playerId]!.mode !== "foot") { diagnostics.push("robot-body-unavailable"); continue; }
      state.controlled.push({ playerId: e.playerId, model: payload.model, state: createRobotBodyState() });
    } else {
      if (session.wave < 8 || state.finales.length >= 2 || remainingCapacity <= 0 || nextActorId >= Number.MAX_SAFE_INTEGER || (payload.kind !== "walker" && payload.kind !== "elizabeth") || !payload.route || typeof payload.route !== "object") { diagnostics.push("finale-unavailable"); continue; }
      try {
        const route = payload.route as FinaleRoute, at = route.waypoints[0]!;
        const radius = payload.kind === "walker" ? 4.5 : 20;
        if (route.waypoints.some((waypoint, index) => circleBlocked(context.world, waypoint.x, waypoint.z, radius) || index > 0 && segmentBlocked(context.world, route.waypoints[index - 1]!.x, route.waypoints[index - 1]!.z, waypoint.x, waypoint.z))) { diagnostics.push("blocked-finale-route"); continue; }
        const coverage = { tick, complete: true, bodies: protectedBodies(context, actors, [...bodies, ...state.specials.map(s => s.body)]) };
        if (!finaleFootfallClear(payload.kind, at, coverage, tick) || !routineFinaleBodyClear(payload.kind, at, coverage.bodies)) { diagnostics.push("unsafe-finale-spawn"); continue; }
        const finale = createFinaleState({ kind: payload.kind, route, position: { x: at.x, z: at.z }, tick, absorbedRobotIds: Array.isArray(payload.absorbedRobotIds) ? payload.absorbedRobotIds as string[] : [] });
        const body: RuntimePhysicalBody = { id: `agent:${nextActorId}`, numericId: nextActorId++, kind: "robot", model: payload.kind === "walker" ? "walker" : "elizabeth", x: at.x, y: meshGroundHeight(context.world, at.x, at.z), z: at.z, previousX: at.x, previousZ: at.z, heading: 0, previousHeading: 0, speed: 0, radius: payload.kind === "walker" ? 3 : 20, halfLength: payload.kind === "walker" ? 4 : 40, halfWidth: payload.kind === "walker" ? 2 : 20, height: payload.kind === "walker" ? 3 : 500, dodge: null };
        remainingCapacity--;
        // Only named joints accept combat rust; the large structural body is never a
        // second generic target that can melt independently of the finale policy.
        body.firmware = "none"; body.operational = true; body.district = districtFor(context.world, body);
        state.finales.push({ body, route: JSON.parse(JSON.stringify(route)) as FinaleRoute, state: finale, landingId: null, applied: [] });
      } catch { diagnostics.push("invalid-finale-route"); }
    }
  }

  const gameSecond = (session.startWeekday * 1440 + runtimeGameMinute(context.state)) * 60;
  const calendarActors = [...actors.map(a => ({ ...combatActor(a, context.state), kind: a.model === "robotaxi" ? "vehicle" as const : a.kind, model: a.model ?? "person", district: options.actorDistricts?.[a.id] ?? districtFor(context.world, a) })), ...state.specials.filter(s => !actors.some(a => a.id === s.body.id)).map(s => ({ ...bodyActor(s.body), model: s.body.model, district: s.body.district ?? "unknown" }))];
  const calendar = stepCalendarRoutines(state.calendar, { tick, gameSecond, actors: calendarActors, citywideFreeze: session.wave >= 4 });
  state.calendar = calendar.state;
  const holdIds = new Set(calendar.holds.map(h => h.actorId));
  for (const event of calendar.events) queue(effect(event.id, event.kind, ""));
  for (const held of calendar.holds) {
    const id = robotAgentId(held.actorId), before = context.previous.ext.agents?.list.find(a => a.id === id);
    actorMetadata[held.actorId] = { ...actorMetadata[held.actorId], ...(before ? { x: before.x, y: before.y, z: before.z } : {}), speed: 0 };
  }
  const conventionDistance = options.conferenceCenter && players.length ? Math.min(...players.map(id => Math.sqrt(d2(observedPlayer(context, id)!, options.conferenceCenter!)))) : 10000;
  const conference = { ...conferenceDensity(Math.floor(gameSecond / (86400 * 7)), conventionDistance <= 600, conventionDistance, false), ...(options.conferenceCenter ? { center: p3(options.conferenceCenter), radiusM: 600 } : {}) };
  const swarmUnitMap = new Map(actors.map(a => [a.id, combatActor(a, context.previous)]));
  const swarmModels = new Map(actors.map(a => [a.id, a.model ?? ""]));
  for (const special of state.specials) if (!boundIds.has(special.body.id)) {
    const actor = bodyActor(special.body), combat = context.previous.ext.combat?.targets[actor.id];
    swarmUnitMap.set(actor.id, { ...actor, operational: actor.operational && (!combat || combat.phase === "active") });
    swarmModels.set(actor.id, special.body.model);
  }
  const claimed = new Set<string>();
  for (const playerId of players) {
    const owner = observedPlayer(context, playerId)!, saved = state.swarms.find(s => s.playerId === playerId);
    const level = options.threatLevels?.[playerId] ?? saved?.threat ?? 0;
    if (level < 4) continue;
    const eligible = [...swarmUnitMap.values()].filter(a => a.kind === "robot" && a.firmware === "bad" && a.operational && !claimed.has(a.id) && !["drone", "walker", "robotaxi"].includes(swarmModels.get(a.id) ?? ""));
    const assigned = allocateSwarm(eligible, owner, level);
    for (const unit of assigned) { claimed.add(unit.id); swarmAssignments.push({ actorId: unit.id, playerId, role: unit.role }); }
    for (const unit of eligible) if (unit.kind === "robot" && unit.firmware === "bad" && unit.operational && d2(unit, owner) <= 120 * 120 && !assigned.some(a => a.id === unit.id)) swarmSuppressedIds.push(unit.id);
  }

  for (let i = 0; i < state.specials.length; i++) {
    let special = state.specials[i]!;
    if (boundIds.has(special.body.id)) { state.specials[i] = special; continue; }
    const observed = actors.find(a => a.id === special.body.id);
    const priorRobots = context.previous.ext.robots as unknown as { metadata?: { actorId: string; firmware: "good" | "bad" }[]; restoredAgentIds?: number[] } | undefined;
    const persistentFirmware = priorRobots?.metadata?.find(m => m.actorId === special.body.id)?.firmware;
    if (persistentFirmware) special.body.firmware = persistentFirmware;
    else if (observed && special.body.firmware === undefined) special.body.firmware = observed.firmware;
    const converted = context.previous.ext.combat?.events?.some(e => e.tick === context.previous.tick && e.kind === "robot.converted" && e.targetId === special.body.id);
    if (converted) special.body.firmware = "bad";
    else if (priorRobots?.restoredAgentIds?.includes(special.body.numericId)) special.body.firmware = "good";
    const owner = observedPlayer(context, special.ownerId), self = bodyActor(special.body);
    const combat = context.previous.ext.combat?.targets[special.body.id];
    const hostileRole = special.role === "drone" || special.role === "patrol" || special.role === "thief" || special.role === "rogue-taxi";
    if (!owner || !self.operational || combat && combat.phase !== "active" || hostileRole && self.firmware !== "bad" || special.role === "tidy" && self.firmware !== "good") {
      if (special.theft?.phase === "driving" && special.stolenOwnerId) {
        const p = context.state.players[special.stolenOwnerId];
        if (p?.mode === "foot") playerOverrides[special.stolenOwnerId] = { ...p, car: { ...p.car, speed: 0, lateral: 0, yawRate: 0 } };
        special.theft = { ...special.theft, phase: "recoverable", lastTick: tick };
        queue(effect(`${self.id}/release/${special.theft.sequence}`, "theft.release", self.id, special.stolenOwnerId, `car:${special.stolenOwnerId}`, null, special.theft.sequence));
      }
      special.body.speed = 0; state.specials[i] = special; continue;
    }
    if (externallyMoved.has(special.body.id)) { state.specials[i] = special; continue; }
    if (holdIds.has(self.id)) { special.body.speed = 0; state.specials[i] = special; continue; }
    let motion: RoutineMotion = { kind: "hold", target: p3(self), speedMps: 0, reason: "idle" };
    if (special.role === "drone" && special.drone) {
      const visible = !segmentBlocked(context.world, self.x, self.z, owner.x, owner.z);
      const result = stepDrone(special.drone, { tick, self, groundY: meshGroundHeight(context.world, self.x, self.z), observedTarget: { ...owner, lineOfSight: visible } });
      special.drone = result.state; motion = result.motion;
      if (result.blast) attackRequests.push({ id: `${self.id}/drone/${++special.attackSequence}`, sequence: special.attackSequence, attackerId: self.id, targetId: owner.id, kind: "ad-blast" });
    } else if (special.role === "patrol") {
      const rawMotions = context.previous.ext.robots?.locomotion;
      const policy = Array.isArray(rawMotions) ? (rawMotions as unknown as readonly RobotLocomotion[]).find(item => item.agentId === special.body.numericId)?.intent : undefined;
      const limits = context.previous.ext.combat ? movementLimit(context.previous.ext.combat, observed ?? {
        id: self.id, kind: "robot", firmware: self.firmware, model: "patrol", x: self.x, y: self.y, z: self.z,
        heading: self.heading, speed: self.speed, radius: special.body.radius, height: special.body.height,
      }) : { maxSpeed: null, scale: 1, blind: false, canAttack: true };
      const speed = Math.min(1.8 * limits.scale, limits.maxSpeed ?? 1.8);
      if (policy?.kind === "pursue") {
        const target = { ...policy.destination, y: meshGroundHeight(context.world, policy.destination.x, policy.destination.z) };
        motion = { kind: "route", target, speedMps: d2(self, target) <= policy.stopDistance * policy.stopDistance ? 0 : speed, reason: "patrol-memory" };
      } else if (policy?.kind === "flee") {
        let destination = policy.toward;
        if (!destination && policy.from) {
          const dx = self.x - policy.from.x, dz = self.z - policy.from.z, distance = Math.sqrt(dx * dx + dz * dz);
          destination = distance > 1e-8 ? { x: self.x + dx / distance * 20, z: self.z + dz / distance * 20 } :
            { x: self.x - dsin(self.heading) * 20, z: self.z + dcos(self.heading) * 20 };
        }
        if (destination) motion = { kind: "route", target: { ...destination, y: meshGroundHeight(context.world, destination.x, destination.z) }, speedMps: speed, reason: "patrol-flee" };
      } else if (policy?.kind === "hold") {
        if (policy.face && d2(self, policy.face) > 1e-8) special.body.heading = datan2(policy.face.x - self.x, self.z - policy.face.z);
      } else if (policy?.kind === "errand" && graph) {
        // A local street patrol is independent of the owner's unseen current position.
        let goal = special.patrolGoal;
        if (!goal || d2(self, goal) < 0.25) {
          const node = nearestSidewalkNode(graph, self);
          const choices = node ? (graph.outgoing.get(node.id) ?? []).filter(edge => graph.edgeById.get(edge.edgeId)?.kind !== "stairs") : [];
          const next = choices.length ? graph.nodeById.get(choices[special.body.numericId % choices.length]!.to) : undefined;
          if (next) { goal = { x: next.x, y: meshGroundHeight(context.world, next.x, next.z), z: next.z }; special = { ...special, patrolGoal: goal }; }
        }
        if (goal) motion = { kind: "route", target: goal, speedMps: speed, reason: "patrol-route" };
      }
      if (limits.maxSpeed === 0) motion = { kind: "hold", target: p3(self), speedMps: 0, reason: "combat" };
      let target: RoutineActor | null = null;
      if (policy?.kind === "pursue") {
        const chase = policy.target;
        if (chase.kind === "player") target = observedPlayer(context, chase.id);
        else { const observed = actors.find(a => robotAgentId(a.id) === chase.id); if (observed) target = combatActor(observed, context.state); }
      }
      const toTarget = target ? Math.sqrt(d2(self, target)) : 0;
      const seen = !!target && (toTarget === 0 || (target.x - self.x) * dsin(self.heading) - (target.z - self.z) * dcos(self.heading) >= toTarget * dcos(0.8726646259971648)) &&
        !segmentBlocked(context.world, self.x, self.z, target.x, target.z);
      const terms = target?.kind === "player" && limits.canAttack && seen ? patrolTerms(self, [{ ...target, lineOfSight: true }]) : null;
      if (terms && tick >= special.nextTermsTick) { queue(effect(`${self.id}/terms/${tick}`, "patrol.terms", self.id, target!.id, terms.targetId)); special.nextTermsTick = tick + 10 * TICK_HZ; }
    } else if (special.role === "sign-spinner") {
      special.body.heading = signSpinnerPose(special.body.numericId, tick).angle;
      actorMetadata[self.id] = { heading: special.body.heading };
    } else if (special.role === "associate") motion = { kind: "hold", target: p3(self), speedMps: 0, reason: "associate-transport-owner" };
    else if (special.role === "rogue-taxi" && special.boxIn) {
      const p = context.state.players[special.ownerId]!;
      const blockingGoal = { x: owner.x + dsin(owner.heading) * 10, y: owner.y, z: owner.z - dcos(owner.heading) * 10 };
      const reachedGoal = d2(self, blockingGoal) <= ROGUE_TAXI_ARRIVAL_M * ROGUE_TAXI_ARRIVAL_M;
      const result = stepBoxIn(special.boxIn, { tick, self, target: p.mode === "vehicle" ? { ...owner, kind: "vehicle", occupiedByTarget: true, lineOfSight: !segmentBlocked(context.world, self.x, self.z, owner.x, owner.z) } : null, reachedGoal });
      special.boxIn = result.state; motion = result.motion;
      const limits = context.previous.ext.combat && observed ? movementLimit(context.previous.ext.combat, observed) : null;
      const speed = Math.min(motion.speedMps * (limits?.scale ?? 1), limits?.maxSpeed ?? motion.speedMps);
      // The final metre is approached physically; a route endpoint never acknowledges arrival.
      const roadGoal = d2(self, blockingGoal) <= 64 ? blockingGoal : roadSteeringTarget(context.world, special.body, blockingGoal);
      const remaining = Math.sqrt(d2(self, blockingGoal));
      special.body = limits?.maxSpeed === 0 ? { ...special.body, speed: 0 } : steerRogueTaxi(context.world, special.body, roadGoal,
        Math.min(speed, Math.sqrt(12 * Math.max(0, remaining - 0.3))), result.state.phase === "hold" ? result.desiredHeading : null,
        [...bodies, ...state.specials.map(s => s.body)], actors);
      actorMetadata[self.id] = { ...actorMetadata[self.id], honking: result.honk && limits?.canAttack !== false };
      motion = { kind: "hold", target: p3(special.body), speedMps: 0, reason: "road-follower-applied" };
    } else if (special.role === "tidy" && special.tidy) {
      special.carryingHeapId = physicalReceipts?.bindings?.find(binding => binding.tidyId === self.id)?.heapId ?? null;
      const heaps = actors.filter(a => context.previous.ext.combat?.targets[a.id]?.phase === "heap").map(a => ({ id: a.id, x: a.x, y: a.y, z: a.z, present: true, converted: options.convertedIds?.includes(a.id) ?? false }));
      const kiosks = (context.world.gameplay?.anchors ?? []).filter(a => a.kind === "repair-kiosk").map(a => ({ id: a.id, x: a.x, y: a.y, z: a.z }));
      const target = special.tidy.heapId, pending = previous.pendingEffects.find(e => e.actorId === self.id && e.targetId === target && (e.kind === "heap.restore" || e.kind === "heap.remove"));
      const applied = pending && options.effectAcks?.includes(pending.id);
      const result = stepTidy(special.tidy, { tick, self, heaps, kiosks, carryingHeapId: special.carryingHeapId, restoredAck: applied && target ? { heapId: target, sequence: special.tidy.sequence } : null });
      special.tidy = result.state;
      for (const intent of result.intents) {
        if (intent.kind === "motion") motion = intent.motion;
        else if (intent.kind === "attach-heap") queue(effect(`${self.id}/attach/${intent.sequence}`, "heap.attach", self.id, "", intent.heapId, p3(self)));
        else {
          queue(effect(`${self.id}/restore/${intent.sequence}`, intent.kind === "restore-good" ? "heap.restore" : "heap.remove", self.id, "", intent.heapId, p3(self)));
        }
      }
      if (!kiosks.length) diagnostics.push("tidy-needs-repair-kiosk");
    } else if (special.role === "thief" && special.theft) {
      const choices = players.filter(id => context.state.players[id]!.mode === "foot" && !physicalReceipts?.carClaims?.some(claim => claim.carId === `car:${id}` && claim.actorId !== self.id)).sort((a, b) => d2(context.state.players[a]!.car, self) - d2(context.state.players[b]!.car, self) || cmp(a, b));
      const ownerId = special.stolenOwnerId ?? choices[0], p = ownerId ? context.state.players[ownerId] : null;
      if (p) {
        special.stolenOwnerId = ownerId!;
        const car = p.car, ownerPosition = observedPlayer(context, ownerId!)!, depot = nearestDepot(context.world, car);
        if (!depot) { diagnostics.push("theft-needs-depot"); special.body.speed = 0; state.specials[i] = special; continue; }
        const claim = physicalReceipts?.carClaims?.find(value => value.carId === `car:${ownerId}`), ack = claim?.actorId === self.id ? { carId: claim.carId, sequence: claim.sequence, tick: claim.tick } : null;
        const result = stepTheft(special.theft, { tick, self, car: { id: `car:${ownerId}`, ownerId: ownerId!, ...car, occupied: p.mode === "vehicle" || claim !== undefined, driverId: p.mode === "vehicle" ? ownerId : claim?.actorId ?? null, parked: Math.abs(car.speed) < 0.1, speed: car.speed }, owner: ownerPosition, depot, claimAck: ack, atDepot: d2(car, depot) <= 9, stoppedByCone: (context.previous.ext.combat?.targets[self.id]?.stoppedUntil ?? 0) > tick, thiefDisabled: !self.operational, recoveredByOwner: p.mode === "vehicle" });
        special.theft = result.state;
        if (result.state.phase === "idle" && d2(car, ownerPosition) > 900) motion = { kind: "route", target: p3(car), speedMps: 1.6, reason: "empty-car-approach" };
        for (const intent of result.intents) {
          if (intent.kind === "claim-empty-car") queue(effect(`${self.id}/claim/${intent.sequence}`, "theft.claim", self.id, ownerId!, intent.carId, p3(car), intent.sequence));
          else if (intent.kind === "drive-stolen-car" && p.mode === "foot" && claim?.actorId === self.id) {
            if (!special.theftRoute) special.theftRoute = planTransportRoadRoute(context.world, car, intent.destination, 30);
            if (!special.theftRoute) { diagnostics.push("theft-needs-safe-road-route"); continue; }
            const path = special.theftRoute.path, projection = projectOnPath(path, car.x, car.z);
            const roadTarget = pathPoint(path, Math.min(path.len, projection.s + 8));
            const finishClear = projection.s >= path.len - 2 && !segmentBlocked(context.world, car.x, car.z, intent.destination.x, intent.destination.z) && !circleBlocked(context.world, intent.destination.x, intent.destination.z, 2.4);
            const target = finishClear ? intent.destination : roadTarget;
            const error = wrapAngle(datan2(target.x - car.x, car.z - target.z) - car.heading);
            const remaining = Math.sqrt(d2(car, depot)), desiredSpeed = Math.min(8, Math.sqrt(12 * Math.max(0, remaining - 2)));
            const braking = car.speed > desiredSpeed || remaining <= 2;
            const driven = stepCar(context.world, car, { throttle: braking ? 0 : 0.45, steer: clamp(error * 1.7, -1, 1), brake: braking ? 1 : 0, actions: 0 }, stolenCarObstacles(context, ownerId!, self.id, [...bodies, ...state.specials.map(s => s.body)]));
            playerOverrides[ownerId!] = { ...p, car: driven };
            special.body = { ...special.body, x: driven.x, y: driven.y, z: driven.z, heading: driven.heading, speed: driven.speed };
          } else if (intent.kind === "release-car" && p.mode === "foot") {
            playerOverrides[ownerId!] = { ...p, car: { ...p.car, speed: 0, lateral: 0, yawRate: 0 } };
            queue(effect(`${self.id}/release/${intent.sequence}`, "theft.release", self.id, ownerId!, intent.carId, p3(car), intent.sequence));
          }
        }
      }
    }
    if (holdIds.has(self.id)) motion = { kind: "hold", target: p3(self), speedMps: 0, reason: "calendar" };
    const swarm = swarmAssignments.find(a => a.actorId === self.id), swarmOwner = swarm && observedPlayer(context, swarm.playerId);
    if (swarm && swarmOwner && special.role === "sign-spinner") {
      const index = swarmAssignments.filter(a => a.playerId === swarm.playerId).findIndex(a => a.actorId === self.id);
      const radius = swarm.role === "melee" ? 1.8 : 8;
      const angle = index * 0.7853981633974483;
      motion = { kind: "route", target: { x: swarmOwner.x + dcos(angle) * radius, y: swarmOwner.y, z: swarmOwner.z + dsin(angle) * radius }, speedMps: 1.8, reason: `swarm-${swarm.role}` };
    } else if (swarmSuppressedIds.includes(self.id) && motion.reason !== "patrol-flee") motion = { kind: "hold", target: p3(self), speedMps: 0, reason: "swarm-capacity" };
    if (special.role !== "rogue-taxi" && !(special.role === "thief" && special.theft?.phase === "driving")) special = moveSpecial(context.world, graph, special, motion, [...bodies, ...state.specials.map(s => s.body)], actors, tick);
    if (special.carryingHeapId) {
      const at = { x: special.body.x, y: special.body.y + 0.4, z: special.body.z };
      actorMetadata[special.carryingHeapId] = { ...at, speed: special.body.speed };
      const carried = bodies.find(b => b.id === special.carryingHeapId); if (carried) Object.assign(carried, at);
    }
    state.specials[i] = special;
  }

  if (session.wave >= 4) {
    for (const playerId of players) {
      const owner = observedPlayer(context, playerId)!;
      const old = state.recruits.find(r => r.playerId === playerId) ?? { playerId, state: createRecruitState() };
      const candidates = actors.filter(a => options.recruitOffers?.[a.id]?.playerId === playerId).map(a => ({ ...combatActor(a, context.state), interruptedUpdate: true, accepted: d2(a, owner) <= 16 && (accepted.get(playerId)?.has(a.id) === true || ((context.inputs[playerId]?.actions ?? 0) & Action.interact) !== 0) }));
      const observed = actors.map(a => ({ ...combatActor(a, context.state), boarded: options.recruitObservations?.[a.id]?.boardedSequence !== undefined, boardedSequence: options.recruitObservations?.[a.id]?.boardedSequence, melted: context.previous.ext.combat?.targets[a.id]?.phase === "heap", restored: options.recruitObservations?.[a.id]?.restored ?? false }));
      const rep = reputation(options, playerId);
      // No roster and no actor eligible to join means this tick cannot consume sight.
      const needsSight = old.state.roster.length > 0 || rep >= 60 && candidates.some(candidate =>
        candidate.kind === "robot" && candidate.firmware === "good" && candidate.operational && candidate.interruptedUpdate && candidate.accepted);
      const visibleBadRobots = needsSight ? actors.map(a => ({ ...combatActor(a, context.state),
        lineOfSight: !segmentBlocked(context.world, owner.x, owner.z, a.x, a.z) })) : [];
      const result = stepRecruits(old.state, { tick, owner, reputation: rep, candidates, observations: observed,
        visibleBadRobots, seatCapacity: 3, ownerInVehicle: context.state.players[playerId]!.mode === "vehicle" });
      const index = state.recruits.findIndex(r => r.playerId === playerId); if (index < 0) state.recruits.push({ playerId, state: result.state }); else state.recruits[index] = { playerId, state: result.state };
      for (const intent of result.intents) {
        if (intent.kind === "follow") {
          const original = actors.find(a => a.id === intent.actorId), physical = bodies.find(b => b.id === intent.actorId);
          if (original) {
            const proxy = physical ?? actorBody(original);
            const moved = directMove(context.world, proxy, intent.target, d2(proxy, owner) > 9 ? 1.6 : 0, [...bodies, ...state.specials.map(s => s.body)], actors);
            actorMetadata[intent.actorId] = { x: moved.x, y: moved.y, z: moved.z, heading: moved.heading, speed: moved.speed };
            if (physical) Object.assign(physical, moved);
          }
        } else if (intent.kind === "spot") queue(effect(`${intent.actorId}/spot/${tick}`, "recruit.spot", intent.actorId, playerId, intent.targetId, null, intent.untilTick));
        else queue(effect(`${intent.actorId}/${intent.kind}/${intent.sequence}`, `recruit.${intent.kind}`, intent.actorId, playerId, "", null, intent.sequence));
      }
    }
    const centre = players[0] ? observedPlayer(context, players[0]!) : null;
    if (centre) {
      while (state.specials.filter(s => s.role === "parrot").length < 12 && state.specials.length < MAX_ROUTINE_BODIES) if (!addSpecial("parrot", players[0]!)) break;
      const flock = parrotFlock(context.state.seed >>> 0, tick, centre, state.specials.filter(s => s.role === "parrot").length);
      let n = 0;
      for (const s of state.specials) if (s.role === "parrot") { const goal = flock[n++]!.goal; if (!boundIds.has(s.body.id) && !externallyMoved.has(s.body.id)) s.body = directMove(context.world, s.body, goal, 8, [...bodies, ...state.specials.map(r => r.body)], actors, true); }
    }
  }
  const associateIds = new Set(state.specials.filter(s => s.role === "associate").map(s => s.body.id));
  const associateResult = stepAssociateTransport(context, state.associateTransport ?? createAssociateTransportState(), {
    bodies: [...bodies, ...state.specials.filter(s => !boundIds.has(s.body.id)).map(s => s.body)],
    owners: state.specials.filter(s => s.role === "associate").map(s => ({ bodyId: s.body.id, playerId: s.ownerId })),
    nextActorId, remainingCapacity,
  });
  state.associateTransport = associateResult.state; nextActorId = associateResult.nextActorId;
  associateRiderBindings = associateResult.riderBindings;
  for (const binding of associateRiderBindings) boundIds.add(binding.riderId);
  for (const special of state.specials) if (associateIds.has(special.body.id)) {
    const actual = associateResult.bodies.find(b => b.id === special.body.id); if (actual) special.body = actual;
  }
  bodies = associateResult.bodies.filter(b => !state.specials.some(s => s.body.id === b.id));
  for (const id of sortedIds(associateResult.actorMetadata)) actorMetadata[id] = associateResult.actorMetadata[id]!;
  diagnostics.push(...associateResult.diagnostics);
  for (const control of state.controlled) {
    const p = context.state.players[control.playerId]; if (!p?.foot || p.mode !== "foot") continue;
    const input = context.inputs[control.playerId];
    const protectedNow = protectedBodies(context, actors, [...bodies, ...state.specials.map(s => s.body)]);
    const candidates = graph?.nodes.slice(0, 512).map(n => ({ id: n.id, x: n.x, z: n.z, y: meshGroundHeight(context.world, n.x, n.z), peopleFree: !protectedNow.some(a => a.id !== control.playerId && a.id !== `player:${control.playerId}` && d2(a, n) < (a.radius + 0.5) * (a.radius + 0.5)) && !circleBlocked(context.world, n.x, n.z, 0.35) })) ?? [];
    const combat = context.previous.ext.combat?.targets[`player:${control.playerId}`] ?? context.previous.ext.combat?.targets[control.playerId];
    const pending = control.state.pendingSpawn;
    const ack = pending && d2(p.foot, pending) <= 0.01 ? { generation: control.state.generation + 1, tick, at: p3(p.foot) } : null;
    const result = stepRobotBody(control.state, { tick, self: p.foot, moveX: input?.steer ?? 0, moveZ: -(input?.throttle ?? 0), burst: (input?.brake ?? 0) > 0, emote: ((input?.actions ?? 0) & Action.emote) !== 0 ? "wave" : "none", melted: !!combat && combat.phase !== "active", respawnCoverageComplete: true, respawnCandidates: candidates, spotters: players.filter(id => id !== control.playerId).map(id => observedPlayer(context, id)!), rebindAck: ack });
    control.state = result.state;
    const proxy = actorBody({ id: `player:${control.playerId}`, kind: "player", firmware: "none", ...p.foot, radius: 0.35, height: 1.8 });
    let at = { ...p.foot };
    if (result.rebind) { at = { ...at, ...result.rebind.at, speed: 0 }; queue(effect(`robot-body:${control.playerId}/rebind/${result.rebind.generation}`, "body.rebind", proxy.id, control.playerId, "", result.rebind.at, result.rebind.generation)); }
    else if (control.state.disconnectedTick < 0) {
      const goal = { x: p.foot.x + result.vx, y: p.foot.y, z: p.foot.z + result.vz };
      const moved = directMove(context.world, proxy, goal, Math.sqrt(((result.vx) * (result.vx)) + ((result.vz) * (result.vz))), [...bodies, ...state.specials.map(s => s.body)], actors);
      at = { ...at, x: moved.x, y: moved.y, z: moved.z, heading: result.heading, speed: moved.speed };
    }
    playerOverrides[control.playerId] = { ...p, foot: at };
    actorMetadata[proxy.id] = { ...at, kind: "robot", firmware: "bad", model: control.model, robotBody: true, playerId: control.playerId,
      robotEmote: result.emote, robotTells: [...result.tells] };
  }

  for (const finale of state.finales) {
    finale.body.firmware = "none";
    finale.body.speed = 0;
    if (finale.state.tick === tick) continue;
    const waypoint = finale.route.waypoints[Math.min(finale.state.waypointIndex, finale.route.waypoints.length - 1)]!;
    const goal = { x: waypoint.x, y: meshGroundHeight(context.world, waypoint.x, waypoint.z), z: waypoint.z };
    const clearanceRadius = waypoint.footprint.kind === "circle" ? waypoint.footprint.radius : Math.max(...waypoint.footprint.vertices.map(v => Math.sqrt(v[0] * v[0] + v[1] * v[1])));
    // Crowd evacuation is ordinary measured locomotion. Players retain their controls;
    // their presence keeps the body and footfall safely held until they leave.
    for (const protectedBody of protectedBodies(context, actors, [...bodies, ...state.specials.map(s => s.body)])) {
      if (finaleFootfallClear(finale.state.kind, waypoint, { tick, complete: true, bodies: [protectedBody] }, tick) && routineFinaleBodyClear(finale.state.kind, waypoint, [protectedBody]) || protectedBody.id.startsWith("player:") || players.includes(protectedBody.id)) continue;
      const physical = bodies.find(b => b.id === protectedBody.id) ?? state.specials.find(s => s.body.id === protectedBody.id)?.body;
      const original = actors.find(a => a.id === protectedBody.id);
      if (!physical && !original) continue;
      const source = physical ?? actorBody(original!);
      if (source.kind === "vehicle") continue;
      const priorLegacy = context.previous.ext.agents?.list.find(a => `agent:${a.id}` === source.id);
      const baseline = physical ? { ...source, x: source.previousX, z: source.previousZ, heading: source.previousHeading } : priorLegacy ? { ...source, x: priorLegacy.x, y: priorLegacy.y, z: priorLegacy.z, heading: priorLegacy.heading } : source;
      let dx = source.x - waypoint.x, dz = source.z - waypoint.z, length = Math.sqrt(dx * dx + dz * dz);
      if (length < 0.001) { const angle = (source.numericId % 16) * 0.39269908169872414; dx = dcos(angle); dz = dsin(angle); length = 1; }
      const radius = clearanceRadius + (finale.state.kind === "walker" ? 3 : 0) + source.radius + 1.5;
      const target = { x: waypoint.x + dx / length * radius, y: source.y, z: waypoint.z + dz / length * radius };
      const moved = directMove(context.world, baseline, target, source.kind === "animal" ? 2.4 : 1.8, [...bodies, ...state.specials.map(s => s.body)], actors, source.model === "parrot");
      if (physical) Object.assign(physical, moved);
      actorMetadata[source.id] = { ...actorMetadata[source.id], x: moved.x, y: moved.y, z: moved.z, speed: moved.speed, heading: moved.heading };
    }
    // The centre advances by measured bounded steps. Impacts still require complete clearance.
    const distance = Math.sqrt(d2(finale.body, goal)), travel = Math.min(distance, (finale.state.kind === "walker" ? 3 : 6) * DT);
    const protectedNow = protectedBodies(context, actors, [...bodies, ...state.specials.map(s => s.body)]);
    if (distance > 0 && finale.state.phase === waypoint.phase && finale.state.status !== "complete" && finale.state.status !== "restoring") {
      const next = { x: finale.body.x + (goal.x - finale.body.x) / distance * travel, z: finale.body.z + (goal.z - finale.body.z) / distance * travel };
      const swept = { ...waypoint, x: finale.body.x, z: finale.body.z };
      const sweptClear = finaleFootfallClear(finale.state.kind, swept, { tick, complete: true, bodies: protectedNow.map(b => ({ ...b, radius: b.radius + travel })) }, tick) && routineFinaleBodyClear(finale.state.kind, finale.body, protectedNow, travel);
      if (sweptClear && !circleBlocked(context.world, next.x, next.z, finale.state.kind === "walker" ? 4.5 : finale.body.radius) && !segmentBlocked(context.world, finale.body.x, finale.body.z, next.x, next.z)) {
        finale.body = { ...finale.body, ...next, y: meshGroundHeight(context.world, next.x, next.z), speed: travel / DT };
      } else { finale.body.speed = 0; diagnostics.push(`finale-route-blocked:${finale.body.id}`); }
    }
    const currentProtected = protectedBodies(context, actors, [...bodies, ...state.specials.map(s => s.body)]);
    const coverage = { tick, complete: routineFinaleBodyClear(finale.state.kind, waypoint, currentProtected), bodies: currentProtected };
    const clear = finaleFootfallClear(finale.state.kind, waypoint, coverage, tick);
    const weakPoints = weakPointActors(finale);
    const rustHits = weakPoints.flatMap(point => {
      const target = context.previous.ext.combat?.targets[point.id], existing = finale.state.weakPoints.find(p => point.id.endsWith(`/weak/${p.id}`))!;
      const amount = (target?.rust ?? 0) - existing.rust;
      const sequence = target ? target.lastWaterTick * 4 + finale.state.weakPoints.indexOf(existing) : -1;
      return target && amount > 0 && target.sourceId && Number.isSafeInteger(sequence) && sequence >= 0 ? [{ sourceId: target.sourceId, sequence, weakPointId: existing.id, rust: amount }] : [];
    });
    const result = stepFinale(finale.state, { tick, route: finale.route, position: finale.body, positionTick: tick, coverage, rustHits,
      landingAcks: physicalReceipts?.landingReceipts ?? [],
      effectAcks: finale.applied.map(id => ({ id, tick })), pitchResolved: context.events.some(e => e.kind === "agents.finale.pitch-resolved" && e.playerId && players.includes(e.playerId)) });
    finale.state = result.state; finale.applied = [];
    if (finale.state.status === "complete" || finale.state.status === "restoring") finale.body.speed = 0;
    finaleWeakPoints.push(...weakPointActors(finale));
    for (const intent of result.intents) {
      if (intent.kind === "land-foot" && clear && d2(finale.body, waypoint) <= 1) finale.landingId = intent.id;
      else if (intent.kind === "cancel-landing") finale.landingId = null;
      else if (["impact", "shed-robots", "restore-robots", "finale-complete"].includes(intent.kind)) {
        const e = intent as FinaleEffect;
        queue(effect(e.id, `finale.${e.kind}`, finale.body.id, "", "", p3(finale.body), e.kind === "shed-robots" ? e.count : 0));
        if (options.effectAcks?.includes(e.id)) finale.applied.push(e.id);
      }
    }
    if (!clear) diagnostics.push(`finale-awaits-evacuation:${finale.body.id}`);
  }
  for (const special of state.specials) {
    if (boundIds.has(special.body.id)) continue;
    const firmware = special.body.firmware ?? "none";
    actorMetadata[special.body.id] = { ...actorMetadata[special.body.id], firmware, kind: special.body.kind === "vehicle" ? "robot" : special.body.kind, ...(special.role === "associate" || special.role === "parrot" ? {} : { model: special.body.model as RobotModel }), protected: special.body.kind === "person" || special.body.kind === "animal" };
  }
  bodies.push(...state.specials.filter(s => !boundIds.has(s.body.id)).map(s => s.body), ...state.finales.map(f => f.body));
  state.specials.sort((a, b) => a.body.numericId - b.body.numericId); state.eventCursors.sort((a, b) => cmp(a.key, b.key));
  state.pendingEffects.sort((a, b) => cmp(a.id, b.id));
  return { state, bodies, nextActorId, actorMetadata, attackRequests: attackRequests.filter(attack => routineSwarmAllowsAttack({ swarmAssignments, swarmSuppressedIds }, attack)), finaleWeakPoints, swarmAssignments, swarmSuppressedIds, associateRiderBindings, effects: state.pendingEffects, playerOverrides, restoreIds, diagnostics: [...new Set(diagnostics)].sort(cmp), conference };
}

const playersInState = (context: SimSystemContext): string[] => sortedIds(context.state.players);
/** Apply equally to queued and newly requested attacks before combat resolves them. */
export function routineSwarmAllowsAttack(output: Pick<RoutineRuntimeStep, "swarmAssignments" | "swarmSuppressedIds">, attack: Pick<AttackRequest, "attackerId" | "targetId" | "kind">): boolean {
  const assignment = output.swarmAssignments.find(a => a.actorId === attack.attackerId);
  if (!assignment) return !output.swarmSuppressedIds.includes(attack.attackerId);
  if (assignment.playerId !== attack.targetId) return false;
  return assignment.role === "melee" || attack.kind === "ad-blast" || attack.kind === "phone-hack";
}

/** Combat-only targets attached to real body-relative joints; never population bodies. */
function weakPointActors(finale: FinaleRuntime): CombatActor[] {
  const b = finale.body, boss = finale.state.kind === "elizabeth";
  return finale.state.weakPoints.map((point, index) => {
    const side = index % 2 === 0 ? -1 : 1, longitudinal = boss ? 0 : index < 2 ? -2 : 2;
    const lateral = side * (boss ? 12 : 1.5), height = boss ? index < 2 ? 5 : 100 : 0.5;
    const exposed = !boss || finale.state.phase === "bridge" || finale.state.phase === "march" && index < 2;
    return { id: `${b.id}/weak/${point.id}`, kind: "robot", model: "walker", firmware: exposed ? "bad" : "none",
      x: b.x + lateral * dcos(b.heading) - longitudinal * dsin(b.heading), y: b.y + height,
      z: b.z + lateral * dsin(b.heading) + longitudinal * dcos(b.heading), heading: b.heading, speed: b.speed,
      radius: boss ? index < 2 ? 4 : 6 : 0.6, height: boss ? index < 2 ? 10 : 12 : 1, rustScale: 0.3 };
  });
}

/** Mirror core car obstacles, adding later-wave bodies and preserving dodge ownership of people. */
function stolenCarObstacles(context: SimSystemContext, ownerId: string, thiefId: string, bodies: readonly RuntimePhysicalBody[]): Circle[] {
  const obstacles: Circle[] = [];
  for (const id of sortedIds(context.state.players)) if (id !== ownerId) obstacles.push(...carCircles(context.state.players[id]!.car));
  for (const agent of context.state.ext.agents?.list ?? []) if (agent.kind !== "person" && `agent:${agent.id}` !== thiefId) obstacles.push(...agentCircles(agent).map(circle => ({ ...circle, person: false })));
  for (const body of bodies) {
    if (body.id === thiefId || body.kind === "person" || body.kind === "animal" || body.y > 2.5) continue;
    if (body.kind === "vehicle") obstacles.push(...carCircles(body));
    else obstacles.push({ x: body.x, z: body.z, r: body.radius, person: false });
  }
  return obstacles;
}

function actorBody(actor: CombatActor): RuntimePhysicalBody {
  return { id: actor.id, numericId: robotAgentId(actor.id) ?? 0, kind: actor.kind === "player" ? "robot" : actor.kind, model: actor.model ?? "person", x: actor.x, y: actor.y, z: actor.z, previousX: actor.x, previousZ: actor.z, heading: actor.heading, previousHeading: actor.heading, speed: actor.speed, radius: actor.radius, halfLength: actor.radius, halfWidth: actor.radius, height: actor.height, dodge: null };
}
function nearestDepot(world: World, from: RoutinePoint): RoutinePoint | null {
  const sites = (world.gameplay?.anchors ?? []).filter(a => a.kind === "garage-candidate" || a.kind === "repair-kiosk").sort((a, b) => d2(a, from) - d2(b, from) || cmp(a.id, b.id));
  return sites[0] ? p3(sites[0]) : null;
}
function steerRogueTaxi(world: World, body: RuntimePhysicalBody, goal: RoutinePoint, requestedSpeed: number, parkingHeading: number | null,
  bodies: readonly RuntimePhysicalBody[], actors: readonly CombatActor[]): RuntimePhysicalBody {
  if (body.dodge) return { ...body, speed: 0 };
  const distance = Math.sqrt(d2(body, goal));
  const moving = parkingHeading === null && requestedSpeed > 0 && distance > 1e-8;
  const desiredHeading = parkingHeading ?? (moving ? datan2(goal.x - body.x, body.z - goal.z) : body.heading);
  const heading = wrapAngle(body.heading + clamp(wrapAngle(desiredHeading - body.heading), -ROGUE_TAXI_TURN_RATE * DT, ROGUE_TAXI_TURN_RATE * DT));
  const speed = moving ? Math.min(requestedSpeed, Math.max(0, body.speed) + 4 * DT) : 0;
  const travel = Math.min(distance, speed * DT);
  const at = { x: body.x + dsin(heading) * travel, z: body.z - dcos(heading) * travel, y: body.y };
  at.y = meshGroundHeight(world, at.x, at.z);
  const candidate = { ...body, ...at, heading, speed: travel / DT };
  if (!safeSpot(world, candidate, at, bodies, actors) ||
      boxCrossedWall(world, { ...at, heading, hl: body.halfLength, hw: body.halfWidth }, body)) return { ...body, speed: 0 };
  return candidate;
}
function roadSteeringTarget(world: World, from: { x: number; z: number; heading: number }, destination: RoutinePoint): RoutinePoint {
  let best: { path: Path; s: number; score: number } | null = null;
  for (const edge of world.roads?.edges ?? []) for (const dir of [1, -1] as const) {
    if (!edge.drivable || edge.laneCount[dir === 1 ? 0 : 1] < 1 || !edge.laneSafe[dir === 1 ? 0 : 1][0]) continue;
    const path = lanePath(edge, dir, 0), projection = projectOnPath(path, from.x, from.z), at = pathPoint(path, projection.s);
    const angle = Math.abs(wrapAngle(datan2(at.tx, -at.tz) - from.heading));
    const end = pathPoint(path, path.len), score = projection.dist * 4 + angle * 8 + Math.sqrt(d2(end, destination)) * 0.05;
    if (!best || score < best.score) best = { path, s: projection.s, score };
  }
  if (!best) return p3(destination);
  const stop = projectOnPath(best.path, destination.x, destination.z);
  const end = stop.dist <= 3 && stop.s >= best.s ? stop.s : best.path.len;
  const p = pathPoint(best.path, Math.min(end, best.s + 8));
  return { x: p.x, y: meshGroundHeight(world, p.x, p.z), z: p.z };
}
