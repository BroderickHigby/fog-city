// Building footprints -> collider buildings.
//
// Heights: the DataSF footprints carry LiDAR statistics from a June 2010 survey
// (hgt_* = height above ground, gnd_* = ground elevation NAVD88, both cm). We take
//   - an explicit override (pipeline/overrides.json) when one exists;
//   - else the 2025 assessor storey count when the parcel was built in or after 2010 and
//     the LiDAR clearly saw less than the building has (construction site, empty lot);
//   - else the LiDAR: one prism at the max height when max is close to the median, or a
//     two-tier massing (podium at the median, a slimmer tower at the max) when it is not.
// A two-tier building is two collider records: "<id>" (the podium, full footprint) and
// "<id>-tower" (the footprint scaled about its centroid, meta.towerOf = "<id>"). Both start
// at ground level, so a renderer that extrudes colliders draws the right massing; the GLB
// starts the tower at the podium roof.
//
// Ground: baseY is the ground (as the sim sees it) at the footprint's centroid, i.e. the
// building's street level. meta.footY is the lowest ground anywhere under the footprint
// (5 cm below it); on a slope the walls must start there so the downhill side never shows a
// gap, and the GLB's walls do.

import { TILE_SIZE_M, tileId, toLocal } from "../../src/geo/project.ts";
import type { TileRef } from "./config.ts";
import {
  centroid,
  cleanRing,
  dropCollinear,
  interiorPoint,
  pointInRing,
  r2,
  signedArea,
  simplifyRing,
  type P2,
} from "./geom.ts";
import type { RawBuilding, RawParcel } from "./sources.ts";
import type { Ground } from "./terrain.ts";

export const SIMPLIFY_TOL_M = 0.45;
export const MIN_AREA_M2 = 4;
export const MIN_HEIGHT_M = 2.5;
/** The LiDAR behind the footprint heights was flown in June 2010. */
export const LIDAR_YEAR = 2010;

export interface Override {
  id: string;
  parcel?: string;
  label: string;
  heightM: number;
  source: string;
  massing?: "prism";
}

export type HeightSource = "lidar" | "assessor-stories" | "override";

export interface BuildingMeta {
  /** Assessor parcel (block+lot) joined to this footprint. */
  parcel?: string;
  year?: number;
  use?: string;
  stories?: number;
  units?: number;
  /** Lowest ground under the footprint minus 5 cm: where walls start so nothing floats. */
  footY: number;
  /** Height of the highest roof above the building's ground reference, metres. */
  heightM: number;
  heightSource: HeightSource;
  /** LiDAR [median, max] height above ground, metres (2010 survey). */
  lidarM: [number, number];
  /** On a "-tower" record: the podium record's id and roof (absolute y). */
  towerOf?: string;
  podiumTopY?: number;
  /** On a podium record: the id of its tower record. */
  tower?: string;
}

export interface Building {
  id: string;
  tile: string;
  /** Exterior ring, local metres, counter-clockwise on a north-up map, not closed. */
  footprint: P2[];
  /** Ground height at the footprint's centroid (inside point), metres. */
  baseY: number;
  topY: number;
  meta: BuildingMeta;
}

export interface BuildingStats {
  raw: number;
  parts: number;
  kept: number;
  droppedSmall: number;
  droppedOutside: number;
  droppedLow: number;
  joinMblr: number;
  joinPoint: number;
  withYear: number;
  withStories: number;
  heightLidar: number;
  heightStories: number;
  heightOverride: number;
  twoTier: number;
  groundRefFromDem: number;
}

const num = (s: string | undefined): number => (s === undefined || s === "" ? NaN : Number(s));

function storyHeight(use: string | undefined): number {
  const u = (use ?? "").toLowerCase();
  if (u.includes("office")) return 4.0;
  if (u.includes("retail")) return 4.5;
  if (u.includes("industrial")) return 5.0;
  if (u.includes("hotel")) return 3.4;
  if (u.includes("residential")) return 3.2;
  return 3.6;
}

/** Outer rings of a GeoJSON Polygon / MultiPolygon in lon/lat. */
function outerRings(shape: RawBuilding["shape"]): Array<Array<[number, number]>> {
  if (!shape) return [];
  const c = shape.coordinates as unknown;
  if (shape.type === "Polygon") return [(c as Array<Array<[number, number]>>)[0]!];
  if (shape.type === "MultiPolygon") return (c as Array<Array<Array<[number, number]>>>).map((p) => p[0]!);
  return [];
}

