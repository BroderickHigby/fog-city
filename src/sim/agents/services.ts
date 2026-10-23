import { TICK_HZ } from "../contract.ts";

export const VAN_RESPONSE_TICKS = 20 * TICK_HZ;
export const VAN_ENTRY_DISTANCE_M = 120;
export const VAN_ENTRY_TOLERANCE_M = 20;
export const SERVICE_REQUEST_RETENTION_TICKS = 120 * TICK_HZ;
export const MAX_SERVICE_REQUESTS = 128;
export const MAX_VAN_JOBS = 32;
export const MAX_ACTIVE_VANS = 16;
export const MAX_ACTIVE_BUSES = 16;
export const MAX_BUS_CATCHUP_DEPARTURES = 4;
export const MAX_SERVICE_SPEED_MPS = 16;
const DAY_MINUTES = 1440;
const STOP_TOLERANCE_M = 0.5;

export interface ServicePoint { x: number; z: number; nodeId: number }

/** Directed road data must come from the road graph, including any turn restrictions.
 * This policy validates continuity and speed bounds; the adapter validates geometry,
 * vehicle clearance and junction permissions with the actual graph/follower.
 */
export interface ServiceRoadLeg {
  edgeId: number;
  fromNode: number;
  toNode: number;
  direction: 1 | -1;
  oneWay: boolean;
  drivable: boolean;
  lengthM: number;
  speedLimitMps: number;
}

export interface ServiceRoadRoute {
  legs: readonly ServiceRoadLeg[];
  cruiseSpeedMps: number;
  /** Follower estimate including acceleration, turns and expected junction waits. */
  expectedTravelTicks: number;
}

export interface VehicleProgress {
  vehicleId: number;
  routeId: string;
  tick: number;
  /** Measured cumulative progress on this route, never a planner estimate. */
  distanceM: number;
  stopped: boolean;
}

/** An external acknowledgement after the van has returned along valid roads and
 * left physical service. Issuing a retirement intent alone does not free capacity.
 */
export interface VanRetirement {
  vehicleId: number;
  requestId: number;
  tick: number;
}

export interface BusRetirement {
  vehicleId: number;
  routeId: string;
  tick: number;
}

export type ServiceIntent =
  | { kind: "spawn-van"; vehicleId: number; requestId: number; depotId: string; origin: ServicePoint; routeId: string; unitCount: 2 }
  | { kind: "spawn-bus"; vehicleId: number; routeId: string; origin: ServicePoint; scheduledGameMinute: number; adWrapSlot: AdWrapSlot }
  | { kind: "drive"; vehicleId: number; routeId: string; route: ServiceRoadRoute; stopAtDistanceM: number; clearance: "person-override" }
  | { kind: "disembark"; vehicleId: number; requestId: number; unitCount: 2; placement: "validated-sidewalk" }
  | { kind: "retire-van"; vehicleId: number; requestId: number; destinationDepotId: string; clearance: "person-override" }
  | { kind: "bus-stop"; vehicleId: number; routeId: string; stopId: string; dwellUntilTick: number }
  | { kind: "retire-bus"; vehicleId: number; routeId: string; clearance: "person-override" };

/** Lane 5 must allocate globally increasing IDs. IDs and requestTick are immutable
 * across replays; this is a local policy API, not a shared SimEvent contract.
 */
export interface ThreatVanRequest {
  id: number;
  requestTick: number;
  playerId: string;
  player: { x: number; z: number };
  threat: 2;
  unitCount: 2;
}

export interface VanRouteCandidate extends ServiceRoadRoute {
  id: string;
  requestId: number;
  depotId: string;
  depotKind: "hq" | "depot";
  origin: ServicePoint;
  target: ServicePoint;
  /** Node at which the routed van enters the encounter, about 120 m away. */
  entry: ServicePoint;
  entryAfterLeg: number;
}

export type VanBlockReason = "no-route" | "invalid-route" | "deadline-infeasible" | "capacity" | "deadline-missed" | "vehicle-ids-exhausted";
export interface VanJob {
  requestId: number;
  requestTick: number;
  deadlineTick: number;
  status: "driving" | "delivered" | "blocked";
  blockedReason: VanBlockReason | null;
  vehicleId: number | null;
  route: VanRouteCandidate | null;
  dispatchedTick: number;
  observedTick: number;
  observedDistanceM: number;
  arrivalTick: number | null;
  onTime: boolean | null;
  retirementRequestedTick: number | null;
  retiredTick: number | null;
}

