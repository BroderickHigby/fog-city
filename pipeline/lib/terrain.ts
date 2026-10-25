// Terrain: a single deterministic elevation function over the world, and the per-tile
// heightfields built from it.
//
// Every heightfield sample sits on the global 10 m lattice (x = i·10, z = k·10), and its
// value is a pure function of that position, so two neighbouring tiles compute their
// shared border row/column from the same calls and meet exactly.

import { TILE_SIZE_M, toLatLon } from "../../src/geo/project.ts";
import type { TileRef } from "./config.ts";
import { isNoData, type GeoRaster } from "./geotiff.ts";
import { r2 } from "./geom.ts";

export const GROUND_CELL_M = 10;
export const SAMPLES_PER_TILE = TILE_SIZE_M / GROUND_CELL_M + 1; // 51: shared border on all sides

/**
 * Bare-earth samples below this many metres NAVD88 are water. Over San Francisco Bay the
 * 3DEP service returns a hydro-flattened surface at (almost exactly) 0 m, bathymetry further
 * out (down to about −23 m) and about −1 m in some slips; land on the waterfront (fill,
 * piers) is 1–4 m. 0.1 m separates them with margin.
 */
export const WATER_MAX_M = 0.1;

export interface Heightfield {
  x0: number;
  z0: number;
  cellSizeM: number;
  nx: number;
  nz: number;
  heights: number[];
  /** 1 where the sample is water (height clamped to sea level 0), else 0. Same indexing as heights. */
  water: number[];
}

export class Elevation {
  private rasters: GeoRaster[];
  constructor(rasters: GeoRaster[]) {
    if (rasters.length === 0) throw new Error("terrain: no elevation rasters");
    this.rasters = rasters;
  }

  /** Raw DEM value (bilinear between pixel centres), from the first raster covering the point. */
  raw(x: number, z: number): number {
    const { lat, lon } = toLatLon(x, z);
    for (const r of this.rasters) {
      // Pixel-centre coordinates.
      const fx = (lon - r.west) / r.dLon - 0.5;
      const fy = (r.north - lat) / r.dLat - 0.5;
      if (fx < 0 || fy < 0 || fx > r.width - 1 || fy > r.height - 1) continue;
      const ix = Math.min(Math.floor(fx), r.width - 2);
      const iy = Math.min(Math.floor(fy), r.height - 2);
      const tx = fx - ix;
      const ty = fy - iy;
      const at = (i: number, k: number): number => {
        const v = r.data[k * r.width + i]!;
        return isNoData(r, v) ? -1 : v;
      };
      const v00 = at(ix, iy);
      const v10 = at(ix + 1, iy);
      const v01 = at(ix, iy + 1);
      const v11 = at(ix + 1, iy + 1);
      return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
    }
    throw new Error(`terrain: no elevation raster covers x=${x.toFixed(1)} z=${z.toFixed(1)}`);
  }

  /** Ground height (water clamped to 0, rounded to cm) and whether it is water. */
  sample(x: number, z: number): { h: number; water: boolean } {
    const v = this.raw(x, z);
    if (v < WATER_MAX_M) return { h: 0, water: true };
    return { h: r2(v), water: false };
  }
}

export function tileHeightfield(t: TileRef, elev: Elevation): Heightfield {
  const n = SAMPLES_PER_TILE;
  const heights: number[] = [];
  const water: number[] = [];
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < n; i++) {
      const s = elev.sample(t.bbox[0] + i * GROUND_CELL_M, t.bbox[1] + k * GROUND_CELL_M);
      heights.push(s.h);
      water.push(s.water ? 1 : 0);
    }
  }
  return { x0: t.bbox[0], z0: t.bbox[1], cellSizeM: GROUND_CELL_M, nx: n, nz: n, heights, water };
}

/**
 * The ground the sim sees: bilinear over whichever tile heightfield covers (x, z), with the
 * same arithmetic as src/sim/world.ts groundHeight(). Indexed by tile for speed.
 */
export class Ground {
  // Numeric keys (no string per lookup: the pipeline asks millions of times).
  private byTile = new Map<number, Heightfield>();
  constructor(fields: ReadonlyArray<{ ix: number; iz: number; field: Heightfield }>) {
    for (const f of fields) this.byTile.set(Ground.key(f.ix, f.iz), f.field);
  }

  private static key(ix: number, iz: number): number {
    return (ix + 4096) * 8192 + (iz + 4096);
  }

  /** The heightfield covering (x, z); a point exactly on a tile's far border also belongs to that tile. */
  field(x: number, z: number): Heightfield | undefined {
    const ix = Math.floor(x / TILE_SIZE_M);
    const iz = Math.floor(z / TILE_SIZE_M);
    const f = this.byTile.get(Ground.key(ix, iz));
    if (f) return f;
    const onX = x === ix * TILE_SIZE_M;
    const onZ = z === iz * TILE_SIZE_M;
    return (
      (onX ? this.byTile.get(Ground.key(ix - 1, iz)) : undefined) ??
      (onZ ? this.byTile.get(Ground.key(ix, iz - 1)) : undefined) ??
      (onX && onZ ? this.byTile.get(Ground.key(ix - 1, iz - 1)) : undefined)
    );
  }

  /** Height at (x, z), or null outside the world's tiles. */
  heightAt(x: number, z: number): number | null {
    const g = this.field(x, z);
    if (!g) return null;
    const fx = (x - g.x0) / g.cellSizeM;
    const fz = (z - g.z0) / g.cellSizeM;
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

  /**
   * Height of the rendered ground mesh at (x, z): planar triangles split along the
   * (i+1, k)–(i, k+1) diagonal, exactly as mesh.ts triangulates each cell. Differs from the
   * bilinear heightAt() by a few centimetres inside twisted cells.
   */
  meshHeightAt(x: number, z: number): number | null {
    const g = this.field(x, z);
    if (!g) return null;
    const fx = (x - g.x0) / g.cellSizeM;
    const fz = (z - g.z0) / g.cellSizeM;
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

  /**
   * Bounds on the ground over a box: the extremes of every lattice sample of the cells the box
   * touches (both the bilinear and the triangulated ground stay within their cell's samples).
   * Null where the box leaves the tiles.
   */
  boxBounds(x0: number, z0: number, x1: number, z1: number): { min: number; max: number } | null {
    let min = Infinity;
    let max = -Infinity;
    const c = 10;
    for (let gx = Math.floor(x0 / c); gx <= Math.ceil(x1 / c); gx++) {
      for (let gz = Math.floor(z0 / c); gz <= Math.ceil(z1 / c); gz++) {
        const x = gx * c;
        const z = gz * c;
        const f = this.field(x, z);
        if (!f) return null;
        const i = Math.round((x - f.x0) / f.cellSizeM);
        const k = Math.round((z - f.z0) / f.cellSizeM);
        const h = f.heights[k * f.nx + i];
        if (h === undefined) return null;
        if (h < min) min = h;
        if (h > max) max = h;
      }
    }
    return Number.isFinite(min) ? { min, max } : null;
  }

  /** True when the nearest lattice sample to (x, z) is water. */
  waterAt(x: number, z: number): boolean {
    const g = this.field(x, z);
    if (!g) return false;
    const i = Math.round((x - g.x0) / g.cellSizeM);
    const k = Math.round((z - g.z0) / g.cellSizeM);
    return g.water[k * g.nx + i] === 1;
  }
}
