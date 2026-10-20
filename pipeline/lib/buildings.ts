// Building footprints -> collider buildings.
//
// Heights: the DataSF footprints carry LiDAR statistics from a June 2010 survey
// (hgt_* = height above ground, gnd_* = ground elevation NAVD88, both cm). We take
//   - an explicit override (pipeline/overrides.json) when one exists;
//   - else the 2025 assessor storey count when the parcel was built in or after 2010 and
//     the LiDAR clearly saw less than the building has (construction site, empty lot);
//   - else the LiDAR: one prism at the max height when max is close to the median; one prism
//     at the median when the max is tree canopy over a low house; a two-tier massing (podium
//     at the median, a slimmer tower at the max) when the statistics describe a tower of
//     plausible size (towerFraction, plausibleTower) and the assessor does not contradict a
//     thin one (isLidarSpike); otherwise the max is an outlier (edge bleed from a neighbour,
//     a single return, a tree) and the building is one prism at the median plus a rooftop
//     allowance.
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
  cleanRing,
  clipToConvex,
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
/** A tower must cover at least this much ground (m²)... */
export const MIN_TOWER_AREA_M2 = 25;
/** ...and rise above its podium at most this many times its width (√area). */
export const MAX_TOWER_SLENDERNESS = 10;
/** A roof whose max is rejected as an outlier: median + max(3 m, 10 % of the median), at most the max. */
export const ROOF_ALLOWANCE_M = 3;
export const ROOF_ALLOWANCE_FRAC = 0.1;
/** Parcels sharing one block and one point: condominium units of one building. */
export const CONDO_MIN_UNITS = 3;
/**
 * Assessor storey counts above this are data-entry noise (the roll has 999, 752, 591...;
 * San Francisco's tallest building has 61 floors) and are ignored. Wave 1 used 70, wave 2
 * 64; the 2025 roll has nothing between 63 and 75, so both give the same world.
 */
export const MAX_STORIES = 64;
/** The LiDAR behind the footprint heights was flown in June 2010. */
export const LIDAR_YEAR = 2010;
/** An assessor-storey height must also fit the footprint: height <= this x sqrt(area) (slender towers reach ~8). */
export const MAX_SLENDERNESS = 8;
/**
 * Trees over houses (wave 2): the LiDAR max over a low residential building is often the
 * canopy above it. A residential building of at most this many assessor storeys gets no tower
 * taller than storeys x 4.5 m + 8 m; its roof is outlierRoof() instead.
 */
export const CANOPY_MAX_STORIES = 4;
/**
 * LiDAR spikes (wave 2), a second guard behind plausibleTower: a "tower" this small (m²) over a
 * podium under SPIKE_PODIUM_M, rising more than SPIKE_RISE_M above it, is usually the scan
 * catching a neighbouring tower, a crane or a tree (one 3-storey office got a 111 m tower).
 * It is dropped when the assessor's storeys disagree (taller than storeys x 4.5 m + 20 m) or,
 * with no storey count, when it is more than 4 times the podium. Real steeples and rooftop
 * structures of this size stay. See thinTowers / spikeTowersDropped in report.json.
 */
export const THIN_TOWER_MAX_AREA_M2 = 60;
export const SPIKE_PODIUM_M = 15;
export const SPIKE_RISE_M = 15;

/** A thin tower (any source): footprint under THIN_TOWER_MAX_AREA_M2 rising SPIKE_RISE_M+ over a podium under SPIKE_PODIUM_M. */
export function isThinTower(towerAreaM2: number, podiumM: number, towerM: number): boolean {
  return towerAreaM2 < THIN_TOWER_MAX_AREA_M2 && podiumM < SPIKE_PODIUM_M && towerM - podiumM > SPIKE_RISE_M;
}

/** A thin tower the assessor (or its own proportions) says is not part of the building. */
export function isLidarSpike(towerAreaM2: number, podiumM: number, towerM: number, stories: number): boolean {
  if (!isThinTower(towerAreaM2, podiumM, towerM)) return false;
  return stories > 0 ? towerM > stories * 4.5 + 20 : towerM > 4 * podiumM;
}

export interface Override {
  id: string;
  parcel?: string;
  label: string;
  heightM: number;
  source: string;
}

export type HeightSource = "lidar" | "assessor-stories" | "override";

