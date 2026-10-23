// Pier decks (W-13). The bare-earth DEM has no pier decks: where the hydro-flattening reaches
// under a pier, its sheds stood in the bay at y = 0 and its roads ran on the water. Here the
// pier is rebuilt as land at deck height:
//   - A pier shed is a footprint of PIER_SHED_MIN_M2 or more at least PIER_SHED_WATER of which
//     lies over water. Smaller structures over water (the Mission Creek houseboats, a fender
//     house at a bridge) float: they are left on the water.
//   - A pier street is a surface street (not a freeway) running over water within PIER_REACH_M
//     of a pier shed (Al Scoma Way, Pier 45 Vly, Pier 50 Vly, the Pier 70 roads). A street over
//     water with no shed beside it is a bridge over a creek (decks.ts), not a pier.
//   - The deck is the union of the sheds buffered by PIER_PAD_M and the pier streets buffered to
//     their kerbs plus PIER_PAD_M. Every lattice sample inside it that is water, or lower than
//     PIER_Y_M, is raised to PIER_Y_M and becomes land.
//   - The buildings on the deck stand on it: their foot and base move up to the deck; their
//     roofs keep the LiDAR's absolute height (it measured them from the water), but never less
//     than ROOF_CLEAR over the deck.
// Runs on the in-memory tile heightfields before anything else reads the ground (roads, tunnels,
// clearance, terraces), so every layer agrees on it.

import type { Building } from "./buildings.ts";
import { pointInRing, r2, signedArea, type P2 } from "./geom.ts";
import { bufferPolyline, unionPolys, type Poly } from "./polygon.ts";
import type { RoadGraph } from "./roads.ts";
import type { Ground, Heightfield } from "./terrain.ts";

/** Deck height of the piers, metres (the Port's piers stand 2.5 to 3.5 m over mean sea level). */
export const PIER_Y_M = 3;
/** A footprint at least this much over water, and this large, is a pier shed... */
export const PIER_SHED_WATER = 0.5;
export const PIER_SHED_MIN_M2 = 400;
// ...a smaller one (a Mission Creek houseboat, a fender house at a bridge) floats where it is.
/** The deck reaches this far past a shed's walls and a pier street's kerbs. */
export const PIER_PAD_M = 4;
/** A street over water this close to a pier shed is a pier street. */
export const PIER_REACH_M = 25;
/** A roof stands at least this far over the deck. */
const ROOF_CLEAR_M = 2.5;

export interface PierStats {
  sheds: string[];
  streets: string[];
  /** Lattice samples raised to the deck. */
  samples: number;
  /** Deck area, m². */
  areaM2: number;
}

/** The fraction of a footprint over water (2 m raster; the vertices for a tiny footprint). */
export function waterFraction(ring: readonly P2[], ground: Ground): number {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of ring) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    z0 = Math.min(z0, z); z1 = Math.max(z1, z);
  }
  let n = 0;
  let w = 0;
  for (let x = Math.ceil(x0 / 2) * 2; x <= x1; x += 2) {
    for (let z = Math.ceil(z0 / 2) * 2; z <= z1; z += 2) {
      if (!pointInRing(x, z, ring)) continue;
      n++;
      if (ground.waterAt(x, z)) w++;
    }
  }
  if (n === 0) {
    for (const [x, z] of ring) {
      n++;
      if (ground.waterAt(x, z)) w++;
    }
  }
  return n ? w / n : 0;
}

/** Points along a polyline every `step` metres. */
function along(points: readonly P2[], step: number): P2[] {
  const out: P2[] = [points[0]!];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

const ringDist = (x: number, z: number, ring: readonly P2[]): number => {
  if (pointInRing(x, z, ring)) return 0;
  let d = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const ex = b[0] - a[0], ez = b[1] - a[1];
    const L2 = ex * ex + ez * ez;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / L2)) : 0;
    d = Math.min(d, Math.hypot(x - (a[0] + ex * t), z - (a[1] + ez * t)));
  }
  return d;
};

/**
 * Find the piers and raise them (mutates the heightfields in `fields`, which `ground` reads).
 * Returns the deck polygons and statistics.
 */
