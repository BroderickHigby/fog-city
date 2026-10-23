// Buildings newer than the footprint layer (world QA W-04).
//
// DataSF's footprints are a 2016 snapshot outlined from the 2010 LiDAR, so blocks built since
// (Mission Rock, Transbay, the Hunters Point Shipyard hilltop, Parkmerced's new rows) are empty
// lots in it. The 2025 assessor roll knows them: a parcel built in or after 2010 with storeys.
//   - The newer-buildings pass: every such parcel with no record within NEAR_M of its point
//     takes its parcel's polygon (DataSF "Parcels – Active and Retired"; a condominium's unit
//     lots share their building's polygon, so one building per polygon) less any footprint
//     already on it, at storeys x storey height. A large lot (LARGE_LOT_M2 or more) of
//     TOWER_MIN_STORIES or more is a podium of PODIUM_STORIES with a tower over TOWER_SHARE of
//     it (towerFootprint, as the LiDAR's two-tier buildings are), the usual SF podium tower.
//   - overrides.json "add" entries: a hand-checked building (a published height, a rectangle cut
//     out of a big lot), which retires the records it stands on.
// New records get ids 201006.9xxxxxx (the pass, numbered in parcel order) and 201006.99xxxxx
// (the overrides), which no DataSF footprint has; meta.outline says where the outline came from.

import { TILE_SIZE_M, tileId, toLocal } from "../../src/geo/project.ts";
import { fitsFootprint, LIDAR_YEAR, MAX_STORIES, minGroundUnder, storyHeight, towerFootprint, type Building, type BuildingMeta, type Override } from "./buildings.ts";
import { cleanRing, dropCollinear, distToRing, interiorPoint, isSimpleRing, pointInRing, r2, signedArea, simplifyRing, type P2 } from "./geom.ts";
import { differenceRings, intersectRing, largest, polyArea } from "./polygon.ts";
import type { RawParcel, RawParcelShape } from "./sources.ts";
import type { Ground } from "./terrain.ts";

/** A parcel point with a record this close (m) is not missing a building. */
export const NEAR_M = 15;
/** A lot whose free part (less the footprints already on it) is under this share is left alone: its building is in the layer. */
export const MIN_FREE_SHARE = 0.4;
export const MIN_NEW_AREA_M2 = 20;
/** A condominium (3+ unit lots on one polygon) whose units list at most 2 storeys stands at least this tall (unit lots carry a unit's floors). */
export const CONDO_MIN_STORIES = 3;
export const LARGE_LOT_M2 = 2500;
export const TOWER_MIN_STORIES = 12;
export const PODIUM_STORIES = 6;
export const TOWER_SHARE = 0.35;
/** A lot whose free part encloses footprints (holes) covering more than this share of it is left alone: those are buildings of their own, not fragments of the new one. */
export const MAX_HOLE_SHARE = 0.25;
/** Parcel outlines are simplified to this tolerance (m). */
export const PARCEL_SIMPLIFY_M = 0.25;

export interface NewerStats {
  /** Roll parcels built in or after 2010 with storeys. */
  candidates: number;
  /** ... with no record within NEAR_M of their point. */
  missing: number;
  /** Polygons (lots) the missing parcels stand on. */
  lots: number;
  /** Lots left alone: most of the lot is already covered by footprints. */
  lotsCovered: number;
  /** Lots whose every parcel lists an implausible storey count (over MAX_STORIES). */
  lotsNoStories: number;
  /** Lots with no polygon in the parcel layer. */
  lotsNoShape: number;
  added: number;
  twoTier: number;
  overridesAdded: string[];
  retired: string[];
  /** Records standing wholly inside a new building's lot (its free part's holes), retired with it. */
  enclosedRetired: string[];
}

const num = (s: string | undefined): number => (s === undefined || s === "" ? NaN : Number(s));

