// Physical recruit transport. Registration, restoration effects and hidden rider filtering
// remain with the owning runtime; acknowledgements here describe observed arrivals only.
import { DT, sortedIds } from "../contract.ts";
import type { PlayerState } from "../contract.ts";
import { CAR, carBox, makeCar } from "../car.ts";
import { boxBlocked, boxCrossedWall, circleInBoxes } from "../collide.ts";
import type { Box, Circle } from "../collide.ts";
import { datan2 } from "../dmath.ts";
import { exitSpot } from "../foot.ts";
import { connector, connectorPath, dirIndex, lanePath, makePath, pathPoint, projectOnPath, subPath } from "../roads.ts";
import type { Dir, Path, RoadEdgeInfo } from "../roads.ts";
import { circleBlocked, meshGroundHeight, segmentBlocked } from "../world.ts";
import type { World } from "../world.ts";
import type { RoutineRuntimeEffect } from "./routine-runtime.ts";
import type { RuntimePhysicalBody } from "./runtime-state.ts";

export const MAX_RECRUIT_TRANSPORT_JOBS = 72;
export const MAX_RECRUIT_TAXIS = 24;
export const RECRUIT_CAR_SEATS = 3;
const MAX_RECEIPTS = 144;
const MAX_ROUTE_M = 5000;
const TAXI_SPEED = 12;
const TAXI_ACCEL = 4;
const TAXI_BRAKE = 8;
const TAXI_CLEARANCE = 0.5;

export interface RecruitSafehouse { readonly id: string; readonly x: number; readonly z: number; readonly radiusM?: number }
export interface RecruitTaxiRoute { readonly path: Path; readonly laneKeys: readonly string[]; readonly speedLimit: number }
export interface RecruitTaxi {
  readonly id: number;
  readonly body: RuntimePhysicalBody;
  readonly route: RecruitTaxiRoute | null;
  readonly distanceM: number;
  readonly recruitId: string | null;
  readonly leg: "pickup" | "dropoff" | null;
}
export type RecruitTransportKind = "board" | "hail-taxi" | "restore-at-safehouse";
export interface RecruitRestorationArrival {
  readonly actorId: string;
  readonly effectId: string;
  readonly playerId: string;
  readonly sequence: number;
  readonly safehouseId: string;
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
}
export interface RecruitTransportJob {
  readonly recruitId: string;
  readonly ownerId: string;
  readonly sequence: number;
  readonly effectId: string;
  readonly kind: RecruitTransportKind;
  readonly phase: "pending" | "pickup" | "riding" | "exit" | "awaiting-restoration" | "complete";
  readonly body: RuntimePhysicalBody;
  /** Carried recruits have no independent collision body while this is non-null. */
  readonly parentVehicleId: string | null;
  readonly seat: number | null;
  readonly taxiId: number | null;
  readonly safehouseId: string | null;
  readonly restorationArrival: RecruitRestorationArrival | null;
  readonly blocked: string | null;
}
export interface RecruitTransportState {
  readonly version: 1;
  readonly lastTick: number;
  readonly jobs: readonly RecruitTransportJob[];
  readonly taxis: readonly RecruitTaxi[];
  readonly receipts: readonly { readonly id: string; readonly tick: number }[];
}
export interface RecruitTransportInput {
  readonly tick: number;
  readonly players: Readonly<Record<string, PlayerState>>;
  readonly bodies: readonly RuntimePhysicalBody[];
  readonly effects: readonly RoutineRuntimeEffect[];
  readonly nextActorId: number;
  readonly safehouses?: readonly RecruitSafehouse[];
  /** Only the effect dispatcher supplies these after resetting combat and firmware. */
  readonly restoredEffectIds?: readonly string[];
}
export interface RecruitTransportResult {
  readonly state: RecruitTransportState;
  readonly bodies: readonly RuntimePhysicalBody[];
  readonly nextActorId: number;
  readonly effectAcks: readonly string[];
  readonly observations: Readonly<Record<string, { boardedSequence?: number; restored?: boolean }>>;
  readonly restorationArrivals: readonly RecruitRestorationArrival[];
  readonly diagnostics: readonly string[];
}

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const distance = (a: { x: number; z: number }, b: { x: number; z: number }): number => {
  const x = a.x - b.x, z = a.z - b.z;
  return Math.sqrt(x * x + z * z);
};
const natural = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const finitePoint = (value: { x: number; z: number }): boolean =>
  Number.isFinite(value.x) && Number.isFinite(value.z) && Math.abs(value.x) <= 1e7 && Math.abs(value.z) <= 1e7;

export function createRecruitTransportState(): RecruitTransportState {
  return { version: 1, lastTick: -1, jobs: [], taxis: [], receipts: [] };
}

interface Lane { key: string; edge: RoadEdgeInfo; dir: Dir; path: Path; from: number; to: number }
interface Projection { lane: Lane; s: number; gap: number }
interface Network { lanes: Lane[]; outgoing: Map<number, Lane[]> }