export function raisePiers(buildings: readonly Building[], graph: RoadGraph, fields: ReadonlyMap<string, Heightfield>, ground: Ground): { decks: Poly[]; stats: PierStats } {
  const sheds = buildings.filter((b) => {
    if (b.meta.towerOf !== undefined) return false;
    // Only footprints with a water sample in reach (water is at 0 m) can be over water.
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [x, z] of b.footprint) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    const box = ground.boxBounds(x0, z0, x1, z1);
    if (box && box.min > 0.1) return false;
    return Math.abs(signedArea(b.footprint)) >= PIER_SHED_MIN_M2 && waterFraction(b.footprint, ground) >= PIER_SHED_WATER;
  });
  const streets = graph.edges.filter((e) => {
    if (e.gradeSeparated || e.kind === "freeway" || e.kind === "ramp") return false;
    const wet = along(e.points, 4).filter(([x, z]) => ground.waterAt(x, z));
    if (!wet.length) return false;
    return wet.some(([x, z]) => sheds.some((b) => ringDist(x, z, b.footprint) <= PIER_REACH_M));
  });
  const pieces: Poly[] = [];
  for (const b of sheds) {
    const ring = b.footprint;
    // The shed's own outline, grown by PIER_PAD_M: a closed polyline buffered.
    pieces.push(...bufferPolyline([...ring, ring[0]!], PIER_PAD_M), { outer: ring.map((p) => [p[0], p[1]] as P2), holes: [] });
  }
  for (const e of streets) pieces.push(...bufferPolyline(e.points, e.widthM / 2 + PIER_PAD_M));
  const decks = pieces.length ? unionPolys(pieces) : [];
  let samples = 0;
  // Along a pier street, every corner of every lattice cell under it is on the deck, so the
  // ground the car drives on there is the deck's (the bilinear blend of the cell's corners).
  const corners = new Set<string>();
  for (const e of streets) {
    for (const [x, z] of along(e.points, 2)) {
      const cx = Math.floor(x / 10) * 10, cz = Math.floor(z / 10) * 10;
      for (const [dx, dz] of [[0, 0], [10, 0], [0, 10], [10, 10]] as const) corners.add(`${cx + dx},${cz + dz}`);
    }
  }
  const boxes = decks.map((p) => {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [x, z] of p.outer) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    return [x0, z0, x1, z1] as const;
  });
  const inDeck = (x: number, z: number): boolean =>
    decks.some((p, d) => {
      const [x0, z0, x1, z1] = boxes[d]!;
      return x >= x0 && x <= x1 && z >= z0 && z <= z1 && pointInRing(x, z, p.outer) && !p.holes.some((h) => pointInRing(x, z, h));
    });
  for (const f of [...fields.values()].sort((a, b) => a.z0 - b.z0 || a.x0 - b.x0)) {
    const fx1 = f.x0 + (f.nx - 1) * f.cellSizeM;
    const fz1 = f.z0 + (f.nz - 1) * f.cellSizeM;
    if (!boxes.some(([x0, z0, x1, z1]) => x1 + 10 >= f.x0 && x0 - 10 <= fx1 && z1 + 10 >= f.z0 && z0 - 10 <= fz1)) continue;
    for (let k = 0; k < f.nz; k++) {
      for (let i = 0; i < f.nx; i++) {
        const j = k * f.nx + i;
        if (f.water[j] !== 1 && f.heights[j]! >= PIER_Y_M) continue;
        const x = f.x0 + i * f.cellSizeM, z = f.z0 + k * f.cellSizeM;
        if (!corners.has(`${x},${z}`) && !inDeck(x, z)) continue;
        f.heights[j] = PIER_Y_M;
        f.water[j] = 0;
        samples++;
      }
    }
  }
  let area = 0;
  for (const p of decks) {
    let a = 0;
    for (let i = 0, j = p.outer.length - 1; i < p.outer.length; j = i++) a += p.outer[j]![0] * p.outer[i]![1] - p.outer[i]![0] * p.outer[j]![1];
    area += Math.abs(a) / 2;
  }
  return {
    decks,
    stats: { sheds: sheds.map((b) => b.id).sort(), streets: streets.map((e) => e.id).sort(), samples, areaM2: Math.round(area) },
  };
}

/**
 * Re-base the buildings standing on raised ground (after raisePiers): foot at the lowest new
 * ground under them, base at the new ground at their anchor, roofs at least ROOF_CLEAR_M over
 * the highest. `lowest(ring)` and `at(x, z)` read the raised ground.
 */
export function rebaseOnDecks(
  buildings: readonly Building[],
  decks: readonly Poly[],
  range: (ring: readonly P2[]) => { min: number; max: number; at: number } | null,
): Building[] {
  if (!decks.length) return buildings.slice();
  const boxes = decks.map((p) => {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [x, z] of p.outer) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    return [x0, z0, x1, z1] as const;
  });
  return buildings.map((b) => {
    const near = b.footprint.some(([x, z]) => boxes.some(([x0, z0, x1, z1]) => x >= x0 - 10 && x <= x1 + 10 && z >= z0 - 10 && z <= z1 + 10));
    if (!near) return b;
    const r = range(b.footprint);
    if (!r) return b;
    const footY = Math.floor((r.min - 0.05) * 100) / 100;
    // A tower keeps its roof and its podium's; only its ground reference moves.
    if (b.meta.towerOf !== undefined) return r.at > b.baseY + 0.01 ? { ...b, baseY: r2(Math.min(r.at, b.topY - 0.5)) } : b;
    if (footY <= b.meta.footY + 0.01 && r.at <= b.baseY + 0.01) return b;
    const baseY = r2(r.at);
    // A podium keeps its roof (its tower stands on it); anything else clears the deck.
    const topY = b.meta.tower !== undefined ? b.topY : r2(Math.max(b.topY, r.max + ROOF_CLEAR_M));
    return { ...b, baseY: Math.min(baseY, topY - 0.5), topY, meta: { ...b.meta, footY: Math.min(footY, baseY, topY - 0.5) } };
  });
}
