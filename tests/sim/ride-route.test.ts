import { describe, expect, it } from "vitest";
import { buildWorld, createInitialState, dodgeExtOf, lanePath, pathPoint, step, type RoadsFile } from "../../src/sim/index.ts";
import { rideRouteNext } from "../../src/sim/ride-route.ts";

function roadWorld(points: Record<string, readonly [number, number]>, links: Array<readonly [string, string, string, boolean?]>) {
  const roads: RoadsFile = {
    version: 1,
    nodes: Object.entries(points).map(([id, [x, z]]) => ({ id, x, z })),
    edges: links.map(([id, a, b, oneway = false]) => ({
      id, a, b, kind: "residential", lanes: 2, oneway, widthM: 11, speedLimitMps: 11.18,
      points: [points[a]!, points[b]!],
    })),
  };
  return buildWorld([{ tileId: "ride-detour", buildings: [], ground: null }], roads);
}

describe("robotaxi destination routing", () => {
  it("chooses the reachable detour on the junction loop that trapped greedy routing", () => {
    const world = roadWorld({ A: [0, 0], B: [0, 100], C: [100, 100], D: [100, 0], E: [-300, 100], G: [300, 0] },
      [["AB", "A", "B"], ["BC", "B", "C"], ["CD", "C", "D"], ["DA", "D", "A"], ["BE", "B", "E"], ["EG", "E", "G"]]);
    expect(rideRouteNext(world.roads!, world.roads!.nodeIndex.get("B")!, { x: 300, z: 0 }))
      .toEqual({ edge: world.roads!.edgeIndex.get("BE"), dir: 1 });
  });

  it("takes a detour away from the goal and actually arrives through the composed game", () => {
    const world = roadWorld({ A: [0, 0], B: [0, 30], C: [30, 30], D: [30, 0], E: [-30, 30], F: [-30, 60], H: [90, 60], G: [90, 0] },
      [["AB", "A", "B"], ["BC", "B", "C"], ["CD", "C", "D"], ["DA", "D", "A"], ["BE", "B", "E"], ["EF", "E", "F"], ["FH", "F", "H"], ["HG", "H", "G"]]);
    let s = createInitialState(world, 5, ["p"], { x: 0, z: 0, heading: 0 });
    const template = s.ext.agents!.list.find((a) => a.kind === "robotaxi")!;
    expect(template).toBeDefined();
    const path = lanePath(world.roads!.edges[world.roads!.edgeIndex.get("AB")!]!, 1, 0);
    const distance = path.len / 2, at = pathPoint(path, distance);
    const taxi = { ...template, x: at.x, y: 0, z: at.z, heading: Math.atan2(at.tx, -at.tz), speed: 0,
      edge: "AB", dir: 1 as const, lane: 0, s: distance, next: "BE", ndir: 1 as const, nlane: 0,
      conn: null, node: "", resume: 0, lat: 0, wait: 0, dwell: 0, ghost: 0, dodge: null };
    s.ext.agents!.list = [taxi];
    s.players.p!.car.x = 1000; s.players.p!.car.z = 1000;
    s.players.p!.ride = { agentId: taxi.id, x: taxi.x, y: taxi.y, z: taxi.z, heading: taxi.heading, speed: taxi.speed, goal: { x: 90, z: 0 }, exitPending: false };
    // This fixture isolates route choice and physical arrival; traffic interactions have their
    // own composed ride tests. An empty population index prevents new ambient blockers.
    const isolated = { ...world, roads: { ...world.roads!, areas: [], areaIndex: new Map() } };
    const route = new Set<string>();
    for (let i = 0; i < 6000 && s.players.p!.ride; i++) {
      s = step(isolated, s, { p: { throttle: 0, steer: 0, brake: 0, actions: 0 } });
      const current = s.ext.agents!.list.find((a) => a.id === taxi.id);
      if (current) route.add(current.edge);
    }
    expect(route.has("BE")).toBe(true);
    expect(route.has("HG")).toBe(true);
    expect(s.players.p!.ride).toBeNull();
    expect(Math.hypot(s.players.p!.foot!.x - 90, s.players.p!.foot!.z)).toBeLessThan(29);
    expect(dodgeExtOf(s).contacts).toBe(0);
    expect(dodgeExtOf(s).failures).toBe(0);
  }, 60_000);

  it("respects one-way travel and can use a clear lane when lane zero is blocked", () => {
    const world = roadWorld({ A: [0, 0], B: [100, 0], C: [100, 100] },
      [["AB", "A", "B", true], ["BC", "B", "C", true], ["CA", "C", "A", true]]);
    const graph = world.roads!;
    const bc = graph.edges[graph.edgeIndex.get("BC")!]!;
    bc.laneClear[0] = [false, true];
    const next = rideRouteNext(graph, graph.nodeIndex.get("B")!, { x: 25, z: 0 });
    expect(next).toEqual({ edge: bc.index, dir: 1 });
  });

  it("ignores a closer road in a disconnected component and replans a changed goal", () => {
    const world = roadWorld({ A: [0, 0], B: [100, 0], C: [-100, 0], X: [500, 0], Y: [600, 0] },
      [["AB", "A", "B"], ["AC", "A", "C"], ["XY", "X", "Y"]]);
    const graph = world.roads!, from = graph.nodeIndex.get("A")!;
    const first = rideRouteNext(graph, from, { x: 550, z: 0 });
    expect(first).toEqual({ edge: graph.edgeIndex.get("AB"), dir: 1 });
    expect(rideRouteNext(graph, from, { x: -80, z: 0 })).toEqual({ edge: graph.edgeIndex.get("AC"), dir: 1 });
    expect(rideRouteNext(graph, from, { x: 550, z: 0 })).toEqual(first);
  });
});
