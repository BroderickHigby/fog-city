// Storefront anchors from the business registry (DataSF g8m3-pdis).
//
// Only active locations with a storefront NAICS code are used, and no name, owner,
// address or registry id ever leaves this module: an anchor is a NAICS code, a position on
// a street-facing ground-floor wall, the direction it faces, and the building it belongs to.
// Each anchor's id is a hash of the registry row id, stable across rebuilds.

import { createHash } from "node:crypto";
import { toLocal } from "../../src/geo/project.ts";
import type { Building } from "./buildings.ts";
import { bearing, distToRing, distToSegment, pointInRing, r2, type P2 } from "./geom.ts";
import type { RoadEdge } from "./roads.ts";
import type { RawBusiness } from "./sources.ts";
import type { Ground } from "./terrain.ts";

/** Storefront NAICS prefixes (2017 and 2022 NAICS). 44/45 retail minus non-store retail. */
export const INCLUDE_PREFIXES = ["44", "45", "722", "8121", "8123"];
/** 454 = non-store retailers (online, vending, door-to-door); 7223 = caterers, mobile food, contractors. */
export const EXCLUDE_PREFIXES = ["454", "7223"];

export function isStorefrontNaics(code: string | undefined): code is string {
  if (!code || !/^[0-9]{2,6}$/.test(code)) return false;
  if (EXCLUDE_PREFIXES.some((p) => code.startsWith(p))) return false;
  return INCLUDE_PREFIXES.some((p) => code.startsWith(p));
}

/** Coarse category for quick filtering; storefront kits match on the NAICS code itself. */
const CATEGORY_BY_PREFIX: Array<[string, string]> = [
  ["722511", "restaurant"],
  ["722513", "fast-food"],
  ["722514", "restaurant"],
  ["722515", "cafe"],
  ["7225", "restaurant"],
  ["7224", "bar"],
  ["722", "restaurant"],
  ["4451", "grocery"],
  ["4452", "specialty-food"],
  ["4453", "liquor"],
  ["445", "grocery"],
  ["812111", "barber"],
  ["812112", "salon"],
  ["812113", "nails"],
  ["8121", "personal-care"],
  ["8123", "laundry"],
  ["446", "pharmacy"],
  ["456", "pharmacy"],
  ["448", "clothing"],
  ["458", "clothing"],
  ["4531", "florist"],
  ["459310", "florist"],
  ["451", "hobby"],
  ["4592", "hobby"],
  ["4591", "hobby"],
  ["443", "electronics"],
  ["4492", "electronics"],
  ["442", "furniture"],
  ["4491", "furniture"],
  ["444", "hardware"],
  ["441", "auto"],
  ["447", "fuel"],
  ["457", "fuel"],
  ["452", "general"],
  ["455", "general"],
];

export function categoryOf(naics: string): string {
  for (const [p, c] of CATEGORY_BY_PREFIX) if (naics.startsWith(p)) return c;
  return "retail";
}

export interface Storefront {
  id: string;
  x: number;
  z: number;
  y: number;
  /** Compass bearing the shopfront faces (outward, toward the street), radians. */
  heading: number;
  naics: string;
  category: string;
  buildingId: string;
}

export interface StorefrontStats {
  raw: number;
  notStorefrontNaics: number;
  noBuilding: number;
  noFrontage: number;
  kept: number;
}

/** How far an anchor may be from a building to count as "in" it, metres. */
const MAX_BUILDING_DIST_M = 20;
/** Minimum spacing between two shopfronts on one building, metres. */
const SPACING_M = 5;
/** A wall faces a street if a drivable centerline is within this distance of its midpoint. */
const STREET_DIST_M = 30;

