import { describe, expect, it } from "vitest";
import { parseFleetTransitLayer } from "../../../src/sim/transit.ts";
import type { FleetTransitLayer } from "../../../src/sim/transit.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import type { RoadsFile } from "../../../src/sim/roads.ts";
import { createFleetState, stepFleet } from "../../../src/sim/agents/runtime-services.ts";
import { muniLocalCandidates } from "../../../src/sim/agents/muni-services.ts";
import { publishBusTimetable } from "../../../src/sim/agents/services.ts";
import { loadWorldFiles, readJson, worldExists } from "../../helpers.ts";

function layer(): FleetTransitLayer {
  return { version: 1, world: "test", routes: [{ id: "source-in", line: "S", mode: "bus", direction: "inbound", night: false,
    lengthM: 140, paths: [[[40, 0], [180, 0]]] }], stops: [
    { id: "source-ferry", x: 40, y: 0, z: 0, routes: ["source-in"] },
    { id: "source-next", x: 180, y: 0, z: 0, routes: ["source-in"] },
  ] };
}
function roads(oneway = false): RoadsFile {
  const nodes = [{ id: "a", x: 0, z: 0 }, { id: "b", x: 240, z: 0 }, { id: "c", x: 240, z: 120 }, { id: "d", x: 0, z: 120 }];
  return { version: 1, nodes, edges: [[0, 1], [1, 2], [2, 3], [3, 0]].map(([a, b], index): RoadsFile["edges"][number] => ({ id: `edge:${index}`,
    a: nodes[a!]!.id, b: nodes[b!]!.id, kind: "residential", lanes: 2, oneway, widthM: 14, speedLimitMps: 16,
    points: [[nodes[a!]!.x, nodes[a!]!.z], [nodes[b!]!.x, nodes[b!]!.z]] })) };
}
const ferry = { x: 40, z: 0 };

