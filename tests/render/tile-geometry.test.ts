import { describe, expect, it } from "vitest";
import type { TileCollider } from "../../src/sim/world.ts";
import { buildTileMeshes, drain, FLAT_GROUND_Y } from "../../src/render/tile-build.ts";
import { MeshBuilder, addBuilding, addHeightfield, addRoad, cleanFootprint, facadeBytes, facadeGrid, type MeshData } from "../../src/render/tile-geometry.ts";
import { nodeClearance, nodeDegrees, nodeHalfWidth } from "../../src/render/roads.ts";
import type { RoadGraph } from "../../src/render/types.ts";

function tri(d: MeshData, t: number): Array<[number, number, number]> {
  return [0, 1, 2].map((k) => {
    const i = d.indices[t * 3 + k]!;
    return [d.positions[i * 3]!, d.positions[i * 3 + 1]!, d.positions[i * 3 + 2]!];
  });
}

function faceNormal(p: Array<[number, number, number]>): [number, number, number] {
  const [a, b, c] = p as [[number, number, number], [number, number, number], [number, number, number]];
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
}

const square: Array<[number, number]> = [
  [0, 0],
  [20, 0],
  [20, 10],
  [0, 10],
];

describe("buildings", () => {
  for (const [name, fp] of [
    ["counter-clockwise", square],
    ["clockwise", [...square].reverse()],
  ] as const) {
    it(`extrudes a ${name} footprint with every face pointing outwards`, () => {
      const mb = new MeshBuilder({ uv: true, facade: true });
      expect(addBuilding(mb, { id: "b", footprint: fp as Array<[number, number]>, baseY: 2, topY: 14 }, { detail: false })).toBe(true);
      const d = mb.build();
      const tris = d.indices.length / 3;
      expect(tris).toBe(4 * 2 + 2);
      for (let t = 0; t < tris; t++) {
        const p = tri(d, t);
        const n = faceNormal(p);
        const cx = (p[0]![0] + p[1]![0] + p[2]![0]) / 3 - 10;
        const cy = (p[0]![1] + p[1]![1] + p[2]![1]) / 3 - 8;
        const cz = (p[0]![2] + p[1]![2] + p[2]![2]) / 3 - 5;
        expect(n[0] * cx + n[1] * cy + n[2] * cz).toBeGreaterThan(0);
      }
      // Walls start below the base (slopes) and stop at the roof.
      let minY = Infinity;
      let maxY = -Infinity;
      for (let i = 1; i < d.positions.length; i += 3) {
        minY = Math.min(minY, d.positions[i]!);
        maxY = Math.max(maxY, d.positions[i]!);
      }
      expect(minY).toBeLessThan(2);
      expect(maxY).toBe(14);
      // _FACADE: 4 bytes per vertex; walls flagged 0, roofs 255; walls run in whole columns.
      expect(d.facade!.length).toBe((d.positions.length / 3) * 4);
      // Decode exactly as the shader does.
      const grid = facadeGrid((d.facade![0]! / 255) * 8, d.facade![1]! / 255);
      for (let i = 0; i < d.positions.length / 3; i++) {
        const isRoof = d.normals[i * 3 + 1]! > 0.5;
        expect(d.facade![i * 4 + 3]).toBe(isRoof ? 255 : 0);
      }
      const wallU = new Set<number>();
      for (let i = 0; i < d.positions.length / 3; i++) if (d.facade![i * 4 + 3] === 0) wallU.add(d.uvs![i * 2]!);
      const us = [...wallU].sort((a, b) => a - b);
      for (const u of us) expect(Math.abs((u - us[0]!) / grid.colW - Math.round((u - us[0]!) / grid.colW))).toBeLessThan(1e-3);
      expect(d.ranges).toEqual([["b", 0, d.indices.length]]);
    });
  }

  it("rejects degenerate footprints and inverted heights", () => {
    expect(cleanFootprint([[0, 0], [1, 1], [0, 0]])).toBeNull();
    expect(cleanFootprint([[0, 0], [1, 0], [1, 1], [0, 0]])).toEqual([[0, 0], [1, 0], [1, 1]]);
    const mb = new MeshBuilder({ uv: true, facade: true });
    expect(addBuilding(mb, { id: "x", footprint: square, baseY: 5, topY: 5 })).toBe(false);
    expect(mb.indexCount).toBe(0);
  });

  it("leaves out buildings replaced by landmarks and records ranges for the rest", () => {
    const collider: TileCollider = {
      tileId: "t0_0",
      ground: null,
      buildings: [
        { id: "keep", footprint: square, baseY: 0, topY: 10 },
        { id: "gone", footprint: square.map(([x, z]) => [x + 50, z] as [number, number]), baseY: 0, topY: 10 },
      ],
    };
    const out = drain(
      buildTileMeshes({
        collider,
        bounds: { id: "t0_0", minX: 0, minZ: 0, maxX: 500, maxZ: 500, exact: true },
        roads: [],
        roadCtx: null,
        skipBuildings: new Set(["gone"]),
      }),
    );
    expect(out.buildingCount).toBe(1);
    expect(out.buildings!.ranges.map((r) => r[0])).toEqual(["keep"]);
    // No heightfield: flat land just above the Bay plane, exactly over the tile.
    const g = out.ground!;
    for (let i = 1; i < g.positions.length; i += 3) expect(g.positions[i]).toBeCloseTo(FLAT_GROUND_Y, 6);
    expect(Math.min(...Array.from({ length: g.positions.length / 3 }, (_, i) => g.positions[i * 3]!))).toBe(0);
  });
});

