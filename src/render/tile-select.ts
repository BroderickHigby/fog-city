// Which tiles to load and unload around the camera. Pure: no three.js, no DOM, so the
// rules are unit-tested (tests/render/tile-select.test.ts) and shared by any streamer.
//
// A tile is wanted when the camera's ground position is within `radius` of the tile's
// rectangle (0 when inside it). A loaded tile is dropped only beyond radius + hysteresis,
// so a camera hovering at the edge does not load and unload the same tile every frame.

import type { TileCollider } from "../sim/world.ts";
import type { ManifestTile } from "./types.ts";

export interface TileBounds {
  id: string;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  /**
   * true when the rectangle came from the manifest (bbox or ix/iz), false when it was
   * derived from collider contents. Derived bounds are "whatever is in it", so the
   * renderer pads ground around them; manifest bounds are exact.
   */
  exact: boolean;
}

export const DEFAULT_RADIUS_M = 1500;
export const DEFAULT_HYSTERESIS_M = 250;

/**
 * Bounds for a manifest tile, by preference: its bbox, else its grid index (ix, iz) times
 * the tile size, else the extent of its collider (footprints and heightfield), else a
 * zero-size rectangle at the origin.
 */
export function tileBounds(t: ManifestTile, tileSizeM: number, collider?: TileCollider | null): TileBounds {
  if (t.bbox && t.bbox.length === 4 && t.bbox.every(Number.isFinite)) {
    const [a, b, c, d] = t.bbox;
    return { id: t.id, minX: Math.min(a, c), minZ: Math.min(b, d), maxX: Math.max(a, c), maxZ: Math.max(b, d), exact: true };
  }
  if (Number.isInteger(t.ix) && Number.isInteger(t.iz) && tileSizeM > 0) {
    const ix = t.ix!;
    const iz = t.iz!;
    return { id: t.id, minX: ix * tileSizeM, minZ: iz * tileSizeM, maxX: (ix + 1) * tileSizeM, maxZ: (iz + 1) * tileSizeM, exact: true };
  }
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  if (collider) {
    for (const b of collider.buildings) {
      for (const [x, z] of b.footprint) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    }
    const g = collider.ground;
    if (g) {
      minX = Math.min(minX, g.x0);
      minZ = Math.min(minZ, g.z0);
      maxX = Math.max(maxX, g.x0 + (g.nx - 1) * g.cellSizeM);
      maxZ = Math.max(maxZ, g.z0 + (g.nz - 1) * g.cellSizeM);
    }
  }
  if (!Number.isFinite(minX)) return { id: t.id, minX: 0, minZ: 0, maxX: 0, maxZ: 0, exact: false };
  return { id: t.id, minX, minZ, maxX, maxZ, exact: false };
}

/** Distance on the ground plane from (x, z) to the rectangle; 0 inside it. */
export function distanceToBounds(b: Readonly<TileBounds>, x: number, z: number): number {
  const dx = x < b.minX ? b.minX - x : x > b.maxX ? x - b.maxX : 0;
  const dz = z < b.minZ ? b.minZ - z : z > b.maxZ ? z - b.maxZ : 0;
  return Math.sqrt(dx * dx + dz * dz);
}

export interface SelectOptions {
  radius: number;
  hysteresis: number;
}

export interface TileSelection {
  /** Tiles to start loading, nearest first (ties broken by id). Excludes tiles already present. */
  load: string[];
  /** Present tiles that are now out of range. */
  unload: string[];
}

/**
 * present = tiles loaded or loading. A tile in `present` is never in `load`; a tile not in
 * `present` is never in `unload`.
 */
export function selectTiles(
  bounds: readonly TileBounds[],
  x: number,
  z: number,
  present: ReadonlySet<string>,
  opts: SelectOptions = { radius: DEFAULT_RADIUS_M, hysteresis: DEFAULT_HYSTERESIS_M },
): TileSelection {
  const want: Array<{ id: string; d: number }> = [];
  const unload: string[] = [];
  const keepR = opts.radius + Math.max(0, opts.hysteresis);
  for (const b of bounds) {
    const d = distanceToBounds(b, x, z);
    if (present.has(b.id)) {
      if (d > keepR) unload.push(b.id);
    } else if (d <= opts.radius) {
      want.push({ id: b.id, d });
    }
  }
  want.sort((p, q) => p.d - q.d || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  unload.sort();
  return { load: want.map((w) => w.id), unload };
}