export function isTransportRoad(edge: Pick<RoadEdgeInfo, "drivable" | "kind">): boolean {
  return edge.drivable && !["freeway", "ramp", "motorway", "motorway_link", "rail_only", "rail", "railway", "tram"].includes(edge.kind);
}

function roadNetwork(world: World): Network {
  const lanes: Lane[] = [], outgoing = new Map<number, Lane[]>();
  for (const edge of [...(world.roads?.edges ?? [])].sort((a, b) => compare(a.id, b.id))) {
    if (!isTransportRoad(edge)) continue;
    for (const dir of [1, -1] as const) {
      if (edge.laneCount[dirIndex(dir)] === 0 || !edge.laneSafe[dirIndex(dir)][0]) continue;
      const lane = { key: `${edge.id}:${dir}`, edge, dir, path: lanePath(edge, dir, 0), from: dir === 1 ? edge.a : edge.b, to: dir === 1 ? edge.b : edge.a };
      lanes.push(lane);
      const list = outgoing.get(lane.from) ?? [];
      list.push(lane); outgoing.set(lane.from, list);
    }
  }
  return { lanes, outgoing };
}

function projections(net: Network, point: { x: number; z: number }, maxGap: number): Projection[] {
  return net.lanes.map((lane) => { const p = projectOnPath(lane.path, point.x, point.z); return { lane, s: p.s, gap: p.dist }; })
    .filter((p) => p.gap <= maxGap).sort((a, b) => a.gap - b.gap || compare(a.lane.key, b.lane.key)).slice(0, 4);
}

function connection(a: Lane, b: Lane): Path {
  const p = pathPoint(a.path, a.path.len), q = pathPoint(b.path, 0);
  return connectorPath(connector(p.x, p.z, p.tx, p.tz, q.x, q.z, q.tx, q.tz));
}

function directedLanes(net: Network, start: Projection, target: Projection): Lane[] | null {
  if (start.lane.key === target.lane.key && target.s >= start.s) return [start.lane];
  const queue = [{ lane: start.lane, cost: 0, key: start.lane.key }];
  const best = new Map<string, number>([[start.lane.key, 0]]), previous = new Map<string, Lane>();
  const seen = new Set<string>();
  while (queue.length) {
    queue.sort((a, b) => b.cost - a.cost || compare(b.key, a.key));
    const current = queue.pop()!;
    if (seen.has(current.lane.key)) continue;
    seen.add(current.lane.key);
    if (current.cost > MAX_ROUTE_M) continue;
    if (current.lane.to === target.lane.from && current.lane.edge.id !== target.lane.edge.id) {
      const found = [current.lane];
      let lane = current.lane;
      while (lane.key !== start.lane.key) { lane = previous.get(lane.key)!; found.push(lane); }
      found.reverse(); found.push(target.lane); return found;
    }
    for (const next of net.outgoing.get(current.lane.to) ?? []) {
      if (seen.has(next.key) || next.edge.id === current.lane.edge.id) continue;
      const cost = current.cost + next.path.len + connection(current.lane, next).len;
      if (cost >= (best.get(next.key) ?? Infinity)) continue;
      best.set(next.key, cost); previous.set(next.key, current.lane);
      queue.push({ lane: next, cost, key: `${current.key}/${next.key}` });
    }
  }
  return null;
}

function makeRoute(world: World, net: Network, start: Projection, end: Projection): RecruitTaxiRoute | null {
  const lanes = directedLanes(net, start, end);
  if (!lanes) return null;
  const pieces: Path[] = [];
  for (let i = 0; i < lanes.length; i++) {
    const lane = lanes[i]!;
    const from = i === 0 ? start.s : 0, to = i === lanes.length - 1 ? end.s : lane.path.len;
    if (to > from + 1e-8) pieces.push(subPath(lane.path, from, to, 1e-8));
    if (i + 1 < lanes.length) pieces.push(connection(lane, lanes[i + 1]!));
  }
  const xs: number[] = [], zs: number[] = [];
  for (const piece of pieces) for (let i = 0; i < piece.xs.length; i++) {
    const x = piece.xs[i]!, z = piece.zs[i]!;
    if (xs.length && x === xs[xs.length - 1] && z === zs[zs.length - 1]) continue;
    xs.push(x); zs.push(z);
  }
  if (xs.length === 0) { const p = pathPoint(start.lane.path, start.s); xs.push(p.x); zs.push(p.z); }
  const path = makePath(xs, zs);
  if (path.len > MAX_ROUTE_M || xs.length > 4096) return null;
  let prior = pose(path, 0);
  for (let s = 0; s < path.len + 1; s += 1) {
    const p = pose(path, Math.min(path.len, s));
    if (boxBlocked(world, { ...p, hl: CAR.halfLength, hw: CAR.halfWidth }, meshGroundHeight(world, p.x, p.z)) ||
      boxCrossedWall(world, { ...p, hl: CAR.halfLength, hw: CAR.halfWidth }, prior)) return null;
    prior = p;
  }
  return { path, laneKeys: lanes.map((lane) => lane.key), speedLimit: Math.min(TAXI_SPEED, ...lanes.map((lane) => lane.edge.speedLimitMps)) };
}

