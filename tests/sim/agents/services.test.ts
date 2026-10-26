import { describe, expect, it } from "vitest";
import {
  MAX_ACTIVE_BUSES,
  MAX_ACTIVE_VANS,
  MAX_BUS_CATCHUP_DEPARTURES,
  MAX_SERVICE_REQUESTS,
  MAX_VAN_JOBS,
  SERVICE_REQUEST_RETENTION_TICKS,
  VAN_RESPONSE_TICKS,
  createBusServiceState,
  createFallbackBusRoute,
  createVanServiceState,
  publishBusTimetable,
  stepBusServices,
  stepVanServices,
  type BusRoute,
  type BusRetirement,
  type BusServiceState,
  type ServiceRoadLeg,
  type ThreatVanRequest,
  type VanRouteCandidate,
  type VanRetirement,
  type VanServiceState,
  type VehicleProgress,
} from "../../../src/sim/agents/services.ts";

function leg(fromNode: number, toNode: number, lengthM: number): ServiceRoadLeg {
  return { edgeId: fromNode, fromNode, toNode, direction: 1, oneWay: true, drivable: true, lengthM, speedLimitMps: 10 };
}

function request(id = 1, requestTick = 0): ThreatVanRequest {
  return { id, requestTick, playerId: "player", player: { x: 0, z: 0 }, threat: 2, unitCount: 2 };
}

function vanRoute(requestId = 1, id = "depot-route"): VanRouteCandidate {
  return { id, requestId, depotId: "depot-1", depotKind: "depot", origin: { x: -180, z: 0, nodeId: 0 }, entry: { x: -120, z: 0, nodeId: 1 }, entryAfterLeg: 1, target: { x: 0, z: 0, nodeId: 2 }, legs: [leg(0, 1, 60), leg(1, 2, 120)], cruiseSpeedMps: 10, expectedTravelTicks: 1080 };
}

function vanStep(state: VanServiceState, tick: number, options: {
  requests?: ThreatVanRequest[]; routes?: VanRouteCandidate[]; observations?: VehicleProgress[]; retirements?: VanRetirement[];
} = {}) {
  return stepVanServices(state, { tick, requests: options.requests ?? [], routes: options.routes ?? [], observations: options.observations ?? [], retirements: options.retirements ?? [] });
}

function progress(vehicleId: number, tick: number, distanceM: number, stopped = true, routeId = "depot-route"): VehicleProgress {
  return { vehicleId, tick, distanceM, stopped, routeId };
}

function busRoute(id = "ferry-loop"): BusRoute {
  return { id, source: "muni", origin: { x: 0, z: 0, nodeId: 0 }, legs: [leg(0, 1, 60), leg(1, 2, 60), leg(2, 0, 120)], cruiseSpeedMps: 10, expectedTravelTicks: 1440, headwayGameMinutes: 10, firstDepartureMinute: 0, stops: [{ id: "ferry", nodeId: 0, afterLeg: 0, dwellTicks: 60 }, { id: "midpoint", nodeId: 1, afterLeg: 1, dwellTicks: 60 }, { id: "ferry", nodeId: 0, afterLeg: 3, dwellTicks: 60 }], adWrapSlot: { slotId: "ferry-wrap", surface: "left-right-rear", contentKey: null } };
}

function busStep(state: BusServiceState, tick: number, gameMinute: number, options: {
  routes?: BusRoute[]; fallbackRoutes?: BusRoute[]; observations?: VehicleProgress[]; retirements?: BusRetirement[];
} = {}) {
  return stepBusServices(state, { tick, gameMinute, routes: options.routes ?? [busRoute()], fallbackRoutes: options.fallbackRoutes ?? [], observations: options.observations ?? [], retirements: options.retirements ?? [] });
}

