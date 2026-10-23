import { describe, expect, it } from "vitest";
import { buildWorld, groundHeight, meshGroundHeight, type World } from "../../../src/sim/world.ts";
import { lanePath, pathPoint, projectOnPath, type RoadsFile } from "../../../src/sim/roads.ts";
import { createFleetState, DEFAULT_FLEET_DEPOTS, stepFleet, type FleetDepot, type FleetObstacle, type FleetState } from "../../../src/sim/agents/runtime-services.ts";
import type { ThreatVanRequest } from "../../../src/sim/agents/services.ts";
import { loadWorldFiles, worldExists } from "../../helpers.ts";

const depots: FleetDepot[] = [{ id: "test-depot", kind: "depot", x: 15, z: 0 }];
const ferry = { x: 15, z: 120 };

function roadWorld(reverse = false): World {
  const nodes = [{ id: "a", x: 0, z: 0 }, { id: "b", x: 240, z: 0 }, { id: "c", x: 240, z: 120 }, { id: "d", x: 0, z: 120 }];
  const edge = (id: string, a: number, b: number): RoadsFile["edges"][number] => ({ id, a: nodes[a]!.id, b: nodes[b]!.id, kind: "residential", lanes: 2, oneway: false, widthM: 14, speedLimitMps: 16, points: [[nodes[a]!.x, nodes[a]!.z], [nodes[b]!.x, nodes[b]!.z]] });
  const edges = [edge("ab", 0, 1), edge("bc", 1, 2), edge("cd", 2, 3), edge("da", 3, 0)];
  return buildWorld([{ tileId: "test", buildings: [], ground: null }], { version: 1, nodes: reverse ? [...nodes].reverse() : nodes, edges: reverse ? edges.reverse() : edges });
}

function request(id = 1, tick = 0): ThreatVanRequest { return { id, requestTick: tick, playerId: "p", player: { x: 180, z: 0 }, threat: 2, unitCount: 2 }; }

function step(world: World, state: FleetState, tick: number, options: { requests?: ThreatVanRequest[]; obstacles?: FleetObstacle[]; gameMinute?: number } = {}) {
  return stepFleet(world, state, { tick, gameMinute: options.gameMinute ?? 1, requests: options.requests ?? [], obstacles: options.obstacles ?? [], depots, ferry });
}