function pose(path: Path, s: number): { x: number; z: number; heading: number } {
  const p = pathPoint(path, s);
  return { x: p.x, z: p.z, heading: datan2(p.tx, -p.tz) };
}

function planFrom(world: World, net: Network, from: { x: number; z: number }, target: { x: number; z: number }, maxTargetGap = 12): RecruitTaxiRoute | null {
  const choices: RecruitTaxiRoute[] = [];
  for (const start of projections(net, from, 0.05)) for (const end of projections(net, target, maxTargetGap)) {
    const route = makeRoute(world, net, start, end);
    if (route) choices.push(route);
  }
  choices.sort((a, b) => a.path.len - b.path.len || compare(a.laneKeys.join("/"), b.laneKeys.join("/")));
  return choices[0] ?? null;
}

/** Shared directed road geometry for physical ground-vehicle adapters. */
export function planTransportRoadRoute(world: World, from: { x: number; z: number }, target: { x: number; z: number }, maxTargetGap = 12): RecruitTaxiRoute | null {
  if (!finitePoint(from) || !finitePoint(target) || !Number.isFinite(maxTargetGap) || maxTargetGap < 0 || maxTargetGap > 100) {
    throw new RangeError("Invalid transport road request");
  }
  return planFrom(world, roadNetwork(world), from, target, maxTargetGap);
}

function circles(input: RecruitTransportInput, bodies: readonly RuntimePhysicalBody[], hidden: ReadonlySet<string>, except: ReadonlySet<string>): Circle[] {
  const result: Circle[] = [];
  for (const body of bodies) if (!hidden.has(body.id) && !except.has(body.id)) {
    result.push({ x: body.x, z: body.z, r: body.kind === "vehicle" ? Math.sqrt(body.halfLength * body.halfLength + body.halfWidth * body.halfWidth) : body.radius,
      person: body.kind !== "vehicle" });
  }
  for (const id of sortedIds(input.players)) {
    const player = input.players[id]!;
    if (!except.has(`player-car:${id}`)) result.push({ x: player.car.x, z: player.car.z, r: Math.sqrt(CAR.halfLength * CAR.halfLength + CAR.halfWidth * CAR.halfWidth), person: false });
    if (player.mode === "foot" && player.foot && !except.has(`player-foot:${id}`)) result.push({ x: player.foot.x, z: player.foot.z, r: 0.35, person: true });
  }
  return result;
}

function spawnTaxi(world: World, net: Network, target: RuntimePhysicalBody, id: number, obstacles: readonly Circle[]): RecruitTaxi | null {
  const sources: Projection[] = [];
  for (const lane of net.lanes) {
    const near = projectOnPath(lane.path, target.x, target.z).s;
    const samples = new Set([0, lane.path.len / 2, lane.path.len,
      Math.max(0, near - 60), Math.min(lane.path.len, near + 60)]);
    for (const s of samples) {
      const p = pathPoint(lane.path, s), gap = distance(p, target);
      if (gap >= 30 && gap <= 150) sources.push({ lane, s, gap });
    }
  }
  sources.sort((a, b) => Math.abs(a.gap - 60) - Math.abs(b.gap - 60) || compare(a.lane.key, b.lane.key) || a.s - b.s);
  const targets = projections(net, target, 12);
  for (const start of sources.slice(0, 16)) {
    const p = pose(start.lane.path, start.s);
    if (boxBlocked(world, { ...p, hl: CAR.halfLength, hw: CAR.halfWidth }, meshGroundHeight(world, p.x, p.z), obstacles)) continue;
    for (const end of targets) {
      const route = makeRoute(world, net, start, end);
      if (!route) continue;
      const body: RuntimePhysicalBody = { id: `recruit-taxi:${id}`, numericId: id, kind: "vehicle", model: "recruit-taxi", firmware: "good",
        x: p.x, y: meshGroundHeight(world, p.x, p.z), z: p.z, previousX: p.x, previousZ: p.z, heading: p.heading, previousHeading: p.heading,
        speed: 0, radius: CAR.halfWidth, halfLength: CAR.halfLength, halfWidth: CAR.halfWidth, height: 1.6, dodge: null };
      return { id, body, route, distanceM: 0, recruitId: target.id, leg: "pickup" };
    }
  }
  return null;
}

