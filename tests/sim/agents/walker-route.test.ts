import { describe, expect, it } from "vitest";
import { buildWorld, circleBlocked, meshGroundHeight, type BuildingCollider, type Heightfield, type World } from "../../../src/sim/world.ts";
import type { RoadsFile } from "../../../src/sim/roads.ts";
import type { BoundaryFile } from "../../../src/sim/boundary.ts";
import { createFinaleState, type ProtectedFinaleBody } from "../../../src/sim/robots/finale.ts";
import { deriveWalkerPatrolRoute, WALKER_PATROL_RADIUS_M, WALKER_PATROL_STEP_M } from "../../../src/sim/agents/walker-route.ts";

function field(height: (x: number, z: number) => number = () => 0): Heightfield {
  const heights: number[] = [];
  for (let z = -200; z <= 200; z += 5) for (let x = -200; x <= 200; x += 5) heights.push(height(x, z));
  return { x0: -200, z0: -200, cellSizeM: 5, nx: 81, nz: 81, heights };
}
function roads(halfLength = 90, x = 100, id = "patrol"): RoadsFile {
  return { version: 1, nodes: [{ id: `${id}-a`, x, z: -halfLength }, { id: `${id}-b`, x, z: halfLength }],
    edges: [{ id, a: `${id}-a`, b: `${id}-b`, kind: "residential", lanes: 2, oneway: false, widthM: 12, points: [[x, -halfLength], [x, halfLength]] }] };
}
function rect(x0: number, z0: number, x1: number, z1: number, extra: Partial<BuildingCollider> = {}): BuildingCollider {
  return { id: "obstacle", footprint: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], baseY: 0, topY: 20, ...extra };
}
function world(options: { road?: RoadsFile; ground?: Heightfield | null; buildings?: BuildingCollider[]; boundary?: BoundaryFile } = {}): World {
  return buildWorld([{ tileId: "patrol-ground", buildings: options.buildings ?? [], ground: options.ground === undefined ? field() : options.ground }], options.road ?? roads(), options.boundary ?? null);
}
const player = Object.freeze({ x: 0, z: 0 });

