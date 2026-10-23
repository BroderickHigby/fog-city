// Static world data the sim collides with: tile colliders (from the citywide collider pack,
// pack.ts, or per-tile collider JSON, schemas/tile-collider.schema.json), optionally the world
// road graph (schemas/roads.schema.json) and the world's edge and shore walls (boundary.json,
// boundary.ts). Never part of SimState, never mutated.

import { buildStairBarriers, buildStairIndex, buildWalls, type BoundaryFile, type StairIndex, type WallSet, type Walls } from "./boundary.ts";
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

/** [x, y, z, w]: a ribbon's centreline point, road-surface height and full width, metres. */
export type RibbonVertex = [number, number, number, number];

/**
 * A road deck above the ground (schemas/tile-collider.schema.json decks): a freeway viaduct or
 * ramp, a street bridge, a street over a freeway cut, a pier. The surface is the ribbon along
 * `path`; layer 1 stands over the ground, 2 over another deck.
 */
export interface Deck {
  id: string;
  kind: "freeway" | "ramp" | "bridge" | "overpass" | "pier";
  /** The roads.json edge the deck carries. */
  edge?: string;
  layer: number;
  path: RibbonVertex[];
}

/** A road below the ground (tunnels): a bored tunnel or an underpass, with a ceiling clearanceM over its floor. */
export interface Tunnel {
  id: string;
  kind: "tunnel" | "underpass";
  edge?: string;
  clearanceM: number;
  path: RibbonVertex[];
}

/** A deck piece that lifts about a hinge line (movable): the Lefty O'Doul bascule. The sim holds it closed. */
export interface Movable {
  id: string;
  kind: "bascule";
  deck: string;
  hinge: [[number, number], [number, number]];
  openRad: number;
}

export interface TileCollider {
  tileId: string;
  buildings: BuildingCollider[];
  ground: Heightfield | null;
  /** Road decks whose segments' midpoints lie in the tile; absent: none. */
  decks?: Deck[];
  /** Tunnel and underpass floors (with their ceilings); absent: none. */
  tunnels?: Tunnel[];
  /** Movable spans; absent: none. */
  movable?: Movable[];
}

/**
 * Every deck and tunnel ribbon segment of the world, indexed for surfaceAt (built by
 * buildWorld). Segment i is SURF_STRIDE numbers at SURF_STRIDE * i: ax, ay, az, half width at a,
 * bx, by, bz, half width at b, the ceiling clearance (a tunnel's clearanceM; -1 for a deck), and
 * the number of its ribbon (a deck's or tunnel's pieces in every tile are one ribbon).
 */
