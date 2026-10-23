import { describe, expect, it } from "vitest";
import { makeCar } from "../../../src/sim/car.ts";
import type { PlayerState } from "../../../src/sim/contract.ts";
import { makeFoot } from "../../../src/sim/foot.ts";
import { lanePath, pathPoint } from "../../../src/sim/roads.ts";
import type { RoadsFile } from "../../../src/sim/roads.ts";
import { createRecruitTransportState, stepRecruitTransport } from "../../../src/sim/agents/recruit-transport.ts";
import type { RecruitTransportInput, RecruitTransportResult, RecruitTransportState } from "../../../src/sim/agents/recruit-transport.ts";
import type { RoutineRuntimeEffect } from "../../../src/sim/agents/routine-runtime.ts";
import type { RuntimePhysicalBody } from "../../../src/sim/agents/runtime-state.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import type { World } from "../../../src/sim/world.ts";

function robot(id = "agent:1", x = 2.5, z = 0): RuntimePhysicalBody {
  return { id, numericId: Number(id.split(":")[1]), kind: "robot", model: "footman", firmware: "good", x, y: 0, z,
    previousX: x, previousZ: z, heading: 0, previousHeading: 0, speed: 0, radius: 0.4, halfLength: 0.4, halfWidth: 0.4, height: 1.6, dodge: null };
}
function player(mode: "vehicle" | "foot" = "vehicle", x = 0, z = 0): PlayerState {
  return { id: "p", mode, car: makeCar(mode === "foot" ? 1000 : x, mode === "foot" ? 1000 : z, 0, 0),
    foot: mode === "foot" ? makeFoot(x, 0, z, 0) : null, exitPending: false };
}
function request(kind: string, actorId = "agent:1", amount = 1): RoutineRuntimeEffect {
  return { id: `${actorId}/${kind}/${amount}`, kind: `recruit.${kind}`, actorId, playerId: "p", targetId: "", position: null, amount };
}
function input(bodies = [robot()], effects = [request("board")], owner = player()): RecruitTransportInput {
  return { tick: 0, players: { p: owner }, bodies, effects, nextActorId: 100 };
}
function roads(oneway = false): World {
  const nodes = [{ id: "a", x: 0, z: 0 }, { id: "b", x: 240, z: 0 }, { id: "c", x: 240, z: 120 }, { id: "d", x: 0, z: 120 }];
  const edge = (id: string, a: number, b: number): RoadsFile["edges"][number] => ({ id, a: nodes[a]!.id, b: nodes[b]!.id,
    kind: "residential", lanes: 2, oneway, widthM: 14, speedLimitMps: 16, points: [[nodes[a]!.x, nodes[a]!.z], [nodes[b]!.x, nodes[b]!.z]] });
  return buildWorld([{ tileId: "test", buildings: [], ground: null }], { version: 1, nodes,
    edges: [edge("ab", 0, 1), edge("bc", 1, 2), edge("cd", 2, 3), edge("da", 3, 0)] });
}
function onLane(world: World): RuntimePhysicalBody {
  const point = pathPoint(lanePath(world.roads!.edges.find((edge) => edge.id === "ab")!, 1, 0), 150);
  return robot("agent:1", point.x, point.z);
}
function untilComplete(world: World, initial: RecruitTransportResult, config: RecruitTransportInput, maxTicks = 10000,
  phase: "complete" | "awaiting-restoration" = "complete"): { result: RecruitTransportResult; tick: number } {
  let result = initial;
  const firstBody = initial.state.jobs[0]!.body;
  let moved = false;
  for (let tick = config.tick + 1; tick <= maxTicks; tick++) {
    const priorTaxis = new Map(result.state.taxis.map((taxi) => [taxi.id, taxi.body]));
    result = stepRecruitTransport(world, result.state, { ...config, tick, bodies: result.bodies, effects: [], nextActorId: result.nextActorId });
    for (const taxi of result.state.taxis) {
      const old = priorTaxis.get(taxi.id);
      if (old) expect(Math.sqrt((old.x - taxi.body.x) ** 2 + (old.z - taxi.body.z) ** 2)).toBeLessThanOrEqual(12 / 60 + 1e-5);
    }
    if (Math.abs(result.state.jobs[0]!.body.x - firstBody.x) + Math.abs(result.state.jobs[0]!.body.z - firstBody.z) > 1) moved = true;
    if (result.state.jobs[0]!.phase === phase) { expect(moved).toBe(true); return { result, tick }; }
  }
  throw new Error(`Recruit transport did not complete: ${JSON.stringify(result.state.jobs[0])}`);
}