describe("source Muni local bus service", () => {
  it("validates the actual source format without mutating or manufacturing transit data", () => {
    const data = layer(), snapshot = JSON.stringify(data);
    expect(parseFleetTransitLayer(data)).toEqual(data);
    expect(parseFleetTransitLayer(data)).not.toBe(data);
    expect(JSON.stringify(data)).toBe(snapshot);
    for (const invalid of [null, { ...data, version: 2 }, { ...data, routes: [...data.routes, data.routes[0]] },
      { ...data, stops: [...data.stops, data.stops[0]] }, { ...data, routes: [{ ...data.routes[0], paths: [[[0, Infinity], [1, 0]]] }] },
      { ...data, stops: [{ ...data.stops[0], y: NaN }] }, { ...data, routes: Array.from({ length: 513 }, () => data.routes[0]) }]) {
      expect(() => parseFleetTransitLayer(invalid)).toThrow(RangeError);
    }
  });

  it("owns and freezes parsed snapshots and only caches those immutable outputs", () => {
    const source = { ...layer(), description: "source description", attribution: "source attribution" };
    const owned = parseFleetTransitLayer(source);
    expect(Object.isFrozen(owned)).toBe(true);
    expect(Object.isFrozen(owned.routes)).toBe(true);
    expect(Object.isFrozen(owned.routes[0])).toBe(true);
    expect(Object.isFrozen(owned.routes[0]!.paths[0])).toBe(true);
    expect(Object.isFrozen(owned.routes[0]!.paths[0]![0])).toBe(true);
    expect(Object.isFrozen(owned.stops[0]!.routes)).toBe(true);
    expect(parseFleetTransitLayer(owned)).toBe(owned);
    expect(owned.description).toBe(source.description);
    expect(owned.attribution).toBe(source.attribution);
    const mutable = source as unknown as { routes: { paths: number[][][] }[]; stops: { routes: string[] }[] };
    mutable.routes[0]!.paths[0]![0]![0] = NaN;
    mutable.stops[0]!.routes.push("unowned");
    expect(() => parseFleetTransitLayer(source)).toThrow(RangeError);
    expect(owned.routes[0]!.paths[0]![0]![0]).toBe(40);
    expect(owned.stops[0]!.routes).toEqual(["source-in"]);
  });

  it("preserves source route and stop IDs, orders by source travel, and excludes non-bus services", () => {
    const data = layer();
    const candidates = muniLocalCandidates(data, ferry);
    expect(candidates.fallbackReason).toBeNull();
    expect(candidates.segments[0]).toMatchObject({ sourceRouteId: "source-in", direction: "inbound", stops: [
      { id: "source-ferry" }, { id: "source-next" },
    ] });
    expect(muniLocalCandidates({ ...data, routes: data.routes.map(route => ({ ...route, mode: "rail" })) }, ferry))
      .toEqual({ segments: [], fallbackReason: "no-ferry-bus-route" });
    expect(muniLocalCandidates({ ...data, stops: [...data.stops].reverse() }, ferry)).toEqual(candidates);
    expect(muniLocalCandidates(undefined, ferry).fallbackReason).toBe("transit-unavailable");
  });

  it("does not expose mutable derived cache objects across identical-input runs", () => {
    const source = parseFleetTransitLayer(layer());
    const first = muniLocalCandidates(source, ferry);
    first.segments[0]!.sourcePath.xs[0] = 999;
    expect(muniLocalCandidates(source, ferry).segments[0]!.sourcePath.xs[0]).toBe(40);
    const world = buildWorld([], roads(), null, undefined, source);
    const input = { tick: 0, gameMinute: 0, requests: [], obstacles: [], ferry };
    const result = stepFleet(world, createFleetState(1000), input);
    const origin = result.state.busRoute!.path.xs[0];
    result.state.busRoute!.path.xs[0] = 999;
    result.state.busPolicy!.origin.x = 999;
    result.state.busPolicy!.stops[0]!.id = "mutated";
    result.state.busService!.sourceStopIds[0] = "mutated";
    const replay = stepFleet(world, createFleetState(1000), input);
    expect(replay.state.busRoute!.path.xs[0]).toBe(origin);
    expect(replay.state.busPolicy!.origin.x).toBe(origin);
    expect(replay.state.busPolicy!.stops[0]!.id).toBe("source-ferry");
    expect(replay.state.busService!.sourceStopIds).toEqual(["source-ferry", "source-next"]);
  });

  it("runs a legal physical local segment with explicit return and a ten-minute source timetable", () => {
    const world = buildWorld([], roads(), null, undefined, layer());
    let result = stepFleet(world, createFleetState(1000), { tick: 0, gameMinute: 0, requests: [], obstacles: [], ferry });
    expect(result.state.busService).toMatchObject({ source: "muni", extent: "local-segment", sourceRouteId: "source-in",
      sourceStopIds: ["source-ferry", "source-next"], returnAfterLeg: 1, fallbackReason: null });
    const policy = result.state.busPolicy!, route = result.state.busRoute!;
    expect(policy.id).toBe("source-in");
    expect(policy.stops.map(stop => stop.id)).toEqual(["source-ferry", "source-next", "source-ferry"]);
    expect(route.path.len).toBeLessThanOrEqual(1800);
    expect(route.path.xs[0]).toBeCloseTo(route.path.xs[route.path.xs.length - 1]!);
    expect(route.path.zs[0]).toBeCloseTo(route.path.zs[route.path.zs.length - 1]!);
    const timetable = publishBusTimetable(policy)!;
    expect(timetable.departureMinutes.every((minute, index) => index === 0 || minute - timetable.departureMinutes[index - 1]! <= 10)).toBe(true);
    expect(1440 + timetable.departureMinutes[0]! - timetable.departureMinutes[timetable.departureMinutes.length - 1]!).toBeLessThanOrEqual(10);
    expect(result.actors[0]).toMatchObject({ halfLength: 4.5, halfWidth: 1.3, personProtected: true, adWrapSlot: { contentKey: null } });
    let arrived = false;
    for (let tick = 1; tick <= 1600; tick++) {
      const old = result.actors[0]!;
      result = stepFleet(world, result.state, { tick, gameMinute: 0, requests: [], obstacles: [], ferry });
      const current = result.actors[0]!;
      expect(Math.sqrt((current.x - old.x) ** 2 + (current.z - old.z) ** 2)).toBeLessThanOrEqual(10 / 60 + 1e-6);
      if (result.state.buses.runs[0]!.nextStop === 2) {
        expect(result.state.vehicles[0]!.distanceM).toBeCloseTo(140, 4);
        expect(current.speed).toBe(0);
        expect(result.state.buses.runs[0]!.dwellUntilTick).toBeGreaterThan(tick);
        arrived = true; break;
      }
    }
    expect(arrived).toBe(true);
  });

  it("falls back explicitly when source direction is illegal instead of reversing a bus", () => {
    const data = layer(), reversed: FleetTransitLayer = { ...data, routes: [{ ...data.routes[0]!, paths: [[[180, 0], [40, 0]]] }] };
    const world = buildWorld([], roads(true), null, undefined, reversed);
    const result = stepFleet(world, createFleetState(1000), { tick: 0, gameMinute: 0, requests: [], obstacles: [], ferry: { x: 180, z: 0 } });
    expect(result.state.busPolicy?.source).toBe("authored-fallback");
    expect(result.state.busService?.fallbackReason).toBe("no-legal-local-segment");
    expect(result.diagnostics).toContain("bus:muni:no-legal-local-segment");
    expect(result.state.busPolicy?.id).not.toBe("source-in");
  });

  it("keeps the absent-layer fallback explicit and deterministically upgrades when transit arrives", () => {
    const world = buildWorld([], roads());
    const first = stepFleet(world, createFleetState(1000), { tick: 0, gameMinute: 0, requests: [], obstacles: [], ferry });
    expect(first.state.busService?.fallbackReason).toBe("transit-unavailable");
    const input = { tick: 60, gameMinute: 10, requests: [], obstacles: [], ferry, transit: layer() };
    const next = stepFleet(world, first.state, input);
    expect(next.state.busPolicy?.source).toBe("muni");
    expect(next.state.buses.runs.map(run => run.route.source)).toEqual(["authored-fallback", "muni"]);
    expect(stepFleet(world, JSON.parse(JSON.stringify(first.state)), input)).toEqual(next);
    expect(stepFleet(world, next.state, input).state).toEqual(next.state);
  });

  it.skipIf(!worldExists("sf"))("loads source Ferry stops and physically runs a bus on the actual SF roads", () => {
    const files = loadWorldFiles("sf"), source = parseFleetTransitLayer(readJson("public/tiles/sf/muni.json"));
    expect(source.routes).toHaveLength(135);
    const world = buildWorld(files.tiles, files.roads as RoadsFile | null, files.boundary, files.gameplay ?? undefined, source);
    let result = stepFleet(world, createFleetState(1000), { tick: 0, gameMinute: 0, requests: [], obstacles: [] });
    expect(result.state.busPolicy?.source).toBe("muni");
    expect(result.state.busService?.sourceStopIds).toContain("s4513");
    const bus = result.actors.find(actor => actor.kind === "bus")!;
    expect(bus).toBeDefined();
    expect(Math.sqrt(bus.x * bus.x + bus.z * bus.z)).toBeLessThanOrEqual(130);
    for (let tick = 1; tick <= 180; tick++) result = stepFleet(world, result.state, { tick, gameMinute: tick / 60, requests: [], obstacles: [] });
    const moved = result.actors.find(actor => actor.id === bus.id)!;
    expect(Math.sqrt((moved.x - bus.x) ** 2 + (moved.z - bus.z) ** 2)).toBeGreaterThan(5);
    expect(result.diagnostics).not.toContain("bus:muni:no-legal-local-segment");
  }, 30000);
});