export interface SurfaceIndex {
  segs: Float64Array;
  /** The roads.json edge of each segment ("" when the ribbon names none). */
  edge: string[];
  /** cellKey of SURFACE_CELL_M cells -> segments whose ribbon reaches into the cell, ascending. */
  cells: Map<number, number[]>;
  /** roads.json edge id -> its segments, ascending. */
  byEdge: Map<string, number[]>;
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
  /** The decks and tunnels (surfaceAt), or null when the world has none. */
  surfaces: SurfaceIndex | null;
  /** Walls only cars meet: the rings round the stairways (boundary.ts buildStairBarriers), or null. */
  barriers: WallSet | null;
  /** The stairways' centrelines (boundary.ts onStairs: walkers climb them steeper than a slope), or null. */
  stairs: StairIndex | null;
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
    surfaces: buildSurfaceIndex(sorted),
    barriers: buildStairBarriers(roads),
    stairs: buildStairIndex(roads),
  };
  if (roads) {
    // A lane or sidewalk of a deck or tunnel edge is checked against buildings at its own
    // surface (a span over a bridge, the houses over a bore), every other one at the ground.
    world.roads = buildRoadGraph(roads, { blocked: (x, z, r, edge) => circleBlocked(world, x, z, r, edge === undefined ? undefined : roadSurfaceHeight(world, edge, x, z)) });
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

/** Bilinear height of one heightfield at (x, z), clamped into its lattice (the caller picked the tile). */
function bilinearOnField(g: Readonly<Heightfield>, x: number, z: number): number {
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
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
}

/**
 * Height of one heightfield at (x, z), clamped into its lattice (the caller picked the tile), on
 * the rendered ground mesh: each lattice cell is two planar triangles split along its
 * (i+1, k)-(i, k+1) diagonal, exactly as pipeline/lib/mesh.ts groundMesh (and the renderer's
 * fallback heightfield mesh) triangulate it (pipeline terrain.ts Ground.meshHeightAt is the
 * same plane). A bilinear blend differs from the drawn triangles by up to a quarter of the
 * cell's twist, |h00 + h11 - h10 - h01| / 4: 4.4 m on the steepest SF cells. On a tile's far
 * border (the last row or column, where the next tile's first one repeats the same samples)
 * the edge is interpolated exactly as the next tile interpolates its near edge, so the two
 * tiles give bit-identical heights there.
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
  // The far border (only ever the lattice's last row or column): as the next tile's near edge.
  if (tx === 1) return tz === 1 ? h11 : h10 + (h11 - h10) * tz;
  if (tz === 1) return h01 + (h11 - h01) * tx;
  if (tx + tz <= 1) return h00 + (h10 - h00) * tx + (h01 - h00) * tz;
  return h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
}

/** The heightfield covering (x, z) by the world's ground lookup (see groundHeight), or null. */
function fieldAt(world: World, x: number, z: number): Heightfield | null {
  const tg = world.tileGround;
  if (tg) {
    const ix = Math.floor(x / TILE_SIZE_M);
    const iz = Math.floor(z / TILE_SIZE_M);
    let g = tg.get(cellKey(ix, iz));
    if (!g) {
      const onX = x === ix * TILE_SIZE_M;
      const onZ = z === iz * TILE_SIZE_M;
      g = (onX ? tg.get(cellKey(ix - 1, iz)) : undefined) ?? (onZ ? tg.get(cellKey(ix, iz - 1)) : undefined) ?? (onX && onZ ? tg.get(cellKey(ix - 1, iz - 1)) : undefined);
    }
    return g ?? null;
  }
  const candidates = world.groundIndex.get(cellKey(Math.floor(x / GROUND_CELL), Math.floor(z / GROUND_CELL)));
  if (!candidates) return null;
  for (const t of candidates) {
    const g = t.ground;
    if (!g) continue;
    const fx = (x - g.x0) / g.cellSizeM;
    const fz = (z - g.z0) / g.cellSizeM;
    if (fx < 0 || fz < 0 || fx > g.nx - 1 || fz > g.nz - 1) continue;
    return g;
  }
  return null;
}

/**
 * The lattice's ground height at (x, z): bilinear over the heightfield that covers the point,
 * else 0 (sea level). The reference the pipeline places its data on (building bases, street
 * furniture) and the renderer's mirrors repeat (src/render/ground.ts, the pipeline's
 * PackGroundIndex); bodies stand on the drawn ground instead (meshGroundHeight). Pipeline worlds
 * look the tile up by floor(x / T), floor(z / T) (world.tileGround); a point on a tile's far
 * border belongs to that tile when the next one is absent. Neighbours repeat their shared
 * border samples, so a border point has one height whichever tile answers. Hand-made worlds
 * whose heightfields are not tile-aligned use the first covering tile in id order
 * (world.groundIndex).
 */
export function groundHeight(world: World, x: number, z: number): number {
  const g = fieldAt(world, x, z);
  return g ? bilinearOnField(g, x, z) : 0;
}

/**
 * The drawn ground's height at (x, z): the ground mesh's two triangles per lattice cell
 * (heightOnField) of the heightfield groundHeight would use, else 0. What cars, walkers and
 * agents stand on (W-22: the bilinear ground was off the drawn ground by up to 4.4 m), so a
 * body is drawn on the terrain that is drawn.
 */
export function meshGroundHeight(world: World, x: number, z: number): number {
  const g = fieldAt(world, x, z);
  return g ? heightOnField(g, x, z) : 0;
}

const SURF_STRIDE = 10;
/** Cell size of the surface index, metres. */
const SURFACE_CELL_M = 25;
/**
 * Bounds on the drawn ground's height over the box from (minX, minZ) to (maxX, maxZ): the least
 * and greatest lattice sample of every cell of every heightfield that covers part of it (the
 * mesh is planar within each cell's triangles, so it never goes outside its cells' samples), and
 * 0 where no heightfield covers a corner (the sea). The dodge uses it for the height a vehicle
 * can reach over its next step.
 */
export function meshGroundRange(world: World, minX: number, minZ: number, maxX: number, maxZ: number): { min: number; max: number } {
  let lo = Infinity;
  let hi = -Infinity;
  const seen: Heightfield[] = [];
  for (const [x, z] of [
    [minX, minZ],
    [maxX, minZ],
    [minX, maxZ],
    [maxX, maxZ],
    [(minX + maxX) / 2, (minZ + maxZ) / 2],
  ] as const) {
    const g = fieldAt(world, x, z);
    if (!g) {
      if (lo > 0) lo = 0;
      if (hi < 0) hi = 0;
      continue;
    }
    if (seen.includes(g)) continue;
    seen.push(g);
    const ix0 = Math.max(0, Math.min(g.nx - 1, Math.floor((minX - g.x0) / g.cellSizeM)));
    const ix1 = Math.max(0, Math.min(g.nx - 1, Math.ceil((maxX - g.x0) / g.cellSizeM)));
    const iz0 = Math.max(0, Math.min(g.nz - 1, Math.floor((minZ - g.z0) / g.cellSizeM)));
    const iz1 = Math.max(0, Math.min(g.nz - 1, Math.ceil((maxZ - g.z0) / g.cellSizeM)));
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const h = g.heights[iz * g.nx + ix] ?? 0;
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
    }
  }
  return { min: lo, max: hi };
}

