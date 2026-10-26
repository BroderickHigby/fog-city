import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { TrafficSignalControls } from "../../src/sim/traffic-signals.ts";
import type { TileCollider } from "../../src/sim/world.ts";
import { createSharedMaterials } from "../../src/render/materials.ts";
import { supplementalSignals } from "../../src/render/signal-placement.ts";
import { StreetDetailLayer } from "../../src/render/street-detail.ts";
import type { SignalRecord } from "../../src/render/street-furniture.ts";
import type { RoadEdge, RoadGraph } from "../../src/render/types.ts";

function crossing(): RoadGraph {
  const ends = [{ id: "north", x: 0, z: -100 }, { id: "east", x: 100, z: 0 },
    { id: "south", x: 0, z: 100 }, { id: "west", x: -100, z: 0 }];
  return { version: 1, nodes: [{ id: "junction", x: 0, z: 0 }, ...ends], edges: ends.map(n => ({
    id: n.id, a: "junction", b: n.id, kind: "residential", lanes: 2, oneway: false, widthM: 10,
    points: [[0, 0], [n.x, n.z]],
  })) };
}
const controls: TrafficSignalControls = new Map([["junction", { node: "junction", groupCount: 2,
  approaches: new Map([["north", 0], ["south", 0], ["east", 1], ["west", 1]]) }]]);
const ground = () => 3;
function blocked(ring: Array<[number, number]>): Map<string, TileCollider> {
  return new Map([["tile", { tileId: "tile", ground: null,
    buildings: [{ id: "wall", footprint: ring, baseY: 0, topY: 10 }] }]]);
}

describe("supplemental signal placement", () => {
  it("fills absent controlled approaches on their right curb, facing approaching traffic", () => {
    const graph = crossing(), result = supplementalSignals([], { roads: graph, controls, ground });
    expect(result.unplaced).toEqual([]);
    expect(result.signals).toHaveLength(4);
    for (const signal of result.signals) {
      const edge = graph.edges.find(e => signal.id === `sig:junction:${e.id}`)!;
      const [x, z] = edge.points[1]!, length = Math.hypot(x, z), ux = x / length, uz = z / length;
      expect(signal.x * uz - signal.z * ux).toBeGreaterThan(5.35);
      expect(signal.x * ux + signal.z * uz).toBeGreaterThanOrEqual(6);
      expect(Math.sin(signal.heading)).toBeCloseTo(ux);
      expect(-Math.cos(signal.heading)).toBeCloseTo(uz);
      expect(signal.arm).toBe(0); expect(signal.ped).toBeNull();
    }
    expect(result.signals.find(s => s.id.endsWith(":north"))!.group).toBe(result.signals.find(s => s.id.endsWith(":south"))!.group);
  });

  it("preserves existing source records and never creates a duplicate head ID", () => {
    const original: SignalRecord = { id: "sig:junction:north", node: "junction", x: -6, z: -9, heading: 0, group: 0, arm: 0, ped: null };
    const snapshot = JSON.stringify(original);
    Object.freeze(original);
    const first = supplementalSignals([original], { roads: crossing(), controls, ground });
    expect(first.signals).toHaveLength(3);
    expect(first.signals.some(s => s.id === original.id)).toBe(false);
    expect(JSON.stringify(original)).toBe(snapshot);
    expect(supplementalSignals([original, ...first.signals], { roads: crossing(), controls, ground })).toEqual({ signals: [], unplaced: [] });
  });

  it("moves farther along the same approach to avoid a building, without moving into a lane", () => {
    const colliders = blocked([[-9, -19], [-5, -19], [-5, -4], [-9, -4]]);
    const result = supplementalSignals([], { roads: crossing(), controls, ground, colliders });
    const north = result.signals.find(s => s.id.endsWith(":north"))!;
    expect(north.z).toBeLessThan(-19.35);
    expect(north.x).toBeLessThan(-5.35);
    expect(result.unplaced).toEqual([]);
  });

  it("reports a blocked approach and never plants poles in water or invalid ground", () => {
    const colliders = blocked([[-10, -60], [-4, -60], [-4, 0], [-10, 0]]);
    const blockedResult = supplementalSignals([], { roads: crossing(), controls, ground, colliders });
    expect(blockedResult.signals.some(s => s.id.endsWith(":north"))).toBe(false);
    expect(blockedResult.unplaced).toContainEqual(expect.objectContaining({ node: "junction", edge: "north", reason: "no-safe-position" }));
    for (const height of [0, -1, NaN, Infinity]) {
      const result = supplementalSignals([], { roads: crossing(), controls, ground: () => height });
      expect(result.signals).toHaveLength(0); expect(result.unplaced).toHaveLength(4);
    }
  });

  it("skips freeways, malformed roads and outgoing one-way approaches", () => {
    for (const change of [{ kind: "freeway" }, { kind: "ramp" }, { oneway: true }, { points: [[0, 0], [NaN, -100]] },
      { points: [[20, 20], [0, -100]] }, { points: [[0, 0], [0, 0]] }]) {
      const graph = crossing(); graph.edges[0] = { ...graph.edges[0]!, ...change } as RoadEdge;
      const result = supplementalSignals([], { roads: graph, controls, ground });
      expect(result.signals.some(s => s.id.endsWith(":north"))).toBe(false);
      expect(result.unplaced).toContainEqual(expect.objectContaining({ edge: "north", reason: "unsupported-approach" }));
    }
  });

  it("handles an incoming one-way polyline and retains supplied objects", () => {
    const graph = crossing();
    graph.edges[0] = { ...graph.edges[0]!, a: "north", b: "junction", oneway: true, points: [[0, -100], [0, -12], [0, 0]] };
    const before = JSON.stringify(graph);
    expect(supplementalSignals([], { roads: graph, controls, ground }).signals.some(s => s.id.endsWith(":north"))).toBe(true);
    expect(JSON.stringify(graph)).toBe(before);
  });

  it("still shows valid controller heads when the street-detail index is unavailable", async () => {
    const materials = createSharedMaterials();
    const detail = new StreetDetailLayer({ base: "/missing/", json: async () => { throw new Error("absent fixture"); },
      roads: crossing(), signals: controls, ground, materials });
    try {
      await detail.load();
      for (let i = 0; i < 8; i++) detail.update(0, 0, i);
      expect(detail.info().signals).toBe(4);
      expect(detail.info().layers).toContain("furniture");
    } finally {
      detail.dispose();
      for (const material of Object.values(materials)) if (material instanceof THREE.Material) material.dispose();
    }
  });
});