export class BuildingIndex {
  private cells = new Map<string, Building[]>();
  constructor(bs: readonly Building[]) {
    for (const b of bs) {
      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
      for (const [x, z] of b.footprint) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      }
      for (let cx = Math.floor(minX / 50); cx <= Math.floor(maxX / 50); cx++) {
        for (let cz = Math.floor(minZ / 50); cz <= Math.floor(maxZ / 50); cz++) {
          const k = `${cx},${cz}`;
          let l = this.cells.get(k);
          if (!l) this.cells.set(k, (l = []));
          l.push(b);
        }
      }
    }
  }
  near(x: number, z: number, r: number): Building[] {
    const out = new Set<Building>();
    for (let cx = Math.floor((x - r) / 50); cx <= Math.floor((x + r) / 50); cx++) {
      for (let cz = Math.floor((z - r) / 50); cz <= Math.floor((z + r) / 50); cz++) {
        for (const b of this.cells.get(`${cx},${cz}`) ?? []) out.add(b);
      }
    }
    return [...out].sort((a, b) => (a.id < b.id ? -1 : 1));
  }
}

class SegmentIndex {
  private cells = new Map<string, Array<[P2, P2]>>();
  constructor(edges: readonly RoadEdge[]) {
    for (const e of edges) {
      if (e.pedestrian || e.kind === "freeway" || e.kind === "ramp") continue;
      for (let i = 1; i < e.points.length; i++) {
        const a = e.points[i - 1]!;
        const b = e.points[i]!;
        const minX = Math.min(a[0], b[0]), maxX = Math.max(a[0], b[0]);
        const minZ = Math.min(a[1], b[1]), maxZ = Math.max(a[1], b[1]);
        for (let cx = Math.floor(minX / 50); cx <= Math.floor(maxX / 50); cx++) {
          for (let cz = Math.floor(minZ / 50); cz <= Math.floor(maxZ / 50); cz++) {
            const k = `${cx},${cz}`;
            let l = this.cells.get(k);
            if (!l) this.cells.set(k, (l = []));
            l.push([a, b]);
          }
        }
      }
    }
  }
  nearest(x: number, z: number, r: number): number {
    let best = Infinity;
    for (let cx = Math.floor((x - r) / 50); cx <= Math.floor((x + r) / 50); cx++) {
      for (let cz = Math.floor((z - r) / 50); cz <= Math.floor((z + r) / 50); cz++) {
        for (const [a, b] of this.cells.get(`${cx},${cz}`) ?? []) {
          const d = distToSegment(x, z, a, b).d;
          if (d < best) best = d;
        }
      }
    }
    return best;
  }
}

interface Wall {
  a: P2;
  b: P2;
  len: number;
  /** Outward unit normal. */
  nx: number;
  nz: number;
  street: number;
}

/** Street-facing walls of a footprint (CCW on a north-up map = negative shoelace in x,z). */
function frontageWalls(b: Building, roads: SegmentIndex): Wall[] {
  const walls: Wall[] = [];
  const ring = b.footprint;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const c = ring[(i + 1) % ring.length]!;
    const dx = c[0] - a[0];
    const dz = c[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 3) continue;
    // For a ring with negative shoelace area in (x, z), the outward normal is (-dz, dx)/len.
    let nx = -dz / len;
    let nz = dx / len;
    const mx = (a[0] + c[0]) / 2;
    const mz = (a[1] + c[1]) / 2;
    if (pointInRing(mx + nx * 0.5, mz + nz * 0.5, ring)) {
      nx = -nx;
      nz = -nz;
    }
    const street = roads.nearest(mx + nx * 1.5, mz + nz * 1.5, STREET_DIST_M);
    if (street > STREET_DIST_M) continue;
    walls.push({ a, b: c, len, nx, nz, street });
  }
  return walls;
}

/** Another (podium) building covering the point, if any. */
function buildingAt(idx: BuildingIndex, x: number, z: number, self: Building): boolean {
  for (const o of idx.near(x, z, 1)) if (o !== self && o.meta.towerOf === undefined && pointInRing(x, z, o.footprint)) return true;
  return false;
}