/**
 * A body leaving a deck or a tunnel bore may step onto a surface at most this far below its
 * feet (a ramp's foot onto the ground beside it); farther down is the deck's edge, held by its
 * rail, and anything above ROOF_STEP_M is the bore's wall (railPush).
 */
export const RAIL_DROP_M = 1;
/** agents and the road graph find an edge's deck or tunnel within this far beyond the ribbon's side (its sidewalks). */
export const EDGE_SURFACE_REACH_M = 4;

/**
 * The deck ribbons (ids before "~<n>") that contradict their own edge's tunnel: a deck of edge E
 * that covers, in plan, a vertex of E's own tunnel bore at more than ROOF_STEP_M over that bore's
 * floor. One road cannot be both in the hill and on a deck over the same spot, so the bore wins
 * and the deck is left out of the surfaces (the pipeline's c3186101.o~0, an "overpass" over the
 * Broadway Tunnel's west portal on the bore's own edge, which lifted the eastbound approach 6 m
 * into the houses over the portal; world QA W-02). Decks of other edges over a bore (a street on
 * the hill above it) are untouched.
 */
export function contradictoryDecks(tiles: readonly TileCollider[]): Set<string> {
  const bores = new Map<string, RibbonVertex[]>();
  for (const t of tiles) {
    for (const u of t.tunnels ?? []) {
      if (u.edge === undefined) continue;
      let l = bores.get(u.edge);
      if (!l) bores.set(u.edge, (l = []));
      l.push(...u.path);
    }
  }
  const out = new Set<string>();
  if (bores.size === 0) return out;
  for (const t of tiles) {
    for (const d of t.decks ?? []) {
      const verts = d.edge === undefined ? undefined : bores.get(d.edge);
      if (!verts) continue;
      const seg = new Float64Array(SURF_STRIDE);
      search: for (let i = 1; i < d.path.length; i++) {
        const a = d.path[i - 1]!;
        const b = d.path[i]!;
        seg.set([a[0], a[1], a[2], a[3] / 2, b[0], b[1], b[2], b[3] / 2, -1, 0]);
        for (const v of verts) {
          const q = onSegment(seg, 0, v[0], v[2]);
          if (q.d2 <= q.half * q.half && q.y > v[1] + ROOF_STEP_M) {
            out.add(d.id.replace(/~\d+$/, ""));
            break search;
          }
        }
      }
    }
  }
  return out;
}

