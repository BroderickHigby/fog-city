// World configuration (pipeline/areas.json) and the tile set it implies.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TILE_SIZE_M, tileId, toLatLon, toLocal } from "../../src/geo/project.ts";

export interface Area {
  id: string;
  milestone: string;
  name: string;
  north: number;
  west: number;
  south: number;
  east: number;
}

export interface SpawnConfig {
  street: string;
  lat: number;
  lon: number;
  /** A point the spawn heading should point toward (picks the direction along the road). */
  towardLat: number;
  towardLon: number;
}

export interface Probe {
  id: string;
  label: string;
  lat: number;
  lon: number;
}

export interface WorldConfig {
  id: string;
  title: string;
  areas: Area[];
  spawn: SpawnConfig;
  probes?: { points: Probe[] };
  sources: {
    buildings: string;
    streets: string;
    assessor: string;
    assessorRollYear: number;
    businesses: string;
  };
}

export interface TileRef {
  id: string;
  ix: number;
  iz: number;
  /** [minX, minZ, maxX, maxZ] local metres. */
  bbox: [number, number, number, number];
}

/** A rectangle of whole tiles, in tile indices (inclusive). */
export interface TileRect {
  ix0: number;
  ix1: number;
  iz0: number;
  iz1: number;
}

export function loadWorldConfig(root: string, world: string): WorldConfig {
  const raw = JSON.parse(readFileSync(join(root, "pipeline/areas.json"), "utf8")) as {
    worlds: Record<string, Omit<WorldConfig, "id">>;
  };
  const w = raw.worlds[world];
  if (!w) throw new Error(`unknown world "${world}" (pipeline/areas.json has: ${Object.keys(raw.worlds).join(", ")})`);
  const ids = new Set<string>();
  for (const a of w.areas) {
    if (ids.has(a.id)) throw new Error(`duplicate area id ${a.id}`);
    ids.add(a.id);
    if (!(a.north > a.south && a.east > a.west)) throw new Error(`area ${a.id}: expected north > south and east > west`);
  }
  return { id: world, ...w };
}

/** The rectangle of tiles an area's bbox touches. */
export function areaTileRect(a: Area): TileRect {
  const nw = toLocal(a.north, a.west);
  const se = toLocal(a.south, a.east);
  return {
    ix0: Math.floor(nw.x / TILE_SIZE_M),
    ix1: Math.floor(se.x / TILE_SIZE_M),
    iz0: Math.floor(nw.z / TILE_SIZE_M),
    iz1: Math.floor(se.z / TILE_SIZE_M),
  };
}

export function tileRef(ix: number, iz: number): TileRef {
  return {
    id: tileId(ix, iz),
    ix,
    iz,
    bbox: [ix * TILE_SIZE_M, iz * TILE_SIZE_M, (ix + 1) * TILE_SIZE_M, (iz + 1) * TILE_SIZE_M],
  };
}

/** Every tile touched by any area, sorted by (iz, ix). */
export function worldTiles(cfg: WorldConfig): TileRef[] {
  const seen = new Map<string, TileRef>();
  for (const a of cfg.areas) {
    const r = areaTileRect(a);
    for (let iz = r.iz0; iz <= r.iz1; iz++) {
      for (let ix = r.ix0; ix <= r.ix1; ix++) {
        const t = tileRef(ix, iz);
        seen.set(t.id, t);
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.iz - b.iz || a.ix - b.ix);
}

/** Lat/lon box (north, west, south, east) of a tile rectangle, padded by padM metres. */
export function rectLatLon(r: TileRect, padM: number): { north: number; west: number; south: number; east: number } {
  const nw = toLatLon(r.ix0 * TILE_SIZE_M - padM, r.iz0 * TILE_SIZE_M - padM);
  const se = toLatLon((r.ix1 + 1) * TILE_SIZE_M + padM, (r.iz1 + 1) * TILE_SIZE_M + padM);
  return { north: nw.lat, west: nw.lon, south: se.lat, east: se.lon };
}

/** Round a coordinate for use in a query string, so URLs (and cache keys) are stable. */
export function q6(v: number): string {
  return v.toFixed(6);
}
