// Hillside buildings (W-05, W-28): no roof under the ground, no single roof over more than
// TERRACE_RELIEF_M of hill.
//
// The pipeline used to make one flat prism per footprint at its ground reference plus the LiDAR
// height, over up to 30 m of relief: uphill the hill came through the roof (an invisible wall to
// a walker, a teleport for a car), downhill a 27 m cliff of wall. Now:
//   - A footprint with more than TERRACE_MIN_RELIEF_M of relief under it is cut into strips across
//     the slope (the downhill direction of a plane fitted to the ground under it), each with at
//     most TERRACE_RELIEF_M of relief where the hill allows, and each strip is its own record with
//     its own ground and roof: roof = the strip's mean ground + the building's height, and never
//     less than ROOF_CLEAR_M over the strip's highest ground. LiDAR heights are measured above the
//     local ground (DSM - DTM per return), so a strip standing its height above its own ground is
//     the LiDAR's own model of a stepped building.
//   - Every record's roof stands at least ROOF_CLEAR_M over the highest ground under it.
// Ground is the sim's (both the mesh's triangles and the bilinear lattice): its extremes over a
// polygon are found exactly at the overlay of the polygon and the lattice's triangles.

import { GROUND_CELL_M, type Ground } from "./terrain.ts";
import { cleanRing, dropCollinear, interiorPoint, isSimpleRing, pointInRing, r2, signedArea, type P2 } from "./geom.ts";
import { intersectRing, unionRings } from "./polygon.ts";
import { MIN_AREA_M2, MIN_HEIGHT_M, type Building } from "./buildings.ts";

/** Footprints with more relief than this under them are terraced... */
export const TERRACE_MIN_RELIEF_M = 6;
/** ...into strips of at most this much relief (where a strip of TERRACE_MIN_WIDTH_M allows; W-28 asks for 4 m or less). */
export const TERRACE_RELIEF_M = 3.5;
/** No strip narrower than this across the slope, metres. */
export const TERRACE_MIN_WIDTH_M = 3;
/** At most this many strips per footprint. */
export const TERRACE_MAX_STRIPS = 24;
/** Every roof stands at least this far above the highest ground under its record. */
export const ROOF_CLEAR_M = 2.5;

export interface GroundRange {
  min: number;
  max: number;
  /** Mean over a 1 m raster (or the vertices, for a tiny footprint). */
  mean: number;
}

/**
 * The sim ground's extremes over a polygon: every vertex of the overlay of the polygon with the
 * lattice cells and their split diagonals (where a piecewise-planar surface takes its extremes),
 * plus every 2 m along the polygon's edges (the bilinear blend has no extremum inside a cell, but
 * is quadratic along a slanted edge), for both the mesh's triangles and the bilinear blend; and a
 * raster for the mean.
 */
export function groundRange(ring: readonly P2[], ground: Ground): GroundRange | null {
  let min = Infinity;
  let max = -Infinity;
  const take = (x: number, z: number): void => {
    const h = ground.heightAt(x, z);
    if (h === null) return;
    const hm = ground.meshHeightAt(x, z)!;
    if (h < min) min = h;
    if (hm < min) min = hm;
    if (h > max) max = h;
    if (hm > max) max = hm;
  };
  const c = GROUND_CELL_M;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[(i + n - 1) % n]!;
    const b = ring[i]!;
    const ax = a[0], az = a[1], bx = b[0], bz = b[1];
    if (bx < minX) minX = bx;
    if (bx > maxX) maxX = bx;
    if (bz < minZ) minZ = bz;
    if (bz > maxZ) maxZ = bz;
    take(bx, bz);
    // Crossings of the edge with x = i·c, z = k·c and the diagonals x + z = m·c, and (the bilinear
    // blend is quadratic along an edge inside a cell) a sample every 2 m.
    if (ax !== bx) {
      const lo = Math.ceil(Math.min(ax, bx) / c), hi = Math.floor(Math.max(ax, bx) / c);
      for (let k = lo; k <= hi; k++) {
        const t = (k * c - ax) / (bx - ax);
        if (t > 0 && t < 1) take(ax + (bx - ax) * t, az + (bz - az) * t);
      }
    }
    if (az !== bz) {
      const lo = Math.ceil(Math.min(az, bz) / c), hi = Math.floor(Math.max(az, bz) / c);
      for (let k = lo; k <= hi; k++) {
        const t = (k * c - az) / (bz - az);
        if (t > 0 && t < 1) take(ax + (bx - ax) * t, az + (bz - az) * t);
      }
    }
    const sa = ax + az, sb = bx + bz;
    if (sa !== sb) {
      const lo = Math.ceil(Math.min(sa, sb) / c), hi = Math.floor(Math.max(sa, sb) / c);
      for (let k = lo; k <= hi; k++) {
        const t = (k * c - sa) / (sb - sa);
        if (t > 0 && t < 1) take(ax + (bx - ax) * t, az + (bz - az) * t);
      }
    }
    const L = Math.hypot(bx - ax, bz - az);
    for (let k = 1; k * 2 < L; k++) {
      const t = (k * 2) / L;
      take(ax + (bx - ax) * t, az + (bz - az) * t);
    }
  }
  // Lattice points inside.
  for (let x = Math.ceil(minX / c) * c; x <= maxX; x += c) {
    for (let z = Math.ceil(minZ / c) * c; z <= maxZ; z += c) if (pointInRing(x, z, ring)) take(x, z);
  }
  // The mean on a raster of at most ~400 points (1 m for a house). The extremes need no raster:
  // the mesh is planar per triangle and the bilinear blend has no extremum inside a cell, so both
  // take theirs at the points above (to within the 2 m edge sampling, for the bilinear blend).
  let sum = 0;
  let cnt = 0;
  const step = Math.max(1, Math.sqrt(((maxX - minX) * (maxZ - minZ)) / 400));
  for (let x = minX + step / 2; x < maxX; x += step) {
    for (let z = minZ + step / 2; z < maxZ; z += step) {
      if (!pointInRing(x, z, ring)) continue;
      const h = ground.meshHeightAt(x, z);
      if (h === null) continue;
      sum += h;
      cnt++;
    }
  }
  if (!Number.isFinite(min)) return null;
  if (cnt === 0) {
    for (const [x, z] of ring) {
      const h = ground.meshHeightAt(x, z);
      if (h !== null) {
        sum += h;
        cnt++;
      }
    }
  }
  return { min, max, mean: cnt ? sum / cnt : (min + max) / 2 };
}

