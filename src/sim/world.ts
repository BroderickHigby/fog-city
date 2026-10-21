// Static world data the sim collides with: tile colliders (from the citywide collider pack,
// pack.ts, or per-tile collider JSON, schemas/tile-collider.schema.json), optionally the world
// road graph (schemas/roads.schema.json) and the world's edge and shore walls (boundary.json,
// boundary.ts). Never part of SimState, never mutated.

import { buildWalls, type BoundaryFile, type Walls } from "./boundary.ts";
import { TILE_SIZE_M } from "../geo/project.ts";
import { buildRoadGraph, type RoadGraph, type RoadsFile } from "./roads.ts";

export interface BuildingCollider {
  id: string;
  /** Footprint polygon, local metres [x, z]. Any winding; not closed (first != last). */
  footprint: Array<[number, number]>;
  /** Ground level at the building, metres. */
  baseY: number;
  /** Roof height, metres. */
  topY: number;
  /**
   * Underside of a structure that spans a street or path (a deck, a bridge between buildings),
   * metres; absent: solid down to the ground. A body passes under it when its top is at or
   * below this height (blocksBand).
   */
  underY?: number;
}

/** Regular grid of ground heights. heights[iz * nx + ix] is at (x0 + ix*cellSizeM, z0 + iz*cellSizeM). */
export interface Heightfield {
  x0: number;
  z0: number;
  cellSizeM: number;
  nx: number;
  nz: number;
  heights: number[];
  /** Water mask per sample (1 = open water, height 0), when the source has one. Only the wall build reads it (boundary.ts). */
  water?: number[];
}

export interface TileCollider {
  tileId: string;
  buildings: BuildingCollider[];
  ground: Heightfield | null;
}

export interface World {
  /** Tiles in ascending id order. */
  tiles: TileCollider[];
  /** Derived: cellKey(gx, gz) of GROUND_CELL m cells -> tiles whose heightfield overlaps the cell, ascending id order. */
  groundIndex: Map<number, TileCollider[]>;
  /** Derived spatial index: cellKey(cx, cz) of 50 m cells -> buildings overlapping the cell, in tile then file order. */
  cells: Map<number, BuildingCollider[]>;
  /**
   * Derived, parallel to `cells`: the bounding box of each listed building, 4 numbers per
   * building ([minX, minZ, maxX, maxZ] at 4 * i), so the per-sample building checks of the road
   * graph build and of agents read them without a lookup.
   */
  cellBoxes: Map<number, Float64Array>;
  /**
   * Derived: when every heightfield covers exactly its own TILE_SIZE_M tile (the pipeline's
   * worlds), cellKey(ix, iz) -> that tile's heightfield, so groundHeight looks the tile up by
   * floor(x / T), floor(z / T). Null for hand-made worlds, which use groundIndex.
   */
  tileGround: Map<number, Heightfield> | null;
  /** Static road graph for traffic and robots (src/sim/roads.ts), or null when the world has none. */
  roads: RoadGraph | null;
  /** The world's edge and shore walls (boundary.ts), or null when the world has no boundary.json. */
  walls: Walls | null;
}

const CELL = 50;
const GROUND_CELL = 250;

/** Integer cell coordinates (|c| < 2^20) packed into one number, for allocation-free Map keys. */
export function cellKey(cx: number, cz: number): number {
  return (cx + 1048576) * 2097152 + (cz + 1048576);
}

/** cellKey(ix, iz) -> heightfield when every heightfield sits exactly on its own tile, else null. */
function tileAligned(sorted: readonly TileCollider[]): Map<number, Heightfield> | null {
  const T = TILE_SIZE_M;
  const out = new Map<number, Heightfield>();
  for (const t of sorted) {
    const g = t.ground;
    if (!g) continue;
    const ix = Math.floor(g.x0 / T);
    const iz = Math.floor(g.z0 / T);
    const key = cellKey(ix, iz);
    if (g.x0 !== ix * T || g.z0 !== iz * T || (g.nx - 1) * g.cellSizeM !== T || (g.nz - 1) * g.cellSizeM !== T || out.has(key)) return null;
    out.set(key, g);
  }
  return out;
}

