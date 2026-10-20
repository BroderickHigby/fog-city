// Static world data the sim collides with. Loaded from tile collider JSON
// (schemas/tile-collider.schema.json) and, optionally, the world road graph
// (schemas/roads.schema.json); never part of SimState, never mutated.

import { buildRoadGraph, type RoadGraph, type RoadsFile } from "./roads.ts";

export interface BuildingCollider {
  id: string;
  /** Footprint polygon, local metres [x, z]. Any winding; not closed (first != last). */
  footprint: Array<[number, number]>;
  /** Ground level at the building, metres. */
  baseY: number;
  /** Roof height, metres. */
  topY: number;
}

/** Regular grid of ground heights. heights[iz * nx + ix] is at (x0 + ix*cellSizeM, z0 + iz*cellSizeM). */
export interface Heightfield {
  x0: number;
  z0: number;
  cellSizeM: number;
  nx: number;
  nz: number;
  heights: number[];
}

export interface TileCollider {
  tileId: string;
  buildings: BuildingCollider[];
  ground: Heightfield | null;
}

export interface World {
  /** Tiles in ascending id order. */
  tiles: TileCollider[];
  /** Derived spatial index: "cx,cz" -> buildings overlapping that 50 m cell. */
  grid: Map<string, BuildingCollider[]>;
  /** Derived: cellKey(gx, gz) of GROUND_CELL m cells -> tiles whose heightfield overlaps the cell, ascending id order. */
  groundIndex: Map<number, TileCollider[]>;
  /** Derived: cellKey(cx, cz) of 50 m cells -> buildings overlapping the cell (same lists as grid, numeric keys). */
  cells: Map<number, BuildingCollider[]>;
  /** Derived: each building's bounding box [minX, minZ, maxX, maxZ]. */
  bounds: Map<BuildingCollider, [number, number, number, number]>;
  /** Static road graph for traffic and robots (src/sim/roads.ts), or null when the world has none. */
  roads: RoadGraph | null;
}

const CELL = 50;
const GROUND_CELL = 250;

/** Integer cell coordinates (|c| < 2^20) packed into one number, for allocation-free Map keys. */
export function cellKey(cx: number, cz: number): number {
  return (cx + 1048576) * 2097152 + (cz + 1048576);
}

/**
 * Build the static world. `roads` is the world's roads.json (manifest.roads), loaded alongside
 * the colliders; without it the world has no ambient traffic.
 *
 * Cost: synchronous, and dominated by the road graph's building-clearance sampling of every
 * lane and sidewalk. Measured in Node on 2026-10-20: about 0.2 s for the 77-tile SF set and
 * 1.6 to 2.3 s for the citywide set (583 tiles, 187k buildings, 15.7k road edges). Callers on
 * a UI thread should build once at load (or in a worker), not per frame.
 */
export function buildWorld(tiles: readonly TileCollider[], roads: RoadsFile | null = null): World {
  const sorted = [...tiles].sort((a, b) => (a.tileId < b.tileId ? -1 : a.tileId > b.tileId ? 1 : 0));
  const grid = new Map<string, BuildingCollider[]>();
  const cells = new Map<number, BuildingCollider[]>();
  const bounds = new Map<BuildingCollider, [number, number, number, number]>();
  for (const t of sorted) {
    for (const b of t.buildings) {
      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
      for (const [x, z] of b.footprint) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      bounds.set(b, [minX, minZ, maxX, maxZ]);
      for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) {
        for (let cz = Math.floor(minZ / CELL); cz <= Math.floor(maxZ / CELL); cz++) {
          const key = cellKey(cx, cz);
          let list = cells.get(key);
          if (!list) {
            cells.set(key, (list = []));
            grid.set(`${cx},${cz}`, list);
          }
          list.push(b);
        }
      }
    }
  }
  const groundIndex = new Map<number, TileCollider[]>();
  for (const t of sorted) {
    const g = t.ground;
    if (!g) continue;
    const x1 = g.x0 + (g.nx - 1) * g.cellSizeM;
    const z1 = g.z0 + (g.nz - 1) * g.cellSizeM;
    for (let gx = Math.floor(g.x0 / GROUND_CELL); gx <= Math.floor(x1 / GROUND_CELL); gx++) {
      for (let gz = Math.floor(g.z0 / GROUND_CELL); gz <= Math.floor(z1 / GROUND_CELL); gz++) {
        const key = cellKey(gx, gz);
        let list = groundIndex.get(key);
        if (!list) groundIndex.set(key, (list = []));
        list.push(t);
      }
    }
  }
  const world: World = { tiles: sorted, grid, groundIndex, cells, bounds, roads: null };
  if (roads) {
    world.roads = buildRoadGraph(roads, { blocked: (x, z, r) => circleBlocked(world, x, z, r) });
  }
  return world;
}

