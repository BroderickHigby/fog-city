// Shared by the content tests that read the committed sf world: its collider records (with the
// facade meta the pipeline keeps in the per-tile JSON), its Analysis Neighborhoods, and the house
// lots the house palette colours (the records pipeline/lib/mesh.ts facadeStyle draws in its
// house class today). Reads committed files only; never the network.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TILE_SIZE_M, toLocal } from "../../src/geo/project.ts";
import type { HouseLot } from "../../src/content/housePalettes.ts";
import { ROOT } from "../helpers.ts";

const SF = join(ROOT, "public/tiles/sf");

export interface SfRecord {
  id: string;
  footprint: Array<[number, number]>;
  baseY: number;
  topY: number;
  meta?: { year?: number; use?: string; parcel?: string; stories?: number; tower?: string; towerOf?: string; pieceOf?: string; heightM?: number };
}

interface DistrictFile {
  districts: Array<{ id: string; polygons: number[][][][]; bbox: [number, number, number, number] }>;
}

/** Records of one tile, or [] where the world has no tile. */
export function tileRecords(ix: number, iz: number): SfRecord[] {
  const p = join(SF, `t${ix}_${iz}.collider.json`);
  if (!existsSync(p)) return [];
  return (JSON.parse(readFileSync(p, "utf8")) as { buildings: SfRecord[] }).buildings;
}

/** Records of the 3 x 3 tiles around a lat/lon. */
export function recordsNear(lat: number, lon: number): SfRecord[] {
  const { x, z } = toLocal(lat, lon);
  const ix = Math.floor(x / TILE_SIZE_M);
  const iz = Math.floor(z / TILE_SIZE_M);
  const out: SfRecord[] = [];
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) out.push(...tileRecords(ix + a, iz + b));
  return out;
}

/** Every record of the committed sf world, tile by tile in manifest order. */
export function allRecords(): SfRecord[] {
  const m = JSON.parse(readFileSync(join(SF, "manifest.json"), "utf8")) as { tiles: Array<{ collider: string }> };
  const out: SfRecord[] = [];
  for (const t of m.tiles) out.push(...(JSON.parse(readFileSync(join(SF, t.collider), "utf8")) as { buildings: SfRecord[] }).buildings);
  return out;
}

function inRing(x: number, z: number, ring: readonly number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i] as [number, number];
    const [xj, zj] = ring[j] as [number, number];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** The DataSF Analysis Neighborhood (public/tiles/sf/districts.json id) containing a point. */
export function districtLookup(): (x: number, z: number) => string | null {
  const d = JSON.parse(readFileSync(join(SF, "districts.json"), "utf8")) as DistrictFile;
  return (x, z) => {
    for (const dist of d.districts) {
      const [x0, z0, x1, z1] = dist.bbox;
      if (x < x0 || x > x1 || z < z0 || z > z1) continue;
      for (const poly of dist.polygons) if (inRing(x, z, poly[0]!) && !poly.slice(1).some((h) => inRing(x, z, h))) return dist.id;
    }
    return null;
  };
}

export function centroid(fp: ReadonlyArray<readonly [number, number]>): [number, number] {
  let x = 0;
  let z = 0;
  for (const [px, pz] of fp) {
    x += px;
    z += pz;
  }
  return [x / fp.length, z / fp.length];
}

/**
 * The house class of pipeline/lib/mesh.ts facadeStyle (its pastel branch): not industrial, not
 * the glass class (60 m or taller, or from 1980 and 25 m or taller), and residential or under
 * 16 m and not an office. Towers wear their podium's style, so they are not lots of their own.
 */
export function isHouseRecord(r: SfRecord): boolean {
  const m = r.meta ?? {};
  if (m.towerOf !== undefined || m.pieceOf !== undefined) return false;
  const h = r.topY - r.baseY;
  const use = (m.use ?? "").toLowerCase();
  const year = m.year ?? null;
  if (use.includes("industrial")) return false;
  if (h >= 60 || (year !== null && year >= 1980 && h >= 25)) return false;
  return use.includes("residential") || (h < 16 && !use.includes("office"));
}

export interface SfHouseLot extends HouseLot {
  use: string;
  parcel: string | null;
}

/** The house lots of a set of records, with their districts. */
export function houseLots(records: readonly SfRecord[]): SfHouseLot[] {
  const districtOf = districtLookup();
  return records.filter(isHouseRecord).map((r) => {
    const [cx, cz] = centroid(r.footprint);
    return { id: r.id, footprint: r.footprint, year: r.meta?.year ?? null, district: districtOf(cx, cz), use: (r.meta?.use ?? "").toLowerCase(), parcel: r.meta?.parcel ?? null };
  });
}
