// W-13: piers. The bare-earth DEM has no pier decks, so pier sheds stood in the bay and pier
// roads ran on the water at y = 0. The piers are now land at deck height (pipeline/lib/piers.ts).

import { describe, expect, it, vi } from "vitest";
import { pointInRing, signedArea, type P2 } from "../../pipeline/lib/geom.ts";
import { PIER_SHED_MIN_M2, PIER_Y_M, raisePiers, waterFraction } from "../../pipeline/lib/piers.ts";
import type { Building } from "../../pipeline/lib/buildings.ts";
import type { RoadGraph } from "../../pipeline/lib/roads.ts";
import { Ground, type Heightfield } from "../../pipeline/lib/terrain.ts";
import { loadSfPack } from "./util.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

describe("raisePiers (unit)", () => {
  it("a shed standing over water and the road out to it become land at deck height", () => {
    // One tile: land (2 m) for x < 100, bay (0 m, water) beyond.
    const nx = 51;
    const heights: number[] = [];
    const water: number[] = [];
    for (let k = 0; k < nx; k++) {
      for (let i = 0; i < nx; i++) {
        heights.push(i * 10 < 100 ? 2 : 0);
        water.push(i * 10 < 100 ? 0 : 1);
      }
    }
    const field: Heightfield = { x0: 0, z0: 0, cellSizeM: 10, nx, nz: nx, heights, water };
    const ground = new Ground([{ ix: 0, iz: 0, field }]);
    const ring: P2[] = [[150, 200], [150, 240], [300, 240], [300, 200]];
    const shed: Building = { id: "201006.0000001", tile: "t0_0", footprint: ring, baseY: 0, topY: 12, meta: { footY: -0.05, heightM: 12, heightSource: "lidar", lidarM: [12, 12] } };
    const graph: RoadGraph = {
      version: 1, attribution: "",
      nodes: [{ id: "n1", x: 60, z: 220, y: 2 }, { id: "n2", x: 320, z: 220, y: 0 }],
      edges: [{ id: "c1", a: "n1", b: "n2", kind: "other", lanes: 1, oneway: false, widthM: 6, speedLimitMps: 6, name: "Pier 1 Vly", points: [[60, 220], [320, 220]], cnn: "1", classcode: null }],
    };
    expect(waterFraction(ring, ground)).toBeGreaterThan(0.9);
    const { stats } = raisePiers([shed], graph, new Map([["t0_0", field]]), ground);
    expect(stats.sheds).toEqual(["201006.0000001"]);
    expect(stats.streets).toEqual(["c1"]);
    expect(waterFraction(ring, ground)).toBe(0);
    for (let x = 100; x <= 320; x += 5) expect(ground.heightAt(x, 220)).toBeGreaterThanOrEqual(PIER_Y_M - 0.01);
    // Open water beside the pier stays water.
    expect(ground.waterAt(400, 400)).toBe(true);
  });
});

describe("sf world: piers (W-13)", () => {
  const { pack, roads, buildings } = loadSfPack();
  const g = new Ground(pack.tiles.map((t) => ({ ix: t.ix, iz: t.iz, field: t.ground })));

  it("no pier shed (400 m2 or more) stands half or more over water; the small structures that do are houseboats, which float", () => {
    const wet = buildings.filter((b) => !b.id.includes("-tower") && waterFraction(b.footprint, g) >= 0.5);
    expect(wet.filter((b) => Math.abs(signedArea(b.footprint)) >= PIER_SHED_MIN_M2).map((b) => b.id)).toEqual([]);
    // The floating ones are few and small (Mission Creek's houseboats, a boathouse or two).
    expect(wet.length).toBeLessThan(60);
  });

  it("Al Scoma Way, Pier 45 Vly and Pier 50 Vly run on the pier deck: ground 2.5 m or more all along", () => {
    for (const name of ["Al Scoma Way", "Pier 45 Vly", "Pier 50 Vly"]) {
      const es = roads.edges.filter((e) => e.name === name);
      expect(es.length, name).toBeGreaterThan(0);
      for (const e of es) {
        for (let i = 1; i < e.points.length; i++) {
          const [ax, az] = e.points[i - 1]!;
          const [bx, bz] = e.points[i]!;
          const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az)));
          for (let k = 0; k <= n; k++) {
            const x = ax + ((bx - ax) * k) / n, z = az + ((bz - az) * k) / n;
            expect(g.heightAt(x, z)!, `${e.id} ${name} at ${x.toFixed(1)},${z.toFixed(1)}`).toBeGreaterThanOrEqual(2.5);
          }
        }
      }
    }
  });

  it("the report's pier buildings stand on the deck (Mission Bay 0000016, Pier 50 0000020, Pier 26 0000040, Pier 1 0000146)", () => {
    for (const id of ["201006.0000016", "201006.0000020", "201006.0000040", "201006.0000146"]) {
      const recs = buildings.filter((b) => b.id === id || b.id.startsWith(`${id}-`));
      expect(recs.length, id).toBeGreaterThan(0);
      for (const b of recs) {
        if (b.id.includes("-tower")) continue;
        const [x, z] = b.footprint.reduce((s, [px, pz]) => [s[0] + px / b.footprint.length, s[1] + pz / b.footprint.length], [0, 0]);
        if (!pointInRing(x, z, b.footprint)) continue;
        expect(b.baseY, b.id).toBeGreaterThanOrEqual(2.5);
      }
    }
  });
});
