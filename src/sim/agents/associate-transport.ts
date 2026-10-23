// Associates retain a person identity and use a separate, stable vehicle body.
// The caller hides bound riders from independent collision and rendering.
import { DT, sortedIds } from "../contract.ts";
import { AGENT_SPEC, ROBOTAXI_BODY } from "../agents.ts";
import { boxBlocked, boxCrossedWall } from "../collide.ts";
import type { Circle } from "../collide.ts";
import type { CombatActor } from "../combat-contract.ts";
import { datan2 } from "../dmath.ts";
import { hash32 } from "../rng.ts";
import { dirIndex, lanePath, pathPoint, projectOnPath } from "../roads.ts";
import type { SimSystemContext } from "../system-contract.ts";
import { circleBlocked, meshGroundHeight, segmentBlocked } from "../world.ts";
import type { World } from "../world.ts";
import { isTransportRoad, planTransportRoadRoute } from "./recruit-transport.ts";
import type { RecruitTaxiRoute } from "./recruit-transport.ts";
import type { RuntimePhysicalBody } from "./runtime-state.ts";

export const MAX_ASSOCIATE_TRANSPORTS = 24;
export type AssociateTransportMode = "scooter" | "car";
export interface AssociateTransportEntry {
  readonly id: string;
  readonly ownerId: string;
  readonly mode: AssociateTransportMode;
  readonly phase: "approach" | "driving" | "parked";
  readonly route: RecruitTaxiRoute | null;
  readonly distanceM: number;
  readonly entryPoint: { readonly x: number; readonly z: number; readonly heading: number } | null;
  readonly target: { readonly x: number; readonly z: number } | null;
  readonly nextPlanTick: number;
  readonly speed: number;
  readonly body: RuntimePhysicalBody;
  readonly vehicle: RuntimePhysicalBody | null;
  readonly blocked: string | null;
}
export interface AssociateTransportState {
  readonly version: 1;
  readonly lastTick: number;
  readonly entries: readonly AssociateTransportEntry[];
}
export interface AssociateTransportInput {
  readonly bodies: readonly RuntimePhysicalBody[];
  readonly owners?: readonly { readonly bodyId: string; readonly playerId: string }[];
  readonly nextActorId: number;
  /** Free physical actor slots, excluding vehicles already retained by this state. */
  readonly remainingCapacity: number;
}
export interface AssociateRiderBinding {
  readonly riderId: string;
  readonly vehicleId: string;
}
export interface AssociateTransportResult {
  readonly state: AssociateTransportState;
  readonly bodies: RuntimePhysicalBody[];
  readonly nextActorId: number;
  readonly riderBindings: AssociateRiderBinding[];
  readonly actorMetadata: Record<string, Partial<CombatActor>>;
  readonly diagnostics: string[];
}

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const gap = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.z - b.z) * (a.z - b.z));
const dimensions = (mode: AssociateTransportMode): { hl: number; hw: number; speed: number; height: number } =>
  mode === "car" ? { hl: 2.2, hw: 0.95, speed: 10, height: 1.6 } : { hl: 0.85, hw: 0.3, speed: 6, height: 1.3 };
const isAssociate = (body: RuntimePhysicalBody): boolean => body.kind === "person" && ["associate", "associate-scooter", "associate-car"].includes(body.model);
function finitePoint(point: { x: number; z: number }): boolean {
  return [point.x, point.z].every((value) => Number.isFinite(value) && Math.abs(value) <= 1e7);
}
function validBody(body: RuntimePhysicalBody): boolean {
  return body.id.length > 0 && body.id.length <= 256 && Number.isSafeInteger(body.numericId) && body.numericId >= 0 && body.numericId < Number.MAX_SAFE_INTEGER && finitePoint(body) &&
    [body.y, body.heading, body.previousX, body.previousZ, body.previousHeading, body.speed, body.radius, body.halfLength, body.halfWidth, body.height].every(Number.isFinite) &&
    body.radius > 0 && body.halfLength > 0 && body.halfWidth > 0 && body.height > 0;
}
function stringHash(id: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) value = Math.imul(value ^ id.charCodeAt(i), 0x01000193);
  return value >>> 0;
}

export function createAssociateTransportState(): AssociateTransportState {
  return { version: 1, lastTick: -1, entries: [] };
}