/** The decks and tunnels of the tiles, segment by segment, in tile order then file order. */
function buildSurfaceIndex(tiles: readonly TileCollider[]): SurfaceIndex | null {
  const segs: number[] = [];
  const edge: string[] = [];
  const cells = new Map<number, number[]>();
  const byEdge = new Map<string, number[]>();
  // Each ribbon gets a number (its pieces, split at tile borders, share the id before "~<n>").
  const ribbons = new Map<string, number>();
  const add = (id: string, path: readonly RibbonVertex[], clearance: number, edgeId: string | undefined): void => {
    const base = id.replace(/~\d+$/, "");
    let rib = ribbons.get(base);
    if (rib === undefined) ribbons.set(base, (rib = ribbons.size));
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!;
      const b = path[i]!;
      const k = edge.length;
      segs.push(a[0], a[1], a[2], a[3] / 2, b[0], b[1], b[2], b[3] / 2, clearance, rib);
      edge.push(edgeId ?? "");
      if (edgeId !== undefined) {
        let l = byEdge.get(edgeId);
        if (!l) byEdge.set(edgeId, (l = []));
        l.push(k);
      }
      const r = (a[3] > b[3] ? a[3] : b[3]) / 2;
      for (let cx = Math.floor(((a[0] < b[0] ? a[0] : b[0]) - r) / SURFACE_CELL_M); cx <= Math.floor(((a[0] > b[0] ? a[0] : b[0]) + r) / SURFACE_CELL_M); cx++) {
        for (let cz = Math.floor(((a[2] < b[2] ? a[2] : b[2]) - r) / SURFACE_CELL_M); cz <= Math.floor(((a[2] > b[2] ? a[2] : b[2]) + r) / SURFACE_CELL_M); cz++) {
          const key = cellKey(cx, cz);
          let l = cells.get(key);
          if (!l) cells.set(key, (l = []));
          l.push(k);
        }
      }
    }
  };
  const dropped = contradictoryDecks(tiles);
  for (const t of tiles) {
    for (const d of t.decks ?? []) if (!dropped.has(d.id.replace(/~\d+$/, ""))) add(d.id, d.path, -1, d.edge);
    for (const u of t.tunnels ?? []) add(u.id, u.path, u.clearanceM, u.edge);
  }
  if (edge.length === 0) return null;
  return { segs: Float64Array.from(segs), edge, cells, byEdge };
}

/** What a body stands on (surfaceAt). */
export interface Surface {
  /** Height of the surface, metres. */
  y: number;
  /** "ground" (the drawn ground), "roof", "deck" or "tunnel" (a bore's floor). */
  kind: "ground" | "roof" | "deck" | "tunnel";
  /** In a bore: its ceiling (the body's top stays under it); else Infinity. */
  ceiling: number;
}

/**
 * Where (x, z) falls on segment k of the surface index: its parameter t along the segment
 * (clamped to the ends, so a ribbon's ends are round), whether the point is beside the segment
 * itself (`inner`: its unclamped t is within the segment) rather than past an end, the squared
 * distance from the centreline, the ribbon's half width there, and the surface height y.
 */