function advanceTaxi(world: World, taxi: RecruitTaxi, obstacles: readonly Circle[]): RecruitTaxi {
  if (!taxi.route || taxi.body.dodge) return taxi;
  const route = taxi.route, remaining = Math.max(0, route.path.len - taxi.distanceM);
  let desired = Math.min(route.speedLimit, Math.sqrt(2 * TAXI_BRAKE * remaining));
  const lookahead = Math.min(route.path.len, taxi.distanceM + taxi.body.speed * taxi.body.speed / (2 * TAXI_BRAKE) + 2);
  const padded = obstacles.map((circle) => ({ ...circle, r: circle.r + TAXI_CLEARANCE }));
  for (let s = taxi.distanceM; s <= lookahead + 0.5; s += 0.5) {
    const p = pose(route.path, Math.min(s, lookahead));
    if (boxBlocked(world, { ...p, hl: CAR.halfLength, hw: CAR.halfWidth }, taxi.body.y, padded)) { desired = 0; break; }
  }
  const speed = desired > taxi.body.speed ? Math.min(desired, taxi.body.speed + TAXI_ACCEL * DT) : Math.max(desired, taxi.body.speed - TAXI_BRAKE * DT);
  const distanceM = Math.min(route.path.len, taxi.distanceM + speed * DT), next = pose(route.path, distanceM);
  if (boxBlocked(world, { ...next, hl: CAR.halfLength, hw: CAR.halfWidth }, taxi.body.y, padded) ||
    boxCrossedWall(world, { ...next, hl: CAR.halfLength, hw: CAR.halfWidth }, taxi.body)) {
    return { ...taxi, body: { ...taxi.body, previousX: taxi.body.x, previousZ: taxi.body.z, previousHeading: taxi.body.heading, speed: 0 } };
  }
  return { ...taxi, distanceM, body: { ...taxi.body, ...next, y: meshGroundHeight(world, next.x, next.z),
    previousX: taxi.body.x, previousZ: taxi.body.z, previousHeading: taxi.body.heading, speed: distanceM >= route.path.len - 1e-6 ? 0 : speed } };
}

function carried(body: RuntimePhysicalBody, carrier: { x: number; y: number; z: number; heading: number; speed: number }): RuntimePhysicalBody {
  return { ...body, previousX: body.x, previousZ: body.z, previousHeading: body.heading,
    x: carrier.x, y: carrier.y + 0.3, z: carrier.z, heading: carrier.heading, speed: carrier.speed, dodge: null };
}

function safeExit(world: World, body: RuntimePhysicalBody, carrier: { x: number; y: number; z: number; heading: number; speed: number },
  input: RecruitTransportInput, bodies: readonly RuntimePhysicalBody[], hidden: ReadonlySet<string>, carrierId: string): RuntimePhysicalBody | null {
  if (Math.abs(carrier.speed) > 0.5) return null;
  const car = { ...makeCar(carrier.x, carrier.z, carrier.heading, carrier.y), speed: carrier.speed };
  const boxes: Box[] = [carBox(car)];
  for (const id of sortedIds(input.players)) if (`player-car:${id}` !== carrierId) boxes.push(carBox(input.players[id]!.car));
  for (const other of bodies) if (other.kind === "vehicle" && other.id !== carrierId) boxes.push({ x: other.x, z: other.z, heading: other.heading, hl: other.halfLength, hw: other.halfWidth });
  const obstacles = circles(input, bodies, hidden, new Set([body.id, carrierId]));
  const spot = exitSpot(world, car, boxes, obstacles, (x, z) => circleBlocked(world, x, z, body.radius) || circleInBoxes(x, z, body.radius, boxes) ||
    obstacles.some((obstacle) => distance({ x, z }, obstacle) < body.radius + obstacle.r));
  return spot ? { ...body, previousX: carrier.x, previousZ: carrier.z, previousHeading: carrier.heading,
    x: spot.x, y: spot.y, z: spot.z, heading: spot.heading, speed: 0, dodge: null } : null;
}

function approachPickup(world: World, body: RuntimePhysicalBody, taxi: RecruitTaxi, obstacles: readonly Circle[]): RuntimePhysicalBody {
  const gap = distance(body, taxi.body);
  if (body.dodge !== null || gap <= 3 || gap > 12 || taxi.body.speed !== 0) return body;
  const step = Math.min(1.4 * DT, gap - 2.9), x = body.x + (taxi.body.x - body.x) * step / gap, z = body.z + (taxi.body.z - body.z) * step / gap;
  if (circleBlocked(world, x, z, body.radius) || segmentBlocked(world, body.x, body.z, x, z) ||
    obstacles.some((obstacle) => distance({ x, z }, obstacle) < body.radius + obstacle.r) ||
    circleInBoxes(x, z, body.radius, [{ x: taxi.body.x, z: taxi.body.z, heading: taxi.body.heading, hl: CAR.halfLength, hw: CAR.halfWidth }])) return body;
  return { ...body, previousX: body.x, previousZ: body.z, previousHeading: body.heading, x, y: meshGroundHeight(world, x, z), z,
    heading: datan2(x - body.x, -(z - body.z)), speed: step / DT };
}

