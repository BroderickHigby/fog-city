import { describe, expect, it } from "vitest";
import type { AgentState } from "../../../src/sim/agents.ts";
import { makeCar } from "../../../src/sim/car.ts";
import { makeFoot } from "../../../src/sim/foot.ts";
import { createInitialState } from "../../../src/sim/step.ts";
import { lanePath, pathPoint } from "../../../src/sim/roads.ts";
import type { RoadsFile } from "../../../src/sim/roads.ts";
import type { SimSystemContext } from "../../../src/sim/system-contract.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import type { World } from "../../../src/sim/world.ts";
import { ASSOCIATE_OWNER_MEMORY_TICKS, createAssociateTransportState, MAX_ASSOCIATE_TRANSPORTS, stepAssociateTransport } from "../../../src/sim/agents/associate-transport.ts";
import type { AssociateTransportInput, AssociateTransportResult, AssociateTransportState } from "../../../src/sim/agents/associate-transport.ts";
import type { RuntimePhysicalBody } from "../../../src/sim/agents/runtime-state.ts";

function roads(kind = "residential", oneway = false): World {
  const nodes = [{ id: "a", x: 0, z: 0 }, { id: "b", x: 240, z: 0 }];
  return buildWorld([], { version: 1, nodes, edges: [{ id: "ab", a: "a", b: "b", kind, lanes: oneway ? 1 : 2,
    oneway, widthM: 14, speedLimitMps: 16, points: [[0, 0], [240, 0]] }] } as RoadsFile);
}
function rider(world: World, id = "associate:1", mode: "car" | "scooter" = "car", x = 40): RuntimePhysicalBody {
  const edge = world.roads?.edges[0], point = edge ? pathPoint(lanePath(edge, 1, 0), x) : { x, z: 0 };
  return { id, numericId: Number(id.split(":")[1]), kind: "person", model: `associate-${mode}`, firmware: "none",
    x: point.x, y: 0, z: point.z, previousX: point.x, previousZ: point.z, heading: Math.PI / 2, previousHeading: Math.PI / 2,
    speed: 0, radius: 0.35, halfLength: 0.35, halfWidth: 0.35, height: 1.7, dodge: null };
}
function context(world: World, tick = 0, ownerX = 70, ownerZ = 18): SimSystemContext {
  const initial = createInitialState(world, 17, [], { x: 1000, z: 1000, heading: 0 });
  const state = { ...initial, tick, players: { p: { id: "p", mode: "foot" as const, car: makeCar(1000, 1000, 0, 0),
    foot: makeFoot(ownerX, 0, ownerZ, 0), exitPending: false } } };
  return { world, previous: { ...state, tick: Math.max(0, tick - 1) }, state, inputs: {}, events: [] };
}
function input(bodies: RuntimePhysicalBody[]): AssociateTransportInput {
  return { bodies, owners: bodies.filter((body) => body.kind === "person").map((body) => ({ bodyId: body.id, playerId: "p" })), nextActorId: 100, remainingCapacity: 24 };
}
function advance(world: World, previous: AssociateTransportResult, tick: number, config: Partial<AssociateTransportInput> = {}): AssociateTransportResult {
  return stepAssociateTransport(context(world, tick), previous.state, { ...input(previous.bodies), nextActorId: previous.nextActorId, ...config });
}
const distance = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);

