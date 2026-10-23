import { AGENT_SPEC, agentCircles, agentsOf, type AgentState, type AgentsExt } from "../agents.ts";
import { DT, sortedIds, type SimState } from "../contract.ts";
import type { CombatActor } from "../combat-contract.ts";
import type { JsonObject, JsonValue } from "../extensions.ts";
import { combatOf, movementLimit } from "../combat/system.ts";
import { datan2 } from "../dmath.ts";
import { hash32 } from "../rng.ts";
import { pathPoint, projectOnPath, walkPath } from "../roads.ts";
import type { ThreatSpawnRequest } from "../gameplay-contract.ts";
import type { SimSystem, SimSystemContext } from "../system-contract.ts";
import type { World } from "../world.ts";
import type { RobotLocomotion } from "../robots/runtime.ts";
import type { RobotMovementIntent } from "../robots/brain.ts";
import type { SidewalkGraph } from "./navigation.ts";
import { createSpatialNavigation, stepRuntimeSpatial, type RuntimeAnimal, type RuntimeSpatialState } from "./runtime-spatial.ts";
import { createFleetState, stepFleet, type FleetDepot, type FleetObstacle, type FleetState } from "./runtime-services.ts";
import { agentRuntimeSession, runtimeGameMinute, type RuntimePhysicalBody } from "./runtime-state.ts";
import { MAX_ACTIVE_VANS, SERVICE_REQUEST_RETENTION_TICKS, VAN_RESPONSE_TICKS, type ThreatVanRequest } from "./services.ts";
import { ACTIVE_FIDELITY_M, MAX_AMBIENT_AGENTS, MAX_AMBIENT_PER_ANCHOR, MAX_SIGNIFICANT_AGENTS, planFidelity, type FidelityAnchor } from "./fidelity.ts";

export const MAX_RUNTIME_REQUEST_KEYS = 128;
export const MAX_RUNTIME_SIGNIFICANT = MAX_SIGNIFICANT_AGENTS;