describe("van service", () => {
  it("dispatches two units from a depot on a route entering 120 m away", () => {
    const initial = createVanServiceState(1000);
    const result = vanStep(initial, 0, { requests: [request()], routes: [vanRoute()] });
    expect(result.intents[0]).toMatchObject({ kind: "spawn-van", vehicleId: 1000, origin: { x: -180 }, unitCount: 2 });
    expect(result.intents[1]).toMatchObject({ kind: "drive", vehicleId: 1000, stopAtDistanceM: 180, clearance: "person-override" });
    expect(result.state.jobs[0]).toMatchObject({ deadlineTick: VAN_RESPONSE_TICKS, arrivalTick: null, status: "driving" });
    expect(initial.jobs).toEqual([]);
  });

  it("requires measured stopped arrival, and unloads exactly once", () => {
    const started = vanStep(createVanServiceState(1000), 0, { requests: [request()], routes: [vanRoute()] });
    const moving = vanStep(started.state, 1080, { observations: [progress(1000, 1080, 180, false)] });
    expect(moving.intents.some((intent) => intent.kind === "disembark")).toBe(false);
    const arrived = vanStep(moving.state, 1081, { observations: [progress(1000, 1081, 180)] });
    expect(arrived.state.jobs[0]).toMatchObject({ status: "delivered", arrivalTick: 1081, onTime: true });
    expect(arrived.intents).toEqual([{ kind: "disembark", vehicleId: 1000, requestId: 1, unitCount: 2, placement: "validated-sidewalk" }, { kind: "retire-van", vehicleId: 1000, requestId: 1, destinationDepotId: "depot-1", clearance: "person-override" }]);
    expect(vanStep(arrived.state, 1082, { observations: [progress(1000, 1081, 180)] }).intents.map((intent) => intent.kind)).toEqual(["retire-van"]);
  });

  it("never derives arrival from elapsed time and reports missed deadlines", () => {
    const started = vanStep(createVanServiceState(1000), 0, { requests: [request()], routes: [vanRoute()] });
    const missed = vanStep(started.state, VAN_RESPONSE_TICKS);
    expect(missed.state.jobs[0]).toMatchObject({ status: "blocked", blockedReason: "deadline-missed", arrivalTick: null });
    expect(missed.intents.map((intent) => intent.kind)).toEqual(["retire-van"]);
    const late = vanStep(missed.state, 1260, { observations: [progress(1000, 1260, 180)] });
    expect(late.state.jobs[0]).toMatchObject({ status: "delivered", arrivalTick: 1260, onTime: false, blockedReason: "deadline-missed" });
  });

  it("accepts an on-time observed arrival delivered after the deadline", () => {
    const started = vanStep(createVanServiceState(1000), 0, { requests: [request()], routes: [vanRoute()] });
    const arrived = vanStep(started.state, 1300, { observations: [progress(1000, 1199, 180)] });
    expect(arrived.state.jobs[0]).toMatchObject({ onTime: true, arrivalTick: 1199 });
  });

  it("rejects missing, disconnected, wrong-way and geometrically impossible routes", () => {
    const disconnected = vanRoute();
    disconnected.legs = [leg(0, 1, 60), leg(3, 2, 120)];
    const wrongWay = vanRoute();
    wrongWay.legs = [{ ...leg(0, 1, 60), direction: -1 }, leg(1, 2, 120)];
    const shortcut = vanRoute();
    shortcut.legs = [leg(0, 1, 60), leg(1, 2, 1)];
    for (const route of [disconnected, wrongWay, shortcut]) {
      const result = vanStep(createVanServiceState(1000), 0, { requests: [request()], routes: [route] });
      expect(result.state.jobs[0]?.blockedReason).toBe("invalid-route");
      expect(result.intents).toEqual([]);
    }
    expect(vanStep(createVanServiceState(1000), 0, { requests: [request()] }).state.jobs[0]?.blockedReason).toBe("no-route");
  });

  it("rejects an impossible speed estimate or a route outside the response deadline", () => {
    const dishonestEstimate = { ...vanRoute(), expectedTravelTicks: 100 };
    expect(vanStep(createVanServiceState(1000), 0, { requests: [request()], routes: [dishonestEstimate] }).state.jobs[0]?.blockedReason).toBe("invalid-route");
    const longRoute = { ...vanRoute(), legs: [leg(0, 1, 180), leg(1, 2, 120)], expectedTravelTicks: 1800 };
    const result = vanStep(createVanServiceState(1000), 0, { requests: [request()], routes: [longRoute] });
    expect(result.state.jobs[0]?.blockedReason).toBe("deadline-infeasible");
    expect(result.intents).toEqual([]);
    expect(vanStep(createVanServiceState(1000), 200, { requests: [request()], routes: [vanRoute()] }).state.jobs[0]?.blockedReason).toBe("deadline-infeasible");
  });

  it("rejects arrival evidence on a wrong route, in the future, or faster than road limits", () => {
    const started = vanStep(createVanServiceState(1000), 0, { requests: [request()], routes: [vanRoute()] });
    const result = vanStep(started.state, 1, { observations: [progress(1000, 1, 180), progress(1000, 1080, 180), progress(1000, 1, 0, true, "wrong")] });
    expect(result.state.jobs[0]?.observedDistanceM).toBe(0);
    expect(result.intents.map((intent) => intent.kind)).toEqual(["drive"]);
  });

  it("enforces every leg's speed limit when validating observed progress", () => {
    const route = vanRoute();
    route.cruiseSpeedMps = 16;
    route.legs = [{ ...leg(0, 1, 60), speedLimitMps: 6 }, { ...leg(1, 2, 120), speedLimitMps: 16 }];
    route.expectedTravelTicks = 1050;
    const started = vanStep(createVanServiceState(1000), 0, { requests: [request()], routes: [route] });
    const tooFast = vanStep(started.state, 675, { observations: [progress(1000, 675, 180)] });
    expect(tooFast.state.jobs[0]?.status).toBe("driving");
    expect(tooFast.state.jobs[0]?.observedDistanceM).toBe(0);
    expect(vanStep(tooFast.state, 1050, { observations: [progress(1000, 1050, 180)] }).state.jobs[0]?.status).toBe("delivered");
  });

  it("deduplicates repeated requests both within and across ticks", () => {
    const first = vanStep(createVanServiceState(1000), 0, { requests: [request(), request()], routes: [vanRoute()] });
    expect(first.state.jobs).toHaveLength(1);
    expect(first.intents.filter((intent) => intent.kind === "spawn-van")).toHaveLength(1);
    const second = vanStep(first.state, 1, { requests: [request()], routes: [vanRoute()] });
    expect(second.rejected).toEqual([{ requestId: 1, reason: "duplicate" }]);
    expect(second.intents.filter((intent) => intent.kind === "spawn-van")).toEqual([]);
    expect(vanStep(first.state, 0, { requests: [request(2)], routes: [vanRoute(2)] }).intents).toEqual([]);
  });

  it("uses numeric request order and canonical route order independently of input order", () => {
    const requests = [request(10), request(2)];
    const routes = [vanRoute(10, "z"), vanRoute(2, "b"), vanRoute(2, "a")];
    const forward = vanStep(createVanServiceState(1000), 0, { requests, routes });
    const reverse = vanStep(createVanServiceState(1000), 0, { requests: [...requests].reverse(), routes: [...routes].reverse() });
    expect(reverse).toEqual(forward);
    expect(forward.state.jobs.map((job) => [job.requestId, job.vehicleId, job.route?.id])).toEqual([[2, 1000, "a"], [10, 1001, "z"]]);
  });

  it("rejects conflicting payloads deterministically and retains a receipt", () => {
    const first = request();
    const second = { ...request(), playerId: "other-player" };
    const forward = vanStep(createVanServiceState(1000), 0, { requests: [first, second], routes: [vanRoute()] });
    const reverse = vanStep(createVanServiceState(1000), 0, { requests: [second, first], routes: [vanRoute()] });
    expect(reverse).toEqual(forward);
    expect(forward.rejected).toEqual([{ requestId: 1, reason: "conflicting-request" }]);
    expect(vanStep(forward.state, 1, { requests: [first], routes: [vanRoute()] }).rejected[0]?.reason).toBe("duplicate");
  });

  it("rejects a whole duplicate group when any payload is invalid, regardless of order", () => {
    const invalid = { ...request(), unitCount: 3 } as unknown as ThreatVanRequest;
    const forward = vanStep(createVanServiceState(1000), 0, { requests: [request(), invalid] });
    const reverse = vanStep(createVanServiceState(1000), 0, { requests: [invalid, request()] });
    expect(reverse).toEqual(forward);
    expect(forward.rejected).toEqual([{ requestId: 1, reason: "invalid-request" }]);
    expect(forward.state.receipts).toEqual([]);
  });

  it("bounds retained jobs and receipts and rejects evicted IDs even with newer ticks", () => {
    const requests = Array.from({ length: 200 }, (_, id) => request(id));
    const result = vanStep(createVanServiceState(1000), 0, { requests });
    expect(result.state.receipts).toHaveLength(MAX_SERVICE_REQUESTS);
    expect(result.state.jobs).toHaveLength(MAX_VAN_JOBS);
    expect(vanStep(result.state, 1, { requests: [request(0, 1)] }).rejected[0]?.reason).toBe("too-old");
    const expired = vanStep(result.state, SERVICE_REQUEST_RETENTION_TICKS + 1, { requests: [request(201, 0)] });
    expect(expired.state.receipts).toEqual([]);
    expect(expired.rejected[0]?.reason).toBe("too-old");
  });

  it("keeps blocked vehicle dispatches bounded without reusing IDs", () => {
    const requests = Array.from({ length: MAX_ACTIVE_VANS + 2 }, (_, id) => request(id));
    const routes = requests.map((r) => vanRoute(r.id));
    const result = vanStep(createVanServiceState(1000), 0, { requests, routes });
    expect(result.intents.filter((intent) => intent.kind === "spawn-van")).toHaveLength(MAX_ACTIVE_VANS);
    expect(result.state.jobs.filter((job) => job.blockedReason === "capacity")).toHaveLength(2);
    expect(result.state.nextVehicleId).toBe(1000 + MAX_ACTIVE_VANS);
  });

  it("retains every physical van until retirement is acknowledged, across long delivery runs", () => {
    let state = createVanServiceState(1000);
    let spawned = 0;
    let unloaded = 0;
    const attempts = MAX_ACTIVE_VANS + 8;
    for (let i = 0; i < attempts; i++) {
      const tick = i * 2000;
      const started = vanStep(state, tick, { requests: [request(i + 1, tick)], routes: [vanRoute(i + 1)] });
      spawned += started.intents.filter((intent) => intent.kind === "spawn-van").length;
      const arrived = vanStep(started.state, tick + 1080, { observations: [progress(1000 + i, tick + 1080, 180)] });
      unloaded += arrived.intents.filter((intent) => intent.kind === "disembark").length;
      state = arrived.state;
      expect(state.jobs.filter((job) => job.vehicleId !== null && job.retiredTick === null).length).toBeLessThanOrEqual(MAX_ACTIVE_VANS);
    }
    expect(spawned).toBe(MAX_ACTIVE_VANS);
    expect(unloaded).toBe(MAX_ACTIVE_VANS);
    // Old delivered jobs survive receipt expiry and newer blocked job history.
    expect(state.jobs.filter((job) => job.status === "delivered" && job.retiredTick === null)).toHaveLength(MAX_ACTIVE_VANS);
    const tick = attempts * 2000;
    const replacement = vanStep(state, tick, { requests: [request(attempts + 1, tick)], routes: [vanRoute(attempts + 1)], retirements: [{ vehicleId: 1000, requestId: 1, tick }] });
    expect(replacement.state.jobs.find((job) => job.requestId === 1)?.retiredTick).toBe(tick);
    expect(replacement.intents.filter((intent) => intent.kind === "spawn-van")).toHaveLength(1);
    expect(replacement.state.jobs.filter((job) => job.vehicleId !== null && job.retiredTick === null)).toHaveLength(MAX_ACTIVE_VANS);
    expect(replacement.intents.some((intent) => intent.kind === "disembark")).toBe(false);
  });

  it("requires a matching, timely retirement acknowledgement after the departure request", () => {
    const started = vanStep(createVanServiceState(1000), 0, { requests: [request()], routes: [vanRoute()] });
    const premature = vanStep(started.state, 1, { retirements: [{ vehicleId: 1000, requestId: 1, tick: 1 }] });
    expect(premature.state.jobs[0]?.retiredTick).toBeNull();
    const arrived = vanStep(premature.state, 1080, { observations: [progress(1000, 1080, 180)] });
    const invalid = vanStep(arrived.state, 1081, { retirements: [{ vehicleId: 1000, requestId: 2, tick: 1081 }, { vehicleId: 1000, requestId: 1, tick: 1079 }, { vehicleId: 1000, requestId: 1, tick: 1082 }] });
    expect(invalid.state.jobs[0]?.retiredTick).toBeNull();
    const retired = vanStep(invalid.state, 1082, { retirements: [{ vehicleId: 1000, requestId: 1, tick: 1081 }], observations: [progress(1000, 1080, 180)] });
    expect(retired.state.jobs[0]?.retiredTick).toBe(1081);
    expect(retired.intents).toEqual([]);
  });

  it("also retains a deadline-failed van until acknowledged retirement", () => {
    const started = vanStep(createVanServiceState(1000), 0, { requests: [request()], routes: [vanRoute()] });
    const failed = vanStep(started.state, VAN_RESPONSE_TICKS);
    expect(failed.intents[0]?.kind).toBe("retire-van");
    expect(failed.state.jobs[0]).toMatchObject({ retiredTick: null, retirementRequestedTick: VAN_RESPONSE_TICKS });
    const retired = vanStep(failed.state, VAN_RESPONSE_TICKS + 1, { retirements: [{ vehicleId: 1000, requestId: 1, tick: VAN_RESPONSE_TICKS + 1 }] });
    expect(retired.state.jobs[0]?.retiredTick).toBe(VAN_RESPONSE_TICKS + 1);
    expect(retired.intents).toEqual([]);
  });

  it("never increments a vehicle ID beyond the safe integer range", () => {
    const result = vanStep(createVanServiceState(Number.MAX_SAFE_INTEGER), 0, { requests: [request()], routes: [vanRoute()] });
    expect(result.state.jobs[0]?.blockedReason).toBe("vehicle-ids-exhausted");
    expect(result.intents).toEqual([]);
    expect(Number.isSafeInteger(result.state.nextVehicleId)).toBe(true);
  });

  it("rejects contradictory observations independently of their order", () => {
    const started = vanStep(createVanServiceState(1000), 0, { requests: [request()], routes: [vanRoute()] });
    const observations = [progress(1000, 1080, 180), progress(1000, 1080, 179)];
    const result = vanStep(started.state, 1080, { observations });
    expect(result).toEqual(vanStep(started.state, 1080, { observations: [...observations].reverse() }));
    expect(result.state.jobs[0]?.status).toBe("driving");
  });

  it("replays from plain JSON without mutating requests, routes, or previous state", () => {
    const initial = createVanServiceState(1000);
    const input = { requests: [request()], routes: [vanRoute()] };
    const before = JSON.stringify({ initial, input });
    const first = vanStep(initial, 0, input);
    expect(JSON.stringify({ initial, input })).toBe(before);
    const restored = JSON.parse(JSON.stringify(first.state)) as VanServiceState;
    expect(vanStep(restored, 1080, { observations: [progress(1000, 1080, 180)] })).toEqual(vanStep(first.state, 1080, { observations: [progress(1000, 1080, 180)] }));
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });
});

