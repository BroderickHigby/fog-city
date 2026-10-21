// W-05 and W-28: hillside buildings. No roof under the ground (an invisible wall to a walker, a
// teleport for a car), no low roof the hill nearly reaches, no single roof over more than 10 m
// of relief, and terraced buildings step down the hill instead of standing as one prism with a
// 27 m cliff of wall downhill. Measured independently of the pipeline's own ground sampling:
// every footprint on a 1 m raster plus its vertices, against both the sim's bilinear ground and
// the drawn mesh's triangles.

import { describe, expect, it, vi } from "vitest";
import { pointInRing, signedArea, type P2 } from "../../pipeline/lib/geom.ts";
import { Ground } from "../../pipeline/lib/terrain.ts";
import { ROOF_CLEAR_M, TERRACE_MIN_RELIEF_M, terraceBuildings } from "../../pipeline/lib/terrace.ts";
import type { Building } from "../../pipeline/lib/buildings.ts";
import { loadSfPack } from "./util.ts";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

/** Ground extremes and mean over a footprint: its vertices and a 1 m raster inside it. */
function rasterRange(ring: readonly P2[], g: Ground): { min: number; max: number; mean: number } | null {
  let min = Infinity, max = -Infinity, sum = 0, n = 0;
  const take = (x: number, z: number, count: boolean): void => {
    const h = g.heightAt(x, z);
    const m = g.meshHeightAt(x, z);
    if (h === null || m === null) return;
    min = Math.min(min, h, m);
    max = Math.max(max, h, m);
    if (count) {
      sum += h;
      n++;
    }
  };
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of ring) {
    take(x, z, false);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    z0 = Math.min(z0, z); z1 = Math.max(z1, z);
  }
  for (let x = Math.ceil(x0); x <= x1; x++) for (let z = Math.ceil(z0); z <= z1; z++) if (pointInRing(x, z, ring)) take(x, z, true);
  if (!Number.isFinite(min)) return null;
  return { min, max, mean: n ? sum / n : (min + max) / 2 };
}

/** The ground's slope at a point (central differences over 4 m, bilinear ground). */
const slopeAt = (g: Ground, x: number, z: number): number => {
  const h = (dx: number, dz: number): number => g.heightAt(x + dx, z + dz) ?? 0;
  return Math.hypot((h(2, 0) - h(-2, 0)) / 4, (h(0, 2) - h(0, -2)) / 4);
};

describe("terraceBuildings (unit)", () => {
  // One tile with a steady 30% slope rising to the east (+x).
  const nx = 51;
  const heights: number[] = [];
  for (let k = 0; k < nx; k++) for (let i = 0; i < nx; i++) heights.push(Math.round(i * 10 * 0.3 * 100) / 100);
  const ground = new Ground([{ ix: 0, iz: 0, field: { x0: 0, z0: 0, cellSizeM: 10, nx, nz: nx, heights, water: new Array(nx * nx).fill(0) } }]);
  const house = (id: string, x0: number, w: number, d: number, h: number): Building => {
    const ring: P2[] = [[x0, 100], [x0, 100 + d], [x0 + w, 100 + d], [x0 + w, 100]];
    const base = ground.heightAt(x0 + w / 2, 100 + d / 2)!;
    return { id, tile: "t0_0", footprint: ring, baseY: base, topY: base + h, meta: { footY: ground.heightAt(x0, 100)! - 0.05, heightM: h, heightSource: "lidar", lidarM: [h, h] } };
  };

  it("a 40 m deep building across a 30% slope (12 m of relief) becomes strips of at most 4 m relief, each with its own base and roof", () => {
    const b = house("201006.0000001", 100, 40, 20, 12);
    const { buildings, stats } = terraceBuildings([b], ground);
    expect(stats.terraced).toBe(1);
    expect(buildings.length).toBeGreaterThanOrEqual(3);
    let area = 0;
    // The strip holding the footprint's anchor keeps the record's id; the others are -s<n> pieces.
    expect(buildings.filter((s) => s.id === b.id).length).toBe(1);
    for (const s of buildings) {
      expect(s.id).toMatch(/^201006\.0000001(-s\d+)?$/);
      if (s.id !== b.id) expect(s.meta.pieceOf).toBe(b.id);
      const r = rasterRange(s.footprint, ground)!;
      expect(r.max - r.min).toBeLessThanOrEqual(4.01);
      expect(s.topY).toBeGreaterThanOrEqual(r.max + ROOF_CLEAR_M - 0.01);
      expect(s.meta.footY).toBeLessThanOrEqual(r.min);
      area += Math.abs(signedArea(s.footprint));
    }
    expect(area).toBeCloseTo(40 * 20, 0);
    // Stepping down the hill: the roofs fall with the ground.
    const tops = [...buildings].sort((p, q) => p.footprint[0]![0] - q.footprint[0]![0]).map((s) => s.topY);
    expect(tops[0]!).toBeLessThan(tops[tops.length - 1]!);
  });

  it("a small house with less relief than TERRACE_MIN_RELIEF_M stays one record, its roof clear of its highest ground", () => {
    const b = house("201006.0000002", 300, 10, 10, 4);
    expect(10 * 0.3).toBeLessThan(TERRACE_MIN_RELIEF_M);
    // Its LiDAR roof (4 m over the centre) would stand only 2.5 m over the uphill corner.
    const { buildings } = terraceBuildings([{ ...b, topY: b.baseY + 3 }], ground);
    expect(buildings.length).toBe(1);
    const r = rasterRange(buildings[0]!.footprint, ground)!;
    expect(buildings[0]!.topY).toBeGreaterThanOrEqual(r.max + ROOF_CLEAR_M - 0.01);
  });
});