export interface RuntimeRequestKey { key: string; numericId: number; requestTick: number; playerId: string }
export interface RuntimeAnimalId { key: string; id: number; lastSeenTick: number }
export interface AgentRuntimeEvent {
  id: string; tick: number; kind: "van.disembark" | "van.rejected"; playerId: string;
  requestId: number; sourceRequestId: string; vehicleId: number | null; unitIds: number[]; reason: string | null;
}
export interface QueuedVanRequest { request: ThreatVanRequest; sourceRequestId: string }
export interface RuntimeBadBaseline { id: string; slots: number; count: number; boosted?: boolean }
export interface AgentRuntimeData {
  version: 1; tick: number; spatial: RuntimeSpatialState; fleet: FleetState;
  bodies: RuntimePhysicalBody[]; animalIds: RuntimeAnimalId[];
  requests: RuntimeRequestKey[]; nextRequestId: number; requestTickFloor: number;
  activeRequestKeys: RuntimeRequestKey[];
  queuedVanRequests: QueuedVanRequest[];
  significantAgentIds: number[]; deliveredAgentIds: number[];
  lanyardPersonIds: number[];
  population: { ambient: number; significant: number; robots: number; people: number; badRobots: number; ambientIds: number[]; perAnchor: { id: string; count: number }[];
    badBaselines: RuntimeBadBaseline[]; extraSignificant: number; reservedVanUnits: number };
  events: AgentRuntimeEvent[]; diagnostics: string[];
  /** Additional same-key reducers own these JSON payloads; the base reducer carries them. */
  routines?: unknown; routineOutput?: unknown; effectState?: unknown; transport?: unknown;
}
type RuntimeAgentsExt = AgentsExt & { runtime: AgentRuntimeData };
export interface AgentRuntimeOptions {
  depots?: readonly FleetDepot[];
  ferry?: { x: number; z: number };
  navigation?: SidewalkGraph;
  animalLimit?: { pigeons: number; dogs: number };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function numbers(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((id): id is number => Number.isSafeInteger(id) && id >= 0).sort((a, b) => a - b) : [];
}
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

export function agentsRuntimeOf(state: Readonly<SimState>): AgentRuntimeData | null {
  const raw = record(state.ext.agents)?.runtime;
  if (raw === undefined || raw === null) return null;
  const candidate = record(raw);
  const fleet = record(candidate?.fleet); const vans = record(fleet?.vans); const buses = record(fleet?.buses);
  const spatial = record(candidate?.spatial); const populationState = record(candidate?.population);
  const arrays = [candidate?.bodies, candidate?.animalIds, candidate?.significantAgentIds, candidate?.deliveredAgentIds, candidate?.requests,
    candidate?.activeRequestKeys, candidate?.queuedVanRequests, candidate?.events, candidate?.diagnostics, fleet?.vehicles, fleet?.pendingDeliveries,
    vans?.receipts, vans?.jobs, buses?.runs, spatial?.walkers, spatial?.animals, populationState?.ambientIds, populationState?.perAnchor];
  if (candidate?.version !== 1 || !Number.isSafeInteger(candidate.tick) || (candidate.tick as number) < 0 ||
    !Number.isSafeInteger(candidate.nextRequestId) || (candidate.nextRequestId as number) < 0 ||
    !Number.isSafeInteger(candidate.requestTickFloor) || (candidate.requestTickFloor as number) < 0 ||
    !Number.isSafeInteger(fleet?.nextActorId) || (fleet?.nextActorId as number) < 0 || spatial?.version !== 1 || arrays.some((value) => !Array.isArray(value))) {
    throw new Error("Invalid agent runtime state");
  }
  return candidate as unknown as AgentRuntimeData;
}

/** Extra bodies only; legacy people/robots/robotaxis keep their established body owner. */
export function runtimePhysicalBodies(state: Readonly<SimState>): readonly RuntimePhysicalBody[] {
  return agentRuntimeSession(state) ? agentsRuntimeOf(state)?.bodies ?? [] : [];
}

/** Extra combat descriptors only. The combat adapter already includes legacy agents. */
export function runtimeCombatActors(state: Readonly<SimState>): readonly CombatActor[] {
  return runtimePhysicalBodies(state).map((body): CombatActor => {
    if (body.kind === "animal") return { id: body.id, kind: "animal", firmware: "none", protected: true,
      x: body.x, y: body.y, z: body.z, radius: body.radius, height: body.height, heading: body.heading, speed: body.speed };
    if (body.model === "bus") return { id: body.id, kind: "person", firmware: "none", protected: true, occupied: true, posture: "seated",
      x: body.x, y: body.y, z: body.z, radius: body.radius, height: body.height, heading: body.heading, speed: body.speed };
    if (body.kind === "person" || (body.kind === "vehicle" && body.model !== "van")) return { id: body.id, kind: "person", firmware: "none", protected: true,
      x: body.x, y: body.y, z: body.z, radius: body.radius, height: body.height, heading: body.heading, speed: body.speed };
    const models = ["footman", "trundle", "robotaxi", "patrol", "drone", "sign-spinner", "tidy", "walker"] as const;
    const model = models.find((candidate) => candidate === body.model) ?? (body.model === "van" ? "robotaxi" : body.model === "elizabeth" || body.model === "finale" ? "walker" : undefined);
    return { id: body.id, kind: "robot", firmware: body.firmware ?? (body.model === "van" ? "bad" : "good"), ...(model ? { model } : {}), obeysTraffic: body.kind === "vehicle",
      x: body.x, y: body.y, z: body.z, radius: body.radius, height: body.height, heading: body.heading, speed: body.speed };
  });
}

function initialRuntime(nextId: number, previousGameMinute: number): AgentRuntimeData {
  const fleet = createFleetState(nextId);
  // Include a departure exactly at activation, before the first simulated tick.
  fleet.buses.absoluteGameMinute = previousGameMinute - 0.000000001;
  return { version: 1, tick: -1, spatial: { version: 1, walkers: [], animals: [] }, fleet, bodies: [], animalIds: [], requests: [], nextRequestId: 0, requestTickFloor: 0, activeRequestKeys: [], queuedVanRequests: [], significantAgentIds: [], deliveredAgentIds: [], lanyardPersonIds: [], population: { ambient: 0, significant: 0, robots: 0, people: 0, badRobots: 0, ambientIds: [], perAnchor: [], badBaselines: [], extraSignificant: 0, reservedVanUnits: 0 }, events: [], diagnostics: [] };
}

function parseRequest(value: unknown, tick: number): ThreatSpawnRequest | null {
  const request = record(value);
  if (!request || request.kind !== "van" || request.threat !== 2 || request.unitCount !== 2 ||
    typeof request.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(request.id) ||
    typeof request.playerId !== "string" || request.playerId.length === 0 ||
    !Number.isSafeInteger(request.requestTick) || (request.requestTick as number) < 0 || (request.requestTick as number) > tick) return null;
  return request as unknown as ThreatSpawnRequest;
}

function requestsFrom(context: SimSystemContext, previous: AgentRuntimeData): { keys: RuntimeRequestKey[]; allKeys: RuntimeRequestKey[]; nextId: number; floor: number; requests: ThreatVanRequest[] } {
  let floor = Math.max(previous.requestTickFloor, context.state.tick - SERVICE_REQUEST_RETENTION_TICKS);
  let keys = previous.requests.filter((key) => key.requestTick >= floor).map((key) => ({ ...key }));
  const incoming: ThreatSpawnRequest[] = [];
  for (const event of context.events) if (event.kind === "threat.spawn" && Number.isSafeInteger(event.tick) && event.tick >= 0 && event.tick <= context.state.tick) {
    const request = parseRequest(event.payload, context.state.tick);
    if (request) incoming.push(request);
  }
  for (const slot of [context.state.ext.player, context.state.ext.heat]) {
    const events = record(slot)?.events;
    if (!Array.isArray(events)) continue;
    for (const value of events) {
      const event = record(value);
      if (event?.kind !== "threat.spawn" || !Number.isSafeInteger(event.tick) || (event.tick as number) < 0 || (event.tick as number) > context.state.tick) continue;
      const request = parseRequest(event.payload, context.state.tick);
      if (request) incoming.push(request);
    }
  }
  incoming.sort((a, b) => a.requestTick - b.requestTick || compare(a.id, b.id) || compare(a.playerId, b.playerId));
  const requests: ThreatVanRequest[] = [];
  let nextId = previous.nextRequestId;
  for (let i = 0; i < incoming.length; i++) {
    const request = incoming[i]!;
    const group = incoming.filter((other) => other.id === request.id);
    if (incoming.findIndex((other) => other.id === request.id) !== i || request.requestTick < floor || keys.some((key) => key.key === request.id) ||
      group.some((other) => other.playerId !== request.playerId || other.requestTick !== request.requestTick) || nextId >= Number.MAX_SAFE_INTEGER) continue;
    const player = context.state.players[request.playerId];
    if (!player) continue;
    const position = player.mode === "foot" && player.foot ? player.foot : player.car;
    const numericId = nextId++;
    keys.push({ key: request.id, numericId, requestTick: request.requestTick, playerId: request.playerId });
    requests.push({ id: numericId, requestTick: request.requestTick, playerId: request.playerId, player: { x: position.x, z: position.z }, threat: 2, unitCount: 2 });
  }
  keys.sort((a, b) => a.numericId - b.numericId);
  const allKeys = [...keys];
  if (keys.length > MAX_RUNTIME_REQUEST_KEYS) {
    const removed = keys.slice(0, keys.length - MAX_RUNTIME_REQUEST_KEYS);
    for (const key of removed) floor = Math.max(floor, key.requestTick + 1);
    keys = keys.filter((key) => key.requestTick >= floor);
  }
  return { keys, allKeys, nextId, floor, requests };
}

function obstacles(context: SimSystemContext, actors: readonly AgentState[], previous: AgentRuntimeData): FleetObstacle[] {
  const result: FleetObstacle[] = [];
  for (const actor of actors) {
    for (const [index, circle] of agentCircles(actor).entries()) result.push({ id: `agent:${actor.id}:${index}`, x: circle.x, z: circle.z, radius: circle.r, person: actor.kind !== "robotaxi" });
  }
  for (const id of sortedIds(context.state.players)) {
    const player = context.state.players[id]!;
    result.push({ id: `player-car:${id}`, x: player.car.x, z: player.car.z, radius: 2.75, person: false });
    if (player.mode === "foot" && player.foot) result.push({ id: `player-foot:${id}`, x: player.foot.x, z: player.foot.z, radius: 0.35, person: true });
  }
  for (const body of previous.bodies) if (!body.id.startsWith("fleet:")) result.push({ id: body.id, x: body.x, z: body.z,
    radius: body.kind === "vehicle" ? Math.sqrt(body.halfLength * body.halfLength + body.halfWidth * body.halfWidth) : body.radius, person: body.kind !== "vehicle" });
  return result;
}

function deliveredActor(world: World, seed: number, unit: { id: number; x: number; y: number; z: number; heading: number }): AgentState | null {
  let best: { edgeId: string; lane: number; s: number; distance: number; heading: number } | null = null;
  for (const edge of [...(world.roads?.edges ?? [])].sort((a, b) => compare(a.id, b.id))) {
    if (!edge.walkable) continue;
    for (const lane of [1, -1]) {
      const path = walkPath(edge, 1, lane);
      const projection = projectOnPath(path, unit.x, unit.z);
      if (projection.dist > 0.05 || (best !== null && projection.dist >= best.distance)) continue;
      const point = pathPoint(path, projection.s);
      best = { edgeId: edge.id, lane, s: projection.s, distance: projection.dist, heading: datan2(point.tx, -point.tz) };
    }
  }
  if (!best) return null;
  return { id: unit.id, kind: "errandRobot", x: unit.x, y: unit.y, z: unit.z, heading: best.heading, pitch: 0, speed: 0, vmax: AGENT_SPEC.errandRobot.vmax,
    edge: best.edgeId, dir: 1, lane: best.lane, s: best.s, next: "", ndir: 1, nlane: best.lane, conn: null, node: "", resume: 0,
    lat: 0, wait: 0, dwell: 0, ghost: 0, mode: "go", rng: hash32(seed, unit.id, 0x51d), dodge: null };
}

function robotMotions(state: Readonly<SimState>): { id: number; movement: RobotMovementIntent }[] {
  const locomotion = record(state.ext.robots)?.locomotion;
  if (!Array.isArray(locomotion)) return [];
  const result: { id: number; movement: RobotMovementIntent }[] = [];
  const seen = new Set<number>();
  for (const raw of locomotion) {
    const value = record(raw);
    const intent = record(value?.intent);
    if (!value || !Number.isSafeInteger(value.agentId) || !intent || !["hold", "errand", "pursue", "flee"].includes(String(intent.kind))) continue;
    const motion = raw as RobotLocomotion;
    if (seen.has(motion.agentId)) continue;
    seen.add(motion.agentId);
    const hold = motion.combat?.maxSpeed === 0 || motion.combat?.scale === 0;
    result.push({ id: motion.agentId, movement: hold ? { kind: "hold", face: null, avoidFog: false } : motion.intent });
  }
  return result.sort((a, b) => a.id - b.id);
}

function combatLimitedActors(actors: readonly AgentState[], previous: Readonly<SimState>): AgentState[] {
  const values = record(previous.ext.robots)?.locomotion;
  const combat = combatOf(previous);
  if (!Array.isArray(values) && !combat) return [...actors];
  const oldActors = new Map(agentsOf(previous).map((actor) => [actor.id, actor]));
  const motions = new Map<number, RobotLocomotion>();
  if (Array.isArray(values)) for (const value of values) {
    const entry = record(value);
    if (entry && Number.isSafeInteger(entry.agentId) && !motions.has(entry.agentId as number)) motions.set(entry.agentId as number, value as RobotLocomotion);
  }
  return actors.map((actor) => {
    if (actor.dodge !== null || actor.mode === "dive" || actor.mode === "recover") return actor;
    const value = motions.get(actor.id);
    const limit = combat ? movementLimit(combat, { id: `agent:${actor.id}`, kind: actor.kind === "person" ? "person" : "robot", firmware: actor.kind === "person" ? "none" : "good",
      radius: AGENT_SPEC[actor.kind].radius, height: 1.8, x: actor.x, y: actor.y, z: actor.z, heading: actor.heading, speed: actor.speed }) : value?.combat;
    if (!limit) return actor;
    const scale = Number.isFinite(limit.scale) ? Math.max(0, Math.min(1, limit.scale)) : 1;
    const maxSpeed = limit.maxSpeed !== null && Number.isFinite(limit.maxSpeed) ? Math.max(0, limit.maxSpeed) : actor.vmax;
    const vmax = Math.min(actor.vmax * scale, maxSpeed);
    const old = oldActors.get(actor.id) ?? actor;
    const dx = actor.x - old.x; const dz = actor.z - old.z;
    const distance = Math.sqrt(dx * dx + dz * dz);
    const fraction = distance > vmax * DT && distance > 0 ? vmax * DT / distance : 1;
    return { ...actor, x: old.x + dx * fraction, z: old.z + dz * fraction, speed: Math.min(actor.speed, vmax), vmax };
  });
}

function badRobots(actors: readonly AgentState[], previous: Readonly<SimState>): Set<number> {
  const firmware = new Map<number, string>();
  const robots = record(previous.ext.robots);
  for (const list of [robots?.baselines, robots?.metadata]) if (Array.isArray(list)) for (const value of list) {
    const item = record(value);
    if (item && Number.isSafeInteger(item.agentId) && (item.firmware === "good" || item.firmware === "bad")) firmware.set(item.agentId as number, item.firmware);
  }
  return new Set(actors.filter((actor) => firmware.has(actor.id) ? firmware.get(actor.id) === "bad" :
    (actor.kind === "errandRobot" || actor.kind === "sidewalkBot") && hash32(previous.seed, actor.id) % 100 < 35).map((actor) => actor.id));
}

function conferenceAt(old: AgentRuntimeData, anchor: FidelityAnchor | null): { active: boolean; multiplier: number } {
  const conference = record(record(old.routineOutput)?.conference);
  if (!anchor || conference?.lanyardCrowd !== true) return { active: false, multiplier: 1 };
  const center = record(conference.center);
  if (center && typeof center.x === "number" && typeof center.z === "number") {
    const radius = typeof conference.radiusM === "number" && Number.isFinite(conference.radiusM) ? Math.max(0, conference.radiusM) : 600;
    if ((anchor.x - center.x) * (anchor.x - center.x) + (anchor.z - center.z) * (anchor.z - center.z) > radius * radius) return { active: false, multiplier: 1 };
  }
  return { active: true, multiplier: conference.badRateMultiplier === 1.5 ? 1.5 : 1 };
}

function inAnchor(point: { x: number; z: number }, anchor: FidelityAnchor): boolean {
  const radius = Math.max(0, Math.min(ACTIVE_FIDELITY_M, anchor.radiusM ?? ACTIVE_FIDELITY_M));
  const dx = point.x - anchor.x; const dz = point.z - anchor.z;
  return dx * dx + dz * dz <= radius * radius;
}

function population(actors: readonly AgentState[], significant: ReadonlySet<number>, anchors: readonly FidelityAnchor[], old: AgentRuntimeData, tick: number, bad: ReadonlySet<number>, reserved: readonly { x: number; z: number }[] = []): { actors: AgentState[]; badBaselines: RuntimeBadBaseline[] } {
  const stable = new Set(old.population.ambientIds);
  const rank = (a: AgentState, b: AgentState): number => Number(stable.has(b.id)) - Number(stable.has(a.id)) || a.id - b.id;
  const candidates = actors.filter(actor => !significant.has(actor.id) && planFidelity({ id: String(actor.id), x: actor.x, z: actor.z, significant: false }, anchors, tick).tier !== "despawn").sort(rank);
  const coverage = new Map(candidates.map(actor => [actor.id, anchors.map((anchor, index) => inAnchor(actor, anchor) ? index : -1).filter(index => index >= 0)]));
  const owners = new Map(candidates.map(actor => [actor.id, nearestAnchor(actor, anchors)!.id]));
  const counts = anchors.map(anchor => reserved.filter(point => inAnchor(point, anchor)).length);
  const selected = new Map<number, AgentState>();
  const hasRoom = (actor: AgentState): boolean => coverage.get(actor.id)!.every(index => counts[index]! < MAX_AMBIENT_PER_ANCHOR);
  const add = (actor: AgentState): void => {
    if (selected.has(actor.id) || selected.size + reserved.length >= MAX_AMBIENT_AGENTS || !hasRoom(actor)) return;
    selected.set(actor.id, actor);
    for (const index of coverage.get(actor.id)!) counts[index] = counts[index]! + 1;
  };
  // Match fidelity's every-covering-anchor admission, retaining established IDs first.
  // Pair robots and people so two formerly separate crowds keep their mix on overlap.
  for (const existing of [true, false]) {
    const robots = candidates.filter(actor => stable.has(actor.id) === existing && actor.kind !== "person");
    const people = candidates.filter(actor => stable.has(actor.id) === existing && actor.kind === "person");
    for (let index = 0; index < Math.max(robots.length, people.length); index++) {
      if (robots[index]) add(robots[index]!);
      if (people[index]) add(people[index]!);
    }
  }
  const badBaselines: RuntimeBadBaseline[] = [];
  const changes: { id: string; wanted: number; raw: number }[] = [];
  for (const anchor of anchors) {
    const robots = [...selected.values()].filter(actor => owners.get(actor.id) === anchor.id && actor.kind !== "person");
    const conference = conferenceAt(old, anchor);
    const prior = old.population.badBaselines?.find(value => value.id === anchor.id);
    const preserve = conference.active || prior?.boosted === true;
    const baseline = Math.min(robots.length, preserve && prior && prior.slots > 0 ? Math.round(prior.count * robots.length / prior.slots) : robots.filter(actor => bad.has(actor.id)).length);
    badBaselines.push({ id: anchor.id, slots: robots.length, count: baseline, boosted: conference.multiplier > 1 });
    if (preserve) {
      const raw = Math.min(robots.length, baseline * conference.multiplier);
      changes.push({ id: anchor.id, wanted: Math.floor(raw), raw });
    }
  }
  // Distribute fractional targets once across owners, avoiding 1.5x rounding inflation.
  let extra = Math.ceil(changes.reduce((sum, change) => sum + change.raw, 0)) - changes.reduce((sum, change) => sum + change.wanted, 0);
  for (const change of [...changes].sort((a, b) => (b.raw - b.wanted) - (a.raw - a.wanted) || compare(a.id, b.id))) if (extra > 0 && change.wanted < change.raw) { change.wanted++; extra--; }
  for (const change of changes) {
    const robots = [...selected.values()].filter(actor => owners.get(actor.id) === change.id && actor.kind !== "person");
    const present = robots.filter(actor => bad.has(actor.id)).length;
    if (present === change.wanted) continue;
    const needBad = present < change.wanted;
    const replacements = candidates.filter(actor => owners.get(actor.id) === change.id && actor.kind !== "person" && bad.has(actor.id) === needBad && !selected.has(actor.id));
    const victims = robots.filter(actor => bad.has(actor.id) !== needBad).sort((a, b) => rank(b, a));
    let remaining = Math.abs(change.wanted - present);
    for (const replacement of replacements) {
      if (remaining === 0) break;
      for (let index = 0; index < victims.length; index++) {
        const victim = victims[index]!;
        for (const covered of coverage.get(victim.id)!) counts[covered] = counts[covered]! - 1;
        if (hasRoom(replacement)) {
          selected.delete(victim.id); selected.set(replacement.id, replacement);
          for (const covered of coverage.get(replacement.id)!) counts[covered] = counts[covered]! + 1;
          victims.splice(index, 1); remaining--; break;
        }
        for (const covered of coverage.get(victim.id)!) counts[covered] = counts[covered]! + 1;
      }
    }
  }
  return { actors: [...actors.filter(actor => significant.has(actor.id)), ...selected.values()].sort((a, b) => a.id - b.id), badBaselines };
}

function nearestAnchor(point: { x: number; z: number }, anchors: readonly FidelityAnchor[]): FidelityAnchor | null {
  let nearest: FidelityAnchor | null = null; let best = Infinity;
  for (const anchor of anchors) {
    if (!inAnchor(point, anchor)) continue;
    const distance = (point.x - anchor.x) * (point.x - anchor.x) + (point.z - anchor.z) * (point.z - anchor.z);
    if (distance < best) { nearest = anchor; best = distance; }
  }
  return nearest;
}

/** The cache contains only immutable navigation derived from a static world. It never
 * stores simulation decisions; rebuilding it yields the same serialized result.
 */
export function createAgentRuntimeSystem(options: AgentRuntimeOptions = {}): SimSystem {
  const navigation = new WeakMap<World, SidewalkGraph>();
  return { key: "agents", step(context): SimState {
    if (!agentRuntimeSession(context.state)) return context.state;
    const current = context.state.ext.agents ?? { nextId: 0, list: [] };
    const old = agentsRuntimeOf(context.previous) ?? initialRuntime(current.nextId, runtimeGameMinute(context.previous));
    if (old.tick >= context.state.tick) return context.state;
    const robotState = record(context.previous.ext.robots);
    const retired = new Set(numbers(robotState?.retiredAgentIds));
    const legacyIds = new Set([...current.list, ...agentsOf(context.previous)].map((actor) => actor.id));
    const significant = new Set([...old.significantAgentIds, ...numbers(robotState?.significantAgentIds), ...numbers(robotState?.robotSignificantAgentIds)].filter((id) => !retired.has(id) && legacyIds.has(id)));
    const extraSignificant = old.population.extraSignificant ?? 0;
    if (!Number.isSafeInteger(extraSignificant) || extraSignificant < 0 || significant.size + extraSignificant > MAX_RUNTIME_SIGNIFICANT) throw new Error("Significant agent capacity exceeded");
    const incoming = current.list.filter((actor) => !retired.has(actor.id));
    for (const actor of agentsOf(context.previous)) if (significant.has(actor.id) && !incoming.some((candidate) => candidate.id === actor.id)) incoming.push(actor);
    const anchors = sortedIds(context.state.players).map((id) => {
      const player = context.state.players[id]!; const position = player.mode === "foot" && player.foot ? player.foot : player.car;
      return { id, x: position.x, z: position.z };
    });
    const bad = badRobots(incoming, context.previous);
    const list = population(incoming, significant, anchors, old, context.state.tick, bad).actors;
    const requestData = requestsFrom(context, old);
    const liveVans = old.fleet.vans.jobs.filter((job) => job.vehicleId !== null && job.retiredTick === null).length;
    const reservedUnits = (old.fleet.vans.jobs.filter((job) => job.vehicleId !== null && job.status !== "delivered" && job.retiredTick === null).length + old.fleet.pendingDeliveries.length) * 2;
    const events: AgentRuntimeEvent[] = [];
    const reject = (entry: QueuedVanRequest, reason: string): void => {
      events.push({ id: `van-rejected:${entry.request.id}`, tick: context.state.tick, kind: "van.rejected", playerId: entry.request.playerId,
        requestId: entry.request.id, sourceRequestId: entry.sourceRequestId, vehicleId: null, unitIds: [], reason });
    };
    const queued = [...(old.queuedVanRequests ?? []), ...requestData.requests.map((request) => ({ request, sourceRequestId: requestData.allKeys.find((key) => key.numericId === request.id)!.key }))].sort((a, b) => a.request.id - b.request.id);
    const queuedVanRequests: QueuedVanRequest[] = [];
    const acceptedRequests: ThreatVanRequest[] = [];
    const acceptedKeys: RuntimeRequestKey[] = [];
    const dispatchSlots = Math.max(0, Math.min(MAX_ACTIVE_VANS - liveVans, Math.floor((MAX_RUNTIME_SIGNIFICANT - significant.size - extraSignificant - reservedUnits) / 2)));
    for (const entry of queued) {
      const player = context.state.players[entry.request.playerId];
      if (!player) { reject(entry, "player-left"); continue; }
      if (entry.request.requestTick + VAN_RESPONSE_TICKS <= context.state.tick) { reject(entry, "capacity-deadline"); continue; }
      const position = player.mode === "foot" && player.foot ? player.foot : player.car;
      const updated = { ...entry.request, player: { x: position.x, z: position.z } };
      if (acceptedRequests.length < dispatchSlots) {
        acceptedRequests.push(updated);
        acceptedKeys.push({ key: entry.sourceRequestId, numericId: updated.id, requestTick: updated.requestTick, playerId: updated.playerId });
      }
      else if (queuedVanRequests.length < MAX_RUNTIME_REQUEST_KEYS) queuedVanRequests.push({ ...entry, request: updated });
      else reject(entry, "backlog-capacity");
    }
    const firstId = Math.max(current.nextId, old.fleet.nextActorId, ...list.map((actor) => actor.id + 1), ...old.animalIds.map((animal) => animal.id + 1), ...old.bodies.map((body) => body.numericId + 1));
    const fleet = stepFleet(context.world, { ...old.fleet, nextActorId: firstId }, { tick: context.state.tick, gameMinute: runtimeGameMinute(context.state), requests: acceptedRequests,
      obstacles: obstacles(context, list, old), ...(options.depots ? { depots: options.depots } : {}), ...(options.ferry ? { ferry: options.ferry } : {}) });
    for (const request of acceptedRequests) {
      const job = fleet.state.vans.jobs.find((candidate) => candidate.requestId === request.id);
      if (job?.status === "blocked" && job.vehicleId === null) reject({ request, sourceRequestId: acceptedKeys.find((key) => key.numericId === request.id)!.key }, job.blockedReason ?? "blocked");
    }
    const activeRequestKeys = [...(old.activeRequestKeys ?? old.requests), ...acceptedKeys].filter((key) => fleet.state.vans.jobs.some((job) => job.requestId === key.numericId && job.vehicleId !== null && job.retiredTick === null)).sort((a, b) => a.numericId - b.numericId);
    const delivered = new Set(old.deliveredAgentIds.filter((id) => !retired.has(id)));
    const fresh: number[] = [];
    for (const delivery of fleet.disembarks) {
      const ids: number[] = [];
      for (const unit of delivery.units) {
        const actor = deliveredActor(context.world, context.state.seed, unit);
        if (!actor) throw new Error("Fleet unload must remain on a valid sidewalk");
        list.push(actor); fresh.push(actor.id); ids.push(actor.id); significant.add(actor.id); delivered.add(actor.id);
        bad.add(actor.id);
      }
      const request = activeRequestKeys.find((key) => key.numericId === delivery.requestId);
      events.push({ id: `van-disembark:${delivery.requestId}`, tick: context.state.tick, kind: "van.disembark", playerId: request?.playerId ?? "", requestId: delivery.requestId,
        sourceRequestId: request?.key ?? "", vehicleId: delivery.vehicleId, unitIds: ids, reason: null });
    }
    let graph = options.navigation ?? navigation.get(context.world);
    if (!graph) { graph = createSpatialNavigation(context.world); navigation.set(context.world, graph); }
    const previousBodies = new Map(old.bodies.map((body) => [body.id, body]));
    const previousSpatial: RuntimeSpatialState = { ...old.spatial, animals: old.spatial.animals.map((animal) => {
      const body = previousBodies.get(animal.id);
      return body ? { ...animal, x: body.x, y: body.y, z: body.z, heading: body.heading, speed: body.speed } : animal;
    }) };
    const spatial = stepRuntimeSpatial({ context, actors: combatLimitedActors(list, context.previous), anchors, navigation: graph, previous: previousSpatial, robotIntents: robotMotions(context.previous), significantActorIds: [...significant].sort((a, b) => a - b), freshSpawnIds: fresh,
      vehicles: [...fleet.bodies.map((body) => ({ id: `fleet:${body.id}`, x: body.x, z: body.z, previousX: body.previousX, previousZ: body.previousZ, halfLength: body.halfLength, halfWidth: body.halfWidth, speed: body.speed })),
        ...old.bodies.filter((body) => body.kind === "vehicle" && !body.id.startsWith("fleet:")).map((body) => ({ id: body.id, x: body.x, z: body.z, previousX: body.x, previousZ: body.z, halfLength: body.halfLength, halfWidth: body.halfWidth, speed: body.speed }))],
      ...(options.animalLimit ? { animalLimit: options.animalLimit } : {}) });
    const originalSpeeds = new Map(list.map((actor) => [actor.id, actor.vmax]));
    const buses = fleet.actors.filter((actor) => actor.kind === "bus");
    const reservedAnimals = spatial.animals.map((animal) => {
      const body = previousBodies.get(animal.id);
      return body?.dodge ? { ...animal, x: body.x, z: body.z } : animal;
    });
    const selected = population(spatial.actors.map((actor) => ({ ...actor, vmax: originalSpeeds.get(actor.id) ?? actor.vmax })), significant, anchors, old, context.state.tick, bad, [...reservedAnimals, ...buses]);
    const finalActors = selected.actors;
    const finalIds = new Set(finalActors.map((actor) => actor.id));
    let nextId = fleet.nextActorId;
    const animalIds: RuntimeAnimalId[] = [];
    const bodies: RuntimePhysicalBody[] = fleet.bodies.map((body) => ({ id: `fleet:${body.id}`, numericId: body.id, kind: "vehicle", model: body.kind,
      x: body.x, y: body.y, z: body.z, previousX: body.previousX, previousZ: body.previousZ, heading: body.heading, previousHeading: body.previousHeading, speed: body.speed,
      radius: body.halfWidth, halfLength: body.halfLength, halfWidth: body.halfWidth, height: body.kind === "bus" ? 3.2 : 2.1, dodge: null }));
    const ownAnimalKeys = new Set(old.animalIds.map((entry) => entry.key));
    for (const body of old.bodies) if (!body.id.startsWith("fleet:") && !ownAnimalKeys.has(body.id)) bodies.push({ ...body, previousX: body.x, previousZ: body.z, previousHeading: body.heading });
    const animals: RuntimeAnimal[] = [];
    for (const animal of spatial.animals) {
      if (animal.ownerId !== null && !finalIds.has(animal.ownerId)) continue;
      const oldBody = previousBodies.get(animal.id);
      const numericId = old.animalIds.find((entry) => entry.key === animal.id)?.id ?? nextId++;
      animalIds.push({ key: animal.id, id: numericId, lastSeenTick: context.state.tick });
      const currentAnimal = oldBody?.dodge ? { ...animal, x: oldBody.x, y: oldBody.y, z: oldBody.z, heading: oldBody.heading, speed: oldBody.speed } : animal;
      animals.push(currentAnimal);
      const pairedCarry = record(oldBody)?.pairedCarry;
      bodies.push({ id: animal.id, numericId, kind: "animal", model: animal.kind, x: currentAnimal.x, y: currentAnimal.y, z: currentAnimal.z,
        previousX: oldBody?.x ?? currentAnimal.x, previousZ: oldBody?.z ?? currentAnimal.z, heading: currentAnimal.heading, previousHeading: oldBody?.heading ?? currentAnimal.heading,
        speed: currentAnimal.speed, radius: animal.radius, halfLength: animal.radius, halfWidth: animal.radius, height: animal.kind === "dog" ? 0.5 : 0.25, dodge: oldBody?.dodge ?? null,
        ...(typeof pairedCarry === "boolean" ? { pairedCarry } : {}) });
    }
    bodies.sort((a, b) => a.numericId - b.numericId);
    const actorIds = finalIds;
    const ambient = finalActors.filter((actor) => !significant.has(actor.id));
    const ambientCount = ambient.length + animals.length + buses.length;
    const perAnchor = anchors.map((anchor) => ({ id: anchor.id, count: [...ambient, ...animals, ...buses].filter((point) => inAnchor(point, anchor)).length }));
    const runtime: AgentRuntimeData = { ...old, version: 1, tick: context.state.tick, spatial: { ...spatial.state, walkers: spatial.state.walkers.filter((track) => finalIds.has(track.id)), animals }, fleet: { ...fleet.state, nextActorId: nextId }, bodies, animalIds,
      requests: requestData.keys, nextRequestId: requestData.nextId, requestTickFloor: requestData.floor,
      activeRequestKeys,
      queuedVanRequests,
      significantAgentIds: [...significant].filter((id) => actorIds.has(id)).sort((a, b) => a - b), deliveredAgentIds: [...delivered].filter((id) => actorIds.has(id)).sort((a, b) => a - b), events,
      lanyardPersonIds: finalActors.filter((actor) => actor.kind === "person" && conferenceAt(old, nearestAnchor(actor, anchors)).active).map((actor) => actor.id),
      population: { ambient: ambientCount, significant: significant.size + extraSignificant, extraSignificant,
        reservedVanUnits: (fleet.state.vans.jobs.filter((job) => job.vehicleId !== null && job.status !== "delivered" && job.retiredTick === null).length + fleet.state.pendingDeliveries.length) * 2,
        robots: ambient.filter((actor) => actor.kind !== "person").length + buses.length, people: ambient.filter((actor) => actor.kind === "person").length, badRobots: ambient.filter((actor) => actor.kind !== "person" && bad.has(actor.id)).length, ambientIds: ambient.map((actor) => actor.id), perAnchor, badBaselines: selected.badBaselines },
      diagnostics: [...fleet.diagnostics, `population:ambient=${ambientCount}:significant=${significant.size + extraSignificant}`, ...(queuedVanRequests.length ? ["van:significant-capacity"] : [])] };
    const ext: RuntimeAgentsExt = { ...current, nextId, list: finalActors, runtime };
    return { ...context.state, ext: { ...context.state.ext, agents: ext } };
  } };
}

/** Recheck actual final poses after shared dodge; significant actors are never trimmed. */
export function enforceAgentRuntimePopulation(state: Readonly<SimState>): SimState {
  if (!agentRuntimeSession(state)) return state as SimState;
  const old = agentsRuntimeOf(state);
  if (!old) return state as SimState;
  const actors = agentsOf(state);
  const actorIds = new Set(actors.map(actor => actor.id));
  const robotState = record(state.ext.robots);
  const previousSignificant = new Set(old.significantAgentIds);
  const extraSignificant = old.population.extraSignificant ?? 0;
  const significant = new Set([...previousSignificant, ...numbers(robotState?.significantAgentIds), ...numbers(robotState?.robotSignificantAgentIds)].filter(id => previousSignificant.has(id) || actorIds.has(id)));
  const anchors = sortedIds(state.players).map(id => {
    const player = state.players[id]!; const point = player.mode === "foot" && player.foot ? player.foot : player.car;
    return { id, x: point.x, z: point.z };
  });
  const byBody = new Map(old.bodies.map(body => [body.id, body]));
  let animals = old.spatial.animals.map(animal => {
    const body = byBody.get(animal.id);
    return body ? { ...animal, x: body.x, y: body.y, z: body.z, heading: body.heading, speed: body.speed } : animal;
  });
  const buses = old.bodies.filter(body => body.model === "bus");
  const bad = badRobots(actors, state);
  let ambient = actors.filter(actor => !significant.has(actor.id));
  const occupied = [...ambient, ...animals, ...buses];
  const overflow = occupied.length > MAX_AMBIENT_AGENTS || anchors.some(anchor => occupied.filter(point => inAnchor(point, anchor)).length > MAX_AMBIENT_PER_ANCHOR);
  const selection = overflow ? population(actors, significant, anchors, old, state.tick, bad, [...animals, ...buses]) : { actors: [...actors], badBaselines: old.population.badBaselines };
  const retained = new Set(selection.actors.map(actor => actor.id));
  const removed = new Set(actors.filter(actor => !retained.has(actor.id)).map(actor => actor.id));
  animals = animals.filter(animal => animal.ownerId === null || retained.has(animal.ownerId));
  const animalKeys = new Set(animals.map(animal => animal.id));
  const oldAnimalKeys = new Set(old.animalIds.map(animal => animal.key));
  const removedNames = new Set([...removed].map(id => `agent:${id}`));
  for (const id of oldAnimalKeys) if (!animalKeys.has(id)) removedNames.add(id);
  ambient = selection.actors.filter(actor => !significant.has(actor.id));
  const total = ambient.length + animals.length + buses.length;
  const metadata = record(record(old.routineOutput)?.actorMetadata);
  let routineOutput = old.routineOutput;
  if (metadata && removedNames.size > 0) {
    const nextMetadata: Record<string, unknown> = {};
    for (const id of sortedIds(metadata)) if (!removedNames.has(id)) nextMetadata[id] = metadata[id];
    routineOutput = { ...record(old.routineOutput), actorMetadata: nextMetadata };
  }
  const runtime: AgentRuntimeData = { ...old, bodies: old.bodies.filter(body => !oldAnimalKeys.has(body.id) || animalKeys.has(body.id)),
    spatial: { ...old.spatial, walkers: old.spatial.walkers.filter(walker => retained.has(walker.id)), animals },
    animalIds: old.animalIds.filter(animal => animalKeys.has(animal.key)),
    significantAgentIds: [...significant].sort((a, b) => a - b), lanyardPersonIds: old.lanyardPersonIds.filter(id => retained.has(id)),
    population: { ...old.population, ambient: total, significant: significant.size + extraSignificant,
      robots: ambient.filter(actor => actor.kind !== "person").length + buses.length, people: ambient.filter(actor => actor.kind === "person").length,
      badRobots: ambient.filter(actor => actor.kind !== "person" && bad.has(actor.id)).length, ambientIds: ambient.map(actor => actor.id),
      perAnchor: anchors.map(anchor => ({ id: anchor.id, count: [...ambient, ...animals, ...buses].filter(point => inAnchor(point, anchor)).length })), badBaselines: selection.badBaselines },
    diagnostics: [...old.diagnostics.filter(value => !value.startsWith("population:ambient=")), `population:ambient=${total}:significant=${significant.size + extraSignificant}`],
    ...(routineOutput === undefined ? {} : { routineOutput }) };
  const robots: JsonObject = { ...state.ext.robots! };
  if (removedNames.size > 0) {
    const keep = (value: JsonValue): boolean => {
      const entry = record(value);
      if (!entry) return true;
      if (typeof entry.agentId === "number" && removed.has(entry.agentId)) return false;
      const id = typeof entry.actorId === "string" ? entry.actorId : typeof entry.id === "string" ? entry.id : "";
      return !removedNames.has(id);
    };
    for (const key of ["actors", "baselines", "metadata", "locomotion"]) if (Array.isArray(robots[key])) robots[key] = (robots[key] as JsonValue[]).filter(keep);
    const brain = robots.brain;
    if (brain !== null && typeof brain === "object" && !Array.isArray(brain) && Array.isArray(brain.robots)) robots.brain = { ...brain, robots: brain.robots.filter(keep) };
  }
  const agents: RuntimeAgentsExt = { ...state.ext.agents!, list: selection.actors, runtime };
  return { ...state, ext: { ...state.ext, robots, agents } };
}

export const agentRuntimeSystem = createAgentRuntimeSystem();