/**
 * Build the static world. `roads` is the world's roads.json (manifest.roads), loaded alongside
 * the colliders; without it the world has no ambient traffic. `boundary` is its boundary.json
 * (manifest.layers.boundary): with it, cars and walkers stop at the world's edge and the shore.
 *
 * Cost: synchronous, and dominated by the road graph's building-clearance sampling of every
 * lane and sidewalk. Measured in Node on 2026-10-20: about 0.2 s for the 77-tile SF set and
 * 1.6 to 2.3 s for the citywide set (583 tiles, 187k buildings, 15.7k road edges). Callers on
 * a UI thread should build once at load (or in a worker), not per frame.
 */
export function buildWorld(tiles: readonly TileCollider[], roads: RoadsFile | null = null, boundary: BoundaryFile | null = null): World {
  const sorted = [...tiles].sort((a, b) => (a.tileId < b.tileId ? -1 : a.tileId > b.tileId ? 1 : 0));
  const cells = new Map<number, BuildingCollider[]>();
  const boxLists = new Map<number, number[]>();
  for (const t of sorted) {
    for (const b of t.buildings) {
      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
      for (const [x, z] of b.footprint) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) {
        for (let cz = Math.floor(minZ / CELL); cz <= Math.floor(maxZ / CELL); cz++) {
          const key = cellKey(cx, cz);
          let list = cells.get(key);
          let boxes = boxLists.get(key);
          if (!list || !boxes) {
            cells.set(key, (list = []));
            boxLists.set(key, (boxes = []));
          }
          list.push(b);
          boxes.push(minX, minZ, maxX, maxZ);
        }
      }
    }
  }
  const cellBoxes = new Map<number, Float64Array>();
  for (const [key, boxes] of boxLists) cellBoxes.set(key, Float64Array.from(boxes));
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
  const world: World = {
    tiles: sorted,
    groundIndex,
    cells,
    cellBoxes,
    tileGround: tileAligned(sorted),
    roads: null,
    walls: null,
  };
  if (roads) {
    world.roads = buildRoadGraph(roads, { blocked: (x, z, r) => circleBlocked(world, x, z, r) });
  }
  if (boundary) {
    // Roads over water get a corridor through the shore only where traffic or people may go.
    const graph = world.roads;
    const usable = graph ? new Set(graph.edges.filter((e) => e.drivable || e.walkable).map((e) => e.id)) : null;
    world.walls = buildWalls(boundary, roads, {
      opens: usable ? (e) => usable.has(e.id) : undefined,
      water: (x, z) => groundWater(world, x, z),
    });
  }
  return world;
}

/**
 * Is (x, z) open water by the ground's water mask (the nearest lattice sample of the covering
 * heightfield)? False where no heightfield with a mask covers the point.
 */