/** Buildings whose bounding cells overlap the square of half-size r around (x, z). Deterministic order. */
export function nearbyBuildings(world: World, x: number, z: number, r: number): BuildingCollider[] {
  const out: BuildingCollider[] = [];
  const cx0 = Math.floor((x - r) / CELL);
  const cx1 = Math.floor((x + r) / CELL);
  const cz0 = Math.floor((z - r) / CELL);
  const cz1 = Math.floor((z + r) / CELL);
  const seen = new Set<string>();
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cz = cz0; cz <= cz1; cz++) {
      const list = world.cells.get(cellKey(cx, cz));
      if (!list) continue;
      for (const b of list) {
        if (seen.has(b.id)) continue;
        seen.add(b.id);
        out.push(b);
      }
    }
  }
  return out;
}

/** Ground height at (x, z): bilinear over whichever tile heightfield covers the point (first in id order), else 0. */
export function groundHeight(world: World, x: number, z: number): number {
  const candidates = world.groundIndex.get(cellKey(Math.floor(x / GROUND_CELL), Math.floor(z / GROUND_CELL)));
  if (!candidates) return 0;
  for (const t of candidates) {
    const g = t.ground;
    if (!g) continue;
    const fx = (x - g.x0) / g.cellSizeM;
    const fz = (z - g.z0) / g.cellSizeM;
    if (fx < 0 || fz < 0 || fx > g.nx - 1 || fz > g.nz - 1) continue;
    const ix = Math.min(Math.floor(fx), g.nx - 2);
    const iz = Math.min(Math.floor(fz), g.nz - 2);
    const tx = fx - ix;
    const tz = fz - iz;
    const h00 = g.heights[iz * g.nx + ix] ?? 0;
    const h10 = g.heights[iz * g.nx + ix + 1] ?? 0;
    const h01 = g.heights[(iz + 1) * g.nx + ix] ?? 0;
    const h11 = g.heights[(iz + 1) * g.nx + ix + 1] ?? 0;
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }
  return 0;
}

export function pointInPolygon(x: number, z: number, poly: ReadonlyArray<readonly [number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]!;
    const [xj, zj] = poly[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Closest point on the polygon's boundary to (x, z). */
export function closestOnBoundary(
  x: number,
  z: number,
  poly: ReadonlyArray<readonly [number, number]>,
): { x: number; z: number; d2: number } {
  let best = { x: 0, z: 0, d2: Infinity };
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, az] = poly[j]!;
    const [bx, bz] = poly[i]!;
    const ex = bx - ax;
    const ez = bz - az;
    const len2 = ex * ex + ez * ez;
    let t = len2 > 0 ? ((x - ax) * ex + (z - az) * ez) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + ex * t;
    const pz = az + ez * t;
    const d2 = (x - px) * (x - px) + (z - pz) * (z - pz);
    if (d2 < best.d2) best = { x: px, z: pz, d2 };
  }
  return best;
}

/**
 * Push a circle of radius r at (x, z) out of every building it overlaps (below roof height y).
 * Returns the corrected position and whether anything was hit.
 */
export function resolveCircle(
  world: World,
  x: number,
  z: number,
  y: number,
  r: number,
): { x: number; z: number; hit: boolean } {
  let hit = false;
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (const b of nearbyBuildings(world, x, z, r + 1)) {
      if (y >= b.topY) continue;
      const inside = pointInPolygon(x, z, b.footprint);
      const c = closestOnBoundary(x, z, b.footprint);
      if (!inside && c.d2 >= r * r) continue;
      const d = Math.sqrt(c.d2);
      if (inside) {
        // Exit through the nearest edge.
        const nx = d > 1e-9 ? (c.x - x) / d : 1;
        const nz = d > 1e-9 ? (c.z - z) / d : 0;
        x = c.x + nx * r;
        z = c.z + nz * r;
      } else {
        const nx = d > 1e-9 ? (x - c.x) / d : 1;
        const nz = d > 1e-9 ? (z - c.z) / d : 0;
        x = c.x + nx * r;
        z = c.z + nz * r;
      }
      hit = true;
      moved = true;
    }
    if (!moved) break;
  }
  return { x, z, hit };
}

