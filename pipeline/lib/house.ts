// House-kit data (world QA W-15, W-29, W-37, W-38, W-46 to W-50; docs/qa/house-kit-spec.md K0-K8):
// for every building record, the street level its facade starts from, the class of each wall,
// a believable storey height, and per tile the list of front walls the renderer lays the kit on.
//
//   * streetY (K0, W-29): the sim's ground at the middle of the record's street wall: of its walls
//     3 m or longer, the one whose middle is nearest a street (a vehicular centreline less half the
//     road's width) within STREET_WALL_M; the facade's storey grid starts there (uv v = 0).
//   * wall classes (K1, W-46): per footprint edge, party where another record's outline runs within
//     PARTY_M along at least PARTY_SHARE of it; front where a street or path centreline lies within
//     its half width + FRONT_M straight out from the wall's middle; else rear (side or rear). The
//     glb's _FACADE.w carries it: 0 rear, 85 party, 170 front, 255 roof.
//   * storeys (K2, W-15): a residential record's storeys are its wall height (roof line less a roof
//     allowance, from the street) over 3.2 m, rounded, each at most 4.2 m; a 1920-1960 row house
//     shows at least its assessor storeys plus its garage storey; assessor storeys implying more
//     than 4.5 m (6 m for other uses) per storey are ignored.
//   * fronts (K4-K8): per tile, every front wall of a record that gets a kit feature, with what the
//     assets' layout maths needs (house-kit.ts): the facade frame (the wall's middle at street
//     level, the bearing it faces), its length, the first floor's rise over the sidewalk, the
//     storeys and storey height, and flags for bays, stoops, garage doors, shopfronts and roofline
//     mouldings.

import type { Building } from "./buildings.ts";
import { bearing, distToSegment, pointInRing, r2, type P2 } from "./geom.ts";
import type { RoadEdge } from "./roads.ts";
import type { Ground } from "./terrain.ts";

export const STREET_WALL_M = 6;
export const PARTY_M = 0.6;
export const PARTY_SHARE = 0.6;
export const FRONT_M = 12;
/** Wall classes as the glb's _FACADE.w byte. */
export const WALL_REAR = 0;
export const WALL_PARTY = 85;
export const WALL_FRONT = 170;
export const WALL_ROOF = 255;

/** Front flags (fronts rows, the last column). */
export const FRONT_BAY = 1;
export const FRONT_STOOP = 2;
export const FRONT_GARAGE = 4;
export const FRONT_SHOP = 8;
export const FRONT_ROOFLINE = 16;

/** Bays on residential fronts this long or longer, built in or before BAY_MAX_YEAR (K6). */
export const BAY_MIN_FRONT_M = 4.5;
export const BAY_MAX_YEAR = 1925;
/** A stoop where the first floor stands this far over the sidewalk (K7). */
export const STOOP_MIN_RISE_M = 1;
/** Garage doors on residential rows of these years and frontages (K4). */
export const GARAGE_YEARS: readonly [number, number] = [1920, 1960];
export const GARAGE_FRONT_M: readonly [number, number] = [5, 16];
/** Roofline mouldings (cornice, parapet) on residential and mixed fronts built before this (K8). */
export const ROOFLINE_MAX_YEAR = 1940;

export const RES_STOREY_M = 3.2;
export const RES_STOREY_MAX_M = 4.2;
export const STOREY_MIN_M = 2.6;

export interface HouseInfo {
  /** The ground at the street wall, absolute y (absent: no street wall; the facade starts at baseY). */
  streetY?: number;
  /** Per footprint edge (edge i runs from vertex i to i + 1): WALL_REAR, WALL_PARTY or WALL_FRONT. */
  walls: number[];
  /** Storey height the facade is drawn with, metres. */
  storeyM: number;
  /** Storeys the facade shows from the street. */
  storeys: number;
}

const isResidential = (b: Building): boolean => {
  const use = (b.meta.use ?? "").toLowerCase();
  return use.includes("residential") || (use === "" && b.topY - b.baseY < 16);
};