function onSegment(s: Float64Array, k: number, x: number, z: number): { t: number; inner: boolean; d2: number; half: number; y: number } {
  const o = k * SURF_STRIDE;
  const ax = s[o]!;
  const az = s[o + 2]!;
  const ex = s[o + 4]! - ax;
  const ez = s[o + 6]! - az;
  const L2 = ex * ex + ez * ez;
  const raw = L2 > 0 ? ((x - ax) * ex + (z - az) * ez) / L2 : 0;
  const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
  const px = ax + ex * t - x;
  const pz = az + ez * t - z;
  return { t, inner: raw === t, d2: px * px + pz * pz, half: s[o + 3]! + (s[o + 7]! - s[o + 3]!) * t, y: s[o + 1]! + (s[o + 5]! - s[o + 1]!) * t };
}

/**
 * Where decks overlap, a body is on the one with the least cost (surfaceAt): its distance from
 * the deck's centreline, metres, plus DECK_HEIGHT_COST per metre the deck is above its feet and
 * DECK_DROP_COST per metre below them. So the nearest centreline wins, and between nearly
 * equally near ones (at a ramp's gore) the one at its feet.
 */
const DECK_HEIGHT_COST = 1;
const DECK_DROP_COST = 2;

/** The body is on a deck when one is at most this far above its feet, or below them (surfaceAt); else it steps up onto the highest. */
const DECK_STAY_M = 0.15;

/** A segment's round end that covers a point counts only when no segment of its own ribbon, or carrying it on from that end, covering the point beside itself is within this height of it (covering). */
const CAP_MERGE_M = 1;

/** Is one of segment k's two ends at (x, z) (within a centimetre)? */
function endsAt(s: Float64Array, k: number, x: number, z: number): boolean {
  const o = k * SURF_STRIDE;
  const ax = s[o]! - x;
  const az = s[o + 2]! - z;
  const bx = s[o + 4]! - x;
  const bz = s[o + 6]! - z;
  return (ax < 0.01 && ax > -0.01 && az < 0.01 && az > -0.01) || (bx < 0.01 && bx > -0.01 && bz < 0.01 && bz > -0.01);
}

/**
 * The ribbon segments covering (x, z) from a cell's list, with their heights and how far from
 * the segment's centreline the point is. A segment's round end (the point past the segment's end) does not
 * count where a segment of the same ribbon, or one that carries it on from that end (the next
 * edge's deck, a ramp leaving it), covers the point beside itself within CAP_MERGE_M of the
 * end's height: so along a ribbon each point has the height of
 * the segment it is beside, and an end's level cap never stands as a shelf over the next
 * segment for a car going downhill to drop off. The caps fill the outside of a bend and round
 * off the ribbons' free ends; a deck that merely crosses another is never mistaken for its
 * continuation.
 */
function covering(s: Float64Array, list: readonly number[], x: number, z: number): Array<{ k: number; y: number; inner: boolean; dist: number }> {
  const hits: Array<{ k: number; y: number; inner: boolean; dist: number; end: number }> = [];
  let anyCap = false;
  for (let i = 0, n = list.length; i < n; i++) {
    const k = list[i]!;
    const q = onSegment(s, k, x, z);
    if (q.d2 > q.half * q.half) continue;
    // dist: how far the point is from the segment's centreline, metres.
    hits.push({ k, y: q.y, inner: q.inner, dist: Math.sqrt(q.d2), end: q.inner ? -1 : q.t === 0 ? 0 : 4 });
    if (!q.inner) anyCap = true;
  }
  if (!anyCap) return hits;
  return hits.filter((h) => {
    if (h.inner) return true;
    const o = h.k * SURF_STRIDE + h.end;
    const ex = s[o]!;
    const ez = s[o + 2]!;
    const rib = s[h.k * SURF_STRIDE + 9]!;
    return !hits.some((c) => c.inner && c.k !== h.k && c.y - h.y < CAP_MERGE_M && h.y - c.y < CAP_MERGE_M && (s[c.k * SURF_STRIDE + 9] === rib || endsAt(s, c.k, ex, ez)));
  });
}

