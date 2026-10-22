// World QA W-41: the far skyline does not pop when a tile streams in. At every record's interior
// point the far layer's highest hull surface is compared with the near skyline there (the highest
// roof of the records standing over that point: a podium under its own tower shows the tower in
// both): records 30 m or taller within 3 m, every record under a hull, lower records within 5 m at
// the 99th percentile.
import { beforeAll, describe, expect, it } from "vitest";
import { interiorPoint, pointInRing, type P2 } from "../../pipeline/lib/geom.ts";
import { loadFarTriangles, loadSfPack, TriangleGrid } from "./util.ts";

const { buildings } = loadSfPack();
let hulls: TriangleGrid;

beforeAll(async () => {
  hulls = new TriangleGrid((await loadFarTriangles()).hulls, 25);
}, 120_000);

const grid = new Map<number, number[]>();
buildings.forEach((b, i) => {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of b.footprint) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    z0 = Math.min(z0, z); z1 = Math.max(z1, z);
  }
  for (let cx = Math.floor(x0 / 25); cx <= Math.floor(x1 / 25); cx++) {
    for (let cz = Math.floor(z0 / 25); cz <= Math.floor(z1 / 25); cz++) (grid.get((cx + 8192) * 16384 + cz + 8192) ?? grid.set((cx + 8192) * 16384 + cz + 8192, []).get((cx + 8192) * 16384 + cz + 8192)!).push(i);
  }
});
const nearTop = (x: number, z: number): number => {
  let best = -Infinity;
  for (const i of grid.get((Math.floor(x / 25) + 8192) * 16384 + Math.floor(z / 25) + 8192) ?? []) {
    const b = buildings[i]!;
    if (pointInRing(x, z, b.footprint as P2[])) best = Math.max(best, b.topY);
  }
  return best;
};

describe("far hulls match the near skyline (W-41)", () => {
  it("records 30 m or taller within 3 m, every record under a hull, the rest within 5 m at p99", () => {
    const tall: number[] = [];
    const low: number[] = [];
    const missing: string[] = [];
    const tallBad: string[] = [];
    for (const b of buildings) {
      const [x, z] = interiorPoint(b.footprint as P2[]);
      const far = hulls.top(x, z);
      if (far === null) {
        missing.push(b.id);
        continue;
      }
      const d = Math.abs(far - nearTop(x, z));
      if (b.topY - b.baseY >= 30) {
        tall.push(d);
        if (d > 3) tallBad.push(`${b.id} ${d.toFixed(1)} m`);
      } else low.push(d);
    }
    low.sort((a, c) => a - c);
    expect(buildings.length).toBeGreaterThan(150_000);
    expect(missing.slice(0, 20), `${missing.length} records under no hull`).toEqual([]);
    expect(tallBad.slice(0, 20), `${tallBad.length} of ${tall.length} tall records off by more than 3 m`).toEqual([]);
    expect(low[Math.floor(0.99 * (low.length - 1))]!).toBeLessThanOrEqual(5);
  }, 120_000);
});