/** Street segments (vehicular, or every non-freeway edge) on a grid. */
class Segments {
  private cells = new Map<number, Array<[P2, P2, number]>>();
  constructor(edges: readonly RoadEdge[], keep: (e: RoadEdge) => boolean) {
    for (const e of edges) {
      if (!keep(e)) continue;
      const hw = e.widthM / 2;
      for (let i = 1; i < e.points.length; i++) {
        const a = e.points[i - 1]!, b = e.points[i]!;
        for (let cx = Math.floor((Math.min(a[0], b[0]) - 30) / 50); cx <= Math.floor((Math.max(a[0], b[0]) + 30) / 50); cx++) {
          for (let cz = Math.floor((Math.min(a[1], b[1]) - 30) / 50); cz <= Math.floor((Math.max(a[1], b[1]) + 30) / 50); cz++) {
            const k = (cx + 4096) * 8192 + cz + 4096;
            (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push([a, b, hw]);
          }
        }
      }
    }
  }
  /** Distance from (x, z) to the nearest street's edge of carriageway (centreline less half width). */
  kerb(x: number, z: number): number {
    let best = Infinity;
    for (const [a, b, hw] of this.cells.get((Math.floor(x / 50) + 4096) * 8192 + Math.floor(z / 50) + 4096) ?? []) {
      best = Math.min(best, distToSegment(x, z, a, b).d - hw);
    }
    return best;
  }
  /** The first centreline crossed by the ray from (x, z) along (dx, dz) within `reach` (plus half its width), or null. */
  ray(x: number, z: number, dx: number, dz: number, reach: number): number | null {
    let best: number | null = null;
    const seen = new Set<string>();
    for (let s = 0; s <= reach + 12; s += 25) {
      const px = x + dx * s, pz = z + dz * s;
      for (const [a, b, hw] of this.cells.get((Math.floor(px / 50) + 4096) * 8192 + Math.floor(pz / 50) + 4096) ?? []) {
        const key = `${a[0]},${a[1]},${b[0]},${b[1]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // Ray-segment intersection.
        const ex = b[0] - a[0], ez = b[1] - a[1];
        const den = dx * ez - dz * ex;
        if (Math.abs(den) < 1e-9) continue;
        const t = ((a[0] - x) * ez - (a[1] - z) * ex) / den;
        const u = ((a[0] - x) * dz - (a[1] - z) * dx) / den;
        if (t < 0 || u < 0 || u > 1 || t > reach + hw) continue;
        if (best === null || t - hw < best) best = t - hw;
      }
    }
    return best;
  }
}

/** Every record's outline edges on a grid, for the party-wall test. */
class Outlines {
  private cells = new Map<number, Array<[number, P2, P2]>>();
  constructor(list: readonly Building[]) {
    list.forEach((b, bi) => {
      const f = b.footprint;
      for (let i = 0; i < f.length; i++) {
        const a = f[i]!, c = f[(i + 1) % f.length]!;
        for (let cx = Math.floor((Math.min(a[0], c[0]) - 1) / 20); cx <= Math.floor((Math.max(a[0], c[0]) + 1) / 20); cx++) {
          for (let cz = Math.floor((Math.min(a[1], c[1]) - 1) / 20); cz <= Math.floor((Math.max(a[1], c[1]) + 1) / 20); cz++) {
            const k = (cx + 8192) * 16384 + cz + 8192;
            (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push([bi, a, c]);
          }
        }
      }
    });
  }
  /** Is another record's outline (not `self`, nor its tower or podium) within d of (x, z)? */
  near(x: number, z: number, d: number, skip: ReadonlySet<number>): boolean {
    for (const [bi, a, c] of this.cells.get((Math.floor(x / 20) + 8192) * 16384 + Math.floor(z / 20) + 8192) ?? []) {
      if (skip.has(bi)) continue;
      if (distToSegment(x, z, a, c).d <= d) return true;
    }
    return false;
  }
}

/** The outward unit normal of edge i of a footprint (clockwise-negative rings: (-dz, dx)), checked against the ring. */
function outward(ring: readonly P2[], i: number): [number, number, number] {
  const a = ring[i]!, c = ring[(i + 1) % ring.length]!;
  const len = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
  let nx = -(c[1] - a[1]) / len, nz = (c[0] - a[0]) / len;
  const mx = (a[0] + c[0]) / 2, mz = (a[1] + c[1]) / 2;
  if (pointInRing(mx + nx * 0.3, mz + nz * 0.3, ring)) {
    nx = -nx;
    nz = -nz;
  }
  return [nx, nz, len];
}

/** K2: the storey height and count a record's facade is drawn with. */
export function storeyGrid(b: Building, streetY: number): { storeyM: number; storeys: number } {
  const use = (b.meta.use ?? "").toLowerCase();
  const roofAt = b.topY;
  const residential = isResidential(b);
  const stories = b.meta.stories ?? 0;
  const year = b.meta.year ?? 0;
  if (!residential) {
    // Offices, shops, industry: the use's storey height, or the assessor's where it is plausible.
    let storeyM = use.includes("office") ? 4.0 : use.includes("industrial") ? 5.0 : 3.6;
    const h = b.meta.heightM;
    if (stories > 0 && h / stories <= 6 && b.meta.heightSource === "lidar") storeyM = Math.min(6, Math.max(STOREY_MIN_M, h / stories));
    return { storeyM: r2(storeyM), storeys: Math.max(1, Math.round((roofAt - streetY) / storeyM)) };
  }
  // The roof line: the LiDAR max is the ridge of a pitched roof; the eaves are about the median.
  const [med, max] = b.meta.lidarM;
  const allowance = b.meta.heightSource === "lidar" && max > med ? Math.min(3, max - med) : 0;
  const wallH = Math.max(STOREY_MIN_M, roofAt - streetY - allowance);
  let n = Math.max(1, Math.round(wallH / RES_STOREY_M));
  if (stories > 0 && b.meta.heightM / stories <= 4.5 && year >= GARAGE_YEARS[0] && year <= GARAGE_YEARS[1] && wallH >= (stories + 1) * 2.4) n = Math.max(n, stories + 1);
  while (wallH / n > RES_STOREY_MAX_M) n++;
  while (n > 1 && wallH / n < STOREY_MIN_M) n--;
  return { storeyM: r2(Math.min(RES_STOREY_MAX_M, Math.max(STOREY_MIN_M, wallH / n))), storeys: n };
}

/**
 * House data for every record (keyed by id). `heightAt` is the sim's ground (bilinear). Towers take
 * their podium's street level; their walls are classed like any other.
 */
export function houseData(list: readonly Building[], edges: readonly RoadEdge[], heightAt: (x: number, z: number) => number | null): Map<string, HouseInfo> {
  const streets = new Segments(edges, (e) => !e.pedestrian && e.kind !== "freeway" && e.kind !== "ramp");
  const paths = new Segments(edges, (e) => e.kind !== "freeway" && e.kind !== "ramp");
  const outlines = new Outlines(list);
  const index = new Map(list.map((b, i) => [b.id, i]));
  const out = new Map<string, HouseInfo>();
  const street = new Map<string, number>();
  // Street level first (towers read their podium's).
  for (const b of list) {
    if (b.meta.towerOf !== undefined) continue;
    const f = b.footprint;
    let best: { d: number; m: P2 } | null = null;
    for (let i = 0; i < f.length; i++) {
      const a = f[i]!, c = f[(i + 1) % f.length]!;
      if (Math.hypot(c[0] - a[0], c[1] - a[1]) < 3) continue;
      const m: P2 = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2];
      const d = streets.kerb(m[0], m[1]);
      if (d <= STREET_WALL_M && (!best || d < best.d)) best = { d, m };
    }
    if (!best) continue;
    const h = heightAt(best.m[0], best.m[1]);
    if (h !== null) street.set(b.id, r2(h));
  }
  list.forEach((b, bi) => {
    const f = b.footprint;
    const skip = new Set<number>([bi]);
    const pod = b.meta.towerOf !== undefined ? index.get(b.meta.towerOf) : undefined;
    const tow = b.meta.tower !== undefined ? index.get(b.meta.tower) : undefined;
    if (pod !== undefined) skip.add(pod);
    if (tow !== undefined) skip.add(tow);
    const walls: number[] = [];
    for (let i = 0; i < f.length; i++) {
      const a = f[i]!, c = f[(i + 1) % f.length]!;
      const [nx, nz, len] = outward(f, i);
      // Party: another outline within PARTY_M along most of the wall.
      const n = Math.max(2, Math.ceil(len));
      let hits = 0;
      for (let s = 0; s <= n; s++) {
        const t = s / n;
        const x = a[0] + (c[0] - a[0]) * t + nx * 0.05, z = a[1] + (c[1] - a[1]) * t + nz * 0.05;
        if (outlines.near(x, z, PARTY_M, skip)) hits++;
      }
      if (hits / (n + 1) >= PARTY_SHARE) {
        walls.push(WALL_PARTY);
        continue;
      }
      if (len >= 2) {
        const mx = (a[0] + c[0]) / 2, mz = (a[1] + c[1]) / 2;
        const d = paths.ray(mx + nx * 0.05, mz + nz * 0.05, nx, nz, FRONT_M);
        if (d !== null && d <= FRONT_M) {
          walls.push(WALL_FRONT);
          continue;
        }
      }
      walls.push(WALL_REAR);
    }
    const sy = street.get(b.meta.towerOf ?? b.id);
    const grid = storeyGrid(b, sy ?? b.baseY);
    const info: HouseInfo = { walls, ...grid };
    if (sy !== undefined) info.streetY = sy;
    out.set(b.id, info);
  });
  return out;
}

/**
 * One front wall of a tile's fronts list (buildings node extras.fronts, one row per wall), all
 * integers to keep the glb small: [record index into extras.buildings, wall middle x and z in
 * decimetres from the tile's north-west corner, bearing the facade faces in degrees, wall length
 * in decimetres, street level in centimetres (absolute y), the first floor's rise over the sidewalk
 * in decimetres, storeys, storey height in centimetres, FRONT_* flags].
 */
export type FrontRow = [number, number, number, number, number, number, number, number, number, number];

/**
 * The front walls of one tile's records that get a kit feature (K4-K8), in record order then wall
 * order. `shops`: storefront anchors (x, z, building id).
 */
export function tileFronts(
  list: readonly Building[],
  info: ReadonlyMap<string, HouseInfo>,
  shops: ReadonlyArray<{ x: number; z: number; buildingId: string }>,
  origin: readonly [number, number],
): FrontRow[] {
  const byBuilding = new Map<string, Array<{ x: number; z: number }>>();
  for (const s of shops) (byBuilding.get(s.buildingId) ?? byBuilding.set(s.buildingId, []).get(s.buildingId)!).push(s);
  const rows: FrontRow[] = [];
  list.forEach((b, ri) => {
    if (b.meta.towerOf !== undefined) return;
    const h = info.get(b.id);
    if (!h || h.streetY === undefined) return;
    const residential = isResidential(b);
    const use = (b.meta.use ?? "").toLowerCase();
    const mixed = use.includes("mixed") || use.includes("retail");
    const year = b.meta.year ?? 0;
    const row = h.walls.includes(WALL_PARTY);
    const f = b.footprint;
    // The first floor's rise over the sidewalk, to the decimetre the row stores (the stoop flag reads the same value).
    const floorM = Math.round(Math.max(0, b.baseY - h.streetY) * 10) / 10;
    for (let i = 0; i < f.length; i++) {
      if (h.walls[i] !== WALL_FRONT) continue;
      const a = f[i]!, c = f[(i + 1) % f.length]!;
      const [nx, nz, rawLen] = outward(f, i);
      const len = Math.round(rawLen * 10) / 10; // as the row stores it
      let flags = 0;
      if (residential && year > 0 && year <= BAY_MAX_YEAR && len >= BAY_MIN_FRONT_M && h.storeys >= 2) flags |= FRONT_BAY;
      if (residential && floorM >= STOOP_MIN_RISE_M) flags |= FRONT_STOOP;
      if (residential && year >= GARAGE_YEARS[0] && year <= GARAGE_YEARS[1] && len >= GARAGE_FRONT_M[0] && len <= GARAGE_FRONT_M[1]) flags |= FRONT_GARAGE;
      if ((byBuilding.get(b.id) ?? []).some((s) => distToSegment(s.x, s.z, a, c).d <= 0.75)) flags |= FRONT_SHOP;
      if ((residential || mixed) && year > 0 && year < ROOFLINE_MAX_YEAR && row) flags |= FRONT_ROOFLINE;
      if (flags === 0) continue;
      const mx = (a[0] + c[0]) / 2, mz = (a[1] + c[1]) / 2;
      const deg = Math.round((bearing(nx, nz) * 180) / Math.PI) % 360;
      rows.push([
        ri,
        Math.round((mx - origin[0]) * 10),
        Math.round((mz - origin[1]) * 10),
        deg,
        Math.round(len * 10),
        Math.round(h.streetY * 100),
        Math.round(floorM * 10),
        h.storeys,
        Math.round(h.storeyM * 100),
        flags,
      ]);
    }
  });
  return rows;
}

