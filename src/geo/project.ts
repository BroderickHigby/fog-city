// Local metric frame shared by the pipeline, the sim and the renderer.
//
// Origin: the Ferry Building clock tower. Axes (three.js convention, y up):
//   +x = east, +y = up, +z = south  (so north is -z).
// Equirectangular projection with WGS84 metres-per-degree at the origin latitude.
// Error is ~0.1% at 10 km from the origin, which is invisible in play because every
// layer projects the same way. Constants are literals so Node and every browser agree.

export const ORIGIN = { lat: 37.7955, lon: -122.3937 } as const;
export const M_PER_DEG_LAT = 110992.5853;
export const M_PER_DEG_LON = 88075.7734;

/** Side length of one world tile, metres. Tile (ix, iz) covers [ix*T, (ix+1)*T) x [iz*T, (iz+1)*T). */
export const TILE_SIZE_M = 500;

export interface LocalXZ {
  x: number;
  z: number;
}

export function toLocal(lat: number, lon: number): LocalXZ {
  return {
    x: (lon - ORIGIN.lon) * M_PER_DEG_LON,
    z: -(lat - ORIGIN.lat) * M_PER_DEG_LAT,
  };
}

export function toLatLon(x: number, z: number): { lat: number; lon: number } {
  return {
    lat: ORIGIN.lat - z / M_PER_DEG_LAT,
    lon: ORIGIN.lon + x / M_PER_DEG_LON,
  };
}

export function tileIndexOf(x: number, z: number): { ix: number; iz: number } {
  return { ix: Math.floor(x / TILE_SIZE_M), iz: Math.floor(z / TILE_SIZE_M) };
}

/** Stable, filename-safe tile id, e.g. "t-2_3". */
export function tileId(ix: number, iz: number): string {
  return `t${ix}_${iz}`;
}