export interface BuildingMeta {
  /** Assessor parcel (block+lot) joined to this footprint. */
  parcel?: string;
  year?: number;
  use?: string;
  stories?: number;
  units?: number;
  /** The parcel is one unit of a condominium building (its storeys and use describe the unit). */
  condo?: boolean;
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
  /** LiDAR max rejected as an outlier (no tower of plausible size behind it). */
  maxOutlier: number;
  condo: number;
  /** Assessor storeys dropped because the LiDAR height contradicts them. */
  storiesImplausible: number;
  groundRefFromDem: number;
  /** Assessor storey counts ignored as implausible (above MAX_STORIES, or too slender for the footprint). */
  storiesRejected: number;
  /** Towers not built because they are tree canopy over a low residential building. */
  canopyTowersDropped: number;
  /** Thin towers not built because they are LiDAR spikes (isLidarSpike). */
  spikeTowersDropped: number;
  /** Thin towers kept (isThinTower), and the tallest of them above its own ground (m). */
  thinTowers: number;
  thinTowerMaxM: number;
}

const num = (s: string | undefined): number => (s === undefined || s === "" ? NaN : Number(s));
const storiesOf = (p: RawParcel): number => {
  const v = num(p.number_of_stories);
  return v > 0 && v <= MAX_STORIES ? v : NaN;
};

function storyHeight(use: string | undefined): number {
  const u = (use ?? "").toLowerCase();
  if (u.includes("office")) return 4.0;
  if (u.includes("retail")) return 4.5;
  if (u.includes("industrial")) return 5.0;
  if (u.includes("hotel")) return 3.4;
  if (u.includes("residential")) return 3.2;
  return 3.6;
}

/** Can a footprint of `area` m² carry `stories` storeys of `use`? (height <= MAX_SLENDERNESS x sqrt(area)) */
function fitsFootprint(stories: number, use: string | undefined, area: number): boolean {
  return !(stories > 0) || stories * storyHeight(use) + 1.5 <= MAX_SLENDERNESS * Math.sqrt(area);
}

/** Outer rings of a GeoJSON Polygon / MultiPolygon in lon/lat. */
function outerRings(shape: RawBuilding["shape"]): Array<Array<[number, number]>> {
  if (!shape) return [];
  const c = shape.coordinates as unknown;
  if (shape.type === "Polygon") return [(c as Array<Array<[number, number]>>)[0]!];
  if (shape.type === "MultiPolygon") return (c as Array<Array<Array<[number, number]>>>).map((p) => p[0]!);
  return [];
}

const siblingKey = (p: RawParcel): string | null => {
  const g = p.the_geom?.coordinates;
  return g && p.block ? `${p.block}@${g[0].toFixed(5)},${g[1].toFixed(5)}` : null;
};