export function groundWater(world: World, x: number, z: number): boolean {
  let g: Heightfield | undefined;
  const tg = world.tileGround;
  if (tg) g = tg.get(cellKey(Math.floor(x / TILE_SIZE_M), Math.floor(z / TILE_SIZE_M)));
  else {
    for (const t of world.groundIndex.get(cellKey(Math.floor(x / GROUND_CELL), Math.floor(z / GROUND_CELL))) ?? []) {
      const h = t.ground;
      if (h && x >= h.x0 && z >= h.z0 && x <= h.x0 + (h.nx - 1) * h.cellSizeM && z <= h.z0 + (h.nz - 1) * h.cellSizeM) {
        g = h;
        break;
      }
    }
  }
  if (!g || !g.water) return false;
  const i = Math.min(g.nx - 1, Math.max(0, Math.floor((x - g.x0) / g.cellSizeM + 0.5)));
  const k = Math.min(g.nz - 1, Math.max(0, Math.floor((z - g.z0) / g.cellSizeM + 0.5)));
  return g.water[k * g.nx + i] === 1;
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

/** Bodies may stand on a building's roof, and are not blocked by it, when it is at most this far above their feet (blocksBand, surfaceHeight). */
export const ROOF_STEP_M = 0.5;
/** A road or path passes under a structure whose underside is at least this far above its ground (agents, the road graph). */
export const UNDER_CLEARANCE_M = 4.5;

/**
 * Does building b block a body whose collision band runs from `bottom` (its feet plus the step
 * it can climb) to `top` (the top of its body)? Only between the building's underside (when it
 * has one) and its roof: a body whose feet are at or above the roof stands on it or passes over
 * it, and a body wholly below an underside passes under it. Flat records (topY <= baseY) never
 * block.
 */
export function blocksBand(b: Readonly<BuildingCollider>, bottom: number, top: number): boolean {
  if (b.topY <= b.baseY || bottom >= b.topY) return false;
  return b.underY === undefined || top > b.underY;
}

/**
 * Height of one heightfield at (x, z), clamped into its lattice (the caller picked the tile), on
 * the rendered ground mesh: each lattice cell is two planar triangles split along its
 * (i+1, k)-(i, k+1) diagonal, exactly as pipeline/lib/mesh.ts groundMesh (and the renderer's
 * fallback heightfield mesh) triangulate it, so a body stands on the ground that is drawn.
 * (A bilinear blend differs from the drawn triangles by up to a quarter of the cell's twist,
 * |h00 + h11 - h10 - h01| / 4: 4.4 m on the steepest SF cells.) Pipeline terrain.ts
 * Ground.meshHeightAt is the same arithmetic. Continuous across cells and across tiles, whose
 * borders repeat the same samples.
 */
export function heightOnField(g: Readonly<Heightfield>, x: number, z: number): number {
  const fx = (x - g.x0) / g.cellSizeM;
  const fz = (z - g.z0) / g.cellSizeM;
  const ix = Math.min(Math.floor(fx), g.nx - 2);
  const iz = Math.min(Math.floor(fz), g.nz - 2);
  const tx = fx - ix;
  const tz = fz - iz;
  const h00 = g.heights[iz * g.nx + ix] ?? 0;
  const h10 = g.heights[iz * g.nx + ix + 1] ?? 0;
  const h01 = g.heights[(iz + 1) * g.nx + ix] ?? 0;
  const h11 = g.heights[(iz + 1) * g.nx + ix + 1] ?? 0;
  if (tx + tz <= 1) return h00 + (h10 - h00) * tx + (h01 - h00) * tz;
  return h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
}

/**
 * Ground height at (x, z): the ground mesh (heightOnField) of the heightfield that covers the
 * point, else 0 (sea level). Pipeline worlds look the tile up by floor(x / T), floor(z / T)
 * (world.tileGround); a point on a tile's far border belongs to that tile when the next one is
 * absent. Neighbours repeat their shared border samples, so a border point has one height
 * whichever tile answers. Hand-made worlds whose heightfields are not tile-aligned use the
 * first covering tile in id order (world.groundIndex).
 */
export function groundHeight(world: World, x: number, z: number): number {
  const tg = world.tileGround;
  if (tg) {
    const ix = Math.floor(x / TILE_SIZE_M);
    const iz = Math.floor(z / TILE_SIZE_M);
    let g = tg.get(cellKey(ix, iz));
    if (!g) {
      const onX = x === ix * TILE_SIZE_M;
      const onZ = z === iz * TILE_SIZE_M;
      g = (onX ? tg.get(cellKey(ix - 1, iz)) : undefined) ?? (onZ ? tg.get(cellKey(ix, iz - 1)) : undefined) ?? (onX && onZ ? tg.get(cellKey(ix - 1, iz - 1)) : undefined);
      if (!g) return 0;
    }
    return heightOnField(g, x, z);
  }
  const candidates = world.groundIndex.get(cellKey(Math.floor(x / GROUND_CELL), Math.floor(z / GROUND_CELL)));
  if (!candidates) return 0;
  for (const t of candidates) {
    const g = t.ground;
    if (!g) continue;
    const fx = (x - g.x0) / g.cellSizeM;
    const fz = (z - g.z0) / g.cellSizeM;
    if (fx < 0 || fz < 0 || fx > g.nx - 1 || fz > g.nz - 1) continue;
    return heightOnField(g, x, z);
  }
  return 0;
}

/**
 * The surface a body with its feet at `feet` stands on at (x, z): the ground, or the roof of a
 * building covering the point when that roof is above the ground and at most ROOF_STEP_M above
 * the feet (a body never steps onto a roof higher than that; such a building blocks it instead,
 * blocksBand). So a body that reaches a roof (from a hillside above it, or over a low ledge)
 * stands on it, and walks or drives off its edge rather than sinking into the building.
 */
export function surfaceHeight(world: World, x: number, z: number, feet: number): number {
  let h = groundHeight(world, x, z);
  const lim = feet + ROOF_STEP_M;
  if (lim <= h) return h;
  const key = cellKey(Math.floor(x / CELL), Math.floor(z / CELL));
  const list = world.cells.get(key);
  if (!list) return h;
  const bb = world.cellBoxes.get(key)!;
  for (let i = 0, n = list.length; i < n; i++) {
    const k = i * 4;
    if (x < bb[k]! || x > bb[k + 2]! || z < bb[k + 1]! || z > bb[k + 3]!) continue;
    const b = list[i]!;
    if (b.topY <= h || b.topY > lim || b.topY <= b.baseY) continue;
    if (pointInPolygon(x, z, b.footprint)) h = b.topY;
  }
  return h;
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
 * Unit normal of the polygon edge nearest (x, z), pointing out of the polygon: the way out for
 * a point on (or within a hair of) the boundary, where the direction to the closest boundary
 * point is undefined. Deterministic: the first nearest edge in ring order.
 */
export function outwardNormal(x: number, z: number, poly: ReadonlyArray<readonly [number, number]>): { x: number; z: number } {
  let best = Infinity;
  let nx = 1;
  let nz = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, az] = poly[j]!;
    const [bx, bz] = poly[i]!;
    const ex = bx - ax;
    const ez = bz - az;
    const len2 = ex * ex + ez * ez;
    if (len2 <= 0) continue;
    let t = ((x - ax) * ex + (z - az) * ez) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + ex * t - x;
    const pz = az + ez * t - z;
    const d2 = px * px + pz * pz;
    if (d2 < best) {
      best = d2;
      const len = Math.sqrt(len2);
      nx = ez / len;
      nz = -ex / len;
    }
  }
  // Whichever side of the edge is outside: step a little that way and test.
  const mx = x + nx * 1e-3;
  const mz = z + nz * 1e-3;
  return pointInPolygon(mx, mz, poly) ? { x: -nx, z: -nz } : { x: nx, z: nz };
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

/**
 * Does a circle of radius r at (x, z) overlap any building footprint? Height is ignored (for
 * ground agents and the road graph), except that a structure whose underside is at least
 * UNDER_CLEARANCE_M above the ground at (x, z) is passed under.
 */
export function circleBlocked(world: World, x: number, z: number, r: number): boolean {
  const r2 = r * r;
  for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++) {
    for (let cz = Math.floor((z - r) / CELL); cz <= Math.floor((z + r) / CELL); cz++) {
      const key = cellKey(cx, cz);
      const list = world.cells.get(key);
      if (!list) continue;
      const bb = world.cellBoxes.get(key)!;
      for (let i = 0, n = list.length; i < n; i++) {
        const k = i * 4;
        if (x + r < bb[k]! || x - r > bb[k + 2]! || z + r < bb[k + 1]! || z - r > bb[k + 3]!) continue;
        const b = list[i]!;
        if (b.topY <= b.baseY) continue;
        // A deck or bridge high enough over the ground here: agents pass under it.
        if (b.underY !== undefined && b.underY - groundHeight(world, x, z) >= UNDER_CLEARANCE_M) continue;
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
 * Height is ignored, as in circleBlocked (for line of sight between bodies on the ground),
 * except that a structure whose underside clears both ends' ground by UNDER_CLEARANCE_M is seen under.
 */
export function segmentBlocked(world: World, ax: number, az: number, bx: number, bz: number): boolean {
  const minX = ax < bx ? ax : bx;
  const maxX = ax > bx ? ax : bx;
  const minZ = az < bz ? az : bz;
  const maxZ = az > bz ? az : bz;
  for (let cx = Math.floor(minX / CELL); cx <= Math.floor(maxX / CELL); cx++) {
    for (let cz = Math.floor(minZ / CELL); cz <= Math.floor(maxZ / CELL); cz++) {
      const key = cellKey(cx, cz);
      const list = world.cells.get(key);
      if (!list) continue;
      const bb = world.cellBoxes.get(key)!;
      for (let i = 0, n = list.length; i < n; i++) {
        const k = i * 4;
        if (maxX < bb[k]! || minX > bb[k + 2]! || maxZ < bb[k + 1]! || minZ > bb[k + 3]!) continue;
        const b = list[i]!;
        if (b.topY <= b.baseY) continue;
        if (b.underY !== undefined && b.underY - Math.max(groundHeight(world, ax, az), groundHeight(world, bx, bz)) >= UNDER_CLEARANCE_M) continue;
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
