import { DT, TICK_HZ } from "../contract.ts";
import { datan2 } from "../dmath.ts";
import { boxBlocked, boxCrossedWall, type Circle } from "../collide.ts";
import { circleBlocked, meshGroundHeight, type World } from "../world.ts";
import { connector, connectorPath, dirIndex, lanePath, makePath, pathPoint, projectOnPath, subPath, walkPath, type Dir, type Path, type RoadEdgeInfo } from "../roads.ts";
import { toLocal } from "../../geo/project.ts";
import { createBusServiceState, createVanServiceState, stepBusServices, stepVanServices, type AdWrapSlot, type BusRetirement, type BusRoute, type BusServiceState, type ServiceIntent, type ServiceRoadLeg, type ThreatVanRequest, type VanRetirement, type VanRouteCandidate, type VanServiceState, type VehicleProgress } from "./services.ts";

export const FLEET_ACCELERATION = 6;
export const FLEET_BRAKING = 10;
export const FLEET_CLEARANCE = 0.75;
const VAN_SPEED = 16;
const BUS_SPEED = 10;
const MAX_ROUTE_M = 1800;
// Authored site points can be inside a large parcel; dispatch starts on its access road.
const DEPOT_ROAD_ACCESS_M = 150;

export interface FleetDepot { id: string; kind: "hq" | "depot"; x: number; z: number }
export const DEFAULT_FLEET_DEPOTS: readonly FleetDepot[] = [
  { id: "moat-hq", kind: "hq", ...toLocal(37.78352, -122.40082) },
  { id: "depot-bridge", kind: "depot", ...toLocal(37.787, -122.3884) },
  { id: "depot-mission-bay", kind: "depot", ...toLocal(37.77, -122.387) },
];
export interface FleetObstacle { id: string; x: number; z: number; radius: number; person: boolean }
export interface FleetSection { edgeId: string; policyEdgeId: number; direction: Dir; fromM: number; toM: number; speedLimitMps: number; oneWay: boolean }
export interface FleetRoute { id: string; path: Path; sections: FleetSection[]; policyLegs: ServiceRoadLeg[]; entryAfterLeg: number; entryM: number; expectedTravelTicks: number; cruiseSpeedMps: number }
export interface FleetVehicle {
  id: number; kind: "van" | "bus"; requestId: number | null; depotId: string | null;
  route: FleetRoute; distanceM: number; stopAtDistanceM: number;
  x: number; y: number; z: number; heading: number; speed: number;
  spawned: boolean; retiring: boolean; retirementRequested: boolean;
  returnAttemptTick: number;
  blocked: boolean; adWrapSlot: AdWrapSlot | null;
}
export interface FleetDelivery { requestId: number; vehicleId: number }
export interface FleetState {
  lastTick: number; nextActorId: number; vans: VanServiceState; buses: BusServiceState;
  vehicles: FleetVehicle[]; busRoute: FleetRoute | null; busPolicy: BusRoute | null;
  pendingDeliveries: FleetDelivery[];
}
export interface FleetActor {
  id: number; kind: "van" | "bus"; x: number; y: number; z: number; heading: number; speed: number;
  halfLength: number; halfWidth: number; personProtected: boolean; adWrapSlot: AdWrapSlot | null;
}
export interface FleetBody extends FleetActor { previousX: number; previousZ: number; previousHeading: number }
export interface FleetDisembark { requestId: number; vehicleId: number; units: { id: number; x: number; y: number; z: number; heading: number }[] }

interface Lane { key: string; edge: RoadEdgeInfo; policyId: number; dir: Dir; path: Path; from: number; to: number }
interface Projection { lane: Lane; s: number; distance: number }
interface Part { path: Path; lane: Lane; speed: number }
interface Network { lanes: Lane[]; outgoing: Map<number, Lane[]> }
// Derived geometry only: no simulation decisions or mutable actor state enter this cache.
const networks = new WeakMap<World, Network>();
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const dimensions = (kind: "van" | "bus"): { hl: number; hw: number } => kind === "van" ? { hl: 2.6, hw: 1.1 } : { hl: 4.5, hw: 1.3 };