function result(state: RecruitTransportState, input: RecruitTransportInput, nextActorId: number, diagnostics: string[]): RecruitTransportResult {
  const bodies = new Map(input.bodies.map((body) => [body.id, body]));
  for (const job of state.jobs) if (job.blocked !== "missing-body" && (job.phase !== "complete" || bodies.has(job.recruitId))) bodies.set(job.recruitId, job.body);
  for (const taxi of state.taxis) bodies.set(taxi.body.id, taxi.body);
  const observations: Record<string, { boardedSequence?: number; restored?: boolean }> = Object.create(null) as Record<string, { boardedSequence?: number; restored?: boolean }>;
  for (const job of state.jobs) {
    if (job.parentVehicleId !== null && job.kind === "board") observations[job.recruitId] = { boardedSequence: job.sequence };
    if (job.kind === "restore-at-safehouse" && job.phase === "complete") observations[job.recruitId] = { restored: true };
  }
  const requested = new Set(input.effects.map((effect) => effect.id));
  return { state, bodies: [...bodies.keys()].sort(compare).map((id) => bodies.get(id)!), nextActorId,
    effectAcks: state.receipts.filter((receipt) => receipt.tick === input.tick || requested.has(receipt.id)).map((receipt) => receipt.id).sort(compare), observations,
    restorationArrivals: state.jobs.filter((job) => job.phase === "awaiting-restoration" && job.restorationArrival != null).map((job) => job.restorationArrival!), diagnostics };
}

function restorationArrival(job: RecruitTransportJob): RecruitRestorationArrival {
  return { actorId: job.recruitId, effectId: job.effectId, playerId: job.ownerId, sequence: job.sequence, safehouseId: job.safehouseId!,
    position: { x: job.body.x, y: job.body.y, z: job.body.z } };
}