describe("physical recruit transport", () => {
  it("boards only at a stopped owner car within three metres and reports its exact sequence", () => {
    const world = buildWorld([]);
    for (const candidate of [input([robot("agent:1", 3.01)]), input([robot()], [request("board")], player("foot"))]) {
      const blocked = stepRecruitTransport(world, createRecruitTransportState(), candidate);
      expect(blocked.effectAcks).toEqual([]);
      expect(blocked.state.jobs[0]!.parentVehicleId).toBeNull();
    }
    const boarded = stepRecruitTransport(world, createRecruitTransportState(), input());
    expect(boarded.effectAcks).toEqual([request("board").id]);
    expect(boarded.observations["agent:1"]).toEqual({ boardedSequence: 1 });
    expect(boarded.state.jobs[0]).toMatchObject({ phase: "riding", parentVehicleId: "player-car:p", seat: 0 });
    const moving = player(); moving.car.speed = 5;
    expect(stepRecruitTransport(world, createRecruitTransportState(), input([robot()], [request("board")], moving)).effectAcks).toEqual([]);
  });

  it("reserves at most three stable seats independent of effect ordering", () => {
    const bodies = [1, 2, 3, 4].map((id) => robot(`agent:${id}`));
    const effects = bodies.map((body) => request("board", body.id));
    const a = stepRecruitTransport(buildWorld([]), createRecruitTransportState(), input(bodies, effects));
    const b = stepRecruitTransport(buildWorld([]), createRecruitTransportState(), input([...bodies].reverse(), [...effects].reverse()));
    expect(b).toEqual(a);
    expect(a.state.jobs.filter((job) => job.parentVehicleId !== null)).toHaveLength(3);
    expect(a.state.jobs[3]!.blocked).toBe("no-seat");
  });

  it("carries a bound rider at actual car coordinates and detaches through a safe exit", () => {
    const world = buildWorld([]);
    const first = stepRecruitTransport(world, createRecruitTransportState(), input());
    const moved = player("vehicle", 12, 7);
    const carried = stepRecruitTransport(world, first.state, { ...input([...first.bodies], [], moved), tick: 1 });
    expect(carried.state.jobs[0]!.body).toMatchObject({ x: 12, z: 7, speed: 0 });
    const footOwner = { ...moved, mode: "foot" as const, foot: makeFoot(16, 0, 7, 0) };
    const exited = stepRecruitTransport(world, carried.state, { ...input([...carried.bodies], [], footOwner), tick: 2 });
    expect(exited.state.jobs[0]!.parentVehicleId).toBeNull();
    expect(exited.state.jobs[0]!.phase).toBe("complete");
    expect(exited.observations["agent:1"]).toBeUndefined();
    expect(Math.sqrt((exited.state.jobs[0]!.body.x - 12) ** 2 + (exited.state.jobs[0]!.body.z - 7) ** 2)).toBeGreaterThan(1);
  });

  it("keeps a rider bound when every exit is obstructed", () => {
    const first = stepRecruitTransport(buildWorld([]), createRecruitTransportState(), input());
    const world = buildWorld([{ tileId: "blocked", ground: null, buildings: [{ id: "box", baseY: 0, topY: 10,
      footprint: [[-4, -4], [4, -4], [4, 4], [-4, 4]] }] }]);
    const owner = { ...player(), mode: "foot" as const, foot: makeFoot(8, 0, 0, 0) };
    const held = stepRecruitTransport(world, first.state, { ...input([...first.bodies], [], owner), tick: 1 });
    expect(held.state.jobs[0]).toMatchObject({ phase: "exit", parentVehicleId: "player-car:p", blocked: "no-safe-exit" });
    expect(held.state.jobs[0]!.body.x).toBe(0);
  });

  it("reserves separate safe exits when several riders leave on the same tick", () => {
    const world = buildWorld([]);
    const bodies = [robot("agent:1"), robot("agent:2")];
    const first = stepRecruitTransport(world, createRecruitTransportState(), input(bodies, bodies.map((body) => request("board", body.id))));
    const owner = { ...player(), mode: "foot" as const, foot: makeFoot(8, 0, 0, 0) };
    const exited = stepRecruitTransport(world, first.state, { ...input([...first.bodies], [], owner), tick: 1 });
    expect(exited.state.jobs.every((job) => job.parentVehicleId === null)).toBe(true);
    const [a, b] = exited.state.jobs.map((job) => job.body);
    expect(Math.sqrt((a!.x - b!.x) ** 2 + (a!.z - b!.z) ** 2)).toBeGreaterThan(a!.radius + b!.radius);
  });

  it("physically drives to pickup and back to the owner before acknowledging a taxi", () => {
    const world = roads();
    const config = input([onLane(world)], [request("hail-taxi")], player("foot", 180, 120));
    const initial = stepRecruitTransport(world, createRecruitTransportState(), config);
    expect(initial.state.taxis).toHaveLength(1);
    expect(initial.effectAcks).toEqual([]);
    expect(initial.state.jobs[0]!.body.x).toBe(config.bodies[0]!.x);
    const completed = untilComplete(world, initial, config);
    expect(completed.tick).toBeGreaterThan(300);
    expect(completed.result.effectAcks).toEqual([request("hail-taxi").id]);
    const body = completed.result.state.jobs[0]!.body;
    expect(Math.sqrt((body.x - 180) ** 2 + (body.z - 120) ** 2)).toBeLessThanOrEqual(12);
    expect(completed.result.state.jobs[0]!.parentVehicleId).toBeNull();
  });

  it("keeps absent road routes pending and never substitutes a timer for arrival", () => {
    const world = buildWorld([]), config = input([robot("agent:1", 500, 0)], [request("hail-taxi")], player("foot"));
    const first = stepRecruitTransport(world, createRecruitTransportState(), config);
    const later = stepRecruitTransport(world, first.state, { ...config, tick: 1000000, effects: [] });
    expect(later.state.jobs[0]).toMatchObject({ phase: "pending", blocked: "no-road-route", parentVehicleId: null });
    expect(later.effectAcks).toEqual([]);
    expect(later.state.jobs[0]!.body.x).toBe(500);
    expect(later.nextActorId).toBe(100);
  });

  it("does not route a taxi along freeway, ramp, or rail-only edges even if a broad road graph marks them drivable", () => {
    for (const kind of ["freeway", "ramp", "rail_only"]) {
      const world = buildWorld([], { version: 1, nodes: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 240, z: 0 }],
        edges: [{ id: "ab", a: "a", b: "b", kind, lanes: 2, oneway: false, widthM: 14, speedLimitMps: 12, points: [[0, 0], [240, 0]] }] });
      const result = stepRecruitTransport(world, createRecruitTransportState(), input([onLane(world)], [request("hail-taxi")], player("foot", 20, 0)));
      expect(result.state.taxis).toEqual([]);
      expect(result.state.jobs[0]!.blocked).toBe("no-road-route");
      expect(result.effectAcks).toEqual([]);
    }
  });

  it("does not board a missing recruit using only its stale last position", () => {
    const world = buildWorld([]);
    const initial = stepRecruitTransport(world, createRecruitTransportState(), input([robot("agent:1", 10)]));
    const missing = stepRecruitTransport(world, initial.state, { ...input([], [], player("vehicle", 10)), tick: 1 });
    expect(missing.effectAcks).toEqual([]);
    expect(missing.state.jobs[0]!.blocked).toBe("missing-body");
    expect(missing.bodies.some((body) => body.id === "agent:1")).toBe(false);
  });

  it("finds a nearby taxi spawn on a long road rather than sampling only its endpoints", () => {
    const world = buildWorld([], { version: 1, nodes: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 1000, z: 0 }],
      edges: [{ id: "ab", a: "a", b: "b", kind: "residential", lanes: 2, oneway: false, widthM: 14, speedLimitMps: 12, points: [[0, 0], [1000, 0]] }] });
    const point = pathPoint(lanePath(world.roads!.edges[0]!, 1, 0), 250);
    const recruit = robot("agent:1", point.x, point.z);
    const result = stepRecruitTransport(world, createRecruitTransportState(), input([recruit], [request("hail-taxi")], player("foot", 100, 0)));
    expect(result.state.taxis).toHaveLength(1);
    const taxi = result.state.taxis[0]!.body;
    const gap = Math.sqrt((taxi.x - recruit.x) ** 2 + (taxi.z - recruit.z) ** 2);
    expect(gap).toBeGreaterThanOrEqual(30);
    expect(gap).toBeLessThanOrEqual(150);
    expect(result.effectAcks).toEqual([]);
  });

  it("honors one-way reachability and leaves an impossible dropoff unacknowledged", () => {
    const world = buildWorld([], { version: 1, nodes: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 240, z: 0 }],
      edges: [{ id: "ab", a: "a", b: "b", kind: "residential", lanes: 1, oneway: true, widthM: 10, speedLimitMps: 12, points: [[0, 0], [240, 0]] }] });
    const config = input([onLane(world)], [request("hail-taxi")], player("foot", 20, 0));
    let result = stepRecruitTransport(world, createRecruitTransportState(), config);
    for (let tick = 1; tick < 1600; tick++) result = stepRecruitTransport(world, result.state, { ...config, tick, bodies: result.bodies, effects: [], nextActorId: result.nextActorId });
    expect(result.state.jobs[0]!.parentVehicleId).not.toBeNull();
    expect(result.state.jobs[0]!.blocked).toBe("no-dropoff-route");
    expect(result.effectAcks).toEqual([]);
    expect(result.state.jobs[0]!.body.x).toBeGreaterThan(100);
  });

  it("reports physical safehouse arrival, then waits for the dispatcher to restore combat and firmware", () => {
    const world = roads();
    const config: RecruitTransportInput = { ...input([{ ...onLane(world), firmware: "bad" }], [request("restore-at-safehouse")], player("foot", 50, 160)),
      safehouses: [{ id: "garage", x: 30, z: 120, radiusM: 5 }] };
    const initial = stepRecruitTransport(world, createRecruitTransportState(), config);
    expect(initial.observations["agent:1"]?.restored).not.toBe(true);
    const arrived = untilComplete(world, initial, config, 10000, "awaiting-restoration");
    expect(arrived.result.observations["agent:1"]?.restored).not.toBe(true);
    expect(arrived.result.effectAcks).toEqual([]);
    const body = arrived.result.state.jobs[0]!.body;
    expect(Math.sqrt((body.x - 30) ** 2 + (body.z - 120) ** 2)).toBeLessThanOrEqual(5);
    expect(arrived.result.restorationArrivals).toEqual([{ actorId: "agent:1", effectId: request("restore-at-safehouse").id,
      playerId: "p", sequence: 1, safehouseId: "garage", position: { x: body.x, y: body.y, z: body.z } }]);
    const earlyAck = stepRecruitTransport(world, arrived.result.state, { ...config, tick: arrived.tick + 1,
      bodies: arrived.result.bodies, restoredEffectIds: [request("restore-at-safehouse").id], nextActorId: arrived.result.nextActorId });
    expect(earlyAck.effectAcks).toEqual([]);
    expect(earlyAck.observations["agent:1"]?.restored).not.toBe(true);
    const restored = stepRecruitTransport(world, earlyAck.state, { ...config, tick: arrived.tick + 2,
      bodies: earlyAck.bodies.map((value) => value.id === "agent:1" ? { ...value, firmware: "good" as const } : value),
      restoredEffectIds: [request("restore-at-safehouse").id], nextActorId: earlyAck.nextActorId });
    expect(restored.effectAcks).toEqual([request("restore-at-safehouse").id]);
    expect(restored.observations["agent:1"]).toEqual({ restored: true });
    expect(restored.restorationArrivals).toEqual([]);
  });

  it.each([false, true])("does not reuse another recruit's taxi after safehouse displacement and a late restore ACK (old snapshot: %s)", (oldSnapshot) => {
    const world = roads(), config: RecruitTransportInput = { ...input([{ ...onLane(world), firmware: "bad" }],
      [request("restore-at-safehouse")], player("foot", 50, 160)), safehouses: [{ id: "garage", x: 30, z: 120, radiusM: 5 }] };
    const first = stepRecruitTransport(world, createRecruitTransportState(), config), taxi = first.state.taxis[0]!;
    // Start from an observed stopped dropoff pose, not a timer or a destination teleport.
    const riding: RecruitTransportState = { ...first.state, jobs: [{ ...first.state.jobs[0]!, phase: "riding",
      body: { ...first.state.jobs[0]!.body, x: taxi.body.x, y: taxi.body.y + 0.3, z: taxi.body.z },
      parentVehicleId: taxi.body.id, seat: 0 }], taxis: [{ ...taxi, route: null, leg: "dropoff" }] };
    const atHouse = { ...config, effects: [], nextActorId: first.nextActorId,
      safehouses: [{ id: "garage", x: taxi.body.x, z: taxi.body.z, radiusM: 5 }] };
    const arrived = stepRecruitTransport(world, riding, { ...atHouse, tick: 1, bodies: [riding.jobs[0]!.body, taxi.body] });
    expect(arrived.state.jobs[0]).toMatchObject({ phase: "awaiting-restoration", taxiId: null, parentVehicleId: null });
    expect(arrived.state.taxis[0]!.recruitId).toBeNull();
    const second = robot("agent:2", taxi.body.x + 25, taxi.body.z);
    const reused = stepRecruitTransport(world, arrived.state, { ...atHouse, tick: 2, bodies: [...arrived.bodies, second],
      effects: [request("hail-taxi", second.id)], nextActorId: arrived.nextActorId });
    expect(reused.state.taxis[0]!.recruitId).toBe(second.id);
    expect(reused.state.jobs[1]!.taxiId).toBe(taxi.id);
    // Old version-1 saves retained the released cab id; they must also recover safely.
    const prior: RecruitTransportState = oldSnapshot ? { ...reused.state, jobs: reused.state.jobs.map(job =>
      job.recruitId === "agent:1" ? { ...job, taxiId: taxi.id, phase: "pending" as const, restorationArrival: null } : job) } : reused.state;
    const bodies = reused.bodies.map(body => body.id === "agent:1"
      ? { ...body, x: taxi.body.x + 60, z: taxi.body.z, firmware: "good" as const } : body);
    const snapshot = JSON.stringify(prior);
    const nextInput = { ...atHouse, tick: 3, bodies, nextActorId: reused.nextActorId,
      restoredEffectIds: [request("restore-at-safehouse").id] };
    const displaced = stepRecruitTransport(world, prior, nextInput);
    const oldJob = displaced.state.jobs[0]!, newJob = displaced.state.jobs[1]!;
    expect(oldJob.parentVehicleId).toBeNull();
    expect(oldJob.taxiId).not.toBe(taxi.id);
    expect(newJob.taxiId).toBe(taxi.id);
    expect(displaced.state.taxis.find(value => value.id === taxi.id)!.recruitId).toBe(second.id);
    expect(displaced.effectAcks).toEqual([]);
    expect(displaced.restorationArrivals).toEqual([]);
    expect(displaced.observations["agent:1"]?.restored).not.toBe(true);
    expect(stepRecruitTransport(world, JSON.parse(snapshot) as RecruitTransportState, nextInput)).toEqual(displaced);
    expect(JSON.stringify(prior)).toBe(snapshot);
  });

  it("does not invent a safehouse or move a backup while none is supplied", () => {
    const world = roads(), config = input([onLane(world)], [request("restore-at-safehouse")], player("foot"));
    const first = stepRecruitTransport(world, createRecruitTransportState(), config);
    const later = stepRecruitTransport(world, first.state, { ...config, tick: 999999, effects: [] });
    expect(later.state.jobs[0]!.blocked).toBe("no-safehouse");
    expect(later.state.jobs[0]!.body).toEqual(config.bodies[0]);
    expect(later.state.taxis).toEqual([]);
    expect(later.observations["agent:1"]).toBeUndefined();
  });

  it("does not equate an already-good body at a safehouse with a completed restore effect", () => {
    const config: RecruitTransportInput = { ...input([robot()], [request("restore-at-safehouse")]),
      safehouses: [{ id: "garage", x: 2.5, z: 0 }] };
    const world = buildWorld([]);
    const arrived = stepRecruitTransport(world, createRecruitTransportState(), config);
    expect(arrived.state.jobs[0]!.phase).toBe("awaiting-restoration");
    expect(arrived.effectAcks).toEqual([]);
    expect(arrived.observations["agent:1"]?.restored).not.toBe(true);
    const unconfirmed = stepRecruitTransport(world, arrived.state, { ...config, tick: 1, bodies: arrived.bodies });
    expect(unconfirmed.effectAcks).toEqual([]);
    const confirmed = stepRecruitTransport(world, unconfirmed.state, { ...config, tick: 2, bodies: unconfirmed.bodies,
      restoredEffectIds: [request("restore-at-safehouse").id] });
    expect(confirmed.observations["agent:1"]).toEqual({ restored: true });
  });

  it("is replay-safe and advances at most one physical step for a large tick jump", () => {
    const world = roads(), config = input([onLane(world)], [request("hail-taxi")], player("foot", 180, 120));
    const initial = stepRecruitTransport(world, createRecruitTransportState(), config);
    const snapshot = JSON.stringify(initial.state);
    const next = { ...config, tick: 1000, bodies: initial.bodies, effects: [], nextActorId: initial.nextActorId };
    const a = stepRecruitTransport(world, initial.state, next);
    const b = stepRecruitTransport(world, JSON.parse(snapshot) as RecruitTransportState, next);
    expect(b).toEqual(a);
    expect(JSON.stringify(initial.state)).toBe(snapshot);
    const oldTaxi = initial.state.taxis[0]!.body, taxi = a.state.taxis[0]!.body;
    expect(Math.sqrt((taxi.x - oldTaxi.x) ** 2 + (taxi.z - oldTaxi.z) ** 2)).toBeLessThanOrEqual(12 / 60);
    expect(a.effectAcks).toEqual([]);
  });

  it("keeps capacity-denied taxi requests pending and retries when a shared slot becomes free", () => {
    const world = roads(), config = { ...input([onLane(world)], [request("hail-taxi")], player("foot", 180, 120)), remainingSignificantCapacity: 0 };
    const denied = stepRecruitTransport(world, createRecruitTransportState(), config);
    expect(denied.state.taxis).toEqual([]);
    expect(denied.state.jobs[0]).toMatchObject({ phase: "pending", taxiId: null, blocked: "significant-capacity" });
    expect(denied.nextActorId).toBe(config.nextActorId);
    expect(denied.effectAcks).toEqual([]);
    const admitted = stepRecruitTransport(world, denied.state, { ...config, tick: 1, effects: [], bodies: denied.bodies, remainingSignificantCapacity: 1 });
    expect(admitted.state.taxis).toHaveLength(1);
    expect(admitted.state.jobs[0]!.taxiId).toBe(config.nextActorId);
    expect(admitted.effectAcks).toEqual([]);
  });

  it("shares new taxi slots deterministically and does not spend a slot on a failed spawn", () => {
    const world = roads(), a = onLane(world), b = { ...onLane(world), id: "agent:2", numericId: 2, x: 80 };
    const config = { ...input([a, b], [request("hail-taxi"), request("hail-taxi", b.id)], player("foot", 180, 120)), remainingSignificantCapacity: 1 };
    const first = stepRecruitTransport(world, createRecruitTransportState(), config);
    const reversed = stepRecruitTransport(world, createRecruitTransportState(), { ...config, bodies: [b, a], effects: [...config.effects].reverse() });
    expect(reversed).toEqual(first);
    expect(first.state.taxis).toHaveLength(1);
    expect(first.state.jobs[0]!.taxiId).not.toBeNull();
    expect(first.state.jobs[1]).toMatchObject({ taxiId: null, blocked: "significant-capacity" });
    const failedFirst = stepRecruitTransport(world, createRecruitTransportState(), { ...config, bodies: [{ ...a, x: 5000, z: 5000 }, b] });
    expect(failedFirst.state.jobs[0]!.taxiId).toBeNull();
    expect(failedFirst.state.jobs[1]!.taxiId).not.toBeNull();
    expect(failedFirst.state.taxis).toHaveLength(1);
  });

  it("honors assigned and idle taxis when no new significant slot is available", () => {
    const world = roads(), config = input([onLane(world)], [request("hail-taxi")], player("foot", 180, 120));
    const first = stepRecruitTransport(world, createRecruitTransportState(), { ...config, remainingSignificantCapacity: 1 });
    const taxi = first.state.taxis[0]!;
    const moved = stepRecruitTransport(world, first.state, { ...config, tick: 1, effects: [], bodies: first.bodies,
      nextActorId: first.nextActorId, remainingSignificantCapacity: 0 });
    expect(moved.state.taxis[0]!.distanceM).toBeGreaterThan(taxi.distanceM);
    expect(moved.nextActorId).toBe(first.nextActorId);
    const idle: RecruitTransportState = { ...first.state, jobs: [], taxis: [{ ...taxi, recruitId: null, route: null, leg: null }] };
    const b = robot("agent:2", taxi.body.x + 25, taxi.body.z);
    const reused = stepRecruitTransport(world, idle, { ...config, tick: 1, effects: [request("hail-taxi", b.id)], bodies: [b, taxi.body],
      nextActorId: first.nextActorId, remainingSignificantCapacity: 0 });
    expect(reused.state.taxis).toHaveLength(1);
    expect(reused.state.jobs[0]!.taxiId).toBe(taxi.id);
    expect(reused.nextActorId).toBe(first.nextActorId);
  });

  it("rejects malformed shared capacity before changing transport state", () => {
    for (const capacity of [-1, 0.5, NaN, Infinity]) {
      expect(() => stepRecruitTransport(roads(), createRecruitTransportState(), { ...input(), remainingSignificantCapacity: capacity })).toThrow(RangeError);
    }
  });

  it("rejects non-finite inputs before storing invalid transport state", () => {
    expect(() => stepRecruitTransport(buildWorld([]), createRecruitTransportState(), { ...input(), tick: NaN })).toThrow();
    expect(() => stepRecruitTransport(buildWorld([]), createRecruitTransportState(), input([robot("agent:1", Infinity)]))).toThrow();
    expect(() => stepRecruitTransport(buildWorld([]), createRecruitTransportState(), input([robot()], [request("board", "agent:1", NaN)]))).toThrow();
  });
});