export interface VanServiceState {
  lastTick: number;
  nextVehicleId: number;
  /** Any ID at/below this floor is rejected even after its receipt is pruned. */
  requestIdFloor: number;
  requestTickFloor: number;
  receipts: { id: number; requestTick: number }[];
  jobs: VanJob[];
}

export interface RequestRejection {
  requestId: number;
  reason: "invalid-request" | "conflicting-request" | "duplicate" | "too-old" | "future-request";
}

/** The caller reserves numeric vehicle IDs across all vehicle-producing policies. */
export function createVanServiceState(firstVehicleId: number): VanServiceState {
  requireId(firstVehicleId);
  return { lastTick: -1, nextVehicleId: firstVehicleId, requestIdFloor: -1, requestTickFloor: 0, receipts: [], jobs: [] };
}

function requireId(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Expected a nonnegative safe integer");
}

function validPoint(p: ServicePoint): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.z) && Number.isSafeInteger(p.nodeId) && p.nodeId >= 0;
}

function routeFacts(route: ServiceRoadRoute): { lengthM: number; minimumTicks: number } | null {
  if (route.legs.length === 0 || !Number.isFinite(route.cruiseSpeedMps) || route.cruiseSpeedMps <= 0 || route.cruiseSpeedMps > MAX_SERVICE_SPEED_MPS) return null;
  let lengthM = 0;
  let seconds = 0;
  let previousNode: number | null = null;
  for (const leg of route.legs) {
    if (!Number.isSafeInteger(leg.edgeId) || leg.edgeId < 0 || !Number.isSafeInteger(leg.fromNode) || leg.fromNode < 0 || !Number.isSafeInteger(leg.toNode) || leg.toNode < 0 || !leg.drivable || (leg.direction !== 1 && leg.direction !== -1) || (leg.oneWay && leg.direction === -1) || !Number.isFinite(leg.lengthM) || leg.lengthM <= 0 || !Number.isFinite(leg.speedLimitMps) || leg.speedLimitMps <= 0 || (previousNode !== null && previousNode !== leg.fromNode)) return null;
    const speed = Math.min(route.cruiseSpeedMps, leg.speedLimitMps);
    lengthM += leg.lengthM;
    seconds += leg.lengthM / speed;
    previousNode = leg.toNode;
  }
  const minimumTicks = Math.ceil(seconds * TICK_HZ);
  if (!Number.isFinite(lengthM) || !Number.isSafeInteger(route.expectedTravelTicks) || route.expectedTravelTicks < minimumTicks) return null;
  return { lengthM, minimumTicks };
}

function minimumProgressTicks(route: ServiceRoadRoute, fromM: number, toM: number): number {
  let legStartM = 0;
  let seconds = 0;
  for (const leg of route.legs) {
    const legEndM = legStartM + leg.lengthM;
    const distanceM = Math.max(0, Math.min(toM, legEndM) - Math.max(fromM, legStartM));
    seconds += distanceM / Math.min(route.cruiseSpeedMps, leg.speedLimitMps);
    legStartM = legEndM;
  }
  return Math.ceil(seconds * TICK_HZ - 0.000000001);
}

function copyRoute<T extends ServiceRoadRoute>(route: T): T {
  return { ...route, legs: route.legs.map((leg) => ({ ...leg })) };
}

function copyVanRoute(route: VanRouteCandidate): VanRouteCandidate {
  return { ...copyRoute(route), origin: { ...route.origin }, entry: { ...route.entry }, target: { ...route.target } };
}

function drive(vehicleId: number, routeId: string, route: ServiceRoadRoute, stopAtDistanceM: number): ServiceIntent {
  return { kind: "drive", vehicleId, routeId, route: copyRoute(route), stopAtDistanceM, clearance: "person-override" };
}

/** Conflicting same-tick observations are ignored rather than resolved by input order. */
function observe(observations: readonly VehicleProgress[], vehicleId: number, routeId: string, fromTick: number, fromDistanceM: number, now: number, route: ServiceRoadRoute): VehicleProgress | null {
  const facts = routeFacts(route);
  if (facts === null) return null;
  const candidates = observations.filter((p) => p.vehicleId === vehicleId && p.routeId === routeId && Number.isSafeInteger(p.tick) && p.tick > fromTick && p.tick <= now && Number.isFinite(p.distanceM) && p.distanceM >= fromDistanceM && p.distanceM <= facts.lengthM && minimumProgressTicks(route, fromDistanceM, p.distanceM) <= p.tick - fromTick);
  candidates.sort((a, b) => b.tick - a.tick || a.distanceM - b.distanceM || Number(a.stopped) - Number(b.stopped));
  const latest = candidates[0];
  if (latest === undefined) return null;
  if (candidates.some((p) => p.tick === latest.tick && (p.distanceM !== latest.distanceM || p.stopped !== latest.stopped))) return null;
  return latest;
}

