import { describe, expect, it } from "vitest";
import { buildGameplayIndex, type GameplayInput } from "../../pipeline/lib/gameplay-index.ts";

function fixture(): GameplayInput {
  return {
    world: "fixture", sourceSnapshot: "unversioned", tileSizeM: 500,
    tiles: [0, 1, 2].map((ix) => ({ id: `t${ix}_0`, ix, iz: 0, bbox: [ix * 500, 0, ix * 500 + 500, 500] })),
    walk: {
      nodes: [
        { id: "a", x: 10, y: 2, z: 100, road: "n0" },
        { id: "b", x: 1200, y: 2, z: 100, road: "n1" },
      ],
      edges: [{ id: "ab", a: "a", b: "b", kind: "sidewalk", road: "road", lengthM: 1190 }],
    },
    roads: {
      version: 1, attribution: "Synthetic test fixture",
      nodes: [{ id: "n0", x: 10, y: 2, z: 90 }, { id: "n1", x: 1200, y: 2, z: 90 }],
      edges: [{ id: "road", a: "n0", b: "n1", name: "TEST", kind: "residential", points: [[10, 90], [1200, 90]], widthM: 8, oneway: false, lanes: 2, speedLimitMps: 10, cnn: "test", classcode: 5 }],
    },
    districts: [{ id: "test", name: "Test", polygons: [[[[0, 0], [1500, 0], [1500, 500], [0, 500]]]], bbox: [0, 0, 1500, 500], areaM2: 750000, tiles: ["t0_0", "t1_0", "t2_0"] }],
    hydrants: [{ id: "h1", x: 10, y: 2, z: 100, at: "a" }, { id: "unsafe", x: 200, y: 2, z: 100, at: "none" }],
    fountains: [{ id: "f1", x: 1200, y: 2, z: 100, bottleFiller: true, dogBowl: false }],
    signals: [{ node: "n0", x: 10, y: 2, z: 90, kind: "signal", ped: true }],
    transit: { routes: [{ id: "r1", line: "Test", mode: "bus", direction: "inbound", night: true, lengthM: 2000, paths: [[[-500, 200], [2000, 200]]] }], stops: [] },
    shore: [{ closed: false, points: [[0, 1], [1400, 1]] }],
    isLand: (x, z) => x !== 200 && z > 0,
    heightAt: () => 2,
    roadClearance: () => 2,
  };
}

describe("gameplay layer index", () => {
  it("includes crossing segments and both endpoints in intermediate tiles", () => {
    const out = buildGameplayIndex(fixture());
    expect(out.tiles[1]!.sidewalkEdges).toEqual(["ab"]);
    expect(out.tiles[1]!.sidewalkNodes).toEqual(["a", "b"]);
    expect(out.tiles.map((t) => t.transitRoutes)).toEqual([["r1"], ["r1"], ["r1"]]);
  });

  it("is stable under independent input ordering and deduplicates repeated route segments", () => {
    const input = fixture(), first = buildGameplayIndex(input);
    input.tiles = [...input.tiles].reverse();
    input.walk.nodes.reverse();
    input.transit.routes[0]!.paths.push(input.transit.routes[0]!.paths[0]!);
    expect(buildGameplayIndex(input)).toEqual(first);
  });

  it("filters water/obstructed refills and puts salt interactions on dry reachable shore", () => {
    const input = fixture();
    const out = buildGameplayIndex(input);
    expect(out.refills.map((r) => r.id)).not.toContain("unsafe");
    expect(out.refills.some((r) => r.kind === "hydrant" && !r.salt)).toBe(true);
    const salt = out.refills.filter((r) => r.kind === "bay");
    expect(salt.length).toBeGreaterThan(0);
    for (const r of salt) expect(input.isLand(r.x, r.z) && r.salt && r.y <= 3.5).toBe(true);
    input.heightAt = () => 10;
    expect(buildGameplayIndex(input).refills.some((r) => r.kind === "bay")).toBe(false);
  });

  it("generates service candidates with existing road and district IDs, away from traffic", () => {
    const input = fixture(), out = buildGameplayIndex(input);
    expect(new Set(out.anchors.map((a) => a.kind)).size).toBe(4);
    for (const a of out.anchors) {
      expect(input.roads.nodes.some((n) => n.id === a.roadNodeId)).toBe(true);
      expect(a.districtId).toBe("test");
      expect(out.tiles.some((t) => t.anchors.includes(a.id))).toBe(true);
    }
    input.roadClearance = () => -1;
    expect(buildGameplayIndex(input).anchors).toEqual([]);
  });

  it("fails closed on dangling or duplicated graph IDs", () => {
    const input = fixture();
    input.walk.edges[0]!.b = "missing";
    expect(() => buildGameplayIndex(input)).toThrow("missing sidewalk endpoint");
    input.walk.edges[0]!.b = "b";
    input.walk.nodes.push(input.walk.nodes[0]!);
    expect(() => buildGameplayIndex(input)).toThrow("duplicate sidewalk node");
  });
});
