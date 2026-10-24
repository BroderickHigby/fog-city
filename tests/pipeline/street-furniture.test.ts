// Signal poles and stop signs (pipeline/lib/street-furniture.ts): on the near-right corner of
// each controlled approach, facing the approaching traffic, off the carriageway. Synthetic
// junctions plus the committed sf output around Chestnut St. No network.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bearing, type P2 } from "../../pipeline/lib/geom.ts";
import type { RoadEdge, RoadGraph } from "../../pipeline/lib/roads.ts";
import { buildFurniture, POLE_OFFSET_M, type SignalPole, type StopSign } from "../../pipeline/lib/street-furniture.ts";
import { buildMarkings, insideRibbon } from "../../pipeline/lib/street-markings.ts";
import { signalState } from "../../src/render/street-furniture.ts";
import { ROOT } from "../helpers.ts";

const edge = (id: string, a: string, b: string, points: P2[], oneway = false, widthM = 11): RoadEdge => ({
  id, a, b, kind: "residential", lanes: 2, oneway, widthM, speedLimitMps: 11, name: "Test St", points, cnn: id.slice(1), classcode: 5,
});

function plus(): RoadGraph {
  return {
    version: 1,
    attribution: "",
    nodes: [
      { id: "n0", x: 0, z: 0, y: 0 },
      { id: "nN", x: 0, z: -100, y: 0 },
      { id: "nE", x: 100, z: 0, y: 0 },
      { id: "nS", x: 0, z: 100, y: 0 },
      { id: "nW", x: -100, z: 0, y: 0 },
    ],
    edges: [
      edge("c1", "n0", "nN", [[0, 0], [0, -100]], true), // one-way away from the node
      edge("c2", "n0", "nE", [[0, 0], [100, 0]], false, 16),
      edge("c3", "nS", "n0", [[0, 100], [0, 0]]),
      edge("c4", "n0", "nW", [[0, 0], [-100, 0]]),
    ],
  };
}

describe("signals and stop signs at a + crossing", () => {
  const g = plus();
  const facts = { continental: new Set(["n0"]), signals: new Set(["n0"]), stopApproaches: new Set<string>() };
  const { junctions } = buildMarkings(g, facts, () => 0);

  it("puts one pole per approach (none on the one-way leaving), facing the traffic, on its near-right corner", () => {
    const f = buildFurniture(g, junctions, new Map([["n0", { ped: true }]]), new Set());
    expect(f.signals.map((s) => s.id).sort()).toEqual(["sig:n0:c2", "sig:n0:c3", "sig:n0:c4"]);
    const south = f.signals.find((s) => s.id === "sig:n0:c3")!;
    // The south leg's traffic drives north: the head faces south (bearing π), on the east kerb.
    expect(south.heading).toBeCloseTo(Math.PI, 3);
    expect(south.x).toBeCloseTo(5.5 + POLE_OFFSET_M, 6);
    expect(south.z).toBeGreaterThan(5.5);
    // Opposite approaches share a phase group; crossing ones do not.
    const east = f.signals.find((s) => s.id === "sig:n0:c2")!, west = f.signals.find((s) => s.id === "sig:n0:c4")!;
    expect(east.group).toBe(west.group);
    expect(east.group).not.toBe(south.group);
    // Only the wide street gets a mast arm; every pole has a pedestrian head.
    expect(east.arm).toBeGreaterThan(0);
    expect(south.arm).toBe(0);
    for (const s of f.signals) expect(s.ped).not.toBeNull();
  });

  it("marks an all-way stop when every approach has a sign", () => {
    const stops = new Set(["n0|c2", "n0|c3", "n0|c4"]);
    const j = buildMarkings(g, { ...facts, signals: new Set(), stopApproaches: stops }, () => 0).junctions;
    const f = buildFurniture(g, j, new Map(), stops);
    expect(f.stopSigns).toHaveLength(3);
    expect(f.stopSigns.every((s) => s.allWay)).toBe(true);
    const two = buildFurniture(g, j, new Map(), new Set(["n0|c3"]));
    expect(two.stopSigns.map((s) => [s.id, s.allWay])).toEqual([["stop:n0:c3", false]]);
  });
});

describe("signal lamps (render-side plan)", () => {
  it("never shows green on both axes, and cycles every 60 s", () => {
    for (let tick = 0; tick < 60 * 60; tick += 7) {
      const a = signalState("n123", 0, tick).aspect, b = signalState("n123", 1, tick).aspect;
      expect(a === "green" && b === "green").toBe(false);
      expect(signalState("n123", 0, tick + 3600).aspect).toBe(a);
    }
    // People cross a leg only while its traffic is red.
    for (let tick = 0; tick < 3600; tick += 11) {
      const s = signalState("n9", 0, tick);
      if (s.walk) expect(s.aspect).toBe("red");
    }
  });
});

describe("sf signals and stop signs around Chestnut St", () => {
  const dir = join(ROOT, "public/tiles/sf");
  const doc = JSON.parse(readFileSync(join(dir, "street-furniture.json"), "utf8")) as { signals: SignalPole[]; stopSigns: StopSign[] };
  const roads = JSON.parse(readFileSync(join(dir, "roads.json"), "utf8")) as RoadGraph;
  const chestnut = new Set(roads.edges.filter((e) => e.name === "Chestnut St").flatMap((e) => [e.a, e.b]));
  const near = roads.edges.filter((e) => chestnut.has(e.a) || chestnut.has(e.b));

  it("signalises Chestnut & Fillmore and stop-controls Chestnut & Scott, all way", () => {
    expect(doc.signals.filter((s) => s.node === "n26763000").length).toBeGreaterThanOrEqual(3);
    const scott = doc.stopSigns.filter((s) => s.node === "n26972000");
    expect(scott).toHaveLength(4);
    expect(scott.every((s) => s.allWay)).toBe(true);
  });

  it("stands every pole and post off the carriageway of every street there", () => {
    const items = [...doc.signals, ...doc.stopSigns].filter((s) => chestnut.has(s.node));
    expect(items.length).toBeGreaterThan(40);
    for (const s of items) {
      for (const e of near) expect(insideRibbon(s.x, s.z, e.points, e.widthM / 2), `${s.id} on ${e.id}`).toBe(false);
      expect(s.heading).toBeGreaterThanOrEqual(0);
      expect(s.heading).toBeLessThan(2 * Math.PI);
    }
  });

  it("faces each sign toward the traffic it controls (along its leg, away from the node)", () => {
    const nodes = new Map(roads.nodes.map((n) => [n.id, n]));
    for (const s of doc.stopSigns.filter((x) => chestnut.has(x.node))) {
      const n = nodes.get(s.node)!;
      const toSign = bearing(s.x - n.x, s.z - n.z);
      let d = Math.abs(toSign - s.heading) % (2 * Math.PI);
      if (d > Math.PI) d = 2 * Math.PI - d;
      // The sign stands out along its leg, a little to the side: within 60° of its facing.
      expect(d, s.id).toBeLessThan(Math.PI / 3);
    }
  });
});