function obstacleCircles(context: SimSystemContext, bodies: Iterable<RuntimePhysicalBody>, ignored: ReadonlySet<string>, y: number, height: number): Circle[] {
  const result: Circle[] = [], represented = new Set<string>();
  const overlapsHeight = (base: number, tall: number): boolean => base < y + height && base + tall > y;
  for (const body of bodies) {
    represented.add(body.id);
    if (ignored.has(body.id) || !overlapsHeight(body.y, body.height)) continue;
    const r = body.kind === "vehicle" ? Math.sqrt(body.halfLength * body.halfLength + body.halfWidth * body.halfWidth) : body.radius;
    result.push({ x: body.x, z: body.z, r: r + 0.6, person: body.kind !== "vehicle" });
  }
  for (const body of context.state.ext.agents?.list ?? []) {
    const id = `agent:${body.id}`, spec = AGENT_SPEC[body.kind];
    if (ignored.has(id) || represented.has(id) || !overlapsHeight(body.y, body.kind === "robotaxi" ? ROBOTAXI_BODY.height : body.kind === "sidewalkBot" ? 0.7 : 1.8)) continue;
    const radius = body.kind === "robotaxi" ? Math.sqrt(ROBOTAXI_BODY.halfLength * ROBOTAXI_BODY.halfLength + ROBOTAXI_BODY.halfWidth * ROBOTAXI_BODY.halfWidth) : spec.radius;
    result.push({ x: body.x, z: body.z, r: radius + 0.6, person: body.kind === "person" });
  }
  for (const playerId of sortedIds(context.state.players)) {
    const player = context.state.players[playerId]!;
    if (overlapsHeight(player.car.y, 1.6)) result.push({ x: player.car.x, z: player.car.z, r: 2.75, person: false });
    if (player.mode === "foot" && player.foot && overlapsHeight(player.foot.y, 1.8)) result.push({ x: player.foot.x, z: player.foot.z, r: 0.95, person: true });
  }
  return result;
}

