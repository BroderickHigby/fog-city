// World QA W-17: where the streaming ring stops at a tile border, the far terrain beyond it meets
// the near ground: every built tile's border, every 5 m, the near lattice (what the tile's ground
// mesh draws along that edge) against the far terrain just across it. And W-40: no land at the
// city's edge faces a hole in the far layer.
import { beforeAll, describe, expect, it } from "vitest";
import { loadFarTriangles, loadSfPack, TriangleGrid } from "./util.ts";

const { manifest, pack } = loadSfPack();
let terrain: TriangleGrid;

beforeAll(async () => {
  const far = await loadFarTriangles();
  terrain = new TriangleGrid(far.terrain, 50);
}, 120_000);

/** Near ground at (x, z) inside tile (ix, iz): bilinear on its lattice (exact along a tile edge, where the mesh is linear between samples). */
const byTile = new Map(pack.tiles.map((t) => [`${t.ix},${t.iz}`, t]));
function nearAt(ix: number, iz: number, x: number, z: number): { y: number; water: boolean } {
  const g = byTile.get(`${ix},${iz}`)!.ground;
  const fx = (x - g.x0) / g.cellSizeM, fz = (z - g.z0) / g.cellSizeM;
  const i = Math.min(Math.max(0, Math.floor(fx)), g.nx - 2), k = Math.min(Math.max(0, Math.floor(fz)), g.nz - 2);
  const tx = fx - i, tz = fz - k;
  const h = (a: number, b: number): number => g.heights[b * g.nx + a]!;
  const w = (a: number, b: number): number => g.water[b * g.nx + a]!;
  const y = (h(i, k) * (1 - tx) + h(i + 1, k) * tx) * (1 - tz) + (h(i, k + 1) * (1 - tx) + h(i + 1, k + 1) * tx) * tz;
  return { y, water: w(i, k) + w(i + 1, k) + w(i, k + 1) + w(i + 1, k + 1) === 4 };
}

describe("the far terrain meets the near ground at every tile border (W-17, W-40)", () => {
  it("|near - far| at every built tile's border every 5 m: p99 at most 1 m, max at most 2 m; the far side never more than 0.5 m above", () => {
    const steps: number[] = [];
    let above = 0;
    let holes = 0;
    const worst: string[] = [];
    for (const t of manifest.tiles) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        for (let s = 2.5; s < 500; s += 5) {
          let bx: number, bz: number;
          if (dx !== 0) {
            bx = (dx > 0 ? t.ix + 1 : t.ix) * 500;
            bz = t.iz * 500 + s;
          } else {
            bz = (dz > 0 ? t.iz + 1 : t.iz) * 500;
            bx = t.ix * 500 + s;
          }
          const n = nearAt(t.ix, t.iz, bx - dx * 0.25, bz - dz * 0.25);
          if (n.water || n.y <= 0.1) continue;
          const f = terrain.top(bx + dx * 0.25, bz + dz * 0.25);
          if (f === null) {
            holes++;
            continue;
          }
          const d = f - n.y;
          steps.push(Math.abs(d));
          if (d > 0.5) {
            above++;
            if (worst.length < 10) worst.push(`${t.id} (${bx}, ${bz}): near ${n.y.toFixed(2)} far ${f.toFixed(2)}`);
          }
        }
      }
    }
    steps.sort((a, b) => a - b);
    const p99 = steps[Math.floor(0.99 * (steps.length - 1))]!;
    const max = steps[steps.length - 1]!;
    expect(steps.length).toBeGreaterThan(150_000);
    expect(holes, "land border samples with no far terrain across").toBe(0);
    expect(p99).toBeLessThanOrEqual(1);
    expect(max).toBeLessThanOrEqual(2);
    expect(above, worst.join("\n")).toBe(0);
  }, 120_000);

  it("the four south-edge and island tiles the QA report found bare have far terrain over at least 95% of them", () => {
    for (const id of ["t-16_21", "t-4_21", "t-3_21", "t7_-5"]) {
      const m = /^t(-?\d+)_(-?\d+)$/.exec(id)!;
      const ix = Number(m[1]), iz = Number(m[2]);
      let hit = 0, n = 0;
      for (let x = ix * 500 + 12.5; x < ix * 500 + 500; x += 25) {
        for (let z = iz * 500 + 12.5; z < iz * 500 + 500; z += 25) {
          n++;
          if (terrain.top(x, z) !== null) hit++;
        }
      }
      // t7_-5 is mostly bay beside Yerba Buena Island: its land is what must be covered.
      if (id === "t7_-5") expect(hit, id).toBeGreaterThan(0);
      else expect(hit / n, id).toBeGreaterThanOrEqual(0.95);
    }
  });

  it("manifest.outside lists every land tile beside a built tile, and San Bruno Mountain stands in the far layer", () => {
    const built = new Set(manifest.tiles.map((t) => `${t.ix},${t.iz}`));
    const outside = new Set(manifest.outside.tiles.map((t) => t.id));
    const missing: string[] = [];
    for (const t of manifest.tiles) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const ix = t.ix + dx, iz = t.iz + dz;
        if (built.has(`${ix},${iz}`)) continue;
        // Land: far terrain above sea level anywhere on a 50 m grid over the tile.
        let land = false;
        for (let x = ix * 500 + 25; x < ix * 500 + 500 && !land; x += 50) {
          for (let z = iz * 500 + 25; z < iz * 500 + 500 && !land; z += 50) land = (terrain.top(x, z) ?? -1) > 0.5;
        }
        if (land && !outside.has(`t${ix}_${iz}`)) missing.push(`t${ix}_${iz}`);
      }
    }
    expect([...new Set(missing)]).toEqual([]);
    for (const id of ["t-16_21", "t-4_21", "t-3_21", "t7_-5"]) expect(outside.has(id), id).toBe(true);
    // San Bruno Mountain (402 m) at 37.6853, -122.4342: x -3567, z 12231.
    let top = -Infinity;
    for (let x = -4567; x <= -2567; x += 20) for (let z = 11231; z <= 13231; z += 20) top = Math.max(top, terrain.top(x, z) ?? -Infinity);
    expect(top).toBeGreaterThan(392 - 0.5);
    expect(top).toBeLessThan(412);
  });
});