function vanRouteValid(route: VanRouteCandidate, request: ThreatVanRequest): boolean {
  const facts = routeFacts(route);
  if (facts === null || !route.id || !route.depotId || (route.depotKind !== "hq" && route.depotKind !== "depot") || !validPoint(route.origin) || !validPoint(route.target) || !validPoint(route.entry) || !Number.isInteger(route.entryAfterLeg) || route.entryAfterLeg < 0 || route.entryAfterLeg >= route.legs.length) return false;
  const first = route.legs[0]!;
  const last = route.legs[route.legs.length - 1]!;
  const entryNode = route.entryAfterLeg === 0 ? first.fromNode : route.legs[route.entryAfterLeg - 1]!.toNode;
  const dx = route.entry.x - request.player.x;
  const dz = route.entry.z - request.player.z;
  const distanceSquared = dx * dx + dz * dz;
  const targetDx = route.target.x - request.player.x;
  const targetDz = route.target.z - request.player.z;
  const beforeEntryM = route.legs.slice(0, route.entryAfterLeg).reduce((sum, leg) => sum + leg.lengthM, 0);
  const afterEntryM = facts.lengthM - beforeEntryM;
  const originDx = route.origin.x - route.entry.x;
  const originDz = route.origin.z - route.entry.z;
  const entryDx = route.entry.x - route.target.x;
  const entryDz = route.entry.z - route.target.z;
  return first.fromNode === route.origin.nodeId && last.toNode === route.target.nodeId && entryNode === route.entry.nodeId && distanceSquared >= 100 * 100 && distanceSquared <= 140 * 140 && targetDx * targetDx + targetDz * targetDz <= 12 * 12 && originDx * originDx + originDz * originDz <= beforeEntryM * beforeEntryM && entryDx * entryDx + entryDz * entryDz <= afterEntryM * afterEntryM;
}

function sameRequest(a: ThreatVanRequest, b: ThreatVanRequest): boolean {
  return a.id === b.id && a.requestTick === b.requestTick && a.playerId === b.playerId && a.player.x === b.player.x && a.player.z === b.player.z && a.threat === b.threat && a.unitCount === b.unitCount;
}

function validRequest(request: ThreatVanRequest): boolean {
  return Number.isSafeInteger(request.id) && request.id >= 0 && Number.isSafeInteger(request.requestTick) && request.requestTick >= 0 && request.playerId.length > 0 && Number.isFinite(request.player.x) && Number.isFinite(request.player.z) && request.threat === 2 && request.unitCount === 2;
}

function retireVan(job: VanJob, tick: number): ServiceIntent {
  if (job.retirementRequestedTick === null) job.retirementRequestedTick = tick;
  return { kind: "retire-van", vehicleId: job.vehicleId!, requestId: job.requestId, destinationDepotId: job.route!.depotId, clearance: "person-override" };
}

