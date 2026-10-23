// Districts, protected areas, Moat Labs sites, safehouses, activity markers and mode instances:
// the content's map data (content/districts.json, places.json, safehouses.json, activities.json,
// modes/instances.json), plus the pure geometry the territory rules need.
//
// Everything is WGS84 lat/lon in the files; geometry runs in the game's local metres
// (src/geo/project.ts), the frame the sim and the pipeline share.

import activitiesJson from "../../content/activities.json" with { type: "json" };
import districtsJson from "../../content/districts.json" with { type: "json" };
import instancesJson from "../../content/modes/instances.json" with { type: "json" };
import placesJson from "../../content/places.json" with { type: "json" };
import safehousesJson from "../../content/safehouses.json" with { type: "json" };
import { toLocal } from "../geo/project.ts";

/** [lat, lon] */
export type LatLon = readonly [number, number];
export type Polygon = readonly LatLon[];

export interface District {
  id: string;
  name: string;
  step: number;
  wave: number;
  active: boolean;
  hub: { label: string; lat: number; lon: number };
  polygon: LatLon[];
  hook: string;
  analysisNeighborhoods: string[];
}

export interface ProtectedArea {
  id: string;
  name: string;
  /** The four areas with no mode instance (and no local activity or bounty set). */
  excluded: boolean;
  step: number;
  polygon: LatLon[];
}

export interface MoatSite {
  id: string;
  kind: "hq" | "conventionCenter" | "depot";
  label: string;
  lat: number;
  lon: number;
  term: number;
  falloffM: number;
}

export interface Site {
  id: string;
  kind: "safehouse" | "garage";
  garage: boolean;
  wave: number;
  district: string;
  label: string;
  lat: number;
  lon: number;
  blurb: string;
  opensAtThreat: number;
  opensAtStars: number;
  vendor?: string;
}

export interface ActivityMarker {
  id: string;
  name: string;
  kind: string;
  district: string;
  lat: number;
  lon: number;
  wave: number;
  note: string;
}

export interface ModeInstance {
  id: string;
  name: string;
  district: string;
  modes: string[];
  polygon: LatLon[];
}

export const DISTRICTS: readonly District[] = (districtsJson as unknown as { districts: District[] }).districts;
export const PROTECTED_AREAS: readonly ProtectedArea[] = (placesJson as unknown as { protectedAreas: ProtectedArea[] }).protectedAreas;
export const MOAT_SITES: readonly MoatSite[] = (placesJson as unknown as { moatSites: MoatSite[] }).moatSites;
export const BASELINE_BAD_RATE: number = (placesJson as unknown as { badRobotRate: { baseline: number } }).badRobotRate.baseline;
export const SITES: readonly Site[] = (safehousesJson as unknown as { sites: Site[] }).sites;
export const ACTIVITIES: readonly ActivityMarker[] = (activitiesJson as unknown as { activities: ActivityMarker[] }).activities;
export const MODES = (instancesJson as unknown as { modes: Array<{ id: string; name: string; wave: number; alternateName?: string }> }).modes;
export const INSTANCES: readonly ModeInstance[] = (instancesJson as unknown as { instances: ModeInstance[] }).instances;

/** Safehouse or garage within this distance of every active district's hub (design.md, Territory). */
export const SAFEHOUSE_RADIUS_M = 1500;

// ---------------------------------------------------------------------------------------------
// Geometry (local metres)

type XZ = { x: number; z: number };
const xz = (p: LatLon): XZ => toLocal(p[0], p[1]);

export function distanceM(a: LatLon, b: LatLon): number {
  const pa = xz(a);
  const pb = xz(b);
  const dx = pa.x - pb.x, dz = pa.z - pb.z;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Even-odd rule; a point on an edge may land either side. */
export function pointInPolygon(p: LatLon, poly: Polygon): boolean {
  const { x, z } = xz(p);
  const ring = poly.map(xz);
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as XZ;
    const b = ring[j] as XZ;
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

function segDist(p: XZ, a: XZ, b: XZ): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2));
  const ex = p.x - (a.x + t * dx), ez = p.z - (a.z + t * dz);
  return Math.sqrt(ex * ex + ez * ez);
}

/** Distance from a point to a polygon: 0 inside, else to the nearest edge. */
export function distanceToPolygonM(p: LatLon, poly: Polygon): number {
  if (pointInPolygon(p, poly)) return 0;
  const q = xz(p);
  const ring = poly.map(xz);
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) best = Math.min(best, segDist(q, ring[i] as XZ, ring[(i + 1) % ring.length] as XZ));
  return best;
}

function segmentsCross(a: XZ, b: XZ, c: XZ, d: XZ): boolean {
  const o = (p: XZ, q: XZ, r: XZ) => Math.sign((q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}

/** True when two polygons overlap: an edge crossing, or one inside the other. */
export function polygonsIntersect(p: Polygon, q: Polygon): boolean {
  const a = p.map(xz);
  const b = q.map(xz);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (segmentsCross(a[i] as XZ, a[(i + 1) % a.length] as XZ, b[j] as XZ, b[(j + 1) % b.length] as XZ)) return true;
    }
  }
  return pointInPolygon(p[0] as LatLon, q) || pointInPolygon(q[0] as LatLon, p);
}

/** The polygon's area in square metres (shoelace). */
export function areaM2(poly: Polygon): number {
  const r = poly.map(xz);
  let s = 0;
  for (let i = 0; i < r.length; i++) {
    const a = r[i] as XZ;
    const b = r[(i + 1) % r.length] as XZ;
    s += a.x * b.z - b.x * a.z;
  }
  return Math.abs(s) / 2;
}

// ---------------------------------------------------------------------------------------------
// Queries

export function districtById(id: string): District | undefined {
  return DISTRICTS.find((d) => d.id === id);
}

/** Districts whose polygon holds the point (game districts may share an edge). */
export function districtsAt(p: LatLon): District[] {
  return DISTRICTS.filter((d) => pointInPolygon(p, d.polygon));
}

export function protectedAreaAt(p: LatLon): ProtectedArea | undefined {
  return PROTECTED_AREAS.find((a) => pointInPolygon(p, a.polygon));
}

/**
 * The bad-robot share of robots at a point (docs/design.md, The living city): the baseline plus
 * each Moat Labs site's term falling linearly to 0 at its falloff, clamped to the baseline in
 * every protected area. The Doom Clock, events and the night-fog halving are the sim's to apply.
 */
export function badRobotRate(p: LatLon, baseline: number = BASELINE_BAD_RATE): number {
  if (protectedAreaAt(p)) return baseline;
  let r = baseline;
  for (const s of MOAT_SITES) {
    const d = distanceM(p, [s.lat, s.lon]);
    if (d < s.falloffM) r += s.term * (1 - d / s.falloffM);
  }
  return r;
}

/** The nearest safehouse or garage shipped by `wave`, and its distance. */
export function nearestSite(p: LatLon, wave: number): { site: Site; m: number } | null {
  let best: { site: Site; m: number } | null = null;
  for (const s of SITES) {
    if (s.wave > wave) continue;
    const m = distanceM(p, [s.lat, s.lon]);
    if (!best || m < best.m) best = { site: s, m };
  }
  return best;
}