function roadEntry(world: World, body: RuntimePhysicalBody, mode: AssociateTransportMode, obstacles: readonly Circle[]): AssociateTransportEntry["entryPoint"] {
  const dim = dimensions(mode);
  const candidates: { x: number; z: number; heading: number; distance: number; key: string }[] = [];
  for (const edge of world.roads?.edges ?? []) {
    if (!isTransportRoad(edge)) continue;
    for (const direction of [1, -1] as const) {
      if (!edge.laneCount[dirIndex(direction)] || !edge.laneSafe[dirIndex(direction)][0]) continue;
      const path = lanePath(edge, direction, 0), projected = projectOnPath(path, body.x, body.z);
      if (projected.dist > 12) continue;
      const point = pathPoint(path, projected.s), heading = datan2(point.tx, -point.tz);
      if (segmentBlocked(world, body.x, body.z, point.x, point.z) || boxBlocked(world, { x: point.x, z: point.z, heading, hl: dim.hl, hw: dim.hw }, body.y, obstacles)) continue;
      candidates.push({ x: point.x, z: point.z, heading, distance: projected.dist, key: `${edge.id}:${direction}` });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance || compare(a.key, b.key));
  const selected = candidates[0];
  return selected ? { x: selected.x, z: selected.z, heading: selected.heading } : null;
}

function descriptor(body: RuntimePhysicalBody, mounted: boolean): Partial<CombatActor> {
  return { kind: "person", firmware: "none", protected: mounted,
    posture: mounted ? "seated" : "standing", occupied: mounted, obeysTraffic: true,
    x: body.x, y: body.y, z: body.z, heading: body.heading, speed: body.speed, radius: body.radius };
}
function poseBody(body: RuntimePhysicalBody, x: number, z: number, heading: number, speed: number, world: World): RuntimePhysicalBody {
  return { ...body, previousX: body.x, previousZ: body.z, previousHeading: body.heading, x, y: meshGroundHeight(world, x, z), z, heading, speed };
}
function carry(rider: RuntimePhysicalBody, vehicle: RuntimePhysicalBody): RuntimePhysicalBody {
  return { ...rider, previousX: rider.x, previousZ: rider.z, previousHeading: rider.heading,
    x: vehicle.x, y: vehicle.y, z: vehicle.z, heading: vehicle.heading, speed: vehicle.speed };
}
function approach(world: World, body: RuntimePhysicalBody, point: NonNullable<AssociateTransportEntry["entryPoint"]>, obstacles: readonly Circle[]): RuntimePhysicalBody {
  const distance = gap(body, point), step = Math.min(distance, 1.6 * DT);
  if (distance <= 1e-8) return { ...body, speed: 0 };
  const x = body.x + (point.x - body.x) * step / distance, z = body.z + (point.z - body.z) * step / distance;
  if (circleBlocked(world, x, z, body.radius) || segmentBlocked(world, body.x, body.z, x, z) ||
    obstacles.some((obstacle) => gap({ x, z }, obstacle) < body.radius + obstacle.r)) return { ...body, speed: 0 };
  return poseBody(body, x, z, datan2(x - body.x, -(z - body.z)), step / DT, world);
}
function drive(world: World, body: RuntimePhysicalBody, entry: AssociateTransportEntry, obstacles: readonly Circle[]): { body: RuntimePhysicalBody; distanceM: number; blocked: boolean } {
  const route = entry.route;
  if (!route) return { body: { ...body, speed: 0 }, distanceM: entry.distanceM, blocked: true };
  const dim = dimensions(entry.mode), remaining = Math.max(0, route.path.len - entry.distanceM);
  let desired = Math.min(dim.speed, route.speedLimit, Math.sqrt(16 * remaining));
  const lookahead = Math.min(route.path.len, entry.distanceM + entry.speed * entry.speed / 16 + 2);
  for (let s = entry.distanceM; s < lookahead + 0.5; s += 0.5) {
    const point = pathPoint(route.path, Math.min(s, lookahead)), heading = datan2(point.tx, -point.tz);
    if (boxBlocked(world, { x: point.x, z: point.z, heading, hl: dim.hl, hw: dim.hw }, body.y, obstacles)) { desired = 0; break; }
  }
  const speed = desired > entry.speed ? Math.min(desired, entry.speed + 3 * DT) : Math.max(desired, entry.speed - 8 * DT);
  const distanceM = Math.min(route.path.len, entry.distanceM + speed * DT), point = pathPoint(route.path, distanceM), heading = datan2(point.tx, -point.tz);
  const box = { x: point.x, z: point.z, heading, hl: dim.hl, hw: dim.hw };
  if (boxBlocked(world, box, body.y, obstacles) || boxCrossedWall(world, box, body)) return { body: { ...body, speed: 0 }, distanceM: entry.distanceM, blocked: true };
  return { body: poseBody(body, point.x, point.z, heading, distanceM >= route.path.len - 1e-8 ? 0 : speed, world), distanceM, blocked: desired === 0 };
}

/** Current rider and vehicle poses are authoritative. Missing routes never move actors. */
export function stepAssociateTransport(context: SimSystemContext, previous: AssociateTransportState, input: AssociateTransportInput): AssociateTransportResult {
  const tick = context.state.tick;
  if (!Number.isSafeInteger(tick) || tick < 0 || tick > Number.MAX_SAFE_INTEGER - 60 || !Number.isSafeInteger(previous.lastTick) || previous.lastTick < -1 || tick < previous.lastTick || previous.version !== 1 ||
    previous.entries.length > MAX_ASSOCIATE_TRANSPORTS || !Number.isSafeInteger(input.nextActorId) || input.nextActorId < 0 ||
    !Number.isSafeInteger(input.remainingCapacity) || input.remainingCapacity < 0 || !Number.isInteger(context.state.seed)) throw new RangeError("Invalid associate transport state");
  const bodyIds = new Set<string>(), numericIds = new Set<number>();
  for (const body of input.bodies) {
    if (bodyIds.has(body.id) || numericIds.has(body.numericId) || !validBody(body)) throw new RangeError("Invalid associate body");
    bodyIds.add(body.id); numericIds.add(body.numericId);
  }
  for (const id of sortedIds(context.state.players)) {
    const owner = context.state.players[id]!;
    if (!finitePoint(owner.car) || (owner.foot && !finitePoint(owner.foot))) throw new RangeError("Invalid associate owner");
  }
  const bindings = new Map((input.owners ?? []).map((binding) => [binding.bodyId, binding.playerId]));
  if (bindings.size !== (input.owners?.length ?? 0)) throw new RangeError("Duplicate associate owner");
  const existing = new Map(previous.entries.map((entry) => [entry.id, entry]));
  if (existing.size !== previous.entries.length) throw new RangeError("Duplicate associate state");
  for (const entry of previous.entries) {
    if (!validBody(entry.body) || entry.body.id !== entry.id || entry.body.kind !== "person" ||
      (entry.mode !== "car" && entry.mode !== "scooter") || !["approach", "driving", "parked"].includes(entry.phase) ||
      (entry.vehicle && (!validBody(entry.vehicle) || entry.vehicle.kind !== "vehicle" || entry.vehicle.id !== `associate-vehicle:${entry.id}`)) ||
      !Number.isSafeInteger(entry.nextPlanTick) || entry.nextPlanTick < 0 || !Number.isFinite(entry.speed) || entry.speed < 0 ||
      !Number.isFinite(entry.distanceM) || entry.distanceM < 0 || (entry.target && !finitePoint(entry.target)) ||
      (entry.entryPoint && (!finitePoint(entry.entryPoint) || !Number.isFinite(entry.entryPoint.heading))) ||
      (entry.route && (!Number.isFinite(entry.route.path.len) || entry.route.path.len < entry.distanceM || !Number.isFinite(entry.route.speedLimit) || entry.route.speedLimit <= 0 ||
      entry.route.path.xs.length < 1 || entry.route.path.xs.length > 4096 || entry.route.path.xs.length !== entry.route.path.zs.length ||
      entry.route.path.xs.length !== entry.route.path.cum.length || !entry.route.path.xs.every(Number.isFinite) ||
      !entry.route.path.zs.every(Number.isFinite) || !entry.route.path.cum.every(Number.isFinite) ||
      entry.route.path.cum[0] !== 0 || entry.route.path.cum[entry.route.path.cum.length - 1] !== entry.route.path.len ||
      entry.route.path.cum.some((value, index) => index > 0 && value < entry.route!.path.cum[index - 1]!)))) throw new RangeError("Invalid associate entry");
  }
  const metadata: Record<string, Partial<CombatActor>> = Object.create(null) as Record<string, Partial<CombatActor>>;
  const diagnostics: string[] = [], entries: AssociateTransportEntry[] = [], riderBindings: AssociateRiderBinding[] = [];
  const output = new Map(input.bodies.map((body) => [body.id, body]));
  const numericOwners = new Map(input.bodies.map((body) => [body.numericId, body.id]));
  for (const entry of previous.entries) if (entry.vehicle && bodyIds.has(entry.id)) {
    const owner = numericOwners.get(entry.vehicle.numericId), current = output.get(entry.vehicle.id);
    if ((owner !== undefined && owner !== entry.vehicle.id) || (current && (current.numericId !== entry.vehicle.numericId || current.kind !== "vehicle"))) throw new RangeError("Conflicting associate vehicle identity");
    numericOwners.set(entry.vehicle.numericId, entry.vehicle.id); numericIds.add(entry.vehicle.numericId);
    if (!current) output.set(entry.vehicle.id, entry.vehicle);
  }
  const hidden = new Set(previous.entries.filter((entry) => entry.vehicle !== null).map((entry) => entry.id));
  let nextActorId = input.nextActorId, capacity = input.remainingCapacity;
  for (const id of numericIds) nextActorId = Math.max(nextActorId, id + 1);
  for (const body of context.state.ext.agents?.list ?? []) { numericIds.add(body.id); nextActorId = Math.max(nextActorId, body.id + 1); }
  for (const original of [...input.bodies].filter(isAssociate).sort((a, b) => compare(a.id, b.id))) {
    if (entries.length === MAX_ASSOCIATE_TRANSPORTS) { diagnostics.push(`${original.id}:associate-capacity`); continue; }
    let entry = existing.get(original.id);
    let ownerId = bindings.get(original.id) ?? entry?.ownerId ?? "";
    if (!ownerId) {
      let best = Infinity;
      for (const id of sortedIds(context.state.players)) {
        const owner = context.state.players[id]!, point = owner.mode === "foot" && owner.foot ? owner.foot : owner.car, distance = gap(original, point);
        if (distance < best) { ownerId = id; best = distance; }
      }
    }
    const mode: AssociateTransportMode = entry?.mode ?? (original.model === "associate-car" ? "car" : original.model === "associate-scooter" ? "scooter" : hash32(context.state.seed, stringHash(original.id)) % 2 === 0 ? "car" : "scooter");
    entry ??= { id: original.id, ownerId, mode, phase: "approach", route: null, distanceM: 0, entryPoint: null, target: null, nextPlanTick: tick, speed: 0, body: original, vehicle: null, blocked: null };
    const owner = context.state.players[ownerId];
    let rider = original, vehicle = entry.vehicle ? output.get(entry.vehicle.id) ?? entry.vehicle : null;
    if (vehicle) output.set(vehicle.id, vehicle);
    const ignored = new Set(hidden); ignored.add(original.id); if (vehicle) ignored.add(vehicle.id);
    const obstacles = obstacleCircles(context, output.values(), ignored, (vehicle ?? rider).y, Math.max(rider.height, dimensions(mode).height));
    let justMounted = false;
    if (tick === previous.lastTick) {
      rider = entry.body; vehicle = entry.vehicle;
    } else if (original.dodge !== null) {
      entry = { ...entry, ownerId, body: original, speed: 0, blocked: "dodge" };
      if (vehicle) vehicle = { ...vehicle, speed: 0 };
    } else if (!owner) {
      rider = { ...rider, speed: 0 }; if (vehicle) vehicle = { ...vehicle, speed: 0 };
      entry = { ...entry, ownerId, speed: 0, blocked: "missing-owner" };
    } else {
      const target = owner.mode === "foot" && owner.foot ? owner.foot : owner.car;
      if (vehicle && entry.route && gap(vehicle, pathPoint(entry.route.path, entry.distanceM)) > 0.05) {
        entry = { ...entry, phase: "parked", route: null, distanceM: 0, speed: 0, nextPlanTick: tick };
      }
      if (!vehicle && entry.phase === "approach") {
        const point = entry.entryPoint ?? (tick >= entry.nextPlanTick ? roadEntry(context.world, rider, mode, obstacles) : null);
        if (!point) {
          rider = { ...rider, speed: 0 };
          entry = { ...entry, blocked: "no-safe-road-entry", nextPlanTick: tick >= entry.nextPlanTick ? tick + 60 : entry.nextPlanTick };
        } else {
          rider = approach(context.world, rider, point, obstacles);
          entry = { ...entry, entryPoint: point, speed: rider.speed, blocked: rider.speed === 0 && gap(rider, point) > 1e-6 ? "entry-blocked" : null };
          const dim = dimensions(mode), vehicleId = `associate-vehicle:${rider.id}`;
          if (gap(rider, point) <= 1e-6 && !boxBlocked(context.world, { ...point, hl: dim.hl, hw: dim.hw }, rider.y, obstacles)) {
            if (capacity <= 0 || output.has(vehicleId)) entry = { ...entry, blocked: "vehicle-capacity" };
            else {
              while (numericIds.has(nextActorId)) nextActorId++;
              if (!Number.isSafeInteger(nextActorId + 1)) throw new RangeError("Associate actor id exhausted");
              vehicle = { ...rider, id: vehicleId, numericId: nextActorId++, kind: "vehicle", model: `associate-${mode}`, firmware: "none",
                radius: dim.hw, halfLength: dim.hl, halfWidth: dim.hw, height: dim.height, previousX: rider.x, previousZ: rider.z, heading: point.heading, previousHeading: point.heading, speed: 0, dodge: null };
              numericIds.add(vehicle.numericId); capacity--; hidden.add(rider.id); justMounted = true;
              entry = { ...entry, phase: "parked", route: null, distanceM: 0, speed: 0, nextPlanTick: tick, blocked: null };
            }
          }
        }
      }
      if (vehicle && !justMounted) {
        const stoppedNearOwner = gap(vehicle, target) <= (mode === "car" ? 10 : 6), routeFinished = entry.route !== null && entry.distanceM >= entry.route.path.len - 1e-6;
        if (!stoppedNearOwner && tick >= entry.nextPlanTick && (entry.route === null || routeFinished || entry.target === null || gap(entry.target, target) > 20)) {
          const route = planTransportRoadRoute(context.world, vehicle, target, 30);
          entry = { ...entry, route, distanceM: 0, target: { x: target.x, z: target.z }, nextPlanTick: tick + 60,
            phase: route ? "driving" : "parked", blocked: route ? null : "no-directed-road-route" };
        }
        if (stoppedNearOwner) {
          vehicle = { ...vehicle, speed: 0 }; entry = { ...entry, speed: 0, phase: "parked", route: null, blocked: null };
        } else if (entry.route) {
          const moved = drive(context.world, vehicle, entry, obstacles); vehicle = moved.body;
          entry = { ...entry, distanceM: moved.distanceM, speed: vehicle.speed, blocked: moved.blocked ? "traffic-or-building" : null };
        } else { vehicle = { ...vehicle, speed: 0 }; entry = { ...entry, speed: 0 }; }
      }
      if (vehicle) rider = carry(rider, vehicle);
    }
    entry = { ...entry, ownerId, body: rider, vehicle };
    entries.push(entry); output.set(rider.id, rider); metadata[rider.id] = descriptor(rider, vehicle !== null);
    if (vehicle) { output.set(vehicle.id, vehicle); metadata[vehicle.id] = descriptor(vehicle, true); riderBindings.push({ riderId: rider.id, vehicleId: vehicle.id }); }
    if (entry.blocked) diagnostics.push(`${entry.id}:${entry.blocked}`);
  }
  // A removed associate no longer owns a retained vehicle; never leave an orphan obstacle.
  for (const old of previous.entries) if (old.vehicle && !entries.some((entry) => entry.id === old.id)) output.delete(old.vehicle.id);
  return { state: { version: 1, lastTick: tick, entries }, bodies: [...output.keys()].sort(compare).map((id) => output.get(id)!), nextActorId, riderBindings, actorMetadata: metadata, diagnostics };
}