export function stepVanServices(previous: Readonly<VanServiceState>, input: {
  tick: number;
  requests: readonly ThreatVanRequest[];
  routes: readonly VanRouteCandidate[];
  observations: readonly VehicleProgress[];
  retirements?: readonly VanRetirement[];
}): { state: VanServiceState; intents: ServiceIntent[]; rejected: RequestRejection[] } {
  requireId(input.tick);
  if (input.tick <= previous.lastTick) return { state: previous as VanServiceState, intents: [], rejected: [] };
  const state: VanServiceState = { ...previous, lastTick: input.tick, requestTickFloor: Math.max(previous.requestTickFloor, input.tick - SERVICE_REQUEST_RETENTION_TICKS), receipts: previous.receipts.map((r) => ({ ...r })), jobs: previous.jobs.map((job) => ({ ...job, route: job.route === null ? null : copyVanRoute(job.route) })) };
  const intents: ServiceIntent[] = [];
  const rejected: RequestRejection[] = [];
  for (const receipt of state.receipts) if (receipt.requestTick < state.requestTickFloor) state.requestIdFloor = Math.max(state.requestIdFloor, receipt.id);
  state.receipts = state.receipts.filter((r) => r.id > state.requestIdFloor && r.requestTick >= state.requestTickFloor);
  for (const job of state.jobs) {
    if (job.route === null || job.vehicleId === null || job.retiredTick !== null) continue;
    if (job.retirementRequestedTick !== null) {
      const retirements = (input.retirements ?? []).filter((r) => r.vehicleId === job.vehicleId && r.requestId === job.requestId && Number.isSafeInteger(r.tick) && r.tick >= job.retirementRequestedTick! && r.tick <= input.tick).sort((a, b) => a.tick - b.tick);
      if (retirements[0] !== undefined) { job.retiredTick = retirements[0].tick; continue; }
    }
    if (job.status === "delivered") { intents.push(retireVan(job, input.tick)); continue; }
    const progress = observe(input.observations, job.vehicleId, job.route.id, job.observedTick, job.observedDistanceM, input.tick, job.route);
    if (progress !== null) {
      job.observedTick = progress.tick;
      job.observedDistanceM = progress.distanceM;
      const facts = routeFacts(job.route)!;
      if (progress.stopped && progress.distanceM >= facts.lengthM - STOP_TOLERANCE_M) {
        job.status = "delivered";
        job.arrivalTick = progress.tick;
        job.onTime = progress.tick <= job.deadlineTick;
        job.blockedReason = job.onTime ? null : "deadline-missed";
        intents.push({ kind: "disembark", vehicleId: job.vehicleId, requestId: job.requestId, unitCount: 2, placement: "validated-sidewalk" });
        intents.push(retireVan(job, input.tick));
        continue;
      }
    }
    if (input.tick >= job.deadlineTick) {
      job.status = "blocked";
      job.blockedReason = "deadline-missed";
      intents.push(retireVan(job, input.tick));
      continue;
    }
    intents.push(drive(job.vehicleId, job.route.id, job.route, routeFacts(job.route)!.lengthM));
  }
  const requests = [...input.requests].sort((a, b) => a.id - b.id || a.requestTick - b.requestTick || compareText(a.playerId, b.playerId) || a.player.x - b.player.x || a.player.z - b.player.z);
  for (let i = 0; i < requests.length; i++) {
    const request = requests[i]!;
    const group: ThreatVanRequest[] = [request];
    while (requests[i + 1]?.id === request.id) group.push(requests[++i]!);
    let reason: RequestRejection["reason"] | null = null;
    if (group.some((r) => !validRequest(r))) reason = "invalid-request";
    else if (request.id <= state.requestIdFloor || request.requestTick < state.requestTickFloor) reason = "too-old";
    else if (state.receipts.some((r) => r.id === request.id)) reason = "duplicate";
    else if (request.requestTick > input.tick) reason = "future-request";
    else if (group.some((r) => !sameRequest(request, r))) reason = "conflicting-request";
    if (reason !== null) {
      rejected.push({ requestId: Number.isSafeInteger(request.id) ? request.id : -1, reason });
      if (reason === "conflicting-request") state.receipts.push({ id: request.id, requestTick: group.reduce((oldest, r) => Math.min(oldest, r.requestTick), request.requestTick) });
      continue;
    }
    state.receipts.push({ id: request.id, requestTick: request.requestTick });
    const matching = input.routes.filter((r) => r.requestId === request.id);
    // IDs identify immutable routes; conflicting candidates are unusable.
    const unique = matching.filter((r) => matching.filter((other) => other.id === r.id).length === 1);
    const valid = unique.filter((r) => vanRouteValid(r, request));
    const feasible = valid.filter((r) => input.tick + r.expectedTravelTicks <= request.requestTick + VAN_RESPONSE_TICKS).sort((a, b) => a.expectedTravelTicks - b.expectedTravelTicks || compareText(a.id, b.id));
    const route = feasible[0];
    const activeCount = state.jobs.filter((j) => j.vehicleId !== null && j.retiredTick === null).length;
    const blockedReason: VanBlockReason | null = matching.length === 0 ? "no-route" : valid.length === 0 ? "invalid-route" : route === undefined ? "deadline-infeasible" : activeCount >= MAX_ACTIVE_VANS ? "capacity" : state.nextVehicleId >= Number.MAX_SAFE_INTEGER ? "vehicle-ids-exhausted" : null;
    const vehicleId = blockedReason === null ? state.nextVehicleId++ : null;
    const job: VanJob = { requestId: request.id, requestTick: request.requestTick, deadlineTick: request.requestTick + VAN_RESPONSE_TICKS, status: blockedReason === null ? "driving" : "blocked", blockedReason, vehicleId, route: blockedReason === null ? copyVanRoute(route!) : null, dispatchedTick: input.tick, observedTick: input.tick, observedDistanceM: 0, arrivalTick: null, onTime: null, retirementRequestedTick: null, retiredTick: null };
    state.jobs.push(job);
    if (vehicleId !== null && job.route !== null) {
      intents.push({ kind: "spawn-van", vehicleId, requestId: request.id, depotId: job.route.depotId, origin: { ...job.route.origin }, routeId: job.route.id, unitCount: 2 });
      intents.push(drive(vehicleId, job.route.id, job.route, routeFacts(job.route)!.lengthM));
    }
  }
  state.receipts.sort((a, b) => a.id - b.id);
  if (state.receipts.length > MAX_SERVICE_REQUESTS) state.requestIdFloor = Math.max(state.requestIdFloor, state.receipts[state.receipts.length - MAX_SERVICE_REQUESTS - 1]!.id);
  state.receipts = state.receipts.filter((r) => r.id > state.requestIdFloor);
  const active = state.jobs.filter((j) => j.vehicleId !== null && j.retiredTick === null);
  const history = state.jobs.filter((j) => j.vehicleId === null || j.retiredTick !== null).sort((a, b) => b.requestId - a.requestId).slice(0, MAX_VAN_JOBS);
  state.jobs = [...active, ...history].sort((a, b) => a.requestId - b.requestId);
  return { state, intents, rejected };
}