describe("bus service", () => {
  it("publishes stops and departures with a headway no greater than ten game minutes", () => {
    const published = publishBusTimetable(busRoute())!;
    expect(published.departureMinutes.slice(0, 3)).toEqual([0, 10, 20]);
    expect(published.stops.map((stop) => stop.id)).toEqual(["ferry", "midpoint", "ferry"]);
    const departures = [...published.departureMinutes, published.departureMinutes[0]! + 1440];
    expect(departures.slice(1).every((minute, index) => minute - departures[index]! <= 10)).toBe(true);
    expect(publishBusTimetable({ ...busRoute(), headwayGameMinutes: 11 })).toBeNull();
    expect(publishBusTimetable({ ...busRoute(), headwayGameMinutes: 7, firstDepartureMinute: 6 })).toBeNull();
    const sevenMinute = publishBusTimetable({ ...busRoute(), headwayGameMinutes: 7 })!;
    const sevenDepartures = [...sevenMinute.departureMinutes, sevenMinute.departureMinutes[0]! + 1440];
    expect(sevenDepartures.slice(1).every((minute, index) => minute - sevenDepartures[index]! <= 7)).toBe(true);
  });

  it("spawns a wrapped bus on the published schedule only once per tick", () => {
    const first = busStep(createBusServiceState(2000), 0, 0);
    expect(first.intents[0]).toMatchObject({ kind: "spawn-bus", vehicleId: 2000, scheduledGameMinute: 0, adWrapSlot: { contentKey: null, surface: "left-right-rear" } });
    expect(busStep(first.state, 0, 0).intents).toEqual([]);
    expect(busStep(first.state, 1, 0).intents.filter((intent) => intent.kind === "spawn-bus")).toEqual([]);
  });

  it("handles time-of-day and absolute day rollover without repeating departures", () => {
    const first = busStep(createBusServiceState(2000), 0, 1430);
    const beforeMidnight = busStep(first.state, 1, 1439);
    const midnight = busStep(beforeMidnight.state, 2, 0);
    expect(midnight.state.absoluteGameMinute).toBe(1440);
    expect(midnight.intents.filter((intent) => intent.kind === "spawn-bus")).toMatchObject([{ scheduledGameMinute: 1440 }]);
    const absolute = busStep(beforeMidnight.state, 2, 1440);
    expect(absolute).toEqual(midnight);
    expect(busStep(midnight.state, 3, 0).intents.filter((intent) => intent.kind === "spawn-bus")).toEqual([]);
  });

  it("uses an authored road loop when usable Muni data is absent", () => {
    const authored = createFallbackBusRoute({ ...busRoute("authored-loop") })!;
    const result = busStep(createBusServiceState(2000), 0, 0, { routes: [], fallbackRoutes: [authored] });
    expect(result.state.runs[0]?.route.source).toBe("authored-fallback");
    expect(result.serviceBlocked).toBe(false);
    expect(result.intents[0]).toMatchObject({ routeId: "authored-loop", origin: { nodeId: 0 } });
    expect(createFallbackBusRoute({ ...busRoute(), legs: [leg(0, 1, 60)] })).toBeNull();
    expect(busStep(createBusServiceState(2000), 0, 0, { routes: [] }).serviceBlocked).toBe(true);
  });

  it("falls back when conflicting duplicate route IDs leave no usable Muni route", () => {
    const authored = createFallbackBusRoute({ ...busRoute("authored-loop") })!;
    const result = busStep(createBusServiceState(2000), 0, 0, { routes: [busRoute(), busRoute()], fallbackRoutes: [authored] });
    expect(result.serviceBlocked).toBe(false);
    expect(result.state.runs.map((run) => run.route.id)).toEqual(["authored-loop"]);
  });

  it("waits for observed stops and final dwell, then retains the bus until retirement acknowledgement", () => {
    const first = busStep(createBusServiceState(2000), 0, 0);
    const waiting = busStep(first.state, 360, 1);
    expect(waiting.intents.some((intent) => intent.kind === "bus-stop")).toBe(false);
    const stop = busStep(waiting.state, 361, 1, { observations: [progress(2000, 360, 60, true, "ferry-loop")] });
    expect(stop.intents).toEqual([{ kind: "bus-stop", vehicleId: 2000, routeId: "ferry-loop", stopId: "midpoint", dwellUntilTick: 421 }]);
    expect(busStep(stop.state, 400, 1).intents).toEqual([]);
    const moving = busStep(stop.state, 421, 1);
    expect(moving.intents[0]).toMatchObject({ kind: "drive", stopAtDistanceM: 240 });
    const final = busStep(moving.state, 1501, 2, { observations: [progress(2000, 1501, 240, true, "ferry-loop")] });
    expect(final.intents[0]?.kind).toBe("bus-stop");
    expect(final.state.runs).toHaveLength(1);
    const retiring = busStep(final.state, 1561, 2);
    expect(retiring.intents).toEqual([{ kind: "retire-bus", vehicleId: 2000, routeId: "ferry-loop", clearance: "person-override" }]);
    expect(retiring.state.runs).toHaveLength(1);
    const pending = busStep(retiring.state, 1562, 2, { retirements: [{ vehicleId: 2000, routeId: "ferry-loop", tick: 1560 }, { vehicleId: 2000, routeId: "wrong-route", tick: 1562 }, { vehicleId: 2000, routeId: "ferry-loop", tick: 1563 }] });
    expect(pending.intents).toEqual([]);
    expect(pending.state.runs).toHaveLength(1);
    const retired = busStep(pending.state, 1563, 2, { retirements: [{ vehicleId: 2000, routeId: "ferry-loop", tick: 1562 }] });
    expect(retired.state.runs).toEqual([]);
    expect(busStep(retired.state, 1564, 2, { retirements: [{ vehicleId: 2000, routeId: "ferry-loop", tick: 1562 }] }).intents).toEqual([]);
  });

  it("keeps completed but unretired buses in the physical fleet capacity", () => {
    let state = createBusServiceState(2000);
    for (let i = 0; i < MAX_ACTIVE_BUSES; i++) state = busStep(state, i * 600, i * 10).state;
    expect(state.runs).toHaveLength(MAX_ACTIVE_BUSES);
    const middle = busStep(state, 10000, 150, { observations: state.runs.map((run) => progress(run.vehicleId, 10000, 60, true, run.route.id)) });
    const final = busStep(middle.state, 11200, 150, { observations: state.runs.map((run) => progress(run.vehicleId, 11200, 240, true, run.route.id)) });
    const retiring = busStep(final.state, 11260, 150);
    expect(retiring.intents.filter((intent) => intent.kind === "retire-bus")).toHaveLength(MAX_ACTIVE_BUSES);
    const pending = busStep(retiring.state, 11261, 160);
    expect(pending.state.runs).toHaveLength(MAX_ACTIVE_BUSES);
    expect(pending.intents).toEqual([]);
    expect(pending.state.missedDepartures).toBe(retiring.state.missedDepartures + 1);
    const replaced = busStep(pending.state, 11262, 170, { retirements: [{ vehicleId: 2000, routeId: "ferry-loop", tick: 11261 }] });
    expect(replaced.state.runs).toHaveLength(MAX_ACTIVE_BUSES);
    expect(replaced.state.runs.some((run) => run.vehicleId === 2000)).toBe(false);
    expect(replaced.intents.filter((intent) => intent.kind === "spawn-bus")).toHaveLength(1);
  });

  it("bounds backlog and active vehicles after large game-clock jumps", () => {
    const first = busStep(createBusServiceState(2000), 0, 0);
    const jump = busStep(first.state, 1, 1_000_000);
    expect(jump.intents.filter((intent) => intent.kind === "spawn-bus")).toHaveLength(MAX_BUS_CATCHUP_DEPARTURES);
    expect(jump.state.missedDepartures).toBeGreaterThan(90_000);
    let state = jump.state;
    for (let tick = 2; tick < 20; tick++) state = busStep(state, tick, 1_000_000 + tick * 50).state;
    expect(state.runs).toHaveLength(MAX_ACTIVE_BUSES);
    expect(state.missedDepartures).toBeGreaterThan(jump.state.missedDepartures);
  });

  it("rejects unsafe clock values and never overflows numeric vehicle IDs", () => {
    expect(() => busStep(createBusServiceState(2000), 0, Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
    const exhausted = busStep(createBusServiceState(Number.MAX_SAFE_INTEGER), 0, 0);
    expect(exhausted.intents).toEqual([]);
    expect(exhausted.state.missedDepartures).toBe(1);
    expect(Number.isSafeInteger(exhausted.state.nextVehicleId)).toBe(true);
  });

  it("makes route and observation ordering irrelevant and survives a JSON replay", () => {
    const routes = [busRoute("route-z"), busRoute("route-a")];
    const forward = busStep(createBusServiceState(2000), 0, 0, { routes });
    expect(busStep(createBusServiceState(2000), 0, 0, { routes: [...routes].reverse() })).toEqual(forward);
    const observations = [progress(2000, 360, 60, true, "route-a"), progress(2001, 360, 60, true, "route-z")];
    const restored = JSON.parse(JSON.stringify(forward.state)) as BusServiceState;
    expect(busStep(restored, 360, 1, { routes, observations })).toEqual(busStep(forward.state, 360, 1, { routes: [...routes].reverse(), observations: [...observations].reverse() }));
    expect(JSON.parse(JSON.stringify(forward))).toEqual(forward);
  });
});
