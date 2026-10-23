// The places table of hero landmarks (content/landmark-tags.json; house kit K10, world QA W-27
// and L-04): which collider records the pipeline tags meta.landmark, the material they are drawn
// in (no office window grid, no shop band) and whether storefront anchors on them are drawn.
//
// resolveProbe repeats the pipeline's probe rule (pipeline/lib/build.ts probeBuildings: the
// records containing the point, or with radiusM every record within it, else the nearest record
// within 30 m; a podium's tower travels with it), so the content tests can check every entry
// against the committed world without running the pipeline.

import tagsJson from "../../content/landmark-tags.json" with { type: "json" };
import { toLocal } from "../geo/project.ts";

export interface LandmarkMaterial {
  /** sRGB hex colours. */
  wall: string;
  trim: string;
  roof: string;
  note?: string;
}

export interface LandmarkTag {
  id: string;
  /** "building": tags footprint records; "site": a landmark with no record (a prop's place). */
  kind: "building" | "site";
  label: string;
  point: { lat: number; lon: number; radiusM?: number };
  /** Podium record ids (towers and terrace pieces of these are tagged with them). Empty for a site. */
  records: string[];
  material?: string;
  shopBand: false;
  /** Whether storefront anchors on the tagged records are drawn (the Ferry Building's market hall). */
  storefronts: boolean;
  publishedHeightM?: number;
  note?: string;
}

export interface LandmarkTagsFile {
  version: 1;
  materials: Record<string, LandmarkMaterial>;
  landmarks: LandmarkTag[];
}

export const LANDMARK_TAGS = tagsJson as unknown as LandmarkTagsFile;

/** A collider record as the tiles hold it (only what the tagging reads). */
export interface TagRecord {
  id: string;
  footprint: ReadonlyArray<readonly [number, number]>;
  meta?: { tower?: string; towerOf?: string; pieceOf?: string } | null;
}

const BY_RECORD = new Map<string, LandmarkTag>();
for (const l of LANDMARK_TAGS.landmarks) for (const r of l.records) BY_RECORD.set(r, l);

/**
 * The landmark a record belongs to: its own id, its podium's (towerOf) or its parent's
 * (pieceOf, a terrace strip or span piece) is listed. Null for every other record.
 */
export function landmarkTagFor(record: { id: string; meta?: { towerOf?: string; pieceOf?: string } | null }, file: LandmarkTagsFile = LANDMARK_TAGS): LandmarkTag | null {
  const keys = [record.id, record.meta?.towerOf, record.meta?.pieceOf].filter((k): k is string => typeof k === "string");
  if (file === LANDMARK_TAGS) {
    for (const k of keys) {
      const t = BY_RECORD.get(k);
      if (t) return t;
    }
    return null;
  }
  for (const l of file.landmarks) if (keys.some((k) => l.records.includes(k))) return l;
  return null;
}

/** The wall, trim and roof colours a tagged record is drawn in, or null for an untagged record. */
export function landmarkMaterialFor(record: { id: string; meta?: { towerOf?: string; pieceOf?: string } | null }, file: LandmarkTagsFile = LANDMARK_TAGS): LandmarkMaterial | null {
  const t = landmarkTagFor(record, file);
  return t?.material ? (file.materials[t.material] ?? null) : null;
}

/** False when a storefront anchor on this building must not be drawn (a civic landmark). */
export function storefrontAllowedOn(buildingId: string, file: LandmarkTagsFile = LANDMARK_TAGS): boolean {
  const t = landmarkTagFor({ id: buildingId }, file);
  return t === null || t.storefronts;
}

// ---------------------------------------------------------------- probe resolution

type Ring = ReadonlyArray<readonly [number, number]>;

function pointInRing(x: number, z: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i]!;
    const [xj, zj] = ring[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from a point to a ring's boundary, metres. */
export function distToRing(x: number, z: number, ring: Ring): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i]!;
    const [bx, bz] = ring[(i + 1) % ring.length]!;
    const dx = bx - ax;
    const dz = bz - az;
    const l2 = dx * dx + dz * dz;
    let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    best = Math.min(best, Math.hypot(ax + t * dx - x, az + t * dz - z));
  }
  return best;
}

export interface ProbeResult {
  /** Record ids, sorted. */
  buildings: string[];
  /** 0 when the point is inside a record (or within radiusM), else the nearest record's distance. */
  nearestM: number;
  /** How far inside the first containing record the point is (its distance to that record's wall). */
  insideByM: number;
}

/** pipeline/lib/build.ts probeBuildings, for a point given in lat/lon. */
export function resolveProbe(point: { lat: number; lon: number; radiusM?: number }, records: readonly TagRecord[]): ProbeResult {
  const { x, z } = toLocal(point.lat, point.lon);
  const inside = records.filter((b) => pointInRing(x, z, b.footprint) || (point.radiusM !== undefined && distToRing(x, z, b.footprint) <= point.radiusM));
  let ids = inside.map((b) => b.id);
  let nearestM = 0;
  if (ids.length === 0) {
    nearestM = Infinity;
    let nearest = "";
    for (const b of records) {
      const d = distToRing(x, z, b.footprint);
      if (d < nearestM) {
        nearestM = d;
        nearest = b.id;
      }
    }
    ids = nearest && nearestM <= 30 ? [nearest] : [];
  }
  const byId = new Map(records.map((b) => [b.id, b]));
  for (const id of [...ids]) {
    const t = byId.get(id)?.meta?.tower;
    if (t && !ids.includes(t)) ids.push(t);
  }
  const first = inside.find((b) => pointInRing(x, z, b.footprint));
  return { buildings: ids.sort(), nearestM: Number.isFinite(nearestM) ? nearestM : -1, insideByM: first ? distToRing(x, z, first.footprint) : 0 };
}

/** Rules beyond the schema: unique ids and records, a material for every building, none for a site. */
export function checkLandmarkTags(file: LandmarkTagsFile = LANDMARK_TAGS): string[] {
  const errs: string[] = [];
  const ids = new Set<string>();
  const recs = new Map<string, string>();
  for (const l of file.landmarks) {
    if (ids.has(l.id)) errs.push(`${l.id}: duplicate id`);
    ids.add(l.id);
    if (l.kind === "building") {
      if (l.records.length === 0) errs.push(`${l.id}: a building entry lists no records`);
      if (!l.material || !file.materials[l.material]) errs.push(`${l.id}: material ${l.material ?? "(none)"} is not defined`);
    } else {
      if (l.records.length > 0) errs.push(`${l.id}: a site entry lists records`);
      if (l.material) errs.push(`${l.id}: a site entry has a material`);
    }
    for (const r of l.records) {
      const prev = recs.get(r);
      if (prev) errs.push(`${r}: tagged by both ${prev} and ${l.id}`);
      recs.set(r, l.id);
      if (/-tower$|-s\d+$|-b\d+$/.test(r)) errs.push(`${l.id}: list the podium ${r.replace(/-(tower|s\d+|b\d+)$/, "")}, not its tower or piece`);
    }
  }
  return errs;
}
