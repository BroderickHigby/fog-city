import { describe, expect, it } from "vitest";
import { lanePath, pathPoint, walkPath } from "../../../src/sim/roads.ts";
import { meshGroundHeight, buildWorld, type World } from "../../../src/sim/world.ts";
import { routineSpawnCandidates } from "../../../src/sim/agents/routine-spawn.ts";
import { gridCity } from "../fixtures.ts";

function brute(world: World, near: { x: number; z: number }, mode: "walking" | "vehicle", altitude: number) {
  const result: { x: number; y: number; z: number }[] = [];
  const distance = (point: { x: number; z: number }) => (point.x - near.x) * (point.x - near.x) + (point.z - near.z) * (point.z - near.z);
  for (const edge of world.roads?.edges ?? []) {
    if (mode === "vehicle" ? !edge.drivable || edge.laneCount[0] === 0 : !edge.walkable) continue;
    const path = mode === "vehicle" ? lanePath(edge, 1, 0) : walkPath(edge, 1, 1);
    for (const offset of [0.25, 0.5, 0.75]) {
      const point = pathPoint(path, path.len * offset);
      const height = meshGroundHeight(world, point.x, point.z) + altitude;
      if (distance(point) >= 15 * 15 && distance(point) <= 150 * 150) result.push({ x: point.x, y: height, z: point.z });
    }
  }
  return result.sort((a, b) => distance(a) - distance(b) || a.x - b.x || a.z - b.z);
}

describe("static routine spawn candidates", () => {
  it("matches the original scan for both path modes and every role altitude over hills and seams", () => {
    const world = gridCity(true);
    for (const near of [{ x: 0, z: 0 }, { x: -150, z: -150 }, { x: 150, z: 150 }, { x: 225, z: 0 }, { x: -40, z: -60 }, { x: 1e7, z: -1e7 }]) {
      for (const mode of ["walking", "vehicle"] as const) for (const altitude of [0, 6, 7]) {
        expect(routineSpawnCandidates(world, near, mode, altitude)).toEqual(brute(world, near, mode, altitude));
        expect(routineSpawnCandidates(world, near, mode, altitude)).toEqual(brute(world, near, mode, altitude));
      }
    }
  });

  it("keeps exact inclusive 15m/150m boundaries with negative coordinates", () => {
    const world = gridCity();
    const edge = world.roads!.edges[0]!;
    const point = pathPoint(walkPath(edge, 1, 1), walkPath(edge, 1, 1).len * 0.5);
    const contains = (near: { x: number; z: number }) => routineSpawnCandidates(world, near, "walking").some(candidate => candidate.x === point.x && candidate.z === point.z);
    expect(contains({ x: point.x - 15, z: point.z })).toBe(true);
    expect(contains({ x: point.x - 14.99, z: point.z })).toBe(false);
    expect(contains({ x: point.x - 150, z: point.z })).toBe(true);
    expect(contains({ x: point.x - 150.01, z: point.z })).toBe(false);
  });

  it("isolates world heights and does not expose mutable cache records", () => {
    const flat = gridCity(), hill = gridCity(true), near = { x: 220, z: 0 };
    const flatPoints = routineSpawnCandidates(flat, near, "walking"), hillPoints = routineSpawnCandidates(hill, near, "walking");
    expect(flatPoints).toEqual(brute(flat, near, "walking", 0));
    expect(hillPoints).toEqual(brute(hill, near, "walking", 0));
    expect(hillPoints.some(point => point.y > 0)).toBe(true);
    const snapshot = JSON.stringify(hillPoints);
    Object.freeze(hillPoints[0]); hillPoints.pop();
    expect(JSON.stringify(routineSpawnCandidates(hill, near, "walking"))).toBe(snapshot);
  });

  it("preserves duplicate-coordinate ties and handles empty/non-finite queries", () => {
    const world = buildWorld([], { version: 1, nodes: [{ id: "a", x: -100, z: 0 }, { id: "b", x: 100, z: 0 }], edges: [
      { id: "z", a: "a", b: "b", kind: "residential", lanes: 2, oneway: false, points: [[-100, 0], [100, 0]] },
      { id: "a", a: "a", b: "b", kind: "residential", lanes: 2, oneway: false, points: [[-100, 0], [100, 0]] },
    ] });
    for (const mode of ["walking", "vehicle"] as const) expect(routineSpawnCandidates(world, { x: 0, z: 0 }, mode)).toEqual(brute(world, { x: 0, z: 0 }, mode, 0));
    expect(routineSpawnCandidates(buildWorld([]), { x: 0, z: 0 }, "walking")).toEqual([]);
    expect(routineSpawnCandidates(world, { x: NaN, z: 0 }, "walking")).toEqual([]);
    expect(routineSpawnCandidates(world, { x: 0, z: Infinity }, "vehicle")).toEqual([]);
  });
});