/** No route, seat, pickup, safehouse or safe exit means a bounded pending job and no ack. */
export function stepRecruitTransport(world: World, previous: RecruitTransportState, input: RecruitTransportInput): RecruitTransportResult {
  if (!natural(input.tick) || !Number.isSafeInteger(previous.lastTick) || previous.lastTick < -1 ||
    input.tick < previous.lastTick || !natural(input.nextActorId) || previous.version !== 1 ||
    previous.jobs.length > MAX_RECRUIT_TRANSPORT_JOBS || previous.taxis.length > MAX_RECRUIT_TAXIS || previous.receipts.length > MAX_RECEIPTS) throw new RangeError("Invalid recruit transport state or tick");
  const inputBodies = new Map<string, RuntimePhysicalBody>();
  const finiteBody = (body: RuntimePhysicalBody): boolean => finitePoint(body) && natural(body.numericId) &&
    [body.y, body.heading, body.speed, body.previousX, body.previousZ, body.previousHeading, body.radius, body.halfLength, body.halfWidth, body.height].every(Number.isFinite) &&
    body.numericId < Number.MAX_SAFE_INTEGER && body.radius > 0 && body.radius <= 20 && body.halfLength >= 0 && body.halfWidth >= 0 && body.height >= 0;
  const numericIds = new Set<number>();
  for (const body of input.bodies) {
    if (inputBodies.has(body.id) || numericIds.has(body.numericId) || !finiteBody(body)) throw new RangeError("Invalid recruit body");
    inputBodies.set(body.id, body);
    numericIds.add(body.numericId);
  }
  for (const id of sortedIds(input.players)) {
    const player = input.players[id]!;
    if (!finitePoint(player.car) || ![player.car.y, player.car.heading, player.car.speed].every(Number.isFinite) ||
      (player.mode === "foot" && (!player.foot || !finitePoint(player.foot)))) throw new RangeError("Invalid recruit owner");
  }
  if (new Set(previous.jobs.map((job) => job.recruitId)).size !== previous.jobs.length ||
    new Set(previous.taxis.map((taxi) => taxi.id)).size !== previous.taxis.length) throw new RangeError("Duplicate recruit transport state");
  for (const job of previous.jobs) if (!natural(job.sequence) || !finiteBody(job.body) ||
    (job.restorationArrival != null && (!finitePoint(job.restorationArrival.position) || !Number.isFinite(job.restorationArrival.position.y))) ||
    (job.seat !== null && (!natural(job.seat) || job.seat >= RECRUIT_CAR_SEATS))) throw new RangeError("Invalid recruit job state");
  for (const taxi of previous.taxis) {
    if (!natural(taxi.id) || !finiteBody(taxi.body) || !Number.isFinite(taxi.distanceM) || taxi.distanceM < 0 ||
      (taxi.route && (!Number.isFinite(taxi.route.path.len) || taxi.route.path.len < 0 || taxi.route.path.len > MAX_ROUTE_M ||
        taxi.distanceM > taxi.route.path.len || taxi.route.path.xs.length === 0 || taxi.route.path.xs.length > 4096 ||
        taxi.route.path.xs.length !== taxi.route.path.zs.length || taxi.route.path.cum.length !== taxi.route.path.xs.length ||
        !taxi.route.path.xs.every(Number.isFinite) || !taxi.route.path.zs.every(Number.isFinite) || !taxi.route.path.cum.every(Number.isFinite) ||
        taxi.route.path.cum[0] !== 0 || taxi.route.path.cum[taxi.route.path.cum.length - 1] !== taxi.route.path.len ||
        taxi.route.path.cum.some((value, i) => i > 0 && value < taxi.route!.path.cum[i - 1]!) ||
        !Number.isFinite(taxi.route.speedLimit) || taxi.route.speedLimit <= 0 || taxi.route.speedLimit > TAXI_SPEED))) {
      throw new RangeError("Invalid recruit taxi state");
    }
  }
  const safehouses = [...(input.safehouses ?? [])].sort((a, b) => compare(a.id, b.id));
  if (new Set(safehouses.map((house) => house.id)).size !== safehouses.length) throw new RangeError("Duplicate recruit safehouse");
  for (const house of safehouses) if (!finitePoint(house) || !house.id || (house.radiusM !== undefined && (!Number.isFinite(house.radiusM) || house.radiusM < 1 || house.radiusM > 30))) throw new RangeError("Invalid recruit safehouse");
  let nextActorId = Math.max(input.nextActorId, ...previous.taxis.map((taxi) => taxi.id + 1), ...input.bodies.map((body) => body.numericId + 1));
  if (input.tick === previous.lastTick) return result(previous, input, nextActorId, []);
  const jobs = new Map(previous.jobs.map((job) => [job.recruitId, { ...job, restorationArrival: job.restorationArrival ?? null, body: inputBodies.get(job.recruitId) ?? job.body }]));
  const taxis = previous.taxis.map((taxi) => {
    const body = inputBodies.get(taxi.body.id) ?? taxi.body;
    const displaced = taxi.route !== null && distance(body, pose(taxi.route.path, taxi.distanceM)) > 0.05;
    return { ...taxi, body: displaced && !body.dodge ? { ...body, speed: 0 } : body, route: displaced ? null : taxi.route };
  });
  const receipts = [...previous.receipts];
  const diagnostics: string[] = [];
  const restoredEffectIds = new Set(input.restoredEffectIds ?? []);
  const acknowledge = (job: RecruitTransportJob): void => {
    if (!receipts.some((receipt) => receipt.id === job.effectId)) receipts.push({ id: job.effectId, tick: input.tick });
  };
  const incoming = [...input.effects].filter((effect) => ["recruit.board", "recruit.hail-taxi", "recruit.restore-at-safehouse"].includes(effect.kind))
    .sort((a, b) => compare(a.actorId, b.actorId) || a.amount - b.amount || compare(a.id, b.id));
  for (const effect of incoming) {
    if (!effect.id || !effect.actorId || !effect.playerId || !natural(effect.amount)) throw new RangeError("Invalid recruit transport effect");
    if (receipts.some((receipt) => receipt.id === effect.id)) continue;
    const old = jobs.get(effect.actorId), body = inputBodies.get(effect.actorId);
    if (old && effect.amount <= old.sequence) {
      if (effect.amount === old.sequence && effect.id !== old.effectId) diagnostics.push(`${effect.actorId}:conflicting-sequence`);
      continue;
    }
    if (old && old.parentVehicleId !== null) { diagnostics.push(`${effect.actorId}:already-carried`); continue; }
    if (!body || body.kind !== "robot" || !input.players[effect.playerId]) { diagnostics.push(`${effect.actorId}:missing-body-or-owner`); continue; }
    if (!old && jobs.size === MAX_RECRUIT_TRANSPORT_JOBS) { diagnostics.push(`${effect.actorId}:transport-capacity`); continue; }
    if (old?.taxiId !== null && old?.taxiId !== undefined) {
      const index = taxis.findIndex((taxi) => taxi.id === old.taxiId);
      if (index >= 0 && taxis[index]!.recruitId === old.recruitId) taxis[index] = { ...taxis[index]!, recruitId: null, leg: null, route: null, body: { ...taxis[index]!.body, speed: 0 } };
    }
    jobs.set(effect.actorId, { recruitId: effect.actorId, ownerId: effect.playerId, sequence: effect.amount, effectId: effect.id,
      kind: effect.kind.slice(8) as RecruitTransportKind, phase: "pending", body, parentVehicleId: null, seat: null, taxiId: null, safehouseId: null,
      restorationArrival: null, blocked: null });
  }
  let net: Network | null = null;
  const network = (): Network => net ?? (net = roadNetwork(world));
  const hidden = new Set([...jobs.values()].filter((job) => job.parentVehicleId !== null).map((job) => job.recruitId));
  for (let index = 0; index < taxis.length; index++) {
    const taxi = taxis[index]!;
    const allBodies = [...input.bodies, ...taxis.filter((other) => other.id !== taxi.id).map((other) => other.body)];
    taxis[index] = advanceTaxi(world, taxi, circles(input, allBodies, hidden, new Set([taxi.body.id])));
  }
  for (const id of [...jobs.keys()].sort(compare)) {
    let job = jobs.get(id)!;
    const player = input.players[job.ownerId];
    const liveBodies = new Map(input.bodies.map((body) => [body.id, body]));
    for (const current of jobs.values()) liveBodies.set(current.recruitId, current.body);
    for (const current of taxis) liveBodies.set(current.body.id, current.body);
    const allBodies = [...liveBodies.keys()].sort(compare).map((key) => liveBodies.get(key)!);
    if (!inputBodies.has(id) && job.parentVehicleId === null) {
      jobs.set(id, { ...job, blocked: "missing-body" }); diagnostics.push(`${id}:missing-body`); continue;
    }
    if (!player) { jobs.set(id, { ...job, blocked: "owner-left" }); diagnostics.push(`${id}:owner-left`); continue; }
    const playerCarrier = `player-car:${job.ownerId}`;
    if (job.parentVehicleId === playerCarrier) {
      if (player.mode === "vehicle") job = { ...job, body: carried(job.body, player.car), phase: "riding", blocked: null };
      else {
        const exited = safeExit(world, job.body, player.car, input, allBodies, hidden, playerCarrier);
        job = exited ? { ...job, body: exited, parentVehicleId: null, seat: null, phase: "complete", blocked: null } : { ...job, body: carried(job.body, player.car), phase: "exit", blocked: "no-safe-exit" };
        if (exited) hidden.delete(id);
      }
      jobs.set(id, job); continue;
    }
    if (job.phase === "complete") { jobs.set(id, { ...job, body: inputBodies.get(id) ?? job.body }); continue; }
    if (job.kind === "board") {
      const occupied = [...jobs.values()].filter((other) => other.parentVehicleId === playerCarrier).map((other) => other.seat);
      const seat = [0, 1, 2].find((index) => !occupied.includes(index));
      if (job.body.dodge !== null || player.mode !== "vehicle" || Math.abs(player.car.speed) > 0.5 || distance(job.body, player.car) > 3 ||
        segmentBlocked(world, job.body.x, job.body.z, player.car.x, player.car.z) || seat === undefined) {
        job = { ...job, blocked: seat === undefined ? "no-seat" : "not-at-owner-car" };
      } else {
        job = { ...job, phase: "riding", parentVehicleId: playerCarrier, seat, body: carried(job.body, player.car), blocked: null };
        hidden.add(id); acknowledge(job);
      }
      jobs.set(id, job); if (job.blocked) diagnostics.push(`${id}:${job.blocked}`); continue;
    }
    let target: { x: number; z: number }, radius = 12;
    if (job.kind === "restore-at-safehouse") {
      const available = safehouses.filter((house) => !circleBlocked(world, house.x, house.z, job.body.radius));
      const house = job.safehouseId === null ? available
        .sort((a, b) => distance(a, job.body) - distance(b, job.body) || compare(a.id, b.id))[0]
        : available.find((house) => house.id === job.safehouseId);
      if (!house) { jobs.set(id, { ...job, blocked: "no-safehouse" }); diagnostics.push(`${id}:no-safehouse`); continue; }
      target = house; radius = house.radiusM ?? 3; job = { ...job, safehouseId: house.id };
      if (job.phase === "awaiting-restoration") {
        if (distance(job.body, house) <= radius && !circleBlocked(world, job.body.x, job.body.z, job.body.radius)) {
          job = { ...job, restorationArrival: restorationArrival(job), blocked: "awaiting-restoration" };
          if (restoredEffectIds.has(job.effectId) && job.body.firmware === "good") {
            job = { ...job, phase: "complete", blocked: null };
            acknowledge(job);
          }
          jobs.set(id, job); continue;
        }
        job = { ...job, phase: "pending", restorationArrival: null, blocked: null };
      }
      if (job.parentVehicleId === null && distance(job.body, house) <= radius && !circleBlocked(world, job.body.x, job.body.z, job.body.radius)) {
        job = { ...job, phase: "awaiting-restoration", restorationArrival: restorationArrival(job), blocked: "awaiting-restoration" };
        jobs.set(id, job); continue;
      }
    } else target = player.mode === "foot" && player.foot ? player.foot : player.car;
    let taxiIndex = taxis.findIndex((taxi) => taxi.id === job.taxiId);
    if (taxiIndex < 0) {
      // A blocked request stays live, but expensive world routing is retried on a
      // deterministic per-recruit phase rather than once for every rendered tick.
      if (job.blocked !== null && (input.tick + job.body.numericId) % 60 !== 0) {
        jobs.set(id, job); diagnostics.push(`${id}:${job.blocked}`); continue;
      }
      const idleIndex = taxis.findIndex((taxi) => taxi.recruitId === null && planFrom(world, network(), taxi.body, job.body) !== null);
      if (idleIndex >= 0) {
        taxiIndex = idleIndex;
        taxis[taxiIndex] = { ...taxis[taxiIndex]!, recruitId: id, leg: "pickup", distanceM: 0, route: planFrom(world, network(), taxis[taxiIndex]!.body, job.body) };
      } else if (taxis.length < MAX_RECRUIT_TAXIS && nextActorId < Number.MAX_SAFE_INTEGER) {
        const spawned = spawnTaxi(world, network(), job.body, nextActorId, circles(input, allBodies, hidden, new Set()));
        if (spawned) { nextActorId++; taxiIndex = taxis.length; taxis.push(spawned); }
      }
      if (taxiIndex < 0) {
        const blocked = network().lanes.length === 0 ? "no-road-route" : nextActorId >= Number.MAX_SAFE_INTEGER ? "actor-id-capacity" :
          taxis.length >= MAX_RECRUIT_TAXIS && taxis.every((taxi) => taxi.recruitId !== null) ? "taxi-capacity" : "no-safe-road-route";
        jobs.set(id, { ...job, blocked }); diagnostics.push(`${id}:${blocked}`); continue;
      }
      job = { ...job, taxiId: taxis[taxiIndex]!.id, phase: "pickup", blocked: null };
    }
    let taxi = taxis[taxiIndex]!;
    if (job.parentVehicleId === null) {
      if (!taxi.route && input.tick % 60 === taxi.id % 60) taxi = { ...taxi, route: planFrom(world, network(), taxi.body, job.body), distanceM: 0 };
      const walked = approachPickup(world, job.body, taxi, circles(input, allBodies, hidden, new Set([job.recruitId, taxi.body.id])));
      job = { ...job, body: walked };
      if (job.body.dodge !== null || taxi.body.dodge !== null || taxi.body.speed !== 0 || distance(job.body, taxi.body) > 3 || segmentBlocked(world, job.body.x, job.body.z, taxi.body.x, taxi.body.z)) {
        if (taxi.route && taxi.distanceM >= taxi.route.path.len - 1e-6 && distance(job.body, taxi.body) > 12) {
          taxi = { ...taxi, route: planFrom(world, network(), taxi.body, job.body), distanceM: 0 };
        }
        job = { ...job, phase: "pickup", blocked: "awaiting-pickup" };
        taxis[taxiIndex] = taxi; jobs.set(id, job); continue;
      }
      job = { ...job, parentVehicleId: taxi.body.id, seat: 0, phase: "riding", body: carried(job.body, taxi.body), blocked: null };
      hidden.add(id);
      taxi = { ...taxi, route: planFrom(world, network(), taxi.body, target, radius), distanceM: 0, leg: "dropoff" };
    } else job = { ...job, body: carried(job.body, taxi.body) };
    if (!taxi.route && input.tick % 60 === taxi.id % 60) taxi = { ...taxi, route: planFrom(world, network(), taxi.body, target, radius), distanceM: 0 };
    if (!taxi.route) job = { ...job, blocked: "no-dropoff-route" };
    if (taxi.body.speed === 0 && distance(taxi.body, target) <= radius) {
      const exited = safeExit(world, job.body, taxi.body, input, allBodies, hidden, taxi.body.id);
      if (exited && distance(exited, target) <= radius) {
        job = { ...job, body: exited, parentVehicleId: null, seat: null,
          phase: job.kind === "restore-at-safehouse" ? "awaiting-restoration" : "complete", blocked: null };
        if (job.kind === "restore-at-safehouse") job = { ...job, restorationArrival: restorationArrival(job), blocked: "awaiting-restoration" };
        taxi = { ...taxi, recruitId: null, route: null, leg: null, body: { ...taxi.body, speed: 0 } };
        hidden.delete(id);
        if (job.kind !== "restore-at-safehouse") acknowledge(job);
      } else job = { ...job, phase: "exit", blocked: "no-safe-exit" };
    } else if (taxi.route && taxi.body.speed === 0 && taxi.distanceM >= taxi.route.path.len - 1e-6) {
      taxi = { ...taxi, route: planFrom(world, network(), taxi.body, target, radius), distanceM: 0 };
    }
    taxis[taxiIndex] = taxi; jobs.set(id, job);
    if (job.blocked) diagnostics.push(`${id}:${job.blocked}`);
  }
  receipts.sort((a, b) => b.tick - a.tick || compare(a.id, b.id));
  const state: RecruitTransportState = { version: 1, lastTick: input.tick, jobs: [...jobs.values()].sort((a, b) => compare(a.recruitId, b.recruitId)),
    taxis: taxis.sort((a, b) => a.id - b.id), receipts: receipts.slice(0, MAX_RECEIPTS) };
  return result(state, input, nextActorId, diagnostics);
}