/** One allocator is shared by vans, buses and the units they deliver. The caller must
 * reserve the returned nextActorId in the ambient actor allocator before spawning more.
 */
export function createFleetState(firstActorId: number): FleetState {
  return { lastTick: -1, nextActorId: firstActorId, vans: createVanServiceState(firstActorId), buses: createBusServiceState(firstActorId), vehicles: [], busRoute: null, busPolicy: null, pendingDeliveries: [] };
}

function network(world: World): Network {
  const cached = networks.get(world);
  if (cached) return cached;
  const lanes: Lane[] = [];
  const outgoing = new Map<number, Lane[]>();
  const edges = [...(world.roads?.edges ?? [])].sort((a, b) => compare(a.id, b.id));
  for (let policyId = 0; policyId < edges.length; policyId++) {
    const edge = edges[policyId]!;
    if (!edge.drivable) continue;
    for (const dir of [1, -1] as const) {
      if (edge.laneCount[dirIndex(dir)] < 1 || !edge.laneSafe[dirIndex(dir)][0]) continue;
      const lane: Lane = { key: `${edge.id}:${dir}`, edge, policyId, dir, path: lanePath(edge, dir, 0), from: dir === 1 ? edge.a : edge.b, to: dir === 1 ? edge.b : edge.a };
      lanes.push(lane);
      const list = outgoing.get(lane.from) ?? [];
      list.push(lane);
      outgoing.set(lane.from, list);
    }
  }
  lanes.sort((a, b) => compare(a.key, b.key));
  for (const list of outgoing.values()) list.sort((a, b) => compare(a.key, b.key));
  const result = { lanes, outgoing };
  networks.set(world, result);
  return result;
}

function projections(net: Network, point: { x: number; z: number }, maxDistance: number, count: number): Projection[] {
  return net.lanes.map((lane) => { const p = projectOnPath(lane.path, point.x, point.z); return { lane, s: p.s, distance: p.dist }; })
    .filter((p) => p.distance <= maxDistance).sort((a, b) => a.distance - b.distance || compare(a.lane.key, b.lane.key)).slice(0, count);
}

function join(lane: Lane, next: Lane): Path {
  const a = pathPoint(lane.path, lane.path.len);
  const b = pathPoint(next.path, 0);
  return connectorPath(connector(a.x, a.z, a.tx, a.tz, b.x, b.z, b.tx, b.tz, 0.56));
}

/** Dijkstra states are directed lanes, so a cheapest arrival from the wrong direction
 * cannot hide a legal turn. Immediate U-turns are excluded; closed loops still work.
 */
function laneRoute(net: Network, start: Projection, target: Projection): Lane[] | null {
  if (start.lane.key === target.lane.key && target.s > start.s + 0.1) return [start.lane];
  const queue: { lane: Lane; cost: number }[] = [{ lane: start.lane, cost: 0 }];
  const distance = new Map<string, number>([[start.lane.key, 0]]);
  const previous = new Map<string, Lane>();
  const done = new Set<string>();
  while (queue.length > 0) {
    queue.sort((a, b) => b.cost - a.cost || compare(b.lane.key, a.lane.key));
    const current = queue.pop()!;
    if (done.has(current.lane.key)) continue;
    done.add(current.lane.key);
    if (current.cost > MAX_ROUTE_M) break;
    if (current.lane.to === target.lane.from && current.lane.edge.id !== target.lane.edge.id) {
      const route = [current.lane];
      let last = current.lane;
      while (last.key !== start.lane.key) { last = previous.get(last.key)!; route.push(last); }
      route.reverse();
      route.push(target.lane);
      return route;
    }
    for (const next of net.outgoing.get(current.lane.to) ?? []) {
      if (next.edge.id === current.lane.edge.id || done.has(next.key)) continue;
      const cost = current.cost + next.path.len + join(current.lane, next).len;
      const old = distance.get(next.key);
      if (old !== undefined && old <= cost) continue;
      distance.set(next.key, cost);
      previous.set(next.key, current.lane);
      queue.push({ lane: next, cost });
    }
  }
  return null;
}

