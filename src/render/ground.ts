// Ground height for the renderer: the same answer as the sim's groundHeight() (first tile
// in ascending id order whose heightfield covers the point, bilinear, else 0), but indexed
// by a coarse grid so draping a whole city's roads does not scan every tile per sample.
// tests/render/ground.test.ts checks it against the sim.

import type { Heightfield, TileCollider } from "../sim/world.ts";
import type { GroundFn } from "./types.ts";

const CELL = 250;

function sample(g: Heightfield, x: number, z: number): number | null {
  const fx = (x - g.x0) / g.cellSizeM;
  const fz = (z - g.z0) / g.cellSizeM;
  if (fx < 0 || fz < 0 || fx > g.nx - 1 || fz > g.nz - 1) return null;
  const ix = Math.min(Math.floor(fx), g.nx - 2);
  const iz = Math.min(Math.floor(fz), g.nz - 2);
  const tx = fx - ix;
  const tz = fz - iz;
  const h00 = g.heights[iz * g.nx + ix] ?? 0;
  const h10 = g.heights[iz * g.nx + ix + 1] ?? 0;
  const h01 = g.heights[(iz + 1) * g.nx + ix] ?? 0;
  const h11 = g.heights[(iz + 1) * g.nx + ix + 1] ?? 0;
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
}

export function makeGroundFn(tiles: readonly TileCollider[], at: (g: Heightfield, x: number, z: number) => number | null = sample): GroundFn {
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
      const h = at(g, x, z);
      if (h !== null) return h;
    }
    return 0;
  };
}

/**
 * The ground as the tiles draw it: each lattice cell split along its (i+1, k)-(i, k+1) diagonal
 * into two planes (pipeline mesh.ts), where the sim's groundHeight is bilinear (world QA W-22;
 * they differ by the twist term, up to 4.4 m in Lincoln Park). What the renderer stands on the
 * ground itself uses this, so it sits on the drawn surface. Same tile order as makeGroundFn.
 */
export function makeDrawnGroundFn(tiles: readonly TileCollider[]): GroundFn {
  return makeGroundFn(tiles, drawnSample);
}

function drawnSample(g: Heightfield, x: number, z: number): number | null {
  const fx = (x - g.x0) / g.cellSizeM;
  const fz = (z - g.z0) / g.cellSizeM;
  if (fx < 0 || fz < 0 || fx > g.nx - 1 || fz > g.nz - 1) return null;
  const ix = Math.min(Math.floor(fx), g.nx - 2);
  const iz = Math.min(Math.floor(fz), g.nz - 2);
  const tx = fx - ix;
  const tz = fz - iz;
  const h00 = g.heights[iz * g.nx + ix] ?? 0;
  const h10 = g.heights[iz * g.nx + ix + 1] ?? 0;
  const h01 = g.heights[(iz + 1) * g.nx + ix] ?? 0;
  const h11 = g.heights[(iz + 1) * g.nx + ix + 1] ?? 0;
  if (tx + tz <= 1) return h00 + (h10 - h00) * tx + (h01 - h00) * tz;
  return h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
}