describe("associate physical transport", () => {
  it("keeps a person identity and allocates a distinct protected occupied vehicle", () => {
    const world = roads(), person = rider(world);
    const result = stepAssociateTransport(context(world), createAssociateTransportState(), input([person]));
    expect(result.bodies.find((body) => body.id === person.id)).toMatchObject({ kind: "person", numericId: 1 });
    const vehicle = result.state.entries[0]!.vehicle!;
    expect(vehicle).toMatchObject({ id: "associate-vehicle:associate:1", kind: "vehicle", numericId: 100, model: "associate-car" });
    expect(distance(vehicle, person)).toBe(0);
    expect(result.riderBindings).toEqual([{ riderId: person.id, vehicleId: vehicle.id }]);
    expect(result.actorMetadata[vehicle.id]).toMatchObject({ kind: "person", protected: true, occupied: true, posture: "seated" });
    expect(result.actorMetadata[person.id]).toMatchObject({ protected: true, posture: "seated" });
    expect(result.nextActorId).toBe(101);
  });

  it("walks to a road entry gradually before mounting and does not drive twice on the mounting tick", () => {
    const world = roads(), person = rider(world); person.z += 1;
    let result = stepAssociateTransport(context(world), createAssociateTransportState(), input([person]));
    expect(result.state.entries[0]!.vehicle).toBeNull();
    expect(distance(result.bodies[0]!, person)).toBeCloseTo(1.6 / 60);
    for (let tick = 1; tick <= 60 && !result.state.entries[0]!.vehicle; tick++) {
      const previous = result.bodies.find((body) => body.id === person.id)!;
      result = advance(world, result, tick);
      expect(distance(previous, result.bodies.find((body) => body.id === person.id)!)).toBeLessThanOrEqual(1.6 / 60 + 1e-7);
    }
    expect(result.state.entries[0]!.vehicle).not.toBeNull();
    expect(result.state.entries[0]!.vehicle!.speed).toBe(0);
    expect(result.state.entries[0]!.vehicle!.previousX).toBe(result.state.entries[0]!.vehicle!.x);
    expect(result.state.entries[0]!.vehicle!.previousZ).toBe(result.state.entries[0]!.vehicle!.z);
    expect(result.state.entries[0]!.body.kind).toBe("person");
  });

  it("drives scooters and cars through actual directed lane geometry with bounded per-tick movement", () => {
    for (const mode of ["car", "scooter"] as const) {
      const world = roads(), person = rider(world, "associate:1", mode);
      let result = stepAssociateTransport(context(world), createAssociateTransportState(), input([person]));
      const start = result.state.entries[0]!.vehicle!;
      for (let tick = 1; tick <= 240; tick++) {
        const old = result.state.entries[0]!.vehicle!;
        result = advance(world, result, tick);
        const vehicle = result.state.entries[0]!.vehicle!;
        expect(distance(old, vehicle)).toBeLessThanOrEqual((mode === "car" ? 10 : 6) / 60 + 1e-7);
        expect(vehicle.z).toBeCloseTo(start.z);
        expect(result.state.entries[0]!.body).toMatchObject({ x: vehicle.x, z: vehicle.z, kind: "person" });
      }
      expect(result.state.entries[0]!.vehicle!.x).toBeGreaterThan(start.x + 10);
      expect(result.nextActorId).toBe(101);
    }
  });

  it("does not invent routes or enter freeway traffic", () => {
    for (const world of [buildWorld([]), roads("freeway"), roads("ramp"), roads("motorway"), roads("rail_only")]) {
      const person = rider(world), first = stepAssociateTransport(context(world), createAssociateTransportState(), input([person]));
      const later = advance(world, first, 1000000);
      expect(later.state.entries[0]!.vehicle).toBeNull();
      expect(later.state.entries[0]!.blocked).toBe("no-safe-road-entry");
      expect(later.bodies[0]).toMatchObject({ x: person.x, z: person.z });
      expect(later.nextActorId).toBe(100);
    }
  });

  it("leaves a destination behind a one-way road pending instead of reversing or teleporting", () => {
    const world = roads("residential", true), person = rider(world, "associate:1", "car", 150);
    const first = stepAssociateTransport(context(world, 0, 130), createAssociateTransportState(), input([person]));
    const next = stepAssociateTransport(context(world, 1000000, 130), first.state, { ...input(first.bodies), nextActorId: first.nextActorId });
    expect(next.state.entries[0]!.blocked).toBe("no-directed-road-route");
    expect(next.state.entries[0]!.vehicle).toMatchObject({ x: first.state.entries[0]!.vehicle!.x, z: first.state.entries[0]!.vehicle!.z, speed: 0 });
  });

  it("stops before another body's occupied clearance footprint", () => {
    const world = roads(), person = rider(world), obstacle = { ...rider(world, "associate:2", "car", 52), model: "parked-car", kind: "vehicle" as const, halfLength: 2.2, halfWidth: 0.95, radius: 0.95 };
    let result = stepAssociateTransport(context(world), createAssociateTransportState(), input([person, obstacle]));
    for (let tick = 1; tick <= 400; tick++) result = advance(world, result, tick);
    const vehicle = result.state.entries[0]!.vehicle!;
    expect(vehicle.x).toBeGreaterThan(person.x);
    expect(obstacle.x - vehicle.x).toBeGreaterThan(5);
    expect(vehicle.speed).toBe(0);
    expect(result.state.entries[0]!.blocked).toBe("traffic-or-building");
  });

  it("treats live legacy traffic as an obstacle and ignores high airborne bodies", () => {
    const world = roads(), person = rider(world), base = context(world);
    const taxi: AgentState = { id: 9, kind: "robotaxi", x: person.x, y: 0, z: person.z, heading: person.heading, pitch: 0, speed: 0, vmax: 10,
      edge: "ab", dir: 1, lane: 0, s: 40, next: "", ndir: 1, nlane: 0, conn: null, node: "", resume: 0,
      lat: 0, wait: 0, dwell: 0, ghost: 0, mode: "go", rng: 42, dodge: null };
    const blocked = stepAssociateTransport({ ...base, state: { ...base.state, ext: { agents: { list: [taxi], nextId: 10 } } } },
      createAssociateTransportState(), input([person]));
    expect(blocked.state.entries[0]!.vehicle).toBeNull();
    const drone = { ...person, id: "drone:2", numericId: 2, kind: "robot" as const, model: "drone", y: 6, height: 0.5 };
    const clear = stepAssociateTransport(base, createAssociateTransportState(), input([person, drone]));
    expect(clear.state.entries[0]!.vehicle).not.toBeNull();
    const grounded = stepAssociateTransport(base, createAssociateTransportState(), input([person, { ...drone, y: 0 }]));
    expect(grounded.state.entries[0]!.vehicle).toBeNull();
  });

  it("reserves omitted restored vehicle identities before allocating another vehicle", () => {
    const world = roads(), person = rider(world);
    const first = stepAssociateTransport(context(world), createAssociateTransportState(), input([person]));
    const secondPerson = rider(world, "associate:2", "scooter", 90);
    const next = stepAssociateTransport(context(world, 1), first.state, input([first.state.entries[0]!.body, secondPerson]));
    expect(next.state.entries.map(entry => entry.vehicle!.numericId)).toEqual([100, 101]);
    expect(next.nextActorId).toBe(102);
    expect(next.bodies.filter(body => body.kind === "vehicle")).toHaveLength(2);
  });

  it("retains a zero-length route safely when the owner is off to the side of its endpoint", () => {
    const world = roads(), person = rider(world), ctx = (tick: number): SimSystemContext => context(world, tick, person.x, 18);
    let result = stepAssociateTransport(ctx(0), createAssociateTransportState(), input([person]));
    for (let tick = 1; tick <= 3; tick++) result = stepAssociateTransport(ctx(tick), result.state, { ...input(result.bodies), nextActorId: result.nextActorId });
    expect(result.state.entries[0]!.vehicle!.x).toBe(person.x);
    expect(result.state.entries[0]!.vehicle!.z).toBe(person.z);
  });

  it("holds an authoritative dodge without allocating a vehicle", () => {
    const world = roads(), person = rider(world);
    person.dodge = { phase: "dive", sx: person.x, sz: person.z, tx: person.x + 1, tz: person.z, t: 0, dur: 30, peak: 0.4, hop: 0, leap: false };
    const result = stepAssociateTransport(context(world), createAssociateTransportState(), input([person]));
    expect(result.bodies[0]).toBe(person);
    expect(result.state.entries[0]!.blocked).toBe("dodge");
    expect(result.riderBindings).toEqual([]);
    expect(result.nextActorId).toBe(100);
  });

  it("holds a retained vehicle's authoritative dodge and resumes only after it clears", () => {
    const world = roads(), first = stepAssociateTransport(context(world), createAssociateTransportState(), input([rider(world)]));
    const moving = advance(world, first, 1), vehicle = moving.state.entries[0]!.vehicle!;
    const dodge = { phase: "dive" as const, sx: vehicle.x, sz: vehicle.z, tx: vehicle.x + 1, tz: vehicle.z,
      t: 0, dur: 30, peak: 0.4, hop: 0, leap: false };
    const bodies = moving.bodies.map(body => body.id === vehicle.id ? { ...body, dodge } : body);
    const held = advance(world, moving, 2, { bodies });
    expect(held.state.entries[0]).toMatchObject({ blocked: "dodge", speed: 0, distanceM: moving.state.entries[0]!.distanceM });
    expect(held.state.entries[0]!.vehicle).toMatchObject({ x: vehicle.x, z: vehicle.z, speed: 0, dodge });
    expect(held.state.entries[0]!.body).toMatchObject({ x: vehicle.x, z: vehicle.z, speed: 0, dodge: null });
    expect(held.nextActorId).toBe(moving.nextActorId);
    const resumed = advance(world, held, 3, { bodies: held.bodies.map(body => body.id === vehicle.id ? { ...body, dodge: null } : body) });
    expect(resumed.state.entries[0]!.distanceM).toBeGreaterThan(held.state.entries[0]!.distanceM);
    expect(resumed.state.entries[0]!.vehicle!.dodge).toBeNull();
  });

  it("does not allocate beyond supplied physical capacity and reuses an existing vehicle", () => {
    const world = roads(), person = rider(world);
    const blocked = stepAssociateTransport(context(world), createAssociateTransportState(), { ...input([person]), remainingCapacity: 0 });
    expect(blocked.state.entries[0]!.vehicle).toBeNull();
    expect(blocked.state.entries[0]!.blocked).toBe("vehicle-capacity");
    const mounted = advance(world, blocked, 1, { remainingCapacity: 1 });
    expect(mounted.state.entries[0]!.vehicle).not.toBeNull();
    const next = advance(world, mounted, 2, { remainingCapacity: 0 });
    expect(next.nextActorId).toBe(101);
    expect(next.state.entries[0]!.vehicle!.numericId).toBe(100);
  });

  it("serializes replay state and resolves input reordering to identical results", () => {
    const world = roads(), a = rider(world, "associate:1", "car", 40), b = rider(world, "associate:2", "scooter", 90);
    const first = stepAssociateTransport(context(world), createAssociateTransportState(), input([b, a]));
    expect(first).toEqual(stepAssociateTransport(context(world), createAssociateTransportState(), input([a, b])));
    const serialized = JSON.stringify(first.state);
    const next = advance(world, first, 1);
    const restored = stepAssociateTransport(context(world, 1), JSON.parse(serialized) as AssociateTransportState,
      { ...input([...first.bodies].reverse()), nextActorId: first.nextActorId });
    expect(restored).toEqual(next);
    expect(JSON.stringify(first.state)).toBe(serialized);
    const replay = stepAssociateTransport(context(world, 1), next.state, { ...input(next.bodies), nextActorId: next.nextActorId });
    expect(replay.state).toEqual(next.state);
  });

  it("does not mount or choose a route to an owner who has never been observed", () => {
    const world = roads(), person = rider(world);
    const result = stepAssociateTransport(context(world, 0, 200), createAssociateTransportState(), input([person]));
    expect(result.state.entries[0]).toMatchObject({ memory: null, target: null, route: null, vehicle: null, blocked: "owner-unobserved" });
    expect(result.bodies[0]).toMatchObject({ x: person.x, z: person.z, speed: 0 });
  });

  it("uses the last observed position through occlusion without refreshing knowledge", () => {
    const clear = roads(), person = rider(clear);
    const first = stepAssociateTransport(context(clear), createAssociateTransportState(), input([person]));
    const blocked = buildWorld([{ tileId: "screen", ground: null, buildings: [{ id: "screen", baseY: 0, topY: 10,
      footprint: [[55, 4], [57, 4], [57, 25], [55, 25]] }] }]);
    blocked.roads = clear.roads;
    const a = stepAssociateTransport(context(blocked, 1, 60), first.state, { ...input(first.bodies), nextActorId: first.nextActorId });
    const b = stepAssociateTransport(context(blocked, 1, 80), first.state, { ...input(first.bodies), nextActorId: first.nextActorId });
    expect(a.state).toEqual(b.state);
    expect(a.state.entries[0]?.memory).toMatchObject({ x: 70, z: 18, observedTick: 0 });
    expect(a.state.entries[0]?.target).toEqual({ x: 70, z: 18 });
  });

  it("stops when owner knowledge expires and resumes only on a fresh observation", () => {
    const world = roads(), person = rider(world);
    const first = stepAssociateTransport(context(world), createAssociateTransportState(), input([person]));
    const expired = stepAssociateTransport(context(world, ASSOCIATE_OWNER_MEMORY_TICKS, 200), first.state,
      { ...input(first.bodies), nextActorId: first.nextActorId });
    expect(expired.state.entries[0]).toMatchObject({ blocked: "owner-memory-expired", route: null, target: null, speed: 0 });
    expect(expired.state.entries[0]?.vehicle).toMatchObject({ x: first.state.entries[0]!.vehicle!.x, z: first.state.entries[0]!.vehicle!.z });
    const seen = stepAssociateTransport(context(world, ASSOCIATE_OWNER_MEMORY_TICKS + 1), expired.state,
      { ...input(expired.bodies), nextActorId: expired.nextActorId });
    expect(seen.state.entries[0]?.memory?.observedTick).toBe(ASSOCIATE_OWNER_MEMORY_TICKS + 1);
    expect(seen.state.entries[0]?.target).toEqual({ x: 70, z: 18 });
    expect(seen.state.entries[0]?.blocked).toBeNull();
  });

  it("chooses an initially visible owner instead of a hidden nearer player's live location", () => {
    const clear = roads(), person = rider(clear);
    const world = buildWorld([{ tileId: "screen", ground: null, buildings: [{ id: "screen", baseY: 0, topY: 10,
      footprint: [[55, 4], [57, 4], [57, 25], [55, 25]] }] }]);
    world.roads = clear.roads;
    const base = context(world, 0, 60), player = base.state.players.p!;
    const ctx = { ...base, state: { ...base.state, players: { ...base.state.players, q: { ...player, id: "q", foot: makeFoot(60, 0, -18, 0) } } } };
    const result = stepAssociateTransport(ctx, createAssociateTransportState(), { ...input([person]), owners: [] });
    expect(result.state.entries[0]?.ownerId).toBe("q");
    expect(result.state.entries[0]?.memory).toMatchObject({ playerId: "q", x: 60, z: -18 });
  });

  it("rejects future or artificially extended memory and preserves restored memory on replay", () => {
    const world = roads(), person = rider(world);
    const first = stepAssociateTransport(context(world), createAssociateTransportState(), input([person]));
    const entry = first.state.entries[0]!;
    for (const memory of [{ ...entry.memory!, observedTick: 1 }, { ...entry.memory!, expiresTick: 99999 }]) {
      expect(() => stepAssociateTransport(context(world, 1), { ...first.state, entries: [{ ...entry, memory }] }, input(first.bodies))).toThrow(RangeError);
    }
    const restored = JSON.parse(JSON.stringify(first.state)) as AssociateTransportState;
    const a = stepAssociateTransport(context(world, 1, 200), restored, { ...input(first.bodies), nextActorId: first.nextActorId });
    const b = stepAssociateTransport(context(world, 1, 220), restored, { ...input([...first.bodies].reverse()), nextActorId: first.nextActorId });
    expect(a.state).toEqual(b.state);
    expect(a.state.entries[0]?.memory).toEqual(first.state.entries[0]?.memory);
  });

  it("bounds tracked associates and rejects non-finite public state", () => {
    const world = buildWorld([]), bodies = Array.from({ length: MAX_ASSOCIATE_TRANSPORTS + 1 }, (_, i) => rider(world, `associate:${i + 1}`, "car", i * 20));
    const result = stepAssociateTransport(context(world), createAssociateTransportState(), input(bodies));
    expect(result.state.entries).toHaveLength(MAX_ASSOCIATE_TRANSPORTS);
    expect(result.diagnostics.some((message) => message.endsWith(":associate-capacity"))).toBe(true);
    expect(() => stepAssociateTransport(context(world), createAssociateTransportState(), input([{ ...bodies[0]!, x: NaN }]))).toThrow(RangeError);
    expect(() => stepAssociateTransport(context(world), createAssociateTransportState(), { ...input([bodies[0]!]), nextActorId: Infinity })).toThrow(RangeError);
  });
});
