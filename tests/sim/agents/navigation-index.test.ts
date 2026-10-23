import { describe, expect, it } from "vitest";
import { buildSidewalkGraph } from "../../../src/sim/agents/navigation.ts";
import type { SidewalkGraph, SidewalkNode } from "../../../src/sim/agents/navigation.ts";
import { nearestSidewalkNode, sidewalkNodesWithin } from "../../../src/sim/agents/navigation-index.ts";

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const distance = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);
function graph(nodes: SidewalkNode[]): SidewalkGraph { return buildSidewalkGraph({ nodes, edges: [] }); }
function exhaustive(g: SidewalkGraph, point: { x: number; z: number }): SidewalkNode[] {
  return [...g.nodes].sort((a, b) => distance(a, point) - distance(b, point) || compare(a.id, b.id));
}
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
}
function expectQueries(g: SidewalkGraph, point: { x: number; z: number }, radius: number): void {
  const ordered = exhaustive(g, point);
  expect(nearestSidewalkNode(g, point)).toBe(ordered[0] ?? null);
  expect(sidewalkNodesWithin(g, point, radius)).toEqual(ordered.filter((node) => distance(node, point) <= radius));
}

describe("immutable sidewalk spatial index", () => {
  it("returns null/empty for an empty graph and original references for a singleton", () => {
    const empty = graph([]);
    expect(nearestSidewalkNode(empty, { x: -10, z: 20 })).toBeNull();
    expect(sidewalkNodesWithin(empty, { x: -10, z: 20 }, 10)).toEqual([]);
    const single = graph([{ id: "only", x: 3, z: 4 }]);
    expect(nearestSidewalkNode(single, { x: 0, z: 0 })).toBe(single.nodes[0]);
    expect(sidewalkNodesWithin(single, { x: 0, z: 0 }, 5)).toEqual(single.nodes);
    expect(sidewalkNodesWithin(single, { x: 0, z: 0 }, 4.999)).toEqual([]);
  });

  it("matches exhaustive scans across seeded grids, jitter, negative seams, and out-of-bounds queries", () => {
    for (const scale of [1, 17, 10000]) {
      const rng = random(0xc0ffee + scale), nodes: SidewalkNode[] = [];
      for (let x = -12; x <= 12; x++) for (let z = -9; z <= 9; z++) {
        nodes.push({ id: `${x}:${z}`, x: x * scale + rng() * scale * 0.1, z: z * scale + rng() * scale * 0.1 });
      }
      const g = graph(nodes), snapshot = JSON.stringify(g.nodes);
      for (let query = 0; query < 120; query++) {
        const point = { x: (rng() * 60 - 30) * scale, z: (rng() * 60 - 30) * scale };
        expectQueries(g, point, rng() * scale * 30);
      }
      for (const point of [{ x: -scale, z: 0 }, { x: 0, z: -scale }, { x: 1e7, z: -1e7 }, { x: -1e7, z: 1e7 }]) expectQueries(g, point, scale * 20);
      expect(JSON.stringify(g.nodes)).toBe(snapshot);
    }
  });

  it("preserves deterministic IDs for equal distances and duplicate coordinates regardless of input order", () => {
    const nodes = [{ id: "z", x: -1, z: 0 }, { id: "a", x: 1, z: 0 }, { id: "m", x: 0, z: -1 }, { id: "b", x: 0, z: 1 },
      { id: "same-z", x: 10, z: 10 }, { id: "same-a", x: 10, z: 10 }];
    for (const input of [nodes, [...nodes].reverse(), [...nodes.slice(2), ...nodes.slice(0, 2)]]) {
      const g = graph(input);
      expect(nearestSidewalkNode(g, { x: 0, z: 0 })!.id).toBe("a");
      expect(sidewalkNodesWithin(g, { x: 0, z: 0 }, 1).map((node) => node.id)).toEqual(["a", "b", "m", "z"]);
      expect(nearestSidewalkNode(g, { x: 10, z: 10 })!.id).toBe("same-a");
      expect(sidewalkNodesWithin(g, { x: 10, z: 10 }, 0).map((node) => node.id)).toEqual(["same-a", "same-z"]);
    }
  });

  it("keeps sqrt-rounded metre ties and inclusive boundaries from the original exhaustive policy", () => {
    // These squared distances differ, but both square roots round to one metre.
    const g = graph([{ id: "z-closer", x: 1, z: 0 }, { id: "a-rounded", x: 1, z: 2 ** -26 }]);
    expect(distance(g.nodes[0]!, { x: 0, z: 0 })).toBe(1);
    expect(nearestSidewalkNode(g, { x: 0, z: 0 })!.id).toBe("a-rounded");
    expect(sidewalkNodesWithin(g, { x: 0, z: 0 }, 1).map((node) => node.id)).toEqual(["a-rounded", "z-closer"]);
  });

  it("matches exhaustive scans for large coordinates and nearly coincident points around ten million metres", () => {
    const rng = random(17), nodes: SidewalkNode[] = [];
    for (let i = 0; i < 400; i++) nodes.push({ id: String(i).padStart(4, "0"), x: 1e7 + (rng() - 0.5) * 0.001, z: -1e7 + (rng() - 0.5) * 0.001 });
    const g = graph(nodes);
    for (let i = 0; i < 80; i++) expectQueries(g, { x: 1e7 + (rng() - 0.5) * 0.002, z: -1e7 + (rng() - 0.5) * 0.002 }, rng() * 0.001);
  });

  it("preserves exhaustive Infinity-score ID ties for finite extreme coordinates", () => {
    const g = graph([{ id: "z", x: -1e300, z: 1e300 }, { id: "a", x: 1e300, z: -1e300 }, { id: "m", x: 1e299, z: 1e299 }]);
    expectQueries(g, { x: 0, z: 0 }, 1e300);
    expect(nearestSidewalkNode(g, { x: -1e300, z: 1e300 })!.id).toBe("z");
    const tiny = graph([{ id: "z", x: 1e-200, z: 0 }, { id: "a", x: -2e-200, z: 0 }]);
    expectQueries(tiny, { x: 0, z: 0 }, 0);
    expect(nearestSidewalkNode(tiny, { x: 0, z: 0 })!.id).toBe("a");
  });

  it("uses each graph's geometry independently and does not mutate frozen node arrays", () => {
    const a = graph([{ id: "left", x: -2, z: 0 }, { id: "right", x: 2, z: 0 }]);
    const b = graph([{ id: "left", x: 2, z: 0 }, { id: "right", x: -2, z: 0 }]);
    Object.freeze(a.nodes); a.nodes.forEach(Object.freeze);
    expect(nearestSidewalkNode(a, { x: -1, z: 0 })!.id).toBe("left");
    expect(nearestSidewalkNode(b, { x: -1, z: 0 })!.id).toBe("right");
    const result = sidewalkNodesWithin(a, { x: 0, z: 0 }, 2); result.pop();
    expect(sidewalkNodesWithin(a, { x: 0, z: 0 }, 2)).toHaveLength(2);
  });

  it("builds the graph index once and reuses it for nearest and radius queries", () => {
    const original = graph([{ id: "a", x: -1, z: 0 }, { id: "b", x: 1, z: 0 }]);
    let reads = 0;
    const observed: SidewalkGraph = { ...original, get nodes() { reads++; return original.nodes; } };
    expect(nearestSidewalkNode(observed, { x: 0, z: 0 })!.id).toBe("a");
    const firstReads = reads;
    expect(firstReads).toBeGreaterThan(0);
    for (let i = 0; i < 20; i++) {
      nearestSidewalkNode(observed, { x: i, z: 0 });
      sidewalkNodesWithin(observed, { x: i, z: 0 }, 2);
    }
    expect(reads).toBe(firstReads);
  });

  it("rejects non-finite points, radii, and graph geometry", () => {
    const g = graph([{ id: "a", x: 0, z: 0 }]);
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(() => nearestSidewalkNode(g, { x: value, z: 0 })).toThrow(RangeError);
      expect(() => sidewalkNodesWithin(g, { x: 0, z: value }, 1)).toThrow(RangeError);
      expect(() => sidewalkNodesWithin(g, { x: 0, z: 0 }, value)).toThrow(RangeError);
    }
    expect(() => sidewalkNodesWithin(g, { x: 0, z: 0 }, -1)).toThrow(RangeError);
    const invalid = { ...g, nodes: [{ id: "bad", x: NaN, z: 0 }] };
    expect(() => nearestSidewalkNode(invalid, { x: 0, z: 0 })).toThrow(RangeError);
  });
});