/** Does a circle of radius r at (x, z) overlap any building footprint? (Height is ignored: for ground agents.) */
export function circleBlocked(world: World, x: number, z: number, r: number): boolean {
  const r2 = r * r;
  for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++) {
    for (let cz = Math.floor((z - r) / CELL); cz <= Math.floor((z + r) / CELL); cz++) {
      const list = world.cells.get(cellKey(cx, cz));
      if (!list) continue;
      for (const b of list) {
        if (b.topY <= b.baseY) continue;
        const bb = world.bounds.get(b)!;
        if (x + r < bb[0] || x - r > bb[2] || z + r < bb[1] || z - r > bb[3]) continue;
        if (circleTouchesPolygon(x, z, r2, b.footprint)) return true;
      }
    }
  }
  return false;
}

/**
 * pointInPolygon(x, z, poly) || closestOnBoundary(x, z, poly).d2 < r2, in one pass over the
 * edges with no allocation (the same arithmetic, so the same answer), stopping at the first
 * edge closer than r. circleBlocked runs this for every building near every sample when the
 * road graph is built, and for agents every tick.
 */
export function circleTouchesPolygon(x: number, z: number, r2: number, poly: ReadonlyArray<readonly [number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i]!;
    const pj = poly[j]!;
    const xi = pi[0];
    const zi = pi[1];
    const xj = pj[0];
    const zj = pj[1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    // Distance to the edge from pj to pi (closestOnBoundary's a = poly[j], b = poly[i]).
    const ex = xi - xj;
    const ez = zi - zj;
    const len2 = ex * ex + ez * ez;
    let t = len2 > 0 ? ((x - xj) * ex + (z - zj) * ez) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = xj + ex * t;
    const pz = zj + ez * t;
    if ((x - px) * (x - px) + (z - pz) * (z - pz) < r2) return true;
  }
  return inside;
}


/** Do segments a-b and c-d cross or touch? */
function segmentsMeet(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): boolean {
  const d1 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d2 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  const d3 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d4 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const on = (px: number, pz: number, qx: number, qz: number, rx: number, rz: number): boolean =>
    rx >= (px < qx ? px : qx) && rx <= (px > qx ? px : qx) && rz >= (pz < qz ? pz : qz) && rz <= (pz > qz ? pz : qz);
  if (d1 === 0 && on(cx, cz, dx, dz, ax, az)) return true;
  if (d2 === 0 && on(cx, cz, dx, dz, bx, bz)) return true;
  if (d3 === 0 && on(ax, az, bx, bz, cx, cz)) return true;
  if (d4 === 0 && on(ax, az, bx, bz, dx, dz)) return true;
  return false;
}

/**
 * Does the straight line from (ax, az) to (bx, bz) cross or enter any building footprint?
 * Height is ignored, as in circleBlocked: for line of sight between bodies on the ground.
 */
export function segmentBlocked(world: World, ax: number, az: number, bx: number, bz: number): boolean {
  const minX = ax < bx ? ax : bx;
  const maxX = ax > bx ? ax : bx;
  const minZ = az < bz ? az : bz;
  const maxZ = az > bz ? az : bz;
  for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) {
    for (let cz = Math.floor(minZ / CELL); cz <= Math.floor(maxZ / CELL); cz++) {
      const list = world.cells.get(cellKey(cx, cz));
      if (!list) continue;
      for (const b of list) {
        if (b.topY <= b.baseY) continue;
        const bb = world.bounds.get(b)!;
        if (maxX < bb[0] || minX > bb[2] || maxZ < bb[1] || minZ > bb[3]) continue;
        if (pointInPolygon(ax, az, b.footprint) || pointInPolygon(bx, bz, b.footprint)) return true;
        const poly = b.footprint;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const p = poly[j]!;
          const q = poly[i]!;
          if (segmentsMeet(ax, az, bx, bz, p[0], p[1], q[0], q[1])) return true;
        }
      }
    }
  }
  return false;
}
