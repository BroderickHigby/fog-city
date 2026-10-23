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
  /** Report every record within this many metres, not only the one under the point. */
  radiusM?: number;
}

/**
 * Citywide mode: every 500 m tile inside this box with SF buildings, roads or land is
 * built. `areas` then only label milestones (report, tests); they no longer choose tiles.
 */
export interface CitywideConfig {
  north: number;
  west: number;
  south: number;
  east: number;
  /** DEM requests cover square blocks of this many tiles per side (plus a margin). */
  demBlockTiles: number;
}

/**
 * The far layer's reach (world QA W-17, W-40): far terrain and massing cover this lat/lon box,
 * which may run past the citywide box (the Marin headlands' ridgeline, San Bruno Mountain).
 * The DEM is downloaded for it in the citywide blocks; buildings and streets are not.
 */
export interface FarConfig {
  north: number;
  west: number;
  south: number;
  east: number;
}

export interface WorldConfig {
  id: string;
  title: string;
  areas: Area[];
  citywide?: CitywideConfig;
  far?: FarConfig;
  spawn: SpawnConfig;
  probes?: { points: Probe[] };
  sources: {
    buildings: string;
    streets: string;
    assessor: string;
    assessorRollYear: number;
    businesses: string;
    /** Citywide extras (DataSF ids). Absent in area-only worlds. */
    neighborhoods?: string;
    fountains?: string;
    muniStops?: string;
    muniRoutes?: string;
    signals?: string;
    crosswalks?: string;
    streetCleaning?: string;
    parking?: string;
    /** Ground cover (world QA W-11, W-18, W-34): Rec and Park properties and the Urban Tree Canopy (DataSF ids). */
    recParks?: string;
    canopy?: string;
    /** Parcel polygons (DataSF "Parcels – Active and Retired"): footprints for buildings newer than the 2016 footprint layer (W-04). */
    parcelShapes?: string;
    /** USGS NHD large-scale waterbodies (ArcGIS MapServer layer URL): inland lake outlines (W-11). */
    waterbodies?: string;
    /** National Park Service unit boundaries (ArcGIS FeatureServer layer URL) and the unit codes to read: GGNRA open space (W-18). */
    federalLands?: string;
    federalUnits?: string[];
    /** The day the cached downloads were taken (DataSF reloads daily; a refresh is a deliberate PR). */
    snapshotDate?: string;
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

/** The rectangle of tiles a lat/lon box touches. */
export function boxTileRect(b: { north: number; west: number; south: number; east: number }): TileRect {
  return areaTileRect({ id: "", milestone: "", name: "", ...b });
}

/**
 * Tiles the build considers: citywide, every tile of the citywide box; otherwise every
 * tile an area touches. Which of them get files is decided later (water-only tiles do not).
 */
export function candidateTiles(cfg: WorldConfig): TileRef[] {
  if (!cfg.citywide) return worldTiles(cfg);
  const r = boxTileRect(cfg.citywide);
  const out: TileRef[] = [];
  for (let iz = r.iz0; iz <= r.iz1; iz++) for (let ix = r.ix0; ix <= r.ix1; ix++) out.push(tileRef(ix, iz));
  return out;
}

/** DEM blocks: squares of `n` tiles aligned to multiples of n, covering the given tiles. Sorted. */
export function demBlocks(tiles: readonly TileRef[], n: number): Array<{ id: string; rect: TileRect }> {
  const seen = new Map<string, { id: string; rect: TileRect; bx: number; bz: number }>();
  for (const t of tiles) {
    const bx = Math.floor(t.ix / n);
    const bz = Math.floor(t.iz / n);
    const id = `dem${bx}_${bz}`;
    if (!seen.has(id)) seen.set(id, { id, bx, bz, rect: { ix0: bx * n, ix1: bx * n + n - 1, iz0: bz * n, iz1: bz * n + n - 1 } });
  }
  return [...seen.values()].sort((a, b) => a.bz - b.bz || a.bx - b.bx).map(({ id, rect }) => ({ id, rect }));
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