describe("physical service fleet", () => {
  it.skipIf(!worldExists("sf"))("drives real SF depot and Ferry routes with acknowledged van arrival", () => {
    const files = loadWorldFiles("sf");
    const world = buildWorld(files.tiles, files.roads as RoadsFile | null, files.boundary);
    const edge = world.roads!.edges.find((value) => value.id === "c5662000")!;
    const path = lanePath(edge, 1, 0);
    const origin = projectOnPath(path, DEFAULT_FLEET_DEPOTS[0]!.x, DEFAULT_FLEET_DEPOTS[0]!.z);
    const target = pathPoint(path, Math.min(origin.s + 110, path.len - 2));
    expect(Math.min(origin.s + 110, path.len - 2) - origin.s).toBeGreaterThanOrEqual(100);
    const obstacles = [{ id: "player-car", x: target.x, z: target.z, radius: 2.75, person: false }];
    const first = stepFleet(world, createFleetState(1000), { tick: 0, gameMinute: 0, requests: [{ ...request(), player: target }], obstacles });
    expect(first.actors.some((body) => body.kind === "bus")).toBe(true);
    expect(first.actors.some((body) => body.kind === "van")).toBe(true);
    let state = first.state; let arrived = false;
    for (let tick = 1; tick <= 1200; tick++) {
      const next = stepFleet(world, state, { tick, gameMinute: tick / 60, requests: [], obstacles });
      state = next.state;
      if (next.disembarks.length) { arrived = true; break; }
    }
    expect(arrived).toBe(true);
    expect(state.vans.jobs[0]?.onTime).toBe(true);
    expect(state.vehicles.some((body) => body.kind === "bus" && body.distanceM > 5)).toBe(true);
  }, 30000);

  it("places physical fleet bodies on the drawn ground mesh", () => {
    const roads = roadWorld().roads;
    const world = buildWorld([{ tileId: "sloped", buildings: [], ground: { x0: -100, z0: -100, cellSizeM: 500, nx: 2, nz: 2, heights: [0, 0, 0, 100] } }]);
    world.roads = roads;
    const result = step(world, createFleetState(1000), 0, { requests: [request()] });
    const van = result.actors.find((body) => body.kind === "van")!;
    expect(van).toBeDefined();
    expect(van.y).toBe(meshGroundHeight(world, van.x, van.z));
    expect(Math.abs(van.y - groundHeight(world, van.x, van.z))).toBeGreaterThan(1);
  });

  it("dispatches at the depot and physically delivers two units within twenty seconds", () => {
    const world = roadWorld();
    let state = createFleetState(1000);
    const initial = step(world, state, 0, { requests: [request()] });
    const van = initial.actors.find((actor) => actor.kind === "van");
    expect(van).toBeDefined();
    expect(van!.x).toBeLessThan(30);
    expect(initial.state.vans.jobs[0]?.route?.entry.x).toBeCloseTo(60, 0);
    state = initial.state;
    let deliveryTick: number | null = null;
    let units = 0;
    let lastX = van!.x;
    for (let tick = 1; tick <= 1200; tick++) {
      const result = step(world, state, tick);
      const moving = result.actors.find((actor) => actor.id === van!.id);
      if (moving !== undefined && deliveryTick === null) {
        expect(Math.abs(moving.x - lastX)).toBeLessThanOrEqual(16 / 60 + 0.001);
        lastX = moving.x;
      }
      if (result.disembarks.length > 0) { deliveryTick = tick; units += result.disembarks[0]!.units.length; }
      state = result.state;
      if (deliveryTick !== null) break;
    }
    expect(deliveryTick).not.toBeNull();
    expect(deliveryTick!).toBeLessThanOrEqual(1200);
    expect(units).toBe(2);
    expect(state.vans.jobs[0]?.onTime).toBe(true);
    expect(state.nextActorId).toBe(1003);
  });

  it("does not spawn into a person and never replaces blocked travel with arrival", () => {
    const world = roadWorld();
    const lane = lanePath(world.roads!.edges.find((edge) => edge.id === "ab")!, 1, 0);
    const origin = pathPoint(lane, 15 - lane.xs[0]!);
    const obstacle: FleetObstacle = { id: "person", x: origin.x, z: origin.z, radius: 1, person: true };
    let state = step(world, createFleetState(1000), 0, { requests: [request()], obstacles: [obstacle] }).state;
    expect(state.vehicles[0]?.spawned).toBe(false);
    for (let tick = 1; tick <= 1200; tick++) state = step(world, state, tick, { obstacles: [obstacle] }).state;
    expect(state.vans.jobs[0]?.arrivalTick).toBeNull();
    expect(state.vans.jobs[0]?.blockedReason).toBe("deadline-missed");
  });

  it("selects a safe nearby stop when the player's vehicle occupies the nearest road point", () => {
    const world = roadWorld();
    const player: FleetObstacle = { id: "player-car", x: 180, z: 0, radius: 2.75, person: false };
    let state = step(world, createFleetState(1000), 0, { requests: [request()], obstacles: [player] }).state;
    const target = state.vans.jobs[0]!.route!.target;
    expect(Math.abs(target.x - player.x)).toBeGreaterThan(6);
    expect(Math.sqrt((target.x - player.x) * (target.x - player.x) + (target.z - player.z) * (target.z - player.z))).toBeLessThanOrEqual(12);
    let delivered = false;
    for (let tick = 1; tick <= 1200; tick++) {
      const result = step(world, state, tick, { obstacles: [player] });
      state = result.state;
      if (result.disembarks.length > 0) { delivered = true; break; }
    }
    expect(delivered).toBe(true);
    expect(state.vans.jobs[0]?.onTime).toBe(true);
  });

  it("brakes before a protected obstacle and resumes along the same road when it clears", () => {
    const world = roadWorld();
    let state = step(world, createFleetState(1000), 0, { requests: [request()] }).state;
    const start = state.vehicles[0]!;
    const person: FleetObstacle = { id: "person", x: 65, z: start.z, radius: 0.4, person: true };
    for (let tick = 1; tick < 500; tick++) state = step(world, state, tick, { obstacles: [person] }).state;
    expect(state.vehicles[0]!.x).toBeLessThan(65 - 2.6 - 0.4 - 0.75);
    expect(state.vehicles[0]!.speed).toBe(0);
    const stopped = state.vehicles[0]!.x;
    for (let tick = 500; tick < 650; tick++) state = step(world, state, tick).state;
    expect(state.vehicles[0]!.x).toBeGreaterThan(stopped + 10);
  });

  it("ignores an overhead parrot but preserves ground-level and legacy obstacle protection", () => {
    const world = roadWorld();
    for (const band of [{ y: 8, height: 0.5, blocked: false }, { y: 0, height: 1.8, blocked: true }, { blocked: true },
      { y: NaN, height: 0.5, blocked: true }, { y: 8, height: NaN, blocked: true },
      { y: 8, height: 0, blocked: true }, { y: 8, height: -1, blocked: true }]) {
      let state = step(world, createFleetState(1000), 0, { requests: [request()] }).state;
      const first = state.vehicles[0]!;
      const obstacle: FleetObstacle = { id: "same-xz", x: 65, z: first.z, radius: 0.4, person: true,
        ...("y" in band ? { y: band.y, height: band.height } : {}) };
      let delivered = false;
      for (let tick = 1; tick <= 1200; tick++) {
        const next = step(world, state, tick, { obstacles: [obstacle] }); state = next.state;
        if (next.disembarks.length) { delivered = true; break; }
      }
      expect(delivered).toBe(!band.blocked);
      if (band.blocked) expect(state.vans.jobs[0]!.arrivalTick).toBeNull();
    }
  });

  it("checks obstacle height against each candidate road pose on elevated ground", () => {
    const geometry = roadWorld().roads;
    const world = buildWorld([{ tileId: "high", buildings: [], ground: { x0: -100, z0: -100, cellSizeM: 500,
      nx: 2, nz: 2, heights: [8, 8, 8, 8] } }]);
    world.roads = geometry;
    let state = step(world, createFleetState(1000), 0, { requests: [request()] }).state;
    const obstacle: FleetObstacle = { id: "ground-bird", x: 65, z: state.vehicles[0]!.z, radius: 0.4, person: true, y: 8, height: 0.5 };
    for (let tick = 1; tick <= 500; tick++) state = step(world, state, tick, { obstacles: [obstacle] }).state;
    expect(state.vehicles[0]!.x).toBeLessThan(65 - 2.6 - 0.4 - 0.75);
    expect(state.vehicles[0]!.speed).toBe(0);
  });

  it("rejects unsafe building routes and disconnected roads instead of spawning at the player", () => {
    const world = roadWorld();
    const blocked = buildWorld([{ tileId: "test", buildings: [{ id: "wall", baseY: 0, topY: 20, footprint: [[90, -20], [110, -20], [110, 20], [90, 20]] }], ground: null }]);
    blocked.roads = world.roads;
    const result = step(blocked, createFleetState(1000), 0, { requests: [request()] });
    expect(result.actors.filter((actor) => actor.kind === "van")).toEqual([]);
    expect(result.state.vans.jobs[0]?.arrivalTick).toBeNull();
    const empty = step(buildWorld([]), createFleetState(1000), 0, { requests: [request()] });
    expect(empty.actors).toEqual([]);
    expect(empty.diagnostics).toContain("van:1:no-road-route");
  });

  it("drives a wrapped Ferry-near road loop and keeps bus IDs in the shared allocator", () => {
    const world = roadWorld();
    const initial = step(world, createFleetState(1000), 0, { gameMinute: 0, requests: [request()] });
    expect(initial.state.busPolicy?.headwayGameMinutes).toBe(10);
    expect(initial.state.vehicles.map((vehicle) => vehicle.id)).toEqual([1000, 1001]);
    expect(initial.nextActorId).toBe(1002);
    const bus = initial.actors.find((actor) => actor.kind === "bus")!;
    expect(bus.adWrapSlot?.contentKey).toBeNull();
    expect(bus.personProtected).toBe(true);
    let state = initial.state;
    for (let tick = 1; tick < 240; tick++) state = step(world, state, tick, { gameMinute: tick / 600 }).state;
    const moved = state.vehicles.find((vehicle) => vehicle.id === bus.id)!;
    expect(Math.abs(moved.x - bus.x) + Math.abs(moved.z - bus.z)).toBeGreaterThan(5);
  });

  it("returns delivered vans along roads before retirement frees their slot", () => {
    const world = roadWorld();
    let state = step(world, createFleetState(1000), 0, { requests: [request()] }).state;
    let delivered = false;
    let retired = false;
    for (let tick = 1; tick <= 6000; tick++) {
      const result = step(world, state, tick);
      if (result.disembarks.length) { delivered = true; expect(result.state.vehicles).toHaveLength(1); }
      state = result.state;
      if (state.vans.jobs[0]?.retiredTick !== null) { retired = true; expect(result.actors).toEqual([]); break; }
    }
    expect(delivered).toBe(true);
    expect(retired).toBe(true);
  });

  it("retains a stranded van and retries a missing return route at most once per second", () => {
    const world = buildWorld([{ tileId: "test", buildings: [], ground: null }], { version: 1,
      nodes: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 240, z: 0 }],
      edges: [{ id: "ab", a: "a", b: "b", kind: "residential", lanes: 2, oneway: true, widthM: 14, speedLimitMps: 16, points: [[0, 0], [240, 0]] }] });
    let state = step(world, createFleetState(1000), 0, { requests: [request()] }).state;
    let attemptedAt = -1;
    for (let tick = 1; tick <= 1200; tick++) {
      const result = step(world, state, tick);
      state = result.state;
      if (result.diagnostics.includes("vehicle:1000:no-return-route")) { attemptedAt = tick; break; }
    }
    expect(attemptedAt).toBeGreaterThan(0);
    for (let tick = attemptedAt + 1; tick < attemptedAt + 60; tick++) {
      const result = step(world, state, tick);
      state = result.state;
      expect(result.diagnostics).not.toContain("vehicle:1000:no-return-route");
    }
    expect(state.vehicles).toHaveLength(1);
    expect(state.vans.jobs[0]?.retiredTick).toBeNull();
    expect(step(world, state, attemptedAt + 60).diagnostics).toContain("vehicle:1000:no-return-route");
  });

  it("preserves deterministic geometry, allocator order and JSON replay", () => {
    const firstWorld = roadWorld();
    const reorderedWorld = roadWorld(true);
    let a = step(firstWorld, createFleetState(1000), 0, { requests: [request()], gameMinute: 0 });
    let b = step(reorderedWorld, createFleetState(1000), 0, { requests: [request()], gameMinute: 0 });
    expect(b).toEqual(a);
    const frozen = JSON.stringify(a.state);
    const restored = JSON.parse(frozen) as FleetState;
    expect(step(firstWorld, restored, 1)).toEqual(step(firstWorld, a.state, 1));
    expect(JSON.stringify(a.state)).toBe(frozen);
    for (let tick = 1; tick < 200; tick++) { a = step(firstWorld, a.state, tick); b = step(reorderedWorld, b.state, tick); }
    expect(b).toEqual(a);
    expect(JSON.parse(JSON.stringify(a))).toEqual(a);
  });
});
