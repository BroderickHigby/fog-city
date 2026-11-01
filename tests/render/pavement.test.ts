import { describe, expect, it } from "vitest";
import { createPavementMask } from "../../src/render/pavement.ts";
import type { RoadGraph } from "../../src/render/types.ts";
import type { TileCollider } from "../../src/sim/world.ts";

type Point = [number, number];
function road(points: Point[], widthM = 10): RoadGraph {
  return { version: 1, nodes: [{ id: "a", x: points[0]![0], z: points[0]![1] }, { id: "b", x: points.at(-1)![0], z: points.at(-1)![1] }],
    edges: [{ id: "road", a: "a", b: "b", kind: "residential", lanes: 2, oneway: false, widthM, points }] };
}

describe("pavement exclusion", () => {
  it("bounds large region indexing and exposes exact candidate footprints",()=>{
    const mask=createPavementMask(null,undefined,[[-1e8,-1e8,1e8,1e8]]);
    mask.addPolygon([[0,0],[10,0],[10,10],[0,10]]);
    expect(mask.contains(5,5)).toBe(true);expect(mask.polygonsIn([2,2,3,3])).toHaveLength(1);
    expect(mask.polygonsIn([200,200,210,210])).toHaveLength(0);
  });
  it("covers the road, sidewalks and padded end caps without masking nearby open land", () => {
    const mask = createPavementMask(road([[0, 0], [0, 30]]));
    expect(mask.contains(0, 15)).toBe(true);
    expect(mask.contains(8.25, 15)).toBe(true);
    expect(mask.contains(8.25, -8.25)).toBe(true);
    expect(mask.contains(8.3, 15)).toBe(false);
    expect(mask.contains(0, -8.3)).toBe(false);
  });

  it("covers curved segments, crossing streets and conservative junction corners", () => {
    const graph = road([[0, -40], [0, 0], [40, 0]]);
    graph.edges.push({ ...graph.edges[0]!, id: "cross", a: "b", b: "c", points: [[40, 0], [40, 40]] });
    graph.nodes.push({ id: "c", x: 40, z: 40 });
    const mask = createPavementMask(graph);
    expect(mask.contains(0, -30)).toBe(true);
    expect(mask.contains(30, 0)).toBe(true);
    expect(mask.contains(40, 30)).toBe(true);
    expect(mask.contains(54, 14)).toBe(true);
    expect(mask.contains(60, 20)).toBe(false);
  });

  it("detects a narrow crossing even when every triangle vertex is outside pavement", () => {
    const mask = createPavementMask(road([[0, -100], [0, 100]], 1));
    for (const p of [[-20, -10], [20, -10], [20, 10]] as Point[]) expect(mask.contains(...p)).toBe(false);
    expect(mask.intersectsTriangle([-20, -10], [20, -10], [20, 10])).toBe(true);
    expect(mask.intersectsTriangle([20, 20], [30, 20], [20, 30])).toBe(false);
  });

  it("handles concave buildings without filling their open courtyard", () => {
    const footprint: Point[] = [[0, 0], [10, 0], [10, 3], [3, 3], [3, 10], [0, 10]];
    const tile: TileCollider = { tileId: "building", ground: null, buildings: [{ id: "L", baseY: 0, topY: 10, footprint }] };
    const mask = createPavementMask(null, new Map([[tile.tileId, tile]]));
    expect(mask.contains(1, 8)).toBe(true);
    expect(mask.contains(8, 1)).toBe(true);
    expect(mask.contains(8, 8)).toBe(false);
    expect(mask.intersectsTriangle([5, 5], [8, 5], [5, 8])).toBe(false);
    expect(mask.intersectsTriangle([-1, -1], [20, -1], [-1, 20])).toBe(true);
    expect(mask.intersectsTriangle([2, 4], [4, 2], [4, 4])).toBe(true);
  });

  it("includes boundary and collinear contact, including at spatial-cell borders", () => {
    const mask = createPavementMask(null);
    mask.addPolygon([[100, 100], [110, 100], [110, 110], [100, 110]]);
    expect(mask.contains(100, 105)).toBe(true);
    expect(mask.intersectsTriangle([90, 100], [100, 100], [90, 90])).toBe(true);
    expect(mask.intersectsTriangle([90, 100], [110, 100], [90, 90])).toBe(true);
    expect(mask.intersectsTriangle([100, 105], [100, 105], [100, 105])).toBe(true);
    expect(mask.intersectsTriangle([90, 90], [90, 90], [90, 90])).toBe(false);
  });

  it("works without roads and snapshots polygons added after creation", () => {
    const mask = createPavementMask(undefined);
    expect(mask.contains(0, 0)).toBe(false);
    expect(mask.intersectsTriangle([0, 0], [1, 0], [0, 1])).toBe(false);
    const points: Point[] = [[0, 0], [3, 0], [3, 3], [0, 3], [0, 0]];
    mask.addPolygon(points); points[0]![0] = 999;
    expect(mask.contains(1, 1)).toBe(true);
    expect(mask.intersectsTriangle([-1, 1], [1, -1], [-1, -1])).toBe(true);
  });

  it("bounds malformed input and large indexing while keeping valid large masks correct", () => {
    const mask = createPavementMask(null);
    mask.addPolygon([[NaN, 0], [1, 0], [0, 1]]);
    mask.addPolygon([[0, 0], [1, 1], [2, 2]]);
    expect(mask.contains(0, 0)).toBe(false);
    expect(mask.contains(Infinity, 0)).toBe(false);
    expect(mask.intersectsTriangle([NaN, 0], [0, 0], [1, 1])).toBe(false);
    mask.addPolygon([[-9000, -9000], [9000, -9000], [9000, 9000], [-9000, 9000]]);
    expect(mask.contains(8000, 8000)).toBe(true);
    expect(mask.intersectsTriangle([-9500, -9500], [9500, -9500], [0, 9500])).toBe(true);
    expect(mask.contains(10000, 10000)).toBe(false);
  });

  it("does not invent junction pavement from invalid or zero-length road records", () => {
    const graph = road([[0, 0], [0, 0]]);
    graph.edges.push({ ...graph.edges[0]!, id: "invalid", points: [[NaN, 0], [10, 0]] });
    const mask = createPavementMask(graph);
    expect(mask.contains(0, 0)).toBe(false);
    expect(mask.intersectsTriangle([0, 0], [1, 0], [0, 1])).toBe(false);
  });

  it("stores only polygons overlapping supplied regions, including polygons added later", () => {
    const graph = road([[0, -20], [0, 20]]);
    graph.edges.push({ ...graph.edges[0]!, id: "remote", points: [[1000, -20], [1000, 20]] });
    const footprint: Point[] = [[900, 900], [910, 900], [910, 910], [900, 910]];
    const tile: TileCollider = { tileId: "remote", ground: null, buildings: [{ id: "B", baseY: 0, topY: 10, footprint }] };
    const regions: Array<[number, number, number, number]> = [[-10, -10, 10, 10]];
    const mask = createPavementMask(graph, new Map([[tile.tileId, tile]]), regions);
    regions[0]![0] = 2000;
    expect(mask.contains(0, 0)).toBe(true);
    expect(mask.contains(1000, 0)).toBe(false);
    expect(mask.contains(905, 905)).toBe(false);
    mask.addPolygon([[2, 2], [4, 2], [4, 4], [2, 4]]);
    mask.addPolygon([[2000, 2000], [2010, 2000], [2010, 2010], [2000, 2010]]);
    expect(mask.contains(3, 3)).toBe(true);
    expect(mask.contains(2005, 2005)).toBe(false);
    const empty = createPavementMask(graph, undefined, []);
    empty.addPolygon([[-2, -2], [2, -2], [2, 2], [-2, 2]]);
    expect(empty.contains(0, 0)).toBe(false);
    expect(empty.intersectsTriangle([-20, -20], [20, -20], [0, 20])).toBe(false);
  });
});
