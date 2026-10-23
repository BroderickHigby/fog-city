import { describe, expect, it } from "vitest";
import { buildRoadGraph } from "../../../src/sim/roads.ts";
import type { RoadsFile } from "../../../src/sim/roads.ts";
import {
  advanceSidewalkRoute, buildFallbackSidewalkGraph, buildSidewalkGraph, shortestSidewalkRoute,
} from "../../../src/sim/agents/navigation.ts";
import type { SidewalkGraphInput } from "../../../src/sim/agents/navigation.ts";

const diamond: SidewalkGraphInput = {
  nodes: [{ id: "start", x: 0, z: 0 }, { id: "a", x: 10, z: -10 },
    { id: "b", x: 10, z: 10 }, { id: "end", x: 20, z: 0 }],
  edges: [
    { id: "a1", a: "start", b: "a", points: [[0, 0], [10, -10]], kind: "sidewalk" },
    { id: "a2", a: "a", b: "end", points: [[10, -10], [20, 0]], kind: "crosswalk" },
    { id: "b1", a: "start", b: "b", points: [[0, 0], [10, 10]], kind: "sidewalk" },
    { id: "b2", a: "b", b: "end", points: [[10, 10], [20, 0]], kind: "sidewalk" },
  ],
};

function crossRoads(): RoadsFile {
  return { version: 1,
    nodes: [{ id: "c", x: 0, z: 0 }, { id: "n", x: 0, z: -100 }, { id: "s", x: 0, z: 100 },
      { id: "e", x: 100, z: 0 }, { id: "w", x: -100, z: 0 }, { id: "f", x: 200, z: 0 },
      { id: "r", x: 100, z: 100 }, { id: "g", x: 100, z: -100 }],
    edges: [
      { id: "north", a: "c", b: "n", points: [[0, 0], [0, -100]], kind: "residential", lanes: 2, oneway: false },
      { id: "south", a: "c", b: "s", points: [[0, 0], [0, 100]], kind: "residential", lanes: 2, oneway: true },
      { id: "east", a: "c", b: "e", points: [[0, 0], [100, 0]], kind: "residential", lanes: 2, oneway: false },
      { id: "west", a: "c", b: "w", points: [[0, 0], [-100, 0]], kind: "residential", lanes: 2, oneway: false },
      { id: "freeway", a: "e", b: "f", points: [[100, 0], [200, 0]], kind: "freeway", lanes: 2, oneway: false },
      { id: "ramp", a: "e", b: "r", points: [[100, 0], [100, 100]], kind: "ramp", lanes: 2, oneway: false },
      { id: "deck", a: "e", b: "g", points: [[100, 0], [100, -100]], kind: "residential", lanes: 2, oneway: false, gradeSeparated: true },
    ],
  };
}

