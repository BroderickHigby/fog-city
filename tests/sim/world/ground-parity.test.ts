// W-22: the sim stands bodies on the ground that is drawn. At 10,000 seeded points on land
// across the whole city, the ground cars, walkers and agents stand on (meshGroundHeight, and
// surfaceAt where no roof is in reach and no deck or bore covers the point) equals the rendered ground mesh's height (each
// lattice cell's two triangles, split along the (i+1, k)-(i, k+1) diagonal as
// pipeline/lib/mesh.ts draws it; computed here by the pipeline's own Ground.meshHeightAt) to
// within 0.02 m. The bilinear ground bodies stood on before differed by up to 1.8 m on this
// sample (4.4 m on the worst cell). Tile borders give one height from either side, exactly.
import { describe, expect, it } from "vitest";
import { meshGroundHeight, heightOnField, surfaceAt } from "../../../src/sim/index.ts";
import { Ground } from "../../../pipeline/lib/terrain.ts";
import { TILE_SIZE_M } from "../../../src/geo/project.ts";
import { CITY_MS, SF, lcg, sfWorld } from "./load.ts";

describe.skipIf(!SF)("sim ground = drawn ground (W-22)", () => {
  it(
    "at 10,000 seeded land points the sim's ground is within 0.02 m of the mesh's",
    () => {
      const { world } = sfWorld();
      const tiles = world.tiles.filter((t) => t.ground && t.ground.water && t.ground.water.some((v) => v === 0));
      const mesh = new Ground(
        world.tiles.filter((t) => t.ground).map((t) => ({ ix: Math.round(t.ground!.x0 / TILE_SIZE_M), iz: Math.round(t.ground!.z0 / TILE_SIZE_M), field: { ...t.ground!, water: t.ground!.water ?? [] } })),
      );
      const rnd = lcg(2210);
      let n = 0;
      let worst = 0;
      while (n < 10000) {
        const t = tiles[Math.floor(rnd() * tiles.length)]!;
        const g = t.ground!;
        const x = g.x0 + rnd() * TILE_SIZE_M;
        const z = g.z0 + rnd() * TILE_SIZE_M;
        if (mesh.waterAt(x, z)) continue;
        const want = mesh.meshHeightAt(x, z)!;
        worst = Math.max(worst, Math.abs(meshGroundHeight(world, x, z) - want));
        // (Where a deck or a bore covers the point, a body that far down stands on that instead.)
        const s = surfaceAt(world, x, z, want - 10);
        if (s.kind === "ground") worst = Math.max(worst, Math.abs(s.y - want));
        n++;
      }
      expect(worst).toBeLessThanOrEqual(0.02);
    },
    CITY_MS,
  );

  it(
    "is continuous across every cell's diagonal and every tile border",
    () => {
      const { world } = sfWorld();
      const rnd = lcg(77);
      for (let i = 0; i < 2000; i++) {
        const t = world.tiles[Math.floor(rnd() * world.tiles.length)]!;
        const g = t.ground;
        if (!g) continue;
        // A point on a cell's diagonal: both triangles' planes agree there.
        const ci = Math.floor(rnd() * (g.nx - 1));
        const ck = Math.floor(rnd() * (g.nz - 1));
        const u = rnd();
        const x = g.x0 + (ci + u) * g.cellSizeM;
        const z = g.z0 + (ck + 1 - u) * g.cellSizeM;
        const h = heightOnField(g, x, z);
        const near = heightOnField(g, x + 1e-7, z + 1e-7);
        expect(Math.abs(h - near)).toBeLessThan(1e-4);
        // A point on the tile's east border, from this tile and from the neighbour.
        const bx = g.x0 + TILE_SIZE_M;
        const bz = g.z0 + rnd() * TILE_SIZE_M;
        const east = world.tiles.find((q) => q.ground && q.ground.x0 === bx && q.ground.z0 === g.z0);
        if (east) expect(heightOnField(east.ground!, bx, bz)).toBe(heightOnField(g, bx, bz));
        // ...and the south border.
        const bz2 = g.z0 + TILE_SIZE_M;
        const bx2 = g.x0 + rnd() * TILE_SIZE_M;
        const south = world.tiles.find((q) => q.ground && q.ground.z0 === bz2 && q.ground.x0 === g.x0);
        if (south) expect(heightOnField(south.ground!, bx2, bz2)).toBe(heightOnField(g, bx2, bz2));
      }
    },
    CITY_MS,
  );
});