function partsFor(net: Network, start: Projection, target: Projection, cruise: number): Part[] | null {
  const route = laneRoute(net, start, target);
  if (route === null) return null;
  const parts: Part[] = [];
  for (let i = 0; i < route.length; i++) {
    const lane = route[i]!;
    const from = i === 0 ? start.s : 0;
    const to = i === route.length - 1 ? target.s : lane.path.len;
    if (to > from + 0.000001) parts.push({ path: subPath(lane.path, from, to, 0.000001), lane, speed: Math.min(cruise, lane.edge.speedLimitMps) });
    if (i + 1 < route.length) parts.push({ path: join(lane, route[i + 1]!), lane, speed: Math.min(cruise, lane.edge.speedLimitMps, route[i + 1]!.edge.speedLimitMps, 8) });
  }
  return parts.length > 0 ? parts : null;
}

function mergedPath(parts: readonly Part[]): Path {
  const xs: number[] = [];
  const zs: number[] = [];
  for (const part of parts) for (let i = 0; i < part.path.xs.length; i++) {
    const x = part.path.xs[i]!; const z = part.path.zs[i]!;
    if (xs.length > 0 && Math.abs(xs[xs.length - 1]! - x) + Math.abs(zs[zs.length - 1]! - z) < 0.000001) continue;
    xs.push(x); zs.push(z);
  }
  return makePath(xs, zs);
}

function entryDistance(path: Path, player: { x: number; z: number }): number | null {
  for (let i = 0; i + 1 < path.xs.length; i++) {
    const ax = path.xs[i]! - player.x; const az = path.zs[i]! - player.z;
    const bx = path.xs[i + 1]! - player.x; const bz = path.zs[i + 1]! - player.z;
    if (ax * ax + az * az >= 120 * 120 && bx * bx + bz * bz <= 120 * 120) {
      const dx = bx - ax; const dz = bz - az;
      const a = dx * dx + dz * dz; const b = 2 * (ax * dx + az * dz); const c = ax * ax + az * az - 120 * 120;
      const discriminant = b * b - 4 * a * c;
      if (a > 0 && discriminant >= 0) {
        const t = Math.max(0, Math.min(1, (-b - Math.sqrt(discriminant)) / (2 * a)));
        return path.cum[i]! + Math.sqrt(a) * t;
      }
    }
  }
  const start = pathPoint(path, 0); const dx = start.x - player.x; const dz = start.z - player.z;
  return dx * dx + dz * dz >= 10000 && dx * dx + dz * dz <= 19600 ? 0 : null;
}

function physicalRoute(world: World, id: string, raw: Part[], kind: "van" | "bus", entry: number | null = null): FleetRoute | null {
  const parts: Part[] = [];
  let base = 0;
  for (const part of raw) {
    if (entry !== null && entry > base + 0.00001 && entry < base + part.path.len - 0.00001) {
      parts.push({ ...part, path: subPath(part.path, 0, entry - base, 0.000001) }, { ...part, path: subPath(part.path, entry - base, part.path.len, 0.000001) });
    } else parts.push(part);
    base += part.path.len;
  }
  const path = mergedPath(parts);
  if (path.len < 0.1 || path.len > MAX_ROUTE_M) return null;
  const sections: FleetSection[] = [];
  const policyLegs: ServiceRoadLeg[] = [];
  let distanceM = 0; let seconds = 0; let entryAfterLeg = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    sections.push({ edgeId: part.lane.edge.id, policyEdgeId: part.lane.policyId, direction: part.lane.dir, fromM: distanceM, toM: distanceM + part.path.len, speedLimitMps: part.speed, oneWay: part.lane.edge.oneway });
    policyLegs.push({ edgeId: part.lane.policyId, fromNode: i, toNode: i + 1, direction: part.lane.dir, oneWay: part.lane.edge.oneway, drivable: true, lengthM: part.path.len, speedLimitMps: part.speed });
    distanceM += part.path.len;
    seconds += part.path.len / part.speed;
    if (entry !== null && distanceM <= entry + 0.00001) entryAfterLeg = i + 1;
  }
  const dim = dimensions(kind);
  let previous = poseAt(path, 0);
  for (let s = 0; s <= path.len + 0.5; s += 0.5) {
    const pose = poseAt(path, Math.min(path.len, s));
    const box = { ...pose, ...dim };
    if (boxBlocked(world, box, meshGroundHeight(world, pose.x, pose.z)) || boxCrossedWall(world, box, previous)) return null;
    previous = pose;
  }
  const cruiseSpeedMps = kind === "van" ? VAN_SPEED : BUS_SPEED;
  return { id, path, sections, policyLegs, entryAfterLeg, entryM: entry ?? 0, expectedTravelTicks: Math.ceil((seconds + cruiseSpeedMps / FLEET_ACCELERATION + cruiseSpeedMps / FLEET_BRAKING) * TICK_HZ), cruiseSpeedMps };
}