describe("sidewalk navigation policy", () => {
  it("chooses shortest paths with stable ties despite node and edge insertion order", () => {
    const before = JSON.stringify(diamond);
    const first = shortestSidewalkRoute(buildSidewalkGraph(diamond), "start", "end")!;
    const reordered = buildSidewalkGraph({ nodes: [...diamond.nodes].reverse(), edges: [...diamond.edges].reverse() });
    expect(shortestSidewalkRoute(reordered, "start", "end")).toEqual(first);
    expect(first.steps.map((step) => step.edgeId)).toEqual(["a1", "a2"]);
    expect(first.lengthM).toBeCloseTo(2 * Math.sqrt(200));
    expect(JSON.stringify(diamond)).toBe(before);
  });

  it("replans around blocked crossings and respects directed explicit edges", () => {
    const graph = buildSidewalkGraph(diamond);
    expect(shortestSidewalkRoute(graph, "start", "end", (edge) => edge.kind === "crosswalk")!
      .steps.map((step) => step.edgeId)).toEqual(["b1", "b2"]);
    expect(shortestSidewalkRoute(graph, "start", "end", () => true)).toBeNull();
    const directed = buildSidewalkGraph({ nodes: diamond.nodes, edges: diamond.edges.map((edge) => ({ ...edge, bidirectional: false })) });
    expect(shortestSidewalkRoute(directed, "end", "start")).toBeNull();
    expect(shortestSidewalkRoute(graph, "missing", "end")).toBeNull();
  });

  it("excludes freeway, ramp, and grade-separated explicit edges", () => {
    const graph = buildSidewalkGraph({ ...diamond, edges: [
      { ...diamond.edges[0]!, id: "freeway", kind: "freeway" },
      { ...diamond.edges[1]!, id: "ramp", kind: "ramp" },
      { ...diamond.edges[2]!, id: "deck", gradeSeparated: true },
    ] });
    expect(graph.edges).toEqual([]);
  });

  it("rejects path endpoints that would teleport between graph nodes", () => {
    expect(() => buildSidewalkGraph({ ...diamond, edges: [{ ...diamond.edges[0]!, points: [[8, 8], [10, -10]] }] }))
      .toThrow("Invalid sidewalk edge");
  });

  it("reuses cleared road geometry and keeps all intersection sides reachable", () => {
    const roads = buildRoadGraph(crossRoads());
    const graph = buildFallbackSidewalkGraph(roads);
    expect(graph.edges.filter((edge) => edge.roadId).map((edge) => edge.roadId)).not.toContain("freeway");
    expect(graph.edges.some((edge) => edge.roadId === "ramp" || edge.roadId === "deck")).toBe(false);
    const source = roads.edges.find((edge) => edge.id === "north")!.walkPaths[0][0];
    const reused = graph.edges.find((edge) => edge.id === JSON.stringify(["walk", "north", 0]))!.path;
    expect(reused).toEqual(source);
    expect(graph.edges.some((edge) => edge.kind === "crosswalk")).toBe(true);
    for (const node of graph.nodes) expect(shortestSidewalkRoute(graph, graph.nodes[0]!.id, node.id)).not.toBeNull();
    // One-way vehicle roads still have walking routes in both directions.
    const south = graph.edges.find((edge) => edge.roadId === "south")!;
    expect(shortestSidewalkRoute(graph, south.b, south.a)!.steps[0]!.reverse).toBe(true);
  });

  it("fallback graph and routes are stable after input permutation", () => {
    const roads = crossRoads();
    const first = buildFallbackSidewalkGraph(roads);
    const second = buildFallbackSidewalkGraph({ ...roads, nodes: [...roads.nodes].reverse(), edges: [...roads.edges].reverse() });
    expect(second.nodes).toEqual(first.nodes);
    expect(second.edges).toEqual(first.edges);
    expect(shortestSidewalkRoute(second, second.nodes[0]!.id, second.nodes[second.nodes.length - 1]!.id))
      .toEqual(shortestSidewalkRoute(first, first.nodes[0]!.id, first.nodes[first.nodes.length - 1]!.id));
  });

  it("keeps corner topology when blocked mid-block sidewalks are omitted", () => {
    const roads = buildRoadGraph(crossRoads());
    for (const [id, side] of [["north", 0], ["east", 1], ["south", 0], ["west", 1]] as const) {
      const road = roads.edges.find((edge) => edge.id === id)!;
      road.walkClear[0][side] = false;
      road.walkClear[1][side] = false;
    }
    const graph = buildFallbackSidewalkGraph(roads);
    expect(graph.edges.filter((edge) => edge.roadId)).toHaveLength(4);
    for (const node of graph.nodes) expect(shortestSidewalkRoute(graph, graph.nodes[0]!.id, node.id)).not.toBeNull();
  });

  it("classifies the short connector across every oriented dead end as a crosswalk", () => {
    for (const [x, z] of [[0, 100], [0, -100], [100, 0], [-100, 0]]) {
      const graph = buildFallbackSidewalkGraph({ version: 1, nodes: [{ id: "a", x: 0, z: 0 }, { id: "b", x: x!, z: z! }],
        edges: [{ id: "road", a: "a", b: "b", kind: "residential", lanes: 2, oneway: false, points: [[0, 0], [x!, z!]] }] });
      const joins = graph.edges.filter((edge) => edge.roadId === null);
      expect(joins).toHaveLength(2);
      expect(joins.every((edge) => edge.kind === "crosswalk")).toBe(true);
    }
  });

  it("advances continuously through corners, stops before blocked edges, and travels in reverse", () => {
    const graph = buildSidewalkGraph({ nodes: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 10, z: 0 }, { id: "c", x: 10, z: 10 }],
      edges: [{ id: "ab", a: "a", b: "b", kind: "sidewalk", points: [[0, 0], [10, 0]] },
        { id: "bc", a: "b", b: "c", kind: "crosswalk", points: [[10, 0], [10, 10]] }] });
    const route = shortestSidewalkRoute(graph, "a", "c")!;
    const cursor = { stepIndex: 0, distanceM: 0 };
    expect(advanceSidewalkRoute(graph, route, cursor, 15).point).toEqual({ x: 10, z: 5 });
    const stopped = advanceSidewalkRoute(graph, route, cursor, 15, (edge) => edge.id === "bc");
    expect(stopped.point).toEqual({ x: 10, z: 0 });
    expect(stopped.movedM).toBe(10);
    expect(stopped.blockedEdgeId).toBe("bc");
    expect(advanceSidewalkRoute(graph, shortestSidewalkRoute(graph, "c", "a")!, cursor, 15).point).toEqual({ x: 5, z: 0 });
    expect(advanceSidewalkRoute(graph, route, cursor, 30)).toMatchObject({ movedM: 20, finished: true, point: { x: 10, z: 10 } });
    expect(cursor).toEqual({ stepIndex: 0, distanceM: 0 });
  });
});
