// The Ferry Building showcase's street detail (src/render/showcase.ts) on the committed sf world:
// where the paint, the median, the palms and the paving mask go. Pure geometry, no WebGL.

import { describe, expect, it } from "vitest";
import { MASK_HALF_M, MASK_PX, MEDIAN_REACH_M, SHOWCASE, inShowcase, medianLine, paintQuads, palmSpots, pavedAt, pavingPolygons, rasterMask } from "../../src/render/showcase.ts";
import { roadHalfWidth } from "../../src/render/roads.ts";
import type { RoadGraph } from "../../src/render/types.ts";
import { readJson, worldExists } from "../helpers.ts";

const hasSf = worldExists("sf");
const roads = hasSf ? readJson<RoadGraph>("public/tiles/sf/roads.json") : ({ nodes: [], edges: [] } as unknown as RoadGraph);

function distToEdge(x: number, z: number, pts: ReadonlyArray<readonly [number, number]>): number {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1]!;
    const [bx, bz] = pts[i]!;
    const ex = bx - ax;
    const ez = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1)));
    best = Math.min(best, Math.hypot(x - ax - ex * t, z - az - ez * t));
  }
  return best;
}

describe("rasterMask", () => {
  it("fills a polygon's inside only (even-odd), in the mask's metre frame", () => {
    const m = rasterMask([[[-10, -10], [10, -10], [10, 10], [-10, 10]]], 20, 40);
    const at = (x: number, z: number): number => m[Math.floor(z + 20) * 40 + Math.floor(x + 20)]!;
    expect(at(0, 0)).toBe(255);
    expect(at(9.5, -9.5)).toBe(255);
    expect(at(11, 0)).toBe(0);
    expect(at(0, -15)).toBe(0);
    expect(m.reduce((n, v) => n + (v ? 1 : 0), 0)).toBe(400);
  });

  it("pavedAt reads the mask back in the same frame", () => {
    const paved = pavedAt(rasterMask([[[-10, -10], [10, -10], [10, 10], [-10, 10]]], 20, 40), 20);
    expect(paved(0, 0)).toBe(true);
    expect(paved(9.5, -9.5)).toBe(true);
    expect(paved(11, 0)).toBe(false);
    expect(paved(0, -15)).toBe(false);
    expect(paved(-25, 0)).toBe(false);
  });
});

describe.skipIf(!hasSf)("the showcase on the sf world", () => {
  const line = medianLine(roads);
  const carriageways = roads.edges.filter((e) => !e.pedestrian && e.points.some(([x, z]) => inShowcase(x, z, 100)));

  it("finds the Embarcadero's median in front of the Ferry Building, not some other stretch", () => {
    expect(line.length).toBeGreaterThan(40);
    for (const [x, z] of line) expect(Math.hypot(x - SHOWCASE.x, z - SHOWCASE.z)).toBeLessThanOrEqual(MEDIAN_REACH_M);
    // It passes the clock tower within 120 m.
    expect(Math.min(...line.map(([x, z]) => Math.hypot(x, z)))).toBeLessThan(120);
  });

  it("stands every palm on the median, clear of every carriageway by 1 m, and keeps the trackbed off them", () => {
    const palms = palmSpots(line, roads);
    expect(palms.length).toBeGreaterThan(30);
    for (const p of palms) {
      for (const e of carriageways) expect(distToEdge(p.x, p.z, e.points), `palm at ${p.x.toFixed(1)}, ${p.z.toFixed(1)} vs ${e.id}`).toBeGreaterThan(roadHalfWidth(e) + 1);
    }
    for (const [x, z] of line) for (const e of carriageways) expect(distToEdge(x, z, e.points), `median at ${x.toFixed(1)}, ${z.toFixed(1)} vs ${e.id}`).toBeGreaterThan(roadHalfWidth(e) + 3.6);
  });

  it("paints crosswalks and stop bars inside the showcase only", () => {
    const { quads, stats } = paintQuads(roads);
    expect(stats.crosswalks).toBeGreaterThan(100);
    expect(stats.stopBars).toBeGreaterThan(50);
    for (const q of quads) for (const [x, z] of q) expect(inShowcase(x, z, 60)).toBe(true);
  });

  it("paves the median and the foot of Market St, and stops near the waterfront", () => {
    const m = rasterMask(pavingPolygons(roads));
    const cell = (2 * MASK_HALF_M) / MASK_PX;
    const at = (x: number, z: number): number => m[Math.floor((z + MASK_HALF_M) / cell) * MASK_PX + Math.floor((x + MASK_HALF_M) / cell)]!;
    for (const [x, z] of line.filter((_, i) => i % 5 === 0)) expect(at(x, z), `median at ${x.toFixed(0)}, ${z.toFixed(0)}`).toBe(255);
    expect(at(-106, 108), "the foot of Market St (the owner's spot)").toBe(255);
    // Inland blocks keep their concrete (lawns are never paved whatever the mask says: detail.ts).
    expect(at(-450, 350)).toBe(0);
  });
});