describe("sf world: hillside buildings (W-05, W-28)", () => {
  const { pack, buildings } = loadSfPack();
  const g = new Ground(pack.tiles.map((t) => ({ ix: t.ix, iz: t.iz, field: t.ground })));
  const ranges = buildings.map((b) => rasterRange(b.footprint, g));

  it("no roof under the ground anywhere in its footprint (1 m raster)", () => {
    const bad: string[] = [];
    buildings.forEach((b, i) => {
      const r = ranges[i];
      if (r && b.topY < r.max) bad.push(`${b.id} ${(r.max - b.topY).toFixed(2)} m under`);
    });
    expect(bad).toEqual([]);
  });

  it("no record 4 m or taller stands less than 2 m above its highest ground", () => {
    const bad: string[] = [];
    buildings.forEach((b, i) => {
      const r = ranges[i];
      if (!r || b.topY - b.baseY < 4) return;
      if (b.topY - r.max < 2) bad.push(`${b.id} ${(b.topY - r.max).toFixed(2)} m`);
    });
    expect(bad).toEqual([]);
  });

  it("no drawn part has more than 10 m of relief under one roof", () => {
    // A tower's walls start on its podium's roof and a span's at its underside: the hill under
    // them draws no wall.
    const bad: string[] = [];
    buildings.forEach((b, i) => {
      const r = ranges[i];
      if (!r || b.id.endsWith("-tower") || /-b\d+$/.test(b.id)) return;
      if (r.max - r.min > 10) bad.push(`${b.id} ${(r.max - r.min).toFixed(1)} m`);
    });
    expect(bad).toEqual([]);
  });

  it("terraced buildings on ground steeper than 30%: the downhill/uphill wall ratio is 1.3 or less at p50", () => {
    // The population is the parts of the large hillside buildings W-28 is about: every terrace
    // strip (-s<n>, from a footprint with more than 6 m of relief) on ground steeper than 30%.
    // A small house on a steep street keeps the downhill storey SF houses really have.
    const ratios: number[] = [];
    buildings.forEach((b, i) => {
      const r = ranges[i];
      if (!r || !/-s\d+$/.test(b.id)) return;
      const c = b.footprint.reduce((s, [x, z]) => [s[0] + x / b.footprint.length, s[1] + z / b.footprint.length], [0, 0]);
      if (slopeAt(g, c[0], c[1]) <= 0.3) return;
      ratios.push((b.topY - r.min) / (b.topY - r.max));
    });
    ratios.sort((p, q) => p - q);
    expect(ratios.length).toBeGreaterThan(1000);
    expect(ratios[ratios.length >> 1]!).toBeLessThanOrEqual(1.3);
  });
});