/** The largest outer ring of a parcel polygon, local metres, clockwise-negative like every footprint. */
function lotRing(shape: RawParcelShape["shape"]): P2[] | null {
  if (!shape) return null;
  const polys = shape.type === "Polygon" ? [shape.coordinates as Array<Array<[number, number]>>] : (shape.coordinates as Array<Array<Array<[number, number]>>>);
  let best: P2[] | null = null;
  let bestA = 0;
  for (const p of polys) {
    const ring = cleanRing(p[0]!.map(([lon, lat]) => {
      const q = toLocal(lat, lon);
      return [q.x, q.z] as P2;
    }));
    const a = Math.abs(signedArea(ring));
    if (ring.length >= 3 && a > bestA) {
      best = ring;
      bestA = a;
    }
  }
  if (!best) return null;
  let r = dropCollinear(cleanRing(simplifyRing(best, PARCEL_SIMPLIFY_M)), 0.02);
  if (r.length < 3 || !isSimpleRing(r)) r = best;
  if (signedArea(r) > 0) r = r.reverse();
  return r;
}

/**
 * The largest free part of a ring (less the given footprints), clockwise-negative, and its holes:
 * the footprints standing wholly inside it, touching none of its edges. A record's footprint is
 * one ring, so the new record covers its holes (L-01): the caller retires what stands in them.
 */
function freePart(ring: readonly P2[], others: readonly (readonly P2[])[]): { ring: P2[]; holes: P2[][] } | null {
  let parts;
  try {
    parts = differenceRings(ring, others);
  } catch {
    return null;
  }
  const best = largest(parts);
  if (!best || polyArea(best) < MIN_NEW_AREA_M2) return null;
  let r = dropCollinear(cleanRing(best.outer), 0.02);
  if (r.length < 3 || !isSimpleRing(r)) return null;
  if (signedArea(r) > 0) r = r.reverse();
  return { ring: r, holes: best.holes };
}

/** A rectangle of `size` [across, along] centred at c, aligned with the ring's longest edge. */
function alignedRect(ring: readonly P2[], c: P2, size: readonly [number, number]): P2[] {
  let ux = 1, uz = 0, best = -1;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len > best) {
      best = len;
      ux = (b[0] - a[0]) / len;
      uz = (b[1] - a[1]) / len;
    }
  }
  const vx = -uz, vz = ux;
  const hu = size[1] / 2, hv = size[0] / 2;
  return [
    [c[0] - ux * hu - vx * hv, c[1] - uz * hu - vz * hv],
    [c[0] + ux * hu - vx * hv, c[1] + uz * hu - vz * hv],
    [c[0] + ux * hu + vx * hv, c[1] + uz * hu + vz * hv],
    [c[0] - ux * hu + vx * hv, c[1] - uz * hu + vz * hv],
  ];
}

/** Footprints bucketed on a grid, for "is there a record near this point" and "what is on this lot". */
class FootprintIndex {
  private cells = new Map<number, number[]>();
  readonly list: readonly Building[];
  constructor(list: readonly Building[]) {
    this.list = list;
    list.forEach((b, i) => {
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const [x, z] of b.footprint) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
        z0 = Math.min(z0, z); z1 = Math.max(z1, z);
      }
      for (let cx = Math.floor(x0 / 50); cx <= Math.floor(x1 / 50); cx++) {
        for (let cz = Math.floor(z0 / 50); cz <= Math.floor(z1 / 50); cz++) {
          const k = (cx + 4096) * 8192 + cz + 4096;
          (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push(i);
        }
      }
    });
  }
  near(x0: number, z0: number, x1: number, z1: number): Building[] {
    const seen = new Set<number>();
    const out: Building[] = [];
    for (let cx = Math.floor(x0 / 50); cx <= Math.floor(x1 / 50); cx++) {
      for (let cz = Math.floor(z0 / 50); cz <= Math.floor(z1 / 50); cz++) {
        for (const i of this.cells.get((cx + 4096) * 8192 + cz + 4096) ?? []) {
          if (seen.has(i)) continue;
          seen.add(i);
          out.push(this.list[i]!);
        }
      }
    }
    return out;
  }
  hasRecordNear(x: number, z: number, d: number): boolean {
    for (const b of this.near(x - d, z - d, x + d, z + d)) if (pointInRing(x, z, b.footprint) || distToRing(x, z, b.footprint) <= d) return true;
    return false;
  }
  onRing(ring: readonly P2[]): Building[] {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [x, z] of ring) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    return this.near(x0, z0, x1, z1);
  }
}