class ParcelIndex {
  private cells = new Map<string, Array<{ p: RawParcel; x: number; z: number }>>();
  private atPoint = new Map<string, RawParcel[]>();
  readonly byNumber = new Map<string, RawParcel>();
  constructor(parcels: RawParcel[]) {
    for (const p of parcels) {
      if (p.parcel_number) this.byNumber.set(p.parcel_number, p);
      const sk = siblingKey(p);
      if (sk) {
        let l = this.atPoint.get(sk);
        if (!l) this.atPoint.set(sk, (l = []));
        l.push(p);
      }
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
  /** Parcels in the same block at the same point (within ~1 m), the parcel itself included. */
  siblings(p: RawParcel): RawParcel[] {
    const sk = siblingKey(p);
    return (sk && this.atPoint.get(sk)) || [p];
  }
}

/**
 * Area fraction of a footprint covered by a tower at the LiDAR max, from the height
 * statistics, under a three-level model: a fraction `a` at the max, a fraction `b` near
 * ground level (courtyards, light wells, low wings), the rest at the median roof. Matching
 * the first two moments about the median gives
 *   a = (std² + m1² + m1·median) / (d·(d + median)),  b = (a·d − m1) / median,
 * with d = max − median and m1 = mean − median. When b comes out negative there is no low
 * part and the two-level estimate a = m1 / d is used. Clamped to [0, 0.5].
 * A single LiDAR return or a sliver of a neighbour's wall at the max gives a tiny a.
 */
export function towerFraction(median: number, max: number, mean: number, std: number): number {
  const d = max - median;
  if (!(d > 0) || !Number.isFinite(mean)) return 0;
  const m1 = mean - median;
  let a = m1 / d;
  if (Number.isFinite(std) && median > 0) {
    const a3 = (std * std + m1 * m1 + m1 * median) / (d * (d + median));
    if (a3 * d - m1 >= 0) a = a3;
  }
  return Math.min(0.5, Math.max(0, a));
}

/** Does a tower of `fraction` of `footprintArea` that rises `rise` m above its podium look like a building? */
export function plausibleTower(footprintArea: number, fraction: number, rise: number): boolean {
  const area = footprintArea * fraction;
  return area >= MIN_TOWER_AREA_M2 && rise <= MAX_TOWER_SLENDERNESS * Math.sqrt(area);
}

/** The roof of a building whose LiDAR max is rejected: median + max(3 m, 10 % of it), never above the max. */
export function outlierRoof(median: number, max: number): number {
  return median + Math.min(max - median, Math.max(ROOF_ALLOWANCE_M, ROOF_ALLOWANCE_FRAC * median));
}

/**
 * Assessor storeys that contradict the measured height (a condo unit's own floors, a parcel's
 * storey count on a low wing of a tower) are not facts about this footprint.
 */
export function plausibleStories(stories: number, heightM: number): boolean {
  return stories * 6 + 15 >= heightM && stories * 2.4 <= heightM + 10;
}

/**
 * The tower of a two-tier building: the footprint clipped to a square of `fraction` of its
 * area, centred on the anchor and aligned with the longest wall, so a long hall gets a
 * compact tower rather than a long slab. Where the building is narrower than the square,
 * the square is lengthened along the wall to keep the area. Falls back to scaling the
 * footprint about the anchor if clipping degenerates.
 */
export function towerFootprint(ring: readonly P2[], anchor: P2, fraction: number): P2[] {
  const target = Math.abs(signedArea(ring)) * fraction;
  let ux = 1;
  let uz = 0;
  let best = -1;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len > best) {
      best = len;
      ux = (b[0] - a[0]) / len;
      uz = (b[1] - a[1]) / len;
    }
  }
  const vx = -uz;
  const vz = ux;
  const side = Math.sqrt(target);
  let along = side;
  let result: P2[] = [];
  for (let iter = 0; iter < 4; iter++) {
    const hu = along / 2;
    const hv = side / 2;
    const square: P2[] = [
      [anchor[0] - ux * hu - vx * hv, anchor[1] - uz * hu - vz * hv],
      [anchor[0] + ux * hu - vx * hv, anchor[1] + uz * hu - vz * hv],
      [anchor[0] + ux * hu + vx * hv, anchor[1] + uz * hu + vz * hv],
      [anchor[0] - ux * hu + vx * hv, anchor[1] - uz * hu + vz * hv],
    ];
    result = dropCollinear(cleanRing(clipToConvex(ring, square)), 0.05);
    const area = result.length >= 3 ? Math.abs(signedArea(result)) : 0;
    if (area >= target * 0.9 || area <= 0) break;
    along *= Math.min(4, target / area);
  }
  if (result.length < 3 || Math.abs(signedArea(result)) < MIN_AREA_M2) {
    const k = Math.sqrt(fraction);
    result = ring.map(([x, z]) => [r2(anchor[0] + (x - anchor[0]) * k), r2(anchor[1] + (z - anchor[1]) * k)] as P2);
  }
  if (signedArea(result) > 0) result.reverse();
  return result;
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
    heightLidar: 0, heightStories: 0, heightOverride: 0, twoTier: 0, maxOutlier: 0, condo: 0, storiesImplausible: 0,
    groundRefFromDem: 0, storiesRejected: 0, canopyTowersDropped: 0, spikeTowersDropped: 0, thinTowers: 0, thinTowerMaxM: 0,
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
          parcel = [...inside].sort((a, b) => (storiesOf(b) || 0) - (storiesOf(a) || 0))[0];
          join = "point";
        }
      }
      const year = parcel ? num(parcel.year_property_built) : NaN;
      // The joined parcel's own storeys: the only storeys a height is ever computed from.
      // Counts above MAX_STORIES, or implying a height the footprint cannot carry, are ignored.
      const area = Math.abs(signedArea(ring));
      let parcelStories = parcel ? storiesOf(parcel) : NaN;
      if (parcel && (num(parcel.number_of_stories) > MAX_STORIES || !fitsFootprint(parcelStories, parcel.use_definition, area))) {
        stats.storiesRejected++;
        parcelStories = NaN;
      }
      // Storeys reported in meta (checked against the LiDAR height below).
      let stories = parcelStories;
      let units = parcel ? num(parcel.number_of_units) : NaN;
      let use = parcel?.use_definition?.trim() || undefined;
      // A condominium building is many unit parcels on one point; the joined parcel's storeys
      // and use describe one unit (often "Single Family Residential", 1 storey). For meta, take
      // the building's storeys as the most any unit records and count the units.
      const siblings = parcel ? pidx.siblings(parcel) : [];
      const condo = siblings.length >= CONDO_MIN_UNITS;
      if (condo) {
        stories = siblings.reduce((m, q) => {
          const v = storiesOf(q);
          return v > 0 && !(m >= v) && fitsFootprint(v, q.use_definition, area) ? v : m;
        }, NaN);
        units = siblings.length;
        if (siblings.every((q) => q.use_code === "SRES" || q.use_code === "MRES")) use = "Residential Condominium";
      }

      const hMax = num(rb.hgt_maxcm) / 100;
      const hMed = num(rb.hgt_mediancm) / 100;
      const hMean = num(rb.hgt_meancm) / 100;
      const hStd = num(rb.hgt_stdcm) / 100;
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
      let towerFrac = 0;
      const o = ov.get(rb.sf16_bldgid);
      if (o && partIndex === 0) {
        if (o.parcel && o.parcel !== mblr) throw new Error(`override ${o.id}: expected parcel ${o.parcel}, footprint has ${mblr}`);
        heightSource = "override";
        top = o.heightM;
        applied.push(o.id);
      } else if (year >= LIDAR_YEAR && parcelStories > 0 && !(hMed >= parcelStories * 2.0)) {
        heightSource = "assessor-stories";
        top = parcelStories * storyHeight(use) + 1.5;
      } else if (!(hMed >= 2.0) && parcelStories > 0) {
        // The LiDAR saw almost nothing, the assessor says there is a building.
        heightSource = "assessor-stories";
        top = parcelStories * storyHeight(use) + 1.5;
      } else if (!(hMed >= 2.0) || !Number.isFinite(hMax)) {
        stats.droppedLow++;
        return;
      } else {
        heightSource = "lidar";
        const d = hMax - hMed;
        // Tree canopy over a low house (the building's storeys: a condo's, not one unit's).
        const lowHouse = (use ?? "").toLowerCase().includes("residential") && stories >= 1 && stories <= CANOPY_MAX_STORIES;
        if (d <= Math.max(4, 0.3 * hMed)) {
          top = hMax;
        } else {
          // The moment model decides first; canopy and spike checks only ever remove a tower.
          const f = towerFraction(hMed, hMax, hMean, hStd);
          if (!plausibleTower(area, f, d)) {
            top = outlierRoof(hMed, hMax);
            stats.maxOutlier++;
          } else if (lowHouse && hMax > stories * 4.5 + 8) {
            // A plausible-looking tower over a low house is the trees over its roof.
            top = outlierRoof(hMed, hMax);
            stats.canopyTowersDropped++;
          } else {
            top = hMax;
            podium = hMed;
            towerFrac = f;
          }
        }
      }

      const baseY = Math.floor(under.at * 100) / 100;
      const footY = Math.min(baseY, Math.floor((under.min - 0.05) * 100) / 100);
      let topY = r2(Math.max(baseY + MIN_HEIGHT_M, gRef + top));
      let towerRecord: Building | null = null;
      if (podium !== null) {
        const podiumTopY = r2(Math.max(baseY + MIN_HEIGHT_M, gRef + podium));
        const towerRing = topY - podiumTopY >= 2 ? towerFootprint(ring, anchor, towerFrac) : null;
        const towerArea = towerRing ? Math.abs(signedArea(towerRing)) : 0;
        if (towerRing && isLidarSpike(towerArea, podium, top, stories)) {
          // A tower the moment model accepts but the assessor contradicts: the max is an
          // outlier after all, and the building is one prism like any other outlier.
          stats.spikeTowersDropped++;
          top = outlierRoof(podium, top);
          topY = r2(Math.max(baseY + MIN_HEIGHT_M, gRef + top));
        } else if (towerRing) {
          if (isThinTower(towerArea, podium, top)) {
            stats.thinTowers++;
            stats.thinTowerMaxM = Math.max(stats.thinTowerMaxM, r2(top));
          }
          // The tower's own street level and foot (its centroid can sit off the podium's).
          const tUnder = minGroundUnder(towerRing, ground) ?? under;
          const tBase = Math.floor(tUnder.at * 100) / 100;
          towerRecord = {
            id: `${id}-tower`,
            tile,
            footprint: towerRing,
            baseY: tBase,
            topY,
            meta: {
              footY: Math.min(tBase, Math.floor((tUnder.min - 0.05) * 100) / 100),
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
      if (heightSource === "assessor-stories") stories = parcelStories;
      if (stories > 0 && heightSource === "lidar" && !plausibleStories(stories, towerRecord ? towerRecord.meta.heightM : top)) {
        stats.storiesImplausible++;
      } else if (stories > 0) {
        meta.stories = stories;
        stats.withStories++;
      }
      if (units > 0) meta.units = units;
      if (condo) {
        meta.condo = true;
        stats.condo++;
      }
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