/**
 * The surface a body with its feet at `feet` stands on at (x, z) (docs/design.md "Decks,
 * tunnels and water"; the pipeline's reference lookup is pipeline/lib/surfaces.ts):
 *  - In a tunnel bore (a tunnel ribbon covers the point, the feet are between its floor less
 *    ROOF_STEP_M and its ceiling, and either within ROOF_STEP_M of the floor or more than that
 *    under the ground above): the bore's floor, with its ceiling. The ground over a bore is not
 *    its surface, so a car that drives in at a portal stays on the floor while the hill rises
 *    over it, and a car on the hill above stays on the hill.
 *  - Otherwise the highest of the drawn ground (meshGroundHeight) and the decks covering the
 *    point that is at most ROOF_STEP_M above the feet: a car on a viaduct stands on the deck,
 *    a car on the street under it on the ground. Where decks overlap, of the decks from
 *    RAIL_DROP_M below the feet to ROOF_STEP_M above them (the ones the body could be on) the
 *    one whose centreline is nearest, rather than a higher one beside it. When every one is
 *    higher (a body under the ground) the lowest. Decks that contradict their own edge's bore
 *    are left out (contradictoryDecks).
 *  - Then a building's roof covering the point when it is above that and at most ROOF_STEP_M
 *    above the feet (a body never steps onto a roof higher than that; such a building blocks
 *    it instead, blocksBand). So a body that reaches a roof (from a hillside above it, or over
 *    a low ledge) stands on it, and walks or drives off its edge rather than sinking into the
 *    building.
 * A deck or tunnel ribbon covers the points within its half width of its centreline segments
 * (the ends round), at the height interpolated along the segment.
 */
export function surfaceAt(world: World, x: number, z: number, feet: number, roofs = true, refX = x, refZ = z): Surface {
  const g = meshGroundHeight(world, x, z);
  const lim = feet + ROOF_STEP_M;
  let h = g;
  let kind: Surface["kind"] = "ground";
  const si = world.surfaces;
  if (si) {
    const list = si.cells.get(cellKey(Math.floor(x / SURFACE_CELL_M), Math.floor(z / SURFACE_CELL_M)));
    if (list) {
      const s = si.segs;
      let bore = -Infinity;
      let ceiling = Infinity;
      let best = g <= lim ? g : -Infinity;
      let lowest = g;
      const hits = covering(s, list, x, z);
      for (const { k, y } of hits) {
        const clearance = s[k * SURF_STRIDE + 8]!;
        if (clearance >= 0) {
          if (feet >= y - ROOF_STEP_M && feet <= y + clearance && (feet <= y + ROOF_STEP_M || feet < g - ROOF_STEP_M) && y > bore) {
            bore = y;
            ceiling = y + clearance;
          }
          continue;
        }
        if (y <= lim && y > best) {
          best = y;
          kind = "deck";
        }
        if (y < lowest) lowest = y;
      }
      if (bore > -Infinity) return { y: bore, kind: "tunnel", ceiling };
      if (kind === "deck") {
        // A body on a deck stays on it. Where decks overlap (a freeway's two directions side by
        // side, their ribbons wider than the gap between them; a ramp leaving it) and one is at
        // or under its feet, of the decks it could be on (from RAIL_DROP_M below its feet to
        // ROOF_STEP_M above them) the one of least cost (DECK_HEIGHT_COST): the nearest
        // centreline to the body (refX, refZ: a car's wheels ask for its centre, so all four keep
        // to the deck the car is on), rather than the highest. So a car keeps to its own deck as
        // another rises or falls away beside it, also while it rides a little over its own deck
        // at a crest, and a ramp diverging from a freeway does not take the wheels on its side.
        // With no deck at or under its feet (a ramp's foot from the ground) it steps up onto the
        // highest. Decks stacked a clearance apart never share that band.
        let score = Infinity;
        let pick = best;
        let under = false;
        for (const hit of hits) {
          if (s[hit.k * SURF_STRIDE + 8]! >= 0 || hit.y > lim || hit.y < g || hit.y < feet - RAIL_DROP_M) continue;
          if (hit.y <= feet + DECK_STAY_M) under = true;
          const d = hit.y > feet ? hit.y - feet : DECK_DROP_COST * (feet - hit.y);
          const q = (refX === x && refZ === z ? hit.dist : Math.sqrt(onSegment(s, hit.k, refX, refZ).d2)) + DECK_HEIGHT_COST * d;
          if (q < score) {
            score = q;
            pick = hit.y;
          }
        }
        if (under) best = pick;
      }
      if (best > -Infinity) h = best;
      else {
        h = lowest;
        kind = lowest < g ? "deck" : "ground";
      }
      if (kind === "deck" && h === g) kind = "ground";
    }
  }
  if (lim <= h || !roofs) return { y: h, kind, ceiling: Infinity };
  const key = cellKey(Math.floor(x / CELL), Math.floor(z / CELL));
  const list = world.cells.get(key);
  if (!list) return { y: h, kind, ceiling: Infinity };
  const bb = world.cellBoxes.get(key)!;
  for (let i = 0, n = list.length; i < n; i++) {
    const k = i * 4;
    if (x < bb[k]! || x > bb[k + 2]! || z < bb[k + 1]! || z > bb[k + 3]!) continue;
    const b = list[i]!;
    if (b.topY <= h || b.topY > lim || b.topY <= b.baseY) continue;
    if (pointInPolygon(x, z, b.footprint)) {
      h = b.topY;
      kind = "roof";
    }
  }
  return { y: h, kind, ceiling: Infinity };
}

