// Ground height for the renderer: the same answer as the sim's groundHeight() (first tile
// in ascending id order whose heightfield covers the point, on the ground mesh's two triangles
// per cell, else 0), but indexed by a coarse grid so draping a whole city's roads does not
// scan every tile per sample. tests/render/ground.test.ts checks it against the sim.

import { heightOnField, type Heightfield, type TileCollider } from "../sim/world.ts";
import type { GroundFn } from "./types.ts";

const CELL = 250;

function sample(g: Heightfield, x: number, z: number): number | null {
  const fx = (x - g.x0) / g.cellSizeM;
  const fz = (z - g.z0) / g.cellSizeM;
  if (fx < 0 || fz < 0 || fx > g.nx - 1 || fz > g.nz - 1) return null;
  return heightOnField(g, x, z);
}

export function makeGroundFn(tiles: readonly TileCollider[]): GroundFn {
  const sorted = [...tiles].sort((a, b) => (a.tileId < b.tileId ? -1 : a.tileId > b.tileId ? 1 : 0));
  const grid = new Map<number, Heightfield[]>();
  const key = (cx: number, cz: number): number => (cx + 32768) * 65536 + (cz + 32768);
  for (const t of sorted) {
    const g = t.ground;
    if (!g || g.nx < 2 || g.nz < 2) continue;
    const x1 = g.x0 + (g.nx - 1) * g.cellSizeM;
    const z1 = g.z0 + (g.nz - 1) * g.cellSizeM;
    for (let cx = Math.floor(g.x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cz = Math.floor(g.z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
        const k = key(cx, cz);
        let l = grid.get(k);
        if (!l) grid.set(k, (l = []));
        l.push(g);
      }
    }
  }
  return (x, z) => {
    const list = grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (!list) return 0;
    for (const g of list) {
      const h = sample(g, x, z);
      if (h !== null) return h;
    }
    return 0;
  };
}