function poseAt(path: Path, distanceM: number): { x: number; z: number; heading: number } {
  const p = pathPoint(path, distanceM);
  return { x: p.x, z: p.z, heading: datan2(p.tx, -p.tz) };
}

function vanCandidate(world: World, net: Network, request: ThreatVanRequest, depots: readonly FleetDepot[], obstacles: readonly FleetObstacle[]): { route: FleetRoute; policy: VanRouteCandidate } | null {
  const targets: Projection[] = [];
  const circles = obstacleCircles(obstacles, [], -1);
  for (const projection of projections(net, request.player, 12, 4)) for (const offset of [0, -8, 8, -10, 10]) {
    const s = Math.max(0, Math.min(projection.lane.path.len, projection.s + offset));
    const pose = poseAt(projection.lane.path, s);
    const dx = pose.x - request.player.x; const dz = pose.z - request.player.z;
    const distance = Math.sqrt(dx * dx + dz * dz);
    if (distance <= 12 && !boxBlocked(world, { ...pose, ...dimensions("van") }, meshGroundHeight(world, pose.x, pose.z), circles)) targets.push({ ...projection, s, distance });
  }
  const choices: { route: FleetRoute; policy: VanRouteCandidate }[] = [];
  for (const depot of [...depots].sort((a, b) => compare(a.id, b.id))) for (const origin of projections(net, depot, DEPOT_ROAD_ACCESS_M, 2)) for (const target of targets) {
    const parts = partsFor(net, origin, target, VAN_SPEED);
    if (parts === null) continue;
    const entry = entryDistance(mergedPath(parts), request.player);
    if (entry === null) continue;
    const route = physicalRoute(world, `van:${request.id}:${depot.id}:${origin.lane.key}:${target.lane.key}`, parts, "van", entry);
    if (route === null || route.entryAfterLeg >= route.policyLegs.length) continue;
    const start = pathPoint(route.path, 0); const finish = pathPoint(route.path, route.path.len); const entering = pathPoint(route.path, route.entryM);
    choices.push({ route, policy: { id: route.id, requestId: request.id, depotId: depot.id, depotKind: depot.kind, origin: { x: start.x, z: start.z, nodeId: 0 }, target: { x: finish.x, z: finish.z, nodeId: route.policyLegs.length }, entry: { x: entering.x, z: entering.z, nodeId: route.entryAfterLeg }, entryAfterLeg: route.entryAfterLeg, legs: route.policyLegs, cruiseSpeedMps: route.cruiseSpeedMps, expectedTravelTicks: route.expectedTravelTicks } });
  }
  choices.sort((a, b) => a.route.expectedTravelTicks - b.route.expectedTravelTicks || compare(a.route.id, b.route.id));
  return choices[0] ?? null;
}