describe("world-derived Walker patrol route", () => {
  it("builds a short ground-backed patrol loop with full footprint and a one-second windup", () => {
    const city = world({ ground: field((_x, z) => z * 0.1) });
    const result = deriveWalkerPatrolRoute(city, player);
    expect(result.diagnostic).toBeNull();
    expect(result.edgeId).toBe("patrol");
    const route = result.route!;
    expect(route.waypoints.length).toBeGreaterThan(4);
    for (let i = 0; i < route.waypoints.length; i++) {
      const a = route.waypoints[i]!, b = route.waypoints[(i + 1) % route.waypoints.length]!;
      expect(a).toMatchObject({ x: 100, phase: "patrol", footprint: { kind: "circle", radius: WALKER_PATROL_RADIUS_M }, windupTicks: 60, shedRobots: 0 });
      expect(Math.sqrt(a.x * a.x + a.z * a.z)).toBeGreaterThanOrEqual(80);
      expect(Math.sqrt(a.x * a.x + a.z * a.z)).toBeLessThanOrEqual(150);
      expect(Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.z - b.z) * (a.z - b.z))).toBeLessThanOrEqual(WALKER_PATROL_STEP_M + 1e-7);
    }
    expect(result.entry!.y).toBe(meshGroundHeight(city, result.entry!.x, result.entry!.z));
    expect(result.entry!.y).not.toBe(0);
    expect(() => createFinaleState({ kind: "walker", route, position: result.entry! })).not.toThrow();
  });

  it("uses stable road IDs and leaves frozen observations unchanged", () => {
    const a = roads(90, 100, "a"), b = roads(90, -100, "b");
    const left = world({ road: { version: 1, nodes: [...a.nodes, ...b.nodes], edges: [...a.edges, ...b.edges] } });
    const right = world({ road: { version: 1, nodes: [...b.nodes, ...a.nodes], edges: [...b.edges, ...a.edges] } });
    const bodies: readonly ProtectedFinaleBody[] = Object.freeze([Object.freeze({ id: "spectator", kind: "person", x: 0, z: 20, radius: 0.4 })]);
    Object.freeze(left); Object.freeze(left.roads!.edges); Object.freeze(left.roads!.nodes);
    const before = JSON.stringify(left.roads);
    expect(deriveWalkerPatrolRoute(left, player, bodies)).toEqual(deriveWalkerPatrolRoute(right, player, [...bodies].reverse()));
    expect(deriveWalkerPatrolRoute(left, player, bodies).edgeId).toBe("a");
    expect(JSON.stringify(left.roads)).toBe(before);
  });

  it("requires a nearby drivable ground road rather than inventing a route", () => {
    expect(deriveWalkerPatrolRoute(buildWorld([]), player).diagnostic).toBe("walker-route-no-drivable-road");
    const pedestrian = roads();
    expect(deriveWalkerPatrolRoute(world({ road: { ...pedestrian, edges: pedestrian.edges.map(e => ({ ...e, pedestrian: true })) } }), player).route).toBeNull();
    expect(deriveWalkerPatrolRoute(world({ road: roads(20, 220) }), player).diagnostic).toBe("walker-route-no-nearby-segment");
    expect(deriveWalkerPatrolRoute(world({ ground: null }), player).diagnostic).toBe("walker-route-no-safe-segment");
  });

  it("rejects an obstacle between clear waypoint footprints, including the return leg", () => {
    // A 40 m edge leaves exactly a 24 m patrol after the node/body clearance margins.
    // The tiny corner clips the swept body at z=2; the neighbouring z=0/4 discs miss it.
    const city = world({ road: roads(20), buildings: [rect(104.4, 1.99, 104.6, 2.01)] });
    for (const z of [-12, -8, -4, 0, 4, 8, 12]) expect(circleBlocked(city, 100, z, WALKER_PATROL_RADIUS_M)).toBe(false);
    expect(deriveWalkerPatrolRoute(city, player)).toMatchObject({ route: null, diagnostic: "walker-route-no-safe-segment" });
  });

  it("rejects a low deck across the ground patrol footprint", () => {
    const city = world({ buildings: [rect(94, -100, 106, 100, { underY: 2.8, topY: 5 })] });
    expect(circleBlocked(city, 100, 0, WALKER_PATROL_RADIUS_M)).toBe(true);
    expect(deriveWalkerPatrolRoute(city, player).route).toBeNull();
  });

  it("rejects incomplete footprint terrain, a hidden steep rise, water and boundary walls", () => {
    const narrow: Heightfield = { x0: 98, z0: -100, cellSizeM: 1, nx: 5, nz: 201, heights: Array(5 * 201).fill(0) };
    expect(deriveWalkerPatrolRoute(world({ ground: narrow }), player).route).toBeNull();
    expect(deriveWalkerPatrolRoute(world({ ground: field(x => x === 105 ? 10 : 0) }), player).route).toBeNull();
    const wet = field(); wet.water = Array(wet.heights.length).fill(1);
    expect(deriveWalkerPatrolRoute(world({ ground: wet }), player).route).toBeNull();
    const boundary: BoundaryFile = { version: 1, edges: [{ kind: "land", closed: false, points: [[100, -100], [100, 100]] }], shore: [] };
    expect(deriveWalkerPatrolRoute(world({ boundary }), player).route).toBeNull();
  });

  it("uses all current protected bodies and keeps the extra three-metre footfall margin", () => {
    const city = world({ road: roads(20) });
    const spectator: ProtectedFinaleBody = { id: "animal", kind: "animal", x: 107.8, z: 0, radius: 0.5 };
    expect(deriveWalkerPatrolRoute(city, player).route).not.toBeNull();
    expect(deriveWalkerPatrolRoute(city, player, [spectator]).route).toBeNull();
    expect(deriveWalkerPatrolRoute(city, player, [{ ...spectator, x: 120 }]).route).not.toBeNull();
    expect(deriveWalkerPatrolRoute(city, { x: NaN, z: 0 }).diagnostic).toBe("walker-route-invalid-input");
    expect(deriveWalkerPatrolRoute(city, player, [{ ...spectator, radius: -1 }]).diagnostic).toBe("walker-route-invalid-input");
  });

  it("checks a separate narrow heightfield hidden between the footprint centre and corners", () => {
    const tile = (tileId: string, x0: number, nx: number, height: number) => ({ tileId, buildings: [],
      ground: { x0, z0: -30, cellSizeM: 1, nx, nz: 61, heights: Array(nx * 61).fill(height) } });
    const city = buildWorld([tile("left", 90, 13, 0), tile("ridge", 102, 2, 10), tile("right", 103, 8, 0)], roads(20));
    for (const x of [95, 100, 105]) expect(meshGroundHeight(city, x, 0)).toBe(0);
    expect(meshGroundHeight(city, 102.5, 0)).toBe(10);
    expect(deriveWalkerPatrolRoute(city, player).route).toBeNull();
  });

  it("preserves every road bend rather than cutting across a building corner", () => {
    const road: RoadsFile = { version: 1, nodes: [{ id: "a", x: 80, z: -25 }, { id: "b", x: 120, z: 25 }], edges: [{ id: "curve", a: "a", b: "b", kind: "residential", lanes: 2, oneway: false, widthM: 12, points: [[80, -25], [80, 0], [120, 0], [120, 25]] }] };
    const result = deriveWalkerPatrolRoute(world({ road }), player);
    expect(result.route).not.toBeNull();
    for (let i = 0; i < result.route!.waypoints.length; i++) {
      const a = result.route!.waypoints[i]!, b = result.route!.waypoints[(i + 1) % result.route!.waypoints.length]!;
      expect(a.x === b.x || a.z === b.z).toBe(true);
    }
  });
});