describe("facade encoding", () => {
  it("matches the pipeline's bytes: storey/8, glazing, (year-1840)/190, roof", () => {
    expect(facadeBytes({ storeyM: 4, glazing: 0.5, year: 1935, roof: false } as never, false)).toEqual([128, 128, 128, 0]);
    expect(facadeBytes({ storeyM: 3.2, glazing: 0.25, year: null }, true)).toEqual([102, 64, 0, 255]);
    expect(facadeBytes({ storeyM: 20, glazing: 2, year: 2100 }, false)).toEqual([255, 255, 255, 0]);
  });

  it("lays out denser, larger windows as glazing grows", () => {
    const res = facadeGrid(3.3, 0.25);
    const glass = facadeGrid(4, 0.85);
    expect(glass.colW).toBeLessThan(res.colW);
    expect(glass.win[1] - glass.win[0]).toBeGreaterThan(res.win[1] - res.win[0]);
    expect(facadeGrid(6, 0.15).colW).toBe(6);
    expect(facadeGrid(1, 0.5).floorH).toBe(2.6);
    expect(res.shopH).toBe(0);
    expect(facadeGrid(3.9, 0.5).shopH).toBeGreaterThan(3.5);
  });
});

describe("ground", () => {
  it("puts a vertex on every heightfield sample and faces up", () => {
    const heights = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    const mb = new MeshBuilder();
    addHeightfield(mb, { x0: 100, z0: 200, cellSizeM: 10, nx: 3, nz: 3, heights });
    const d = mb.build();
    expect(d.positions.length / 3).toBe(9);
    for (let i = 0; i < 9; i++) {
      expect(d.positions[i * 3]).toBe(100 + (i % 3) * 10);
      expect(d.positions[i * 3 + 2]).toBe(200 + Math.floor(i / 3) * 10);
      expect(d.positions[i * 3 + 1]).toBe(heights[i]);
    }
    for (let t = 0; t < d.indices.length / 3; t++) expect(faceNormal(tri(d, t))[1]).toBeGreaterThan(0);
  });

  it("skips cells entirely under deep water", () => {
    const mb = new MeshBuilder();
    addHeightfield(mb, { x0: 0, z0: 0, cellSizeM: 10, nx: 3, nz: 2, heights: [-5, -5, 1, -5, -5, 1] });
    expect(mb.indexCount).toBe(6); // only the right-hand cell
  });
});

describe("roads", () => {
  const graph: RoadGraph = {
    version: 1,
    nodes: [
      { id: "w", x: -100, z: 0 },
      { id: "c", x: 0, z: 0 },
      { id: "e", x: 100, z: 0 },
      { id: "n", x: 0, z: -100 },
    ],
    edges: [
      { id: "we", a: "w", b: "c", kind: "collector", lanes: 2, oneway: false, widthM: 14, points: [[-100, 0], [0, 0]] },
      { id: "ce", a: "c", b: "e", kind: "collector", lanes: 2, oneway: false, widthM: 14, points: [[0, 0], [100, 0]] },
      { id: "cn", a: "c", b: "n", kind: "residential", lanes: 2, oneway: false, widthM: 10, points: [[0, 0], [0, -100]] },
    ],
  };
  const ground = (x: number): number => x * 0.05 + 3;
  const ctx = { ground, degrees: nodeDegrees(graph), nodeHalfWidth: nodeHalfWidth(graph), nodeOuter: nodeClearance(graph) };

  it("drapes every vertex just above the ground and faces up", () => {
    const mb = new MeshBuilder();
    for (const e of graph.edges) addRoad(mb, e, ctx);
    const d = mb.build();
    expect(d.indices.length).toBeGreaterThan(0);
    for (let i = 0; i < d.positions.length; i += 3) {
      const lift = d.positions[i + 1]! - ground(d.positions[i]!);
      expect(lift).toBeGreaterThan(0.05);
      expect(lift).toBeLessThan(0.3);
    }
    for (let t = 0; t < d.indices.length / 3; t++) expect(faceNormal(tri(d, t))[1]).toBeGreaterThan(0);
  });

  it("keeps markings out of the intersection box", () => {
    const mb = new MeshBuilder();
    addRoad(mb, graph.edges[1]!, ctx);
    const d = mb.build();
    // Marking vertices sit highest; none may lie within the crossing street's half-width of the node.
    for (let i = 0; i < d.positions.length; i += 3) {
      const lift = d.positions[i + 1]! - ground(d.positions[i]!);
      if (lift > 0.23) expect(Math.abs(d.positions[i]!)).toBeGreaterThan(5);
    }
  });
});