class ParcelIndex {
  private cells = new Map<string, Array<{ p: RawParcel; x: number; z: number }>>();
  readonly byNumber = new Map<string, RawParcel>();
  constructor(parcels: RawParcel[]) {
    for (const p of parcels) {
      if (p.parcel_number) this.byNumber.set(p.parcel_number, p);
      const g = p.the_geom?.coordinates;
      if (!g) continue;
      const { x, z } = toLocal(g[1], g[0]);
      const key = `${Math.floor(x / 50)},${Math.floor(z / 50)}`;
      let list = this.cells.get(key);
      if (!list) this.cells.set(key, (list = []));
      list.push({ p, x, z });
    }
  }
  inside(ring: readonly P2[]): RawParcel[] {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const [x, z] of ring) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    const out: RawParcel[] = [];
    for (let cx = Math.floor(minX / 50); cx <= Math.floor(maxX / 50); cx++) {
      for (let cz = Math.floor(minZ / 50); cz <= Math.floor(maxZ / 50); cz++) {
        for (const e of this.cells.get(`${cx},${cz}`) ?? []) if (pointInRing(e.x, e.z, ring)) out.push(e.p);
      }
    }
    return out.sort((a, b) => (a.parcel_number! < b.parcel_number! ? -1 : 1));
  }
}

/** Lowest ground under a footprint, sampled densely enough that no part of it floats. */
export function minGroundUnder(ring: readonly P2[], ground: Ground): { min: number; max: number; at: number } | null {
  let min = Infinity;
  let max = -Infinity;
  // Both the sim's bilinear ground and the rendered mesh's planar triangles, so the base
  // sits at or below whichever surface is lower.
  const take = (x: number, z: number): void => {
    const h = ground.heightAt(x, z);
    const hm = ground.meshHeightAt(x, z);
    if (h === null || hm === null) return;
    const lo = Math.min(h, hm);
    const hi = Math.max(h, hm);
    if (lo < min) min = lo;
    if (hi > max) max = hi;
  };
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, az] = ring[j]!;
    const [bx, bz] = ring[i]!;
    minX = Math.min(minX, bx); maxX = Math.max(maxX, bx);
    minZ = Math.min(minZ, bz); maxZ = Math.max(maxZ, bz);
    const len = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.ceil(len / 2));
    for (let s = 0; s < steps; s++) take(ax + ((bx - ax) * s) / steps, az + ((bz - az) * s) / steps);
  }
  // Lattice points inside: bilinear minima can sit on them.
  const cell = 10;
  for (let x = Math.ceil(minX / cell) * cell; x <= maxX; x += cell) {
    for (let z = Math.ceil(minZ / cell) * cell; z <= maxZ; z += cell) {
      if (pointInRing(x, z, ring)) take(x, z);
    }
  }
  const c = interiorPoint(ring);
  const at = ground.heightAt(c[0], c[1]);
  if (at !== null) take(c[0], c[1]);
  if (!Number.isFinite(min)) return null;
  return { min, max, at: at ?? min };
}