function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

export interface AdWrapSlot { slotId: string; surface: "left-right-rear"; contentKey: null }
export interface BusStop { id: string; nodeId: number; afterLeg: number; dwellTicks: number }
export interface BusRoute extends ServiceRoadRoute {
  id: string;
  source: "muni" | "authored-fallback";
  origin: ServicePoint;
  headwayGameMinutes: number;
  firstDepartureMinute: number;
  stops: readonly BusStop[];
  adWrapSlot: AdWrapSlot;
}
export interface BusRun {
  vehicleId: number;
  route: BusRoute;
  scheduledGameMinute: number;
  observedTick: number;
  observedDistanceM: number;
  nextStop: number;
  dwellUntilTick: number;
  retirementRequestedTick: number | null;
  retiredTick: number | null;
}
export interface BusServiceState {
  lastTick: number;
  absoluteGameMinute: number | null;
  nextVehicleId: number;
  runs: BusRun[];
  missedDepartures: number;
}

export function createBusServiceState(firstVehicleId: number): BusServiceState {
  requireId(firstVehicleId);
  return { lastTick: -1, absoluteGameMinute: null, nextVehicleId: firstVehicleId, runs: [], missedDepartures: 0 };
}

function stopDistance(route: BusRoute, stopIndex: number): number {
  return route.legs.slice(0, route.stops[stopIndex]!.afterLeg).reduce((sum, leg) => sum + leg.lengthM, 0);
}

function busRouteValid(route: BusRoute): boolean {
  if (routeFacts(route) === null || !route.id || !validPoint(route.origin) || (route.source !== "muni" && route.source !== "authored-fallback") || !Number.isInteger(route.headwayGameMinutes) || route.headwayGameMinutes < 1 || route.headwayGameMinutes > 10 || !Number.isInteger(route.firstDepartureMinute) || route.firstDepartureMinute < 0 || route.firstDepartureMinute >= route.headwayGameMinutes || route.stops.length < 2 || !route.adWrapSlot.slotId || route.adWrapSlot.surface !== "left-right-rear" || route.adWrapSlot.contentKey !== null) return false;
  const lastDeparture = route.firstDepartureMinute + Math.floor((DAY_MINUTES - 1 - route.firstDepartureMinute) / route.headwayGameMinutes) * route.headwayGameMinutes;
  if (DAY_MINUTES + route.firstDepartureMinute - lastDeparture > route.headwayGameMinutes) return false;
  if (route.legs[0]!.fromNode !== route.origin.nodeId || route.legs[route.legs.length - 1]!.toNode !== route.origin.nodeId || route.stops[0]!.afterLeg !== 0 || route.stops[route.stops.length - 1]!.afterLeg !== route.legs.length) return false;
  let previous = -1;
  for (const stop of route.stops) {
    if (!stop.id || !Number.isInteger(stop.afterLeg) || stop.afterLeg <= previous || stop.afterLeg > route.legs.length || !Number.isSafeInteger(stop.dwellTicks) || stop.dwellTicks < 0) return false;
    const nodeId = stop.afterLeg === 0 ? route.origin.nodeId : route.legs[stop.afterLeg - 1]!.toNode;
    if (stop.nodeId !== nodeId) return false;
    previous = stop.afterLeg;
  }
  return true;
}