function busCandidate(world: World, net: Network, ferry: { x: number; z: number }): { route: FleetRoute; policy: BusRoute } | null {
  for (const start of projections(net, ferry, 250, 8)) {
    const parts = partsFor(net, start, start, BUS_SPEED);
    if (parts === null) continue;
    const route = physicalRoute(world, `ferry-loop:${start.lane.key}`, parts, "bus");
    if (route === null) continue;
    const origin = pathPoint(route.path, 0);
    // Synthetic policy seam IDs describe continuous lane/connector boundaries. The
    // closed loop's final seam is the origin, as required by the timetable policy.
    route.policyLegs[route.policyLegs.length - 1]!.toNode = 0;
    return { route, policy: { id: route.id, source: "authored-fallback", origin: { x: origin.x, z: origin.z, nodeId: 0 }, legs: route.policyLegs, cruiseSpeedMps: BUS_SPEED, expectedTravelTicks: route.expectedTravelTicks, headwayGameMinutes: 10, firstDepartureMinute: 0, stops: [{ id: "ferry", nodeId: 0, afterLeg: 0, dwellTicks: 60 }, { id: "ferry", nodeId: 0, afterLeg: route.policyLegs.length, dwellTicks: 60 }], adWrapSlot: { slotId: "ferry-loop:wrap", surface: "left-right-rear", contentKey: null } } };
  }
  return null;
}

function vehicleCircles(vehicle: FleetVehicle): Circle[] {
  if (!vehicle.spawned) return [];
  const dim = dimensions(vehicle.kind);
  const p = pathPoint(vehicle.route.path, vehicle.distanceM);
  return [-1, 0, 1].map((sign) => ({ x: vehicle.x + p.tx * sign * (dim.hl - dim.hw), z: vehicle.z + p.tz * sign * (dim.hl - dim.hw), r: dim.hw + FLEET_CLEARANCE, person: vehicle.kind === "bus" }));
}

function obstacleCircles(obstacles: readonly FleetObstacle[], vehicles: readonly FleetVehicle[], except: number): Circle[] {
  const result: Circle[] = obstacles.map((o) => ({ x: o.x, z: o.z, r: o.radius + FLEET_CLEARANCE, person: o.person }));
  for (const vehicle of vehicles) if (vehicle.id !== except) result.push(...vehicleCircles(vehicle));
  return result;
}

function advance(world: World, vehicle: FleetVehicle, obstacles: readonly FleetObstacle[], vehicles: readonly FleetVehicle[]): void {
  if (!vehicle.spawned) return;
  const dim = dimensions(vehicle.kind);
  const circles = obstacleCircles(obstacles, vehicles, vehicle.id);
  const remaining = Math.max(0, vehicle.stopAtDistanceM - vehicle.distanceM);
  const section = vehicle.route.sections.find((s) => s.toM > vehicle.distanceM + 0.00001) ?? vehicle.route.sections[vehicle.route.sections.length - 1]!;
  let desired = Math.min(vehicle.route.cruiseSpeedMps, section.speedLimitMps, Math.sqrt(2 * FLEET_BRAKING * remaining));
  for (const ahead of vehicle.route.sections) {
    if (ahead.fromM <= vehicle.distanceM) continue;
    desired = Math.min(desired, Math.sqrt(ahead.speedLimitMps * ahead.speedLimitMps + 2 * FLEET_BRAKING * (ahead.fromM - vehicle.distanceM)));
  }
  let speed = desired > vehicle.speed ? Math.min(desired, vehicle.speed + FLEET_ACCELERATION * DT) : Math.max(desired, vehicle.speed - FLEET_BRAKING * DT);
  const lookahead = Math.min(vehicle.stopAtDistanceM, vehicle.distanceM + vehicle.speed * vehicle.speed / (2 * FLEET_BRAKING) + 2 + speed * DT);
  let blocked = false;
  for (let s = vehicle.distanceM; s <= lookahead + 0.25; s += 0.25) {
    const pose = poseAt(vehicle.route.path, Math.min(s, lookahead));
    if (boxBlocked(world, { ...pose, ...dim }, meshGroundHeight(world, pose.x, pose.z), circles)) { blocked = true; break; }
  }
  if (blocked) speed = Math.max(0, vehicle.speed - FLEET_BRAKING * DT);
  const nextDistance = Math.min(vehicle.stopAtDistanceM, vehicle.distanceM + speed * DT);
  const pose = poseAt(vehicle.route.path, nextDistance);
  const box = { ...pose, ...dim };
  if (boxBlocked(world, box, meshGroundHeight(world, pose.x, pose.z), circles) || boxCrossedWall(world, box, vehicle)) { vehicle.speed = 0; vehicle.blocked = true; return; }
  vehicle.distanceM = nextDistance;
  vehicle.x = pose.x; vehicle.z = pose.z; vehicle.heading = pose.heading; vehicle.y = meshGroundHeight(world, pose.x, pose.z);
  vehicle.speed = remaining <= speed * DT + 0.00001 ? 0 : speed;
  vehicle.blocked = blocked;
}