export function buildBuildings(
  raw: RawBuilding[],
  parcels: RawParcel[],
  overrides: Override[],
  tiles: TileRef[],
  ground: Ground,
): { buildings: Building[]; stats: BuildingStats; overridesApplied: string[] } {
  const tileSet = new Set(tiles.map((t) => t.id));
  const pidx = new ParcelIndex(parcels);
  const ov = new Map(overrides.map((o) => [o.id, o]));
  const applied: string[] = [];
  const stats: BuildingStats = {
    raw: raw.length, parts: 0, kept: 0, droppedSmall: 0, droppedOutside: 0, droppedLow: 0,
    joinMblr: 0, joinPoint: 0, withYear: 0, withStories: 0,
    heightLidar: 0, heightStories: 0, heightOverride: 0, twoTier: 0, groundRefFromDem: 0,
  };
  const out: Building[] = [];

  for (const rb of raw) {
    // Rings -> cleaned local polygons, largest first.
    const rings: P2[][] = [];
    for (const r of outerRings(rb.shape)) {
      stats.parts++;
      let ring = cleanRing(r.map(([lon, lat]) => {
        const p = toLocal(lat, lon);
        return [p.x, p.z] as P2;
      }));
      if (ring.length < 3) {
        stats.droppedSmall++;
        continue;
      }
      ring = dropCollinear(cleanRing(simplifyRing(ring, SIMPLIFY_TOL_M)), 0.05);
      const a = signedArea(ring);
      if (ring.length < 3 || Math.abs(a) < MIN_AREA_M2) {
        stats.droppedSmall++;
        continue;
      }
      if (a > 0) ring.reverse();
      rings.push(ring);
    }
    rings.sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));

    rings.forEach((ring, partIndex) => {
      const id = partIndex === 0 ? rb.sf16_bldgid : `${rb.sf16_bldgid}-${partIndex}`;
      const anchor = interiorPoint(ring);
      const tile = tileId(Math.floor(anchor[0] / TILE_SIZE_M), Math.floor(anchor[1] / TILE_SIZE_M));
      if (!tileSet.has(tile)) {
        stats.droppedOutside++;
        return;
      }

      // Assessor join: exact block+lot first, else a parcel point inside the footprint.
      let parcel: RawParcel | undefined;
      let join: "mblr" | "point" | undefined;
      const mblr = rb.mblr?.startsWith("SF") ? rb.mblr.slice(2) : undefined;
      if (mblr && pidx.byNumber.has(mblr)) {
        parcel = pidx.byNumber.get(mblr);
        join = "mblr";
      } else {
        const inside = pidx.inside(ring);
        if (inside.length > 0) {
          // Prefer the parcel that says most about the building.
          parcel = [...inside].sort((a, b) => num(b.number_of_stories) - num(a.number_of_stories) || 0)[0];
          join = "point";
        }
      }
      const year = parcel ? num(parcel.year_property_built) : NaN;
      const stories = parcel ? num(parcel.number_of_stories) : NaN;
      const units = parcel ? num(parcel.number_of_units) : NaN;
      const use = parcel?.use_definition?.trim() || undefined;

      const hMax = num(rb.hgt_maxcm) / 100;
      const hMed = num(rb.hgt_mediancm) / 100;
      const hMean = num(rb.hgt_meancm) / 100;
      const gMed = num(rb.gnd_mediancm) / 100;

      const under = minGroundUnder(ring, ground);
      if (!under) {
        stats.droppedOutside++;
        return;
      }
      // Ground reference for roof heights: the LiDAR's own ground, unless it disagrees with
      // the bare-earth DEM by more than 3 m (2010 excavations, piers), then the DEM.
      let gRef = gMed;
      if (!Number.isFinite(gRef) || Math.abs(gRef - under.at) > 3) {
        gRef = under.at;
        stats.groundRefFromDem++;
      }

      let heightSource: HeightSource;
      let top: number;
      let podium: number | null = null;
      let towerScale = 1;
      const o = ov.get(rb.sf16_bldgid);
      if (o && partIndex === 0) {
        if (o.parcel && o.parcel !== mblr) throw new Error(`override ${o.id}: expected parcel ${o.parcel}, footprint has ${mblr}`);
        heightSource = "override";
        top = o.heightM;
        applied.push(o.id);
      } else if (year >= LIDAR_YEAR && stories > 0 && !(hMed >= stories * 2.0)) {
        heightSource = "assessor-stories";
        top = stories * storyHeight(use) + 1.5;
      } else if (!(hMed >= 2.0) && stories > 0) {
        // The LiDAR saw almost nothing, the assessor says there is a building.
        heightSource = "assessor-stories";
        top = stories * storyHeight(use) + 1.5;
      } else if (!(hMed >= 2.0) || !Number.isFinite(hMax)) {
        stats.droppedLow++;
        return;
      } else {
        heightSource = "lidar";
        if (hMax - hMed <= Math.max(4, 0.3 * hMed)) {
          top = hMax;
        } else {
          top = hMax;
          podium = hMed;
          const f = Number.isFinite(hMean) ? (hMean - hMed) / (hMax - hMed) : 0;
          towerScale = Math.sqrt(Math.min(0.5, Math.max(0.04, f)));
        }
      }

      const baseY = Math.floor(under.at * 100) / 100;
      const footY = Math.min(baseY, Math.floor((under.min - 0.05) * 100) / 100);
      let topY = r2(Math.max(baseY + MIN_HEIGHT_M, gRef + top));
      let towerRecord: Building | null = null;
      if (podium !== null) {
        const podiumTopY = r2(Math.max(baseY + MIN_HEIGHT_M, gRef + podium));
        if (topY - podiumTopY >= 2) {
          const k = towerScale;
          const towerRing = ring.map(([x, z]) => [r2(anchor[0] + (x - anchor[0]) * k), r2(anchor[1] + (z - anchor[1]) * k)] as P2);
          towerRecord = {
            id: `${id}-tower`,
            tile,
            footprint: towerRing,
            baseY,
            topY,
            meta: {
              footY,
              heightM: r2(top),
              heightSource,
              lidarM: [r2(hMed), r2(hMax)],
              towerOf: id,
              podiumTopY,
            },
          };
          topY = podiumTopY;
          top = podium;
          stats.twoTier++;
        }
      }
      const meta: BuildingMeta = {
        footY,
        heightM: r2(top),
        heightSource,
        lidarM: [r2(Number.isFinite(hMed) ? hMed : 0), r2(Number.isFinite(hMax) ? hMax : 0)],
      };
      if (parcel) {
        meta.parcel = parcel.parcel_number;
        if (join === "mblr") stats.joinMblr++;
        else stats.joinPoint++;
      }
      if (year > 1800) {
        meta.year = year;
        stats.withYear++;
      }
      if (use) meta.use = use;
      if (stories > 0) {
        meta.stories = stories;
        stats.withStories++;
      }
      if (units > 0) meta.units = units;
      if (towerRecord) meta.tower = towerRecord.id;
      if (heightSource === "lidar") stats.heightLidar++;
      else if (heightSource === "override") stats.heightOverride++;
      else stats.heightStories++;
      out.push({ id, tile, footprint: ring, baseY, topY, meta });
      if (towerRecord) out.push(towerRecord);
      stats.kept++;
    });
  }
  for (const o of overrides) if (!applied.includes(o.id)) throw new Error(`override ${o.id} (${o.label}) matched no footprint`);
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { buildings: out, stats, overridesApplied: applied };
}

/** Area-weighted centroid, exported for tests and storefront placement. */
export function footprintCentroid(b: Building): P2 {
  return centroid(b.footprint);
}
