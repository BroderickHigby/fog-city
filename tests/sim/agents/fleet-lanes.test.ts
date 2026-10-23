import { describe, expect, it } from "vitest";
import { buildWorld } from "../../../src/sim/world.ts";
import { lanePath, pathPoint, projectOnPath, type RoadsFile } from "../../../src/sim/roads.ts";
import { createFleetState, stepFleet, type FleetObstacle } from "../../../src/sim/agents/runtime-services.ts";

const roads: RoadsFile = { version: 1, nodes: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 240, z: 0 },
  { id: "c", x: 240, z: 120 }, { id: "d", x: 0, z: 120 }], edges: [
  { id: "ab", a: "a", b: "b", kind: "arterial", lanes: 3, oneway: true, widthM: 14.7, speedLimitMps: 16, points: [[0, 0], [240, 0]] },
  { id: "bc", a: "b", b: "c", kind: "arterial", lanes: 3, oneway: true, widthM: 14.7, speedLimitMps: 16, points: [[240, 0], [240, 120]] },
  { id: "cd", a: "c", b: "d", kind: "arterial", lanes: 3, oneway: true, widthM: 14.7, speedLimitMps: 16, points: [[240, 120], [0, 120]] },
  { id: "da", a: "d", b: "a", kind: "arterial", lanes: 3, oneway: true, widthM: 14.7, speedLimitMps: 16, points: [[0, 120], [0, 0]] },
] };
const world = buildWorld([], roads), edge = world.roads!.edges.find(edge => edge.id === "ab")!;
const outer = lanePath(edge, 1, 0), player = pathPoint(outer, 170);
const depots = [{ id: "depot", kind: "depot" as const, x: 15, z: 0 }], ferry = { x: 100, z: outer.zs[0]! };
const playerCar: FleetObstacle = { id: "player-car", x: player.x, z: player.z, radius: 2.75, person: false };
const request = { id: 1, requestTick: 1, playerId: "p", player, threat: 2 as const, unitCount: 2 as const };

describe("safe dispatch lane selection", () => {
  it("keeps the ordinary outer lane when its corridor is clear", () => {
    const result = stepFleet(world, createFleetState(100), { tick: 1, gameMinute: 1, requests: [request], obstacles: [playerCar], depots, ferry });
    const van = result.state.vehicles.find(vehicle => vehicle.kind === "van")!;
    expect(van.route.id).not.toContain(":lane");
    expect(projectOnPath(outer, van.x, van.z).dist).toBeLessThan(0.000001);
  });

  it("dispatches on a clear parallel lane past a bus queue without changing the bus or teleporting", () => {
    const first = stepFleet(world, createFleetState(100), { tick: 0, gameMinute: 0, requests: [], obstacles: [playerCar], depots, ferry });
    const bus = first.state.vehicles.find(vehicle => vehicle.kind === "bus")!;
    expect(bus).toBeDefined();
    let result = stepFleet(world, first.state, { tick: 1, gameMinute: 0, requests: [request], obstacles: [playerCar], depots, ferry });
    const van = result.state.vehicles.find(vehicle => vehicle.kind === "van")!;
    expect(van.route.id).toContain(":lane");
    expect(Math.sqrt((van.x - depots[0]!.x) ** 2 + van.z ** 2)).toBeLessThan(10);
    const routeId = van.route.id;
    let last = { x: van.x, z: van.z }, delivered = 0, deliveredTick = 0;
    for (let tick = 2; tick <= 1201; tick++) {
      result = stepFleet(world, result.state, { tick, gameMinute: 0, requests: [], obstacles: [playerCar], depots, ferry });
      const current = result.state.vehicles.find(vehicle => vehicle.id === van.id)!;
      if (result.disembarks.length) { delivered += result.disembarks[0]!.units.length; deliveredTick = tick; break; }
      expect(current.route.id).toBe(routeId);
      expect(Math.sqrt((current.x - last.x) ** 2 + (current.z - last.z) ** 2)).toBeLessThanOrEqual(16 / 60 + 1e-6);
      last = current;
    }
    expect(delivered).toBe(2);
    expect(result.state.vans.jobs[0]!.onTime).toBe(true);
    expect(result.state.vehicles.some(vehicle => vehicle.id === bus.id && vehicle.kind === "bus")).toBe(true);
    let retired = false;
    for (let tick = deliveredTick + 1; tick <= deliveredTick + 6000; tick++) {
      const before = result.state.vehicles.find(vehicle => vehicle.id === van.id)!;
      result = stepFleet(world, result.state, { tick, gameMinute: 0, requests: [], obstacles: tick < deliveredTick + 240 ? [playerCar] : [], depots, ferry });
      const current = result.state.vehicles.find(vehicle => vehicle.id === van.id);
      if (tick === deliveredTick + 200) { expect(current?.retiring).toBe(true); expect(current?.speed).toBe(0); }
      if (!current) { retired = true; break; }
      expect(Math.sqrt((current.x - before.x) ** 2 + (current.z - before.z) ** 2)).toBeLessThanOrEqual(16 / 60 + 1e-6);
      if (before.route.id !== current.route.id) {
        expect(current.route.path.xs[0]).toBeCloseTo(before.x, 6);
        expect(current.route.path.zs[0]).toBeCloseTo(before.z, 6);
      }
    }
    expect(retired).toBe(true);
    expect(result.state.vans.jobs[0]!.retiredTick).not.toBeNull();
  });

  it("keeps arrival unacknowledged when every parallel lane is occupied", () => {
    const blocked = [0, 1, 2].map(lane => {
      const path = lanePath(edge, 1, lane), point = pathPoint(path, 95);
      return { id: `parked:${lane}`, x: point.x, z: point.z, radius: 2.75, person: false };
    });
    let result = stepFleet(world, createFleetState(100), { tick: 1, gameMinute: 1, requests: [request], obstacles: [...blocked, playerCar], depots, ferry });
    let delivered = 0;
    for (let tick = 2; tick <= 1201; tick++) {
      result = stepFleet(world, result.state, { tick, gameMinute: 1, requests: [], obstacles: [...blocked, playerCar], depots, ferry });
      delivered += result.disembarks.length;
    }
    expect(delivered).toBe(0);
    expect(result.state.vans.jobs[0]!.arrivalTick).toBeNull();
    expect(result.state.vans.jobs[0]!.blockedReason).toBe("deadline-missed");
  });
});