function actor(vehicle: FleetVehicle): FleetActor {
  const dim = dimensions(vehicle.kind);
  return { id: vehicle.id, kind: vehicle.kind, x: vehicle.x, y: vehicle.y, z: vehicle.z, heading: vehicle.heading, speed: vehicle.speed, halfLength: dim.hl, halfWidth: dim.hw, personProtected: vehicle.kind === "bus", adWrapSlot: vehicle.adWrapSlot === null ? null : { ...vehicle.adWrapSlot } };
}

function unloadPositions(world: World, vehicle: FleetVehicle, obstacles: readonly FleetObstacle[], vehicles: readonly FleetVehicle[]): { x: number; z: number }[] | null {
  const candidates: { x: number; z: number; distance: number; key: string }[] = [];
  for (const edge of world.roads?.edges ?? []) {
    if (!edge.walkable) continue;
    for (const side of [1, -1]) {
      const path = walkPath(edge, 1, side);
      const p = projectOnPath(path, vehicle.x, vehicle.z);
      if (p.dist > 18) continue;
      for (const delta of [-1, 1]) {
        const q = pathPoint(path, Math.max(0, Math.min(path.len, p.s + delta * 1.2)));
        candidates.push({ x: q.x, z: q.z, distance: p.dist, key: `${edge.id}:${side}:${delta}` });
      }
    }
  }
  candidates.sort((a, b) => a.distance - b.distance || compare(a.key, b.key));
  const circles = obstacleCircles(obstacles, vehicles, -1);
  const result: { x: number; z: number }[] = [];
  for (const p of candidates) {
    if (circleBlocked(world, p.x, p.z, 0.4) || circles.some((c) => { const dx = c.x - p.x; const dz = c.z - p.z; return dx * dx + dz * dz < (c.r + 0.4) * (c.r + 0.4); }) || result.some((q) => (p.x - q.x) * (p.x - q.x) + (p.z - q.z) * (p.z - q.z) < 2.25)) continue;
    result.push({ x: p.x, z: p.z });
    if (result.length === 2) return result;
  }
  return null;
}

/** Pure physical fleet reducer. Each call advances at most one physical tick even
 * when the supplied tick jumps; elapsed time never teleports a vehicle to its stop.
 * Call before the shared final clearance/dodge pass, then reserve nextActorId.
 */