export function buildStorefronts(
  raw: RawBusiness[],
  buildings: readonly Building[],
  edges: readonly RoadEdge[],
  ground: Ground,
): { storefronts: Storefront[]; stats: StorefrontStats } {
  const stats: StorefrontStats = { raw: raw.length, notStorefrontNaics: 0, noBuilding: 0, noFrontage: 0, kept: 0 };
  const bidx = new BuildingIndex(buildings);
  const roads = new SegmentIndex(edges);

  // Assign each business to a building.
  const byBuilding = new Map<Building, Array<{ id: string; naics: string; x: number; z: number }>>();
  const sorted = [...raw].sort((a, b) => (a.uniqueid < b.uniqueid ? -1 : 1));
  for (const r of sorted) {
    const code = r.self_reported_naics_code?.trim();
    if (!isStorefrontNaics(code)) {
      stats.notStorefrontNaics++;
      continue;
    }
    const g = r.location?.coordinates;
    if (!g) {
      stats.noBuilding++;
      continue;
    }
    const { x, z } = toLocal(g[1], g[0]);
    let host: Building | undefined;
    let hostD = Infinity;
    for (const b of bidx.near(x, z, MAX_BUILDING_DIST_M)) {
      if (b.meta.towerOf !== undefined) continue; // the podium record owns the ground floor
      const d = pointInRing(x, z, b.footprint) ? 0 : distToRing(x, z, b.footprint);
      if (d < hostD) {
        hostD = d;
        host = b;
      }
    }
    if (!host || hostD > MAX_BUILDING_DIST_M) {
      stats.noBuilding++;
      continue;
    }
    const id = `sf-${createHash("sha256").update(r.uniqueid).digest("hex").slice(0, 12)}`;
    let list = byBuilding.get(host);
    if (!list) byBuilding.set(host, (list = []));
    list.push({ id, naics: code, x, z });
  }

  const out: Storefront[] = [];
  const hosts = [...byBuilding.keys()].sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const b of hosts) {
    const walls = frontageWalls(b, roads);
    const list = byBuilding.get(b)!.sort((p, q) => (p.id < q.id ? -1 : 1));
    if (walls.length === 0) {
      stats.noFrontage += list.length;
      continue;
    }
    // Slots: positions every SPACING_M along each street-facing wall, inset from corners.
    const slots: Array<{ x: number; z: number; w: Wall; used: boolean }> = [];
    for (const w of walls) {
      const n = Math.max(1, Math.floor((w.len - 2) / SPACING_M));
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        const x = w.a[0] + (w.b[0] - w.a[0]) * t;
        const z = w.a[1] + (w.b[1] - w.a[1]) * t;
        // A real shopfront: 2.5 m of open ground in front, the building just behind (rules out
        // light wells and notches).
        if ([0.5, 1.5, 2.5].some((d) => pointInRing(x + w.nx * d, z + w.nz * d, b.footprint))) continue;
        if (!pointInRing(x - w.nx * 0.6, z - w.nz * 0.6, b.footprint)) continue;
        if (buildingAt(bidx, x + w.nx * 1.5, z + w.nz * 1.5, b)) continue;
        slots.push({ x, z, w, used: false });
      }
    }
    for (const s of list) {
      // Nearest free slot to the registry point; ties broken by slot order (deterministic).
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < slots.length; i++) {
        const sl = slots[i]!;
        if (sl.used) continue;
        const d = Math.hypot(sl.x - s.x, sl.z - s.z) + sl.w.street * 0.25;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best < 0) {
        stats.noFrontage++;
        continue;
      }
      const sl = slots[best]!;
      sl.used = true;
      const x = sl.x + sl.w.nx * 0.3;
      const z = sl.z + sl.w.nz * 0.3;
      out.push({
        id: s.id,
        x: r2(x),
        z: r2(z),
        y: r2(ground.heightAt(x, z) ?? b.baseY),
        heading: Math.round(bearing(sl.w.nx, sl.w.nz) * 10000) / 10000,
        naics: s.naics,
        category: categoryOf(s.naics),
        buildingId: b.id,
      });
      stats.kept++;
    }
  }
  out.sort((a, b) => (a.id < b.id ? -1 : 1));
  return { storefronts: out, stats };
}