function copyBusRoute(route: BusRoute): BusRoute {
  return { ...copyRoute(route), origin: { ...route.origin }, stops: route.stops.map((s) => ({ ...s })), adWrapSlot: { ...route.adWrapSlot } };
}

/** Published daily departures include the rollover gap, which is never >10 minutes. */
export function publishBusTimetable(route: BusRoute): { routeId: string; departureMinutes: number[]; stops: BusStop[] } | null {
  if (!busRouteValid(route)) return null;
  const departureMinutes: number[] = [];
  for (let minute = route.firstDepartureMinute; minute < DAY_MINUTES; minute += route.headwayGameMinutes) departureMinutes.push(minute);
  return { routeId: route.id, departureMinutes, stops: route.stops.map((stop) => ({ ...stop })) };
}

/** An authored loop must name real directed road legs. Missing data yields no service;
 * this helper never invents an off-road rectangle or a destination spawn.
 */
export function createFallbackBusRoute(authored: Omit<BusRoute, "source" | "headwayGameMinutes" | "firstDepartureMinute" | "adWrapSlot">): BusRoute | null {
  const route: BusRoute = { ...authored, source: "authored-fallback", headwayGameMinutes: 10, firstDepartureMinute: 0, adWrapSlot: { slotId: `${authored.id}:wrap`, surface: "left-right-rear", contentKey: null } };
  return busRouteValid(route) ? copyBusRoute(route) : null;
}

function departureCount(route: BusRoute, minute: number): number {
  if (minute < 0) return 0;
  const day = Math.floor(minute / DAY_MINUTES);
  const dailyCount = Math.floor((DAY_MINUTES - 1 - route.firstDepartureMinute) / route.headwayGameMinutes) + 1;
  return day * dailyCount + Math.max(0, Math.floor((minute - day * DAY_MINUTES - route.firstDepartureMinute) / route.headwayGameMinutes) + 1);
}

function departureAt(route: BusRoute, ordinal: number): number {
  const dailyCount = Math.floor((DAY_MINUTES - 1 - route.firstDepartureMinute) / route.headwayGameMinutes) + 1;
  return Math.floor(ordinal / dailyCount) * DAY_MINUTES + route.firstDepartureMinute + ordinal % dailyCount * route.headwayGameMinutes;
}