/** Least-squares plane h = a + b·x + c·z over a 2 m raster of the ground under the ring: the downhill unit vector. */
function downhill(ring: readonly P2[], ground: Ground): [number, number] {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const [x, z] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const step = Math.max(1, Math.min(4, Math.sqrt((maxX - minX) * (maxZ - minZ)) / 30));
  let n = 0, sx = 0, sz = 0, sh = 0, sxx = 0, szz = 0, sxz = 0, sxh = 0, szh = 0;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const add = (x: number, z: number): void => {
    const h = ground.meshHeightAt(x, z);
    if (h === null) return;
    const u = x - cx;
    const v = z - cz;
    n++;
    sx += u; sz += v; sh += h; sxx += u * u; szz += v * v; sxz += u * v; sxh += u * h; szh += v * h;
  };
  for (let x = minX + step / 2; x < maxX; x += step) for (let z = minZ + step / 2; z < maxZ; z += step) if (pointInRing(x, z, ring)) add(x, z);
  for (const [x, z] of ring) add(x, z);
  // Normal equations for (b, c) after removing the means.
  const mx = sx / n, mz = sz / n, mh = sh / n;
  const cxx = sxx / n - mx * mx, czz = szz / n - mz * mz, cxz = sxz / n - mx * mz;
  const cxh = sxh / n - mx * mh, czh = szh / n - mz * mh;
  const det = cxx * czz - cxz * cxz;
  let b = 0;
  let c = 0;
  if (Math.abs(det) > 1e-9) {
    b = (cxh * czz - czh * cxz) / det;
    c = (czh * cxx - cxh * cxz) / det;
  }
  const L = Math.hypot(b, c);
  if (L < 1e-9) return [1, 0];
  return [-b / L, -c / L];
}

export interface TerraceStats {
  /** Footprints cut into strips, and the strip records added (beyond the original record). */
  terraced: number;
  strips: number;
  /** Strip pieces under MIN_AREA_M2 that touched no strip to join (left out). */
  slivers: number;
  /** Records whose roof was raised to ROOF_CLEAR_M over their highest ground. */
  roofsRaised: number;
  /** Strips left with more than TERRACE_RELIEF_M of relief (narrower than two minimum-width strips, or at the recursion limit). */
  steepStrips: number;
}

const piecePolys = (ring: readonly P2[], ux: number, uz: number, s0: number, s1: number, lo: number, hi: number): P2[][] => {
  // The band s0 <= (x, z)·u <= s1, as a long rectangle across the footprint.
  const vx = -uz;
  const vz = ux;
  const band: P2[] = [
    [ux * s0 + vx * lo, uz * s0 + vz * lo],
    [ux * s1 + vx * lo, uz * s1 + vz * lo],
    [ux * s1 + vx * hi, uz * s1 + vz * hi],
    [ux * s0 + vx * hi, uz * s0 + vz * hi],
  ];
  try {
    return intersectRing(ring, band).map((p) => dropCollinear(cleanRing(p.outer), 0.02));
  } catch {
    return [];
  }
};