const bbox = (ring: readonly P2[]): [number, number, number, number] => {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of ring) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    z0 = Math.min(z0, z); z1 = Math.max(z1, z);
  }
  return [x0, z0, x1, z1];
};
const overlapsBox = (a: readonly number[], b: readonly number[]): boolean => a[0]! <= b[2]! && a[2]! >= b[0]! && a[1]! <= b[3]! && a[3]! >= b[1]!;

interface Spec {
  id: string;
  ring: P2[];
  heightM: number;
  podiumM?: number;
  towerFraction?: number;
  meta: Omit<BuildingMeta, "footY" | "heightM" | "heightSource" | "lidarM">;
}

/** The record(s) of a new building: one prism, or a podium and its "-tower". Null outside the world. */
function records(s: Spec, ground: Ground, tiles: ReadonlySet<string>): Building[] | null {
  const anchor = interiorPoint(s.ring);
  const tile = tileId(Math.floor(anchor[0] / TILE_SIZE_M), Math.floor(anchor[1] / TILE_SIZE_M));
  if (!tiles.has(tile)) return null;
  const under = minGroundUnder(s.ring, ground);
  if (!under) return null;
  const baseY = Math.floor(under.at * 100) / 100;
  const footY = Math.min(baseY, Math.floor((under.min - 0.05) * 100) / 100);
  const meta = (heightM: number): BuildingMeta => ({ footY, heightM: r2(heightM), heightSource: "override", lidarM: [0, 0], ...s.meta });
  if (s.podiumM === undefined || s.towerFraction === undefined) {
    const m = meta(s.heightM);
    if (s.meta.outline === "parcel") m.heightSource = "assessor-stories";
    return [{ id: s.id, tile, footprint: s.ring, baseY, topY: r2(baseY + s.heightM), meta: m }];
  }
  const towerRing = towerFootprint(s.ring, anchor, s.towerFraction);
  const tUnder = minGroundUnder(towerRing, ground) ?? under;
  const tBase = Math.floor(tUnder.at * 100) / 100;
  const podiumTopY = r2(baseY + s.podiumM);
  const podium: Building = { id: s.id, tile, footprint: s.ring, baseY, topY: podiumTopY, meta: { ...meta(s.podiumM), tower: `${s.id}-tower` } };
  const tower: Building = {
    id: `${s.id}-tower`,
    tile,
    footprint: towerRing,
    baseY: tBase,
    topY: r2(baseY + s.heightM),
    meta: { footY: Math.min(tBase, Math.floor((tUnder.min - 0.05) * 100) / 100), heightM: r2(s.heightM), heightSource: podium.meta.heightSource, lidarM: [0, 0], towerOf: s.id, podiumTopY },
  };
  if (s.meta.outline === "parcel") {
    podium.meta.heightSource = "assessor-stories";
    tower.meta.heightSource = "assessor-stories";
  }
  return [podium, tower];
}

/**
 * Add the buildings the footprint layer is missing (see the file comment). Returns the new
 * records and the ids of the records the overrides retire; the caller merges them into the
 * building list before the clearance and terrace passes, which treat them like any other.
 */