/** The height of surfaceAt(world, x, z, feet): what a body with its feet at `feet` stands on. */
export function surfaceHeight(world: World, x: number, z: number, feet: number): number {
  return surfaceAt(world, x, z, feet).y;
}

/**
 * Can a body with its feet at `feet` stand at (x, z) without falling or climbing: is the
 * surface there (surfaceAt) between RAIL_DROP_M below its feet and ROOF_STEP_M above them?
 * `roofs` false: roofs do not count (a body on a deck never leaves it for a roof beside it).
 */
export function supported(world: World, x: number, z: number, feet: number, roofs = true): boolean {
  const y = surfaceAt(world, x, z, feet, roofs).y;
  return y <= feet + ROOF_STEP_M && y >= feet - RAIL_DROP_M;
}

/**
 * The rails of decks and the walls of tunnel bores: a body on a deck or in a bore (its feet at
 * `feet`) whose point (x, z) has moved off every deck, bore floor or ground it could stand on
 * (supported, roofs not counted) is
 * pushed back onto the nearest deck or tunnel ribbon at its height, to `inset` inside the
 * ribbon's edge. Returns the push, or null when the point is supported or no ribbon at the
 * body's height is near.
 */
export function railPush(world: World, x: number, z: number, feet: number, inset = 0): { dx: number; dz: number } | null {
  const si = world.surfaces;
  // (A roof beside a viaduct at the deck's height is behind the rail, not a way off it.)
  if (!si || supported(world, x, z, feet, false)) return null;
  const s = si.segs;
  const cx0 = Math.floor(x / SURFACE_CELL_M);
  const cz0 = Math.floor(z / SURFACE_CELL_M);
  let bestPen = Infinity;
  let px = 0;
  let pz = 0;
  for (let cx = cx0 - 1; cx <= cx0 + 1; cx++) {
    for (let cz = cz0 - 1; cz <= cz0 + 1; cz++) {
      const list = si.cells.get(cellKey(cx, cz));
      if (!list) continue;
      for (let i = 0, n = list.length; i < n; i++) {
        const k = list[i]!;
        const q = onSegment(s, k, x, z);
        const o = k * SURF_STRIDE;
        const y = q.y;
        // A ribbon the body could stand on (the one it is on, or one it is moving onto).
        if (y > feet + ROOF_STEP_M || y < feet - RAIL_DROP_M) continue;
        const d = Math.sqrt(q.d2);
        const pen = d - (q.half - inset);
        if (pen >= bestPen) continue;
        bestPen = pen;
        // Back toward the centreline.
        const ax = s[o]!;
        const az = s[o + 2]!;
        const cxp = ax + (s[o + 4]! - ax) * q.t;
        const czp = az + (s[o + 6]! - az) * q.t;
        px = d > 1e-9 ? (cxp - x) / d : 0;
        pz = d > 1e-9 ? (czp - z) / d : 0;
      }
    }
  }
  if (bestPen <= 0 || bestPen === Infinity) return null;
  const k = bestPen + 1e-4;
  return { dx: px * k, dz: pz * k };
}

