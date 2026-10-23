import { describe, expect, it } from "vitest";
import type { Building } from "../../pipeline/lib/buildings.ts";
import { clearCorridors, UNDER_CLEAR_M } from "../../pipeline/lib/clearance.ts";
import { pointInRing, signedArea } from "../../pipeline/lib/geom.ts";
import type { RoadGraph } from "../../pipeline/lib/roads.ts";
import { Ground } from "../../pipeline/lib/terrain.ts";

const ground = new Ground([{
  ix: 0, iz: 0,
  field: { x0: 0, z0: 0, cellSizeM: 10, nx: 51, nz: 51, heights: Array(2601).fill(0), water: Array(2601).fill(0) },
}]);

function footprint(id: string, z: number): Building {
  return {
    id, tile: "0_0", baseY: 0, topY: 12,
    footprint: [[40, z], [40, z + 40], [100, z + 40], [100, z]],
    meta: { footY: -0.05, heightM: 12, heightSource: "lidar", lidarM: [12, 12] },
  };
}

function roads(): RoadGraph {
  return {
    version: 1, attribution: "synthetic test", nodes: [],
    edges: [60, 160].map((z, i) => ({
      id: `road-${i}`, cnn: String(i), a: `a${i}`, b: `b${i}`, kind: "residential",
      lanes: 2, oneway: false, widthM: 8, speedLimitMps: 10, name: "Recently edited street",
      points: [[20, z], [120, z]], classcode: 4,
    })),
  };
}

const dates = [0, 1].map((i) => ({ cnn: String(i), date_altered: "2025-01-01" }));

describe("verified landmark preservation during corridor clearance", () => {
  it("retains an existing landmark with no assessor year, clears its road, and still drops unverified stale footprints", () => {
    const buildings = [footprint("landmark", 40), footprint("redeveloped", 140)];
    const original = clearCorridors(buildings, roads(), dates, ground);
    expect(original.stats.staleDropped).toEqual(["landmark", "redeveloped"]);

    const graph = roads();
    const options = { preserveExisting: new Set(["landmark"]), keepCentreline: new Set(graph.edges.map((e) => e.id)) };
    const result = clearCorridors(buildings, graph, dates, ground, options);
    expect(result.stats.staleDropped).toEqual(["redeveloped"]);
    expect(result.buildings.length).toBeGreaterThan(0);
    expect(result.buildings.every((b) => b.id === "landmark" || b.meta.pieceOf === "landmark")).toBe(true);
    // Exemption only affects stale inference: preserve usable area while leaving the road open.
    expect(result.buildings.reduce((area, b) => area + Math.abs(signedArea(b.footprint)), 0)).toBeGreaterThan(2000);
    for (let x = 20; x <= 120; x++) {
      for (const b of result.buildings) {
        if (pointInRing(x, 60, b.footprint)) expect(b.underY, b.id).toBeGreaterThanOrEqual(UNDER_CLEAR_M);
      }
    }
    expect(result.stats.spans.length).toBeGreaterThan(0);
    // The second pass runs after terracing and sees derived ids instead of the source record.
    const repeated = clearCorridors(result.buildings, graph, dates, ground, options);
    expect(repeated.stats.staleDropped).toEqual([]);
    expect(repeated.buildings).toEqual(result.buildings);
  });

  it.each(["landmark-s1", "landmark-tower-s1"])("recognizes %s as a piece of the protected source", (id) => {
    const building = footprint(id, 40);
    building.meta.pieceOf = id.replace(/-s1$/, "");
    const result = clearCorridors([building], roads(), dates, ground, { preserveExisting: new Set(["landmark"]) });
    expect(result.stats.staleDropped).toEqual([]);
    expect(result.buildings.length).toBeGreaterThan(0);
  });
});