interface Piece {
  ring: P2[];
  range: GroundRange;
}

/**
 * Cut a ring into strips across its ground's slope so each strip has at most TERRACE_RELIEF_M
 * of relief; a strip that still has more (a curved or uneven hill) is cut again across its own
 * slope, up to MAX_DEPTH times. Slivers under MIN_AREA_M2 join the strip they touch.
 */
function splitStrips(ring: readonly P2[], range: GroundRange, ground: Ground, stats: TerraceStats, depth: number, counter: number[]): Piece[] {
  const [ux, uz] = downhill(ring, ground);
  let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity;
  for (const [x, z] of ring) {
    const s = x * ux + z * uz;
    const t = -x * uz + z * ux;
    if (s < s0) s0 = s;
    if (s > s1) s1 = s;
    if (t < t0) t0 = t;
    if (t > t1) t1 = t;
  }
  const span = s1 - s0;
  const maxStrips = Math.min(TERRACE_MAX_STRIPS, Math.floor(span / TERRACE_MIN_WIDTH_M));
  if (maxStrips < 2) return [{ ring: [...ring], range }];
  let n = Math.min(maxStrips, Math.max(2, Math.ceil((range.max - range.min) / TERRACE_RELIEF_M)));
  let pieces: Piece[] = [];
  let slivers: P2[][] = [];
  for (;;) {
    pieces = [];
    slivers = [];
    let worst = 0;
    for (let k = 0; k < n; k++) {
      const a = s0 + (span * k) / n;
      const c = s0 + (span * (k + 1)) / n;
      for (const r of piecePolys(ring, ux, uz, k === 0 ? a - 1 : a, k === n - 1 ? c + 1 : c, t0 - 1, t1 + 1)) {
        if (r.length < 3 || !isSimpleRing(r)) continue;
        if (Math.abs(signedArea(r)) < MIN_AREA_M2) {
          slivers.push(r);
          continue;
        }
        const gr = groundRange(r, ground);
        if (!gr) continue;
        worst = Math.max(worst, gr.max - gr.min);
        pieces.push({ ring: signedArea(r) > 0 ? [...r].reverse() : r, range: gr });
      }
    }
    if (worst <= TERRACE_RELIEF_M || n >= maxStrips) break;
    n = Math.min(maxStrips, n + Math.max(1, Math.ceil(n * ((worst - TERRACE_RELIEF_M) / TERRACE_RELIEF_M))));
  }
  for (const sl of slivers) {
    let merged = false;
    const c = interiorPoint(sl);
    for (const p of [...pieces].sort((a, b) => distTo(a.ring, c) - distTo(b.ring, c))) {
      try {
        const u = unionRings([p.ring, sl]);
        if (u.length !== 1 || u[0]!.holes.length) continue;
        const r = dropCollinear(cleanRing(u[0]!.outer), 0.02);
        if (r.length < 3 || !isSimpleRing(r)) continue;
        const gr = groundRange(r, ground);
        if (!gr) continue;
        p.ring = signedArea(r) > 0 ? [...r].reverse() : r;
        p.range = gr;
        merged = true;
        break;
      } catch {
        // try the next strip
      }
    }
    if (!merged) stats.slivers++;
  }
  if (pieces.length < 2) return [{ ring: [...ring], range }];
  const out: Piece[] = [];
  for (const p of pieces) {
    if (p.range.max - p.range.min > TERRACE_RELIEF_M && depth < MAX_DEPTH) {
      const sub = splitStrips(p.ring, p.range, ground, stats, depth + 1, counter);
      out.push(...sub);
    } else {
      if (p.range.max - p.range.min > TERRACE_RELIEF_M) stats.steepStrips++;
      out.push(p);
    }
  }
  return out;
}

const MAX_DEPTH = 2;

/** Distance from a point to a ring's nearest vertex (enough to rank neighbouring strips). */
function distTo(ring: readonly P2[], p: P2): number {
  let best = Infinity;
  for (const q of ring) best = Math.min(best, Math.hypot(q[0] - p[0], q[1] - p[1]));
  return best;
}

/**
 * Terrace the solid building records and raise buried roofs. Towers (meta.towerOf) are left as
 * they are, except that a tower starts on the highest strip under it. Returns the new record
 * list (sorted by id, as buildBuildings returns it).
 */