/**
 * The road surface of a roads.json edge at (x, z), for bodies that follow it (agents, the road
 * graph's clearance checks): the edge's deck or tunnel floor when one of its ribbons is beside
 * the point within EDGE_SURFACE_REACH_M of the ribbon's side (the lanes and sidewalks over a
 * bridge or through a bore) or covers it with a round end, else the drawn ground.
 */
export function roadSurfaceHeight(world: World, edgeId: string, x: number, z: number): number {
  const list = world.surfaces?.byEdge.get(edgeId);
  if (list) {
    const s = world.surfaces!.segs;
    // The nearest segment beside the point; only where none is, the nearest end.
    let best = Infinity;
    let y = 0;
    let bestEnd = Infinity;
    let yEnd = 0;
    for (let i = 0, n = list.length; i < n; i++) {
      const k = list[i]!;
      const q = onSegment(s, k, x, z);
      const reach = q.half + EDGE_SURFACE_REACH_M;
      if (q.d2 > reach * reach) continue;
      const gap = Math.sqrt(q.d2) - q.half;
      if (q.inner && gap < best) {
        best = gap;
        y = q.y;
      } else if (!q.inner && gap <= 0 && gap < bestEnd) {
        bestEnd = gap;
        yEnd = q.y;
      }
    }
    if (best < Infinity) return y;
    if (bestEnd < Infinity) return yEnd;
  }
  return meshGroundHeight(world, x, z);
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
 * UNDER_CLEARANCE_M above the body's surface `y` (default: the drawn ground at (x, z); a deck or
 * a tunnel floor for a body on one, roadSurfaceHeight) is passed under.
 */
export function circleBlocked(world: World, x: number, z: number, r: number, y?: number): boolean {
  const r2 = r * r;
  let base = y;
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
        if (b.underY !== undefined && b.underY - (base ??= meshGroundHeight(world, x, z)) >= UNDER_CLEARANCE_M) continue;
        if (circleTouchesPolygon(x, z, r2, b.footprint)) return true;
      }
    }
  }
  return false;
}

/**
 * Does a circle of radius r at (x, z) overlap a building that blocks a body whose collision band
 * runs from `bottom` to `top` (blocksBand: its feet plus the step it can climb, to the top of
 * its head)? The height-aware circleBlocked: a body on a roof is not blocked by that roof, nor
 * by a low deck it can step onto, and passes under a high enough underside.
 */
export function circleBlockedBand(world: World, x: number, z: number, r: number, bottom: number, top: number): boolean {
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
        if (!blocksBand(b, bottom, top)) continue;
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
        if (b.underY !== undefined && b.underY - Math.max(meshGroundHeight(world, ax, az), meshGroundHeight(world, bx, bz)) >= UNDER_CLEARANCE_M) continue;
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