export function stepBusServices(previous: Readonly<BusServiceState>, input: {
  tick: number;
  /** Absolute game minutes, or minute-of-day; a decrease in the latter means rollover. */
  gameMinute: number;
  routes: readonly BusRoute[];
  fallbackRoutes: readonly BusRoute[];
  observations: readonly VehicleProgress[];
  retirements?: readonly BusRetirement[];
}): { state: BusServiceState; intents: ServiceIntent[]; blockedRouteIds: string[]; serviceBlocked: boolean } {
  requireId(input.tick);
  if (!Number.isFinite(input.gameMinute) || input.gameMinute < 0 || input.gameMinute > Number.MAX_SAFE_INTEGER - 2 * DAY_MINUTES) throw new RangeError("Expected safe nonnegative game minutes");
  if (input.tick <= previous.lastTick) return { state: previous as BusServiceState, intents: [], blockedRouteIds: [], serviceBlocked: false };
  let minute = input.gameMinute;
  if (minute < DAY_MINUTES && previous.absoluteGameMinute !== null) {
    const day = Math.floor(previous.absoluteGameMinute / DAY_MINUTES);
    minute += day * DAY_MINUTES;
    if (minute < previous.absoluteGameMinute) minute += DAY_MINUTES;
  }
  if (previous.absoluteGameMinute !== null && minute < previous.absoluteGameMinute) throw new RangeError("Game minutes cannot move backwards");
  const state: BusServiceState = { ...previous, lastTick: input.tick, absoluteGameMinute: minute, runs: previous.runs.map((r) => ({ ...r, route: copyBusRoute(r.route) })) };
  const intents: ServiceIntent[] = [];
  for (const run of state.runs) {
    if (run.retirementRequestedTick !== null) {
      const retirements = (input.retirements ?? []).filter((r) => r.vehicleId === run.vehicleId && r.routeId === run.route.id && Number.isSafeInteger(r.tick) && r.tick >= run.retirementRequestedTick! && r.tick <= input.tick).sort((a, b) => a.tick - b.tick);
      if (retirements[0] !== undefined) run.retiredTick = retirements[0].tick;
      continue;
    }
    if (input.tick < run.dwellUntilTick) continue;
    if (run.nextStop === run.route.stops.length) {
      run.retirementRequestedTick = input.tick;
      intents.push({ kind: "retire-bus", vehicleId: run.vehicleId, routeId: run.route.id, clearance: "person-override" });
      continue;
    }
    const target = stopDistance(run.route, run.nextStop);
    const progress = observe(input.observations, run.vehicleId, run.route.id, Math.max(run.observedTick, run.dwellUntilTick), run.observedDistanceM, input.tick, run.route);
    if (progress !== null && progress.distanceM <= target + STOP_TOLERANCE_M) {
      run.observedTick = progress.tick;
      run.observedDistanceM = progress.distanceM;
      if (progress.stopped && Math.abs(progress.distanceM - target) <= STOP_TOLERANCE_M) {
        const stop = run.route.stops[run.nextStop]!;
        run.nextStop++;
        run.dwellUntilTick = input.tick + stop.dwellTicks;
        intents.push({ kind: "bus-stop", vehicleId: run.vehicleId, routeId: run.route.id, stopId: stop.id, dwellUntilTick: run.dwellUntilTick });
        continue;
      }
    }
    intents.push(drive(run.vehicleId, run.route.id, run.route, target));
  }
  state.runs = state.runs.filter((r) => r.retiredTick === null);
  const muni = input.routes.filter((r) => r.source === "muni");
  const validMuni = muni.filter((r) => busRouteValid(r) && muni.filter((other) => other.id === r.id).length === 1);
  const source = validMuni.length > 0 ? muni : input.fallbackRoutes.filter((r) => r.source === "authored-fallback");
  const blockedRouteIds = source.filter((r) => !busRouteValid(r) || source.filter((other) => other.id === r.id).length !== 1).map((r) => r.id).sort(compareText);
  const routes = source.filter((r) => !blockedRouteIds.includes(r.id)).sort((a, b) => compareText(a.id, b.id));
  const due: { route: BusRoute; minute: number }[] = [];
  let dueCount = 0;
  for (const route of routes) {
    const end = departureCount(route, minute);
    const start = previous.absoluteGameMinute === null ? departureCount(route, minute - 0.000001) : departureCount(route, previous.absoluteGameMinute);
    dueCount += end - start;
    for (let ordinal = Math.max(start, end - MAX_BUS_CATCHUP_DEPARTURES); ordinal < end; ordinal++) due.push({ route, minute: departureAt(route, ordinal) });
  }
  due.sort((a, b) => b.minute - a.minute || compareText(a.route.id, b.route.id));
  const capacity = Math.min(MAX_BUS_CATCHUP_DEPARTURES, MAX_ACTIVE_BUSES - state.runs.length, Number.MAX_SAFE_INTEGER - state.nextVehicleId);
  const selected = due.slice(0, capacity).sort((a, b) => a.minute - b.minute || compareText(a.route.id, b.route.id));
  state.missedDepartures += dueCount - selected.length;
  for (const departure of selected) {
    const route = copyBusRoute(departure.route);
    const vehicleId = state.nextVehicleId++;
    state.runs.push({ vehicleId, route, scheduledGameMinute: departure.minute, observedTick: input.tick, observedDistanceM: 0, nextStop: 1, dwellUntilTick: input.tick, retirementRequestedTick: null, retiredTick: null });
    intents.push({ kind: "spawn-bus", vehicleId, routeId: route.id, origin: { ...route.origin }, scheduledGameMinute: departure.minute, adWrapSlot: { ...route.adWrapSlot } });
    intents.push(drive(vehicleId, route.id, route, stopDistance(route, 1)));
  }
  state.runs.sort((a, b) => a.vehicleId - b.vehicleId);
  return { state, intents, blockedRouteIds, serviceBlocked: routes.length === 0 };
}