export function stepFleet(world: World, previous: Readonly<FleetState>, input: {
  tick: number; gameMinute: number; requests: readonly ThreatVanRequest[];
  obstacles: readonly FleetObstacle[]; depots?: readonly FleetDepot[]; ferry?: { x: number; z: number };
}): { state: FleetState; nextActorId: number; actors: FleetActor[]; bodies: FleetBody[]; disembarks: FleetDisembark[]; diagnostics: string[] } {
  if (!Number.isSafeInteger(input.tick) || input.tick < 0) throw new RangeError("Invalid fleet tick");
  if (input.tick <= previous.lastTick) return { state: previous as FleetState, nextActorId: previous.nextActorId, actors: previous.vehicles.filter((v) => v.spawned).map(actor), bodies: [], disembarks: [], diagnostics: [] };
  const state: FleetState = { ...previous, lastTick: input.tick, vehicles: previous.vehicles.map((v) => ({ ...v })), pendingDeliveries: previous.pendingDeliveries.map((d) => ({ ...d })) };
  const diagnostics: string[] = [];
  const disembarks: FleetDisembark[] = [];
  const unloadingObstacles = [...input.obstacles];
  const vanRetirements: VanRetirement[] = [];
  const busRetirements: BusRetirement[] = [];
  const depots = input.depots ?? DEFAULT_FLEET_DEPOTS;
  let net: Network | null = null;
  const getNetwork = (): Network => net ?? (net = network(world));
  state.vehicles.sort((a, b) => a.id - b.id);
  for (const vehicle of state.vehicles) advance(world, vehicle, input.obstacles, state.vehicles);
  state.vehicles = state.vehicles.filter((vehicle) => {
    if (!vehicle.retiring || vehicle.distanceM < vehicle.stopAtDistanceM - 0.01 || vehicle.speed !== 0) return true;
    if (vehicle.kind === "van") vanRetirements.push({ vehicleId: vehicle.id, requestId: vehicle.requestId!, tick: input.tick });
    else busRetirements.push({ vehicleId: vehicle.id, routeId: previous.busRoute!.id, tick: input.tick });
    return false;
  });
  const observations: VehicleProgress[] = state.vehicles.filter((v) => v.spawned && !v.retiring).map((v) => ({ vehicleId: v.id, routeId: v.route.id, tick: input.tick, distanceM: v.distanceM, stopped: v.speed === 0 }));
  const routeMap = new Map<string, FleetRoute>();
  for (const vehicle of state.vehicles) routeMap.set(vehicle.route.id, vehicle.route);
  const candidates: VanRouteCandidate[] = [];
  for (const request of [...input.requests].sort((a, b) => a.id - b.id)) {
    if (previous.vans.receipts.some((r) => r.id === request.id) || request.id <= previous.vans.requestIdFloor) continue;
    const candidate = vanCandidate(world, getNetwork(), request, depots, input.obstacles);
    if (candidate !== null) { candidates.push(candidate.policy); routeMap.set(candidate.route.id, candidate.route); }
    else diagnostics.push(`van:${request.id}:no-road-route`);
  }
  if (state.busRoute === null && (previous.lastTick < 0 || input.tick % 60 === 0)) {
    const candidate = busCandidate(world, getNetwork(), input.ferry ?? { x: 0, z: 0 });
    if (candidate !== null) { state.busRoute = candidate.route; state.busPolicy = candidate.policy; }
    else diagnostics.push("bus:no-ferry-loop");
  }
  if (state.busRoute !== null) routeMap.set(state.busRoute.id, state.busRoute);
  const vans = stepVanServices({ ...previous.vans, nextVehicleId: state.nextActorId }, { tick: input.tick, requests: input.requests, routes: candidates, observations, retirements: vanRetirements });
  const buses = stepBusServices({ ...previous.buses, nextVehicleId: vans.state.nextVehicleId }, { tick: input.tick, gameMinute: input.gameMinute, routes: [], fallbackRoutes: state.busPolicy === null ? [] : [state.busPolicy], observations, retirements: busRetirements });
  state.vans = vans.state; state.buses = buses.state; state.nextActorId = buses.state.nextVehicleId;
  for (const intent of [...vans.intents, ...buses.intents]) {
    if (intent.kind === "spawn-van" || intent.kind === "spawn-bus") {
      const route = routeMap.get(intent.routeId)!;
      const pose = poseAt(route.path, 0);
      state.vehicles.push({ id: intent.vehicleId, kind: intent.kind === "spawn-van" ? "van" : "bus", requestId: intent.kind === "spawn-van" ? intent.requestId : null, depotId: intent.kind === "spawn-van" ? intent.depotId : null, route, distanceM: 0, stopAtDistanceM: route.path.len, ...pose, y: meshGroundHeight(world, pose.x, pose.z), speed: 0, spawned: false, retiring: false, retirementRequested: false, returnAttemptTick: -1, blocked: false, adWrapSlot: intent.kind === "spawn-bus" ? { ...intent.adWrapSlot } : null });
    } else {
      const vehicle = state.vehicles.find((v) => v.id === intent.vehicleId);
      if (vehicle === undefined) continue;
      if (intent.kind === "drive" && !vehicle.retiring) vehicle.stopAtDistanceM = intent.stopAtDistanceM;
      if (intent.kind === "disembark" && !state.pendingDeliveries.some((d) => d.requestId === intent.requestId)) state.pendingDeliveries.push({ requestId: intent.requestId, vehicleId: vehicle.id });
      if (intent.kind === "retire-van" || intent.kind === "retire-bus") vehicle.retirementRequested = true;
    }
  }
  state.pendingDeliveries = state.pendingDeliveries.filter((delivery) => {
    const vehicle = state.vehicles.find((v) => v.id === delivery.vehicleId);
    if (vehicle === undefined) return true;
    const positions = unloadPositions(world, vehicle, unloadingObstacles, state.vehicles);
    if (positions === null || state.nextActorId > Number.MAX_SAFE_INTEGER - 2) return true;
    disembarks.push({ ...delivery, units: positions.map((p) => ({ id: state.nextActorId++, ...p, y: meshGroundHeight(world, p.x, p.z), heading: vehicle.heading })) });
    for (const p of positions) unloadingObstacles.push({ id: `delivery:${delivery.requestId}:${p.x}:${p.z}`, ...p, radius: 0.4, person: true });
    return false;
  });
  for (const vehicle of state.vehicles) {
    if (vehicle.retirementRequested && !vehicle.retiring && !state.pendingDeliveries.some((d) => d.vehicleId === vehicle.id)) {
      if (!vehicle.spawned) { vehicle.retiring = true; vehicle.distanceM = vehicle.stopAtDistanceM; }
      else if ((vehicle.returnAttemptTick ?? -1) < 0 || input.tick - vehicle.returnAttemptTick >= 60) {
        vehicle.returnAttemptTick = input.tick;
        const target = vehicle.kind === "van" ? depots.find((d) => d.id === vehicle.depotId) : input.ferry ?? { x: 0, z: 0 };
        const sources = projections(getNetwork(), vehicle, 0.000001, 2);
        const targets = target === undefined ? [] : projections(getNetwork(), target, DEPOT_ROAD_ACCESS_M, 4);
        let returning: FleetRoute | null = null;
        for (const source of sources) for (const end of targets) {
          if (returning !== null) break;
          const parts = partsFor(getNetwork(), source, end, vehicle.kind === "van" ? VAN_SPEED : BUS_SPEED);
          if (parts !== null) returning = physicalRoute(world, `return:${vehicle.id}`, parts, vehicle.kind);
        }
        if (returning !== null) { vehicle.route = returning; vehicle.distanceM = 0; vehicle.stopAtDistanceM = returning.path.len; vehicle.retiring = true; }
        else { vehicle.blocked = true; diagnostics.push(`vehicle:${vehicle.id}:no-return-route`); }
      }
    }
    if (!vehicle.spawned && !vehicle.retiring && !boxBlocked(world, { x: vehicle.x, z: vehicle.z, heading: vehicle.heading, ...dimensions(vehicle.kind) }, vehicle.y, obstacleCircles(input.obstacles, state.vehicles, vehicle.id))) vehicle.spawned = true;
  }
  state.vehicles.sort((a, b) => a.id - b.id);
  const actors = state.vehicles.filter((v) => v.spawned).map(actor);
  const bodies = actors.map((a) => { const old = previous.vehicles.find((v) => v.id === a.id && v.spawned); return { ...a, previousX: old?.x ?? a.x, previousZ: old?.z ?? a.z, previousHeading: old?.heading ?? a.heading }; });
  return { state, nextActorId: state.nextActorId, actors, bodies, disembarks, diagnostics };
}