export function newerBuildings(
  existing: readonly Building[],
  parcels: readonly RawParcel[],
  shapes: readonly RawParcelShape[],
  overrides: readonly Override[],
  ground: Ground,
  tiles: ReadonlySet<string>,
): { added: Building[]; retired: Set<string>; stats: NewerStats } {
  const stats: NewerStats = { candidates: 0, missing: 0, lots: 0, lotsCovered: 0, lotsNoStories: 0, lotsNoShape: 0, added: 0, twoTier: 0, overridesAdded: [], retired: [], enclosedRetired: [] };
  const idx = new FootprintIndex(existing);
  const shapeOf = new Map<string, RawParcelShape>();
  for (const s of shapes) if (!shapeOf.has(s.blklot) || s.active) shapeOf.set(s.blklot, s);
  const added: Building[] = [];
  const retired = new Set<string>();
  const usedLots = new Set<string>();
  const lotKey = (sh: RawParcelShape): string => JSON.stringify(sh.shape?.coordinates ?? null);

  // Overrides first: they own their lots.
  for (const o of overrides.filter((q) => q.add).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const sh = shapeOf.get(o.parcel!);
    if (!sh) throw new Error(`override ${o.id} (${o.label}): no polygon for parcel ${o.parcel} in the parcel layer`);
    const lot = lotRing(sh.shape);
    if (!lot) throw new Error(`override ${o.id} (${o.label}): parcel ${o.parcel} has no usable polygon`);
    usedLots.add(lotKey(sh));
    let ring = lot;
    if (o.sizeM) {
      const c = o.at ? ((p) => [p.x, p.z] as P2)(toLocal(o.at[0], o.at[1])) : interiorPoint(lot);
      const part = largest(intersectRing(lot, alignedRect(lot, c, o.sizeM)));
      if (!part) throw new Error(`override ${o.id} (${o.label}): its rectangle misses the lot`);
      ring = dropCollinear(cleanRing(part.outer), 0.02);
      if (signedArea(ring) > 0) ring = ring.reverse();
    }
    const scope = o.retire === "lot" ? lot : ring;
    for (const b of idx.onRing(scope)) {
      const p = interiorPoint(b.footprint);
      if (pointInRing(p[0], p[1], scope)) retired.add(b.id);
    }
    const meta: Spec["meta"] = { outline: "override", parcel: o.parcel };
    if (o.year) meta.year = o.year;
    if (o.use) meta.use = o.use;
    if (o.stories) meta.stories = o.stories;
    if (o.units) meta.units = o.units;
    const recs = records({ id: o.id, ring, heightM: o.heightM!, podiumM: o.podiumM, towerFraction: o.towerFraction, meta }, ground, tiles);
    if (!recs) throw new Error(`override ${o.id} (${o.label}): outside the world`);
    added.push(...recs);
    stats.overridesAdded.push(o.id);
  }

  // The pass: parcels built since the LiDAR with storeys and no record near their point.
  const lots = new Map<string, { shape: RawParcelShape; parcels: RawParcel[] }>();
  // Per block, the median plausible storey count of its newer parcels.
  const blockStories = new Map<string, number>();
  {
    const by = new Map<string, number[]>();
    for (const p of parcels) {
      const v = num(p.number_of_stories);
      if (!(num(p.year_property_built) >= LIDAR_YEAR) || !(v > 0 && v <= MAX_STORIES) || !p.block) continue;
      (by.get(p.block) ?? by.set(p.block, []).get(p.block)!).push(v);
    }
    for (const [b, vs] of [...by].sort((a, c) => (a[0] < c[0] ? -1 : 1))) {
      vs.sort((a, c) => a - c);
      blockStories.set(b, vs[Math.floor((vs.length - 1) / 2)]!);
    }
  }
  for (const p of parcels) {
    const year = num(p.year_property_built);
    const stories = num(p.number_of_stories);
    if (!(year >= LIDAR_YEAR) || !(stories > 0) || !p.parcel_number || !p.the_geom) continue;
    stats.candidates++;
    const q = toLocal(p.the_geom.coordinates[1], p.the_geom.coordinates[0]);
    if (idx.hasRecordNear(q.x, q.z, NEAR_M)) continue;
    stats.missing++;
    const sh = shapeOf.get(p.parcel_number);
    if (!sh?.shape) {
      stats.lotsNoShape++;
      continue;
    }
    const k = lotKey(sh);
    if (usedLots.has(k)) continue;
    const l = lots.get(k);
    if (l) l.parcels.push(p);
    else lots.set(k, { shape: sh, parcels: [p] });
  }
  stats.lots = lots.size;
  const ordered = [...lots.values()]
    .map((l) => ({ ...l, parcels: l.parcels.sort((a, b) => (a.parcel_number! < b.parcel_number! ? -1 : 1)) }))
    .sort((a, b) => (a.parcels[0]!.parcel_number! < b.parcels[0]!.parcel_number! ? -1 : 1));
  let seq = 9000001;
  const newRings: P2[][] = [];
  for (const l of ordered) {
    const lot = lotRing(l.shape.shape);
    if (!lot) {
      stats.lotsNoShape++;
      continue;
    }
    const lotBox = bbox(lot);
    const others = [...idx.onRing(lot).map((b) => b.footprint), ...newRings.filter((r) => overlapsBox(bbox(r), lotBox))];
    const free = freePart(lot, others);
    const ring = free?.ring;
    const lotArea = Math.abs(signedArea(lot));
    const holeArea = free ? free.holes.reduce((a, h) => a + Math.abs(signedArea(h)), 0) : 0;
    if (!free || !ring || Math.abs(signedArea(ring)) < MIN_FREE_SHARE * lotArea || holeArea > MAX_HOLE_SHARE * Math.abs(signedArea(ring))) {
      stats.lotsCovered++;
      continue;
    }
    // The footprints in its holes stand inside the new building (an older or partial outline of
    // the same site: two 4-storey fragments on a 4,400 m2 lot of 141 units): they are retired, or
    // they would stand as duplicates inside it (L-01).
    const enclosed = free.holes.length
      ? idx.onRing(lot).filter((b) => {
          const p = interiorPoint(b.footprint);
          return free.holes.some((h) => pointInRing(p[0], p[1], h));
        })
      : [];
    const area = Math.abs(signedArea(ring));
    // Storeys: the most any parcel on the lot lists (condominium units list their own floors).
    const condo = l.parcels.length >= 3;
    const uses = l.parcels.map((p) => p.use_definition?.trim() ?? "").filter(Boolean);
    const allUnits = uses.length > 0 && l.parcels.every((p) => p.use_code === "SRES" || p.use_code === "MRES" || (p.use_definition ?? "").includes("Residential"));
    const use = condo && allUnits ? "Residential Condominium" : [...uses].sort()[0];
    let stories = 0;
    for (const p of l.parcels) {
      const v = num(p.number_of_stories);
      if (v > 0 && v <= MAX_STORIES && v > stories) stories = v;
    }
    if (stories < 1) {
      // Every parcel lists an implausible count (the Shipyard hilltop has 680 and 688): the
      // block's own newer parcels' median count, as its neighbours stand.
      stories = blockStories.get(l.parcels[0]!.block ?? "") ?? 0;
      if (stories < 1) {
        stats.lotsNoStories++;
        continue;
      }
    }
    if (condo && stories <= 2) stories = CONDO_MIN_STORIES;
    while (stories > 1 && !fitsFootprint(stories, use, area)) stories--;
    const storeyM = storyHeight(use);
    const heightM = stories * storeyM + 1.5;
    const year = Math.max(...l.parcels.map((p) => num(p.year_property_built)).filter((v) => v > 0));
    const units = l.parcels.reduce((s, p) => s + Math.max(0, num(p.number_of_units) || 0), 0);
    const meta: Spec["meta"] = { outline: "parcel", parcel: l.parcels[0]!.parcel_number, year, stories };
    if (use) meta.use = use;
    const unitCount = condo ? l.parcels.length : units;
    if (unitCount > 0) meta.units = unitCount;
    if (condo) meta.condo = true;
    const twoTier = area >= LARGE_LOT_M2 && stories >= TOWER_MIN_STORIES;
    const id = `201006.${seq++}`;
    const recs = records(
      twoTier ? { id, ring, heightM, podiumM: PODIUM_STORIES * storeyM + 1.5, towerFraction: TOWER_SHARE, meta } : { id, ring, heightM, meta },
      ground,
      tiles,
    );
    if (!recs) continue;
    if (twoTier) stats.twoTier++;
    for (const b of enclosed) {
      retired.add(b.id);
      stats.enclosedRetired.push(b.id);
    }
    added.push(...recs);
    newRings.push(ring);
    stats.added++;
  }
  stats.retired = [...retired].sort();
  stats.enclosedRetired.sort();
  added.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { added, retired, stats };
}