export function terraceBuildings(buildings: readonly Building[], ground: Ground, exempt: (b: Building) => boolean = () => false): { buildings: Building[]; stats: TerraceStats } {
  const stats: TerraceStats = { terraced: 0, strips: 0, slivers: 0, roofsRaised: 0, steepStrips: 0 };
  const out: Building[] = [];
  const stripsOf = new Map<string, Building[]>();
  // Piece numbers in use per source footprint (ids ending -s<n> or -b<n>).
  const used = new Map<string, number>();
  for (const b of buildings) {
    const m = /^(.*)-[sb](\d+)$/.exec(b.id);
    if (m) used.set(m[1]!, Math.max(used.get(m[1]!) ?? 0, Number(m[2])));
  }
  const nextPiece = (base: string): number => {
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return n;
  };
  const byId = new Map(buildings.map((b) => [b.id, b]));
  for (const b of buildings) {
    // Towers, spans, the records an override sets by hand (placeholders, public-record roofs)
    // and the records a landmark will replace (`exempt`) keep their one prism.
    if (b.meta.towerOf !== undefined || b.underY !== undefined || b.meta.heightSource === "override" || exempt(b)) {
      out.push(b);
      continue;
    }
    // Most buildings stand on gentle ground well under their roof: the lattice around the box says so.
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [x, z] of b.footprint) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    const bound = ground.boxBounds(x0, z0, x1, z1);
    if (bound && bound.max - bound.min <= TERRACE_MIN_RELIEF_M && b.topY >= bound.max + ROOF_CLEAR_M) {
      out.push(b);
      continue;
    }
    const range = groundRange(b.footprint, ground);
    if (!range) {
      out.push(b);
      continue;
    }
    const height = b.meta.heightM;
    if (range.max - range.min <= TERRACE_MIN_RELIEF_M) {
      const minTop = r2(range.max + ROOF_CLEAR_M);
      if (b.topY < minTop) {
        stats.roofsRaised++;
        out.push({ ...b, topY: minTop, meta: { ...b.meta, footY: Math.min(b.meta.footY, Math.floor((range.min - 0.05) * 100) / 100) } });
      } else out.push(b);
      continue;
    }
    // ---- Strips across the slope (recursively: a strip still too steep is cut again across
    // its own slope).
    const pieces = splitStrips(b.footprint, range, ground, stats, 0, [0]);
    if (pieces.length < 2) {
      // The clipper gave nothing usable: keep one record, roof clear of the hill.
      const minTop = r2(range.max + ROOF_CLEAR_M);
      if (b.topY < minTop) stats.roofsRaised++;
      out.push({ ...b, topY: Math.max(b.topY, minTop) });
      continue;
    }
    stats.terraced++;
    // The piece holding the footprint's anchor keeps the record's id; the others are numbered on
    // from the source footprint's highest piece number (a clearance cut may have made some).
    // A podium's primary piece is the one its tower stands on (its tower's anchor), so the tower
    // stays on its podium record's roof.
    const tower = b.meta.tower !== undefined ? byId.get(b.meta.tower) : undefined;
    const anchor = interiorPoint(tower ? tower.footprint : b.footprint);
    let primary = pieces.findIndex((p) => pointInRing(anchor[0], anchor[1], p.ring));
    if (primary < 0) {
      primary = 0;
      pieces.forEach((p, i) => {
        if (Math.abs(signedArea(p.ring)) > Math.abs(signedArea(pieces[primary]!.ring))) primary = i;
      });
    }
    const base = b.meta.pieceOf ?? b.id;
    const made: Building[] = [];
    pieces.forEach((p, i) => {
      const at = interiorPoint(p.ring);
      const h = ground.heightAt(at[0], at[1]) ?? p.range.mean;
      const baseY = Math.floor(h * 100) / 100;
      const footY = Math.min(baseY, Math.floor((p.range.min - 0.05) * 100) / 100);
      const topY = r2(Math.max(baseY + MIN_HEIGHT_M, p.range.mean + height, p.range.max + ROOF_CLEAR_M));
      const id = i === primary ? b.id : `${base}-s${nextPiece(base)}`;
      // heightM stays the building's measured height; each piece's roof is its own topY.
      const meta = { ...b.meta, footY };
      if (i !== primary) {
        meta.pieceOf = base;
        meta.piece = "strip";
        delete meta.tower;
      }
      made.push({ id, tile: b.tile, footprint: p.ring, baseY, topY, meta });
    });
    stats.strips += made.length - 1;
    stripsOf.set(b.id, made);
    out.push(...made);
  }
  // A tower stands on its podium record (the primary strip, under it).
  const final: Building[] = out.map((b) => {
    if (b.meta.towerOf === undefined) return b;
    const strips = stripsOf.get(b.meta.towerOf);
    if (!strips) return b;
    const podium = strips.find((s) => s.id === b.meta.towerOf) ?? strips[0]!;
    const top = podium.topY;
    const topY = Math.max(b.topY, r2(top + MIN_HEIGHT_M));
    return { ...b, topY, meta: { ...b.meta, podiumTopY: top } };
  });
  final.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { buildings: final, stats };
}
