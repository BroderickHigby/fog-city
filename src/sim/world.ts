// Static world data the sim collides with. Loaded from tile collider JSON
// (schemas/tile-collider.schema.json); never part of SimState, never mutated.

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
}

const CELL = 50;

export function buildWorld(tiles: readonly TileCollider[]): World {
  const sorted = [...tiles].sort((a, b) => (a.tileId < b.tileId ? -1 : a.tileId > b.tileId ? 1 : 0));
  const grid = new Map<string, BuildingCollider[]>();
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
          const key = `${cx},${cz}`;
          let list = grid.get(key);
          if (!list) grid.set(key, (list = []));
          list.push(b);
        }
      }
    }
  }
  return { tiles: sorted, grid };
}

/** Buildings whose bounding cells overlap the square of half-size r around (x, z). Deterministic order. */
export function nearbyBuildings(world: World, x: number, z: number, r: number): BuildingCollider[] {
  const out: BuildingCollider[] = [];
  const seen = new Set<string>();
  for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++) {
    for (let cz = Math.floor((z - r) / CELL); cz <= Math.floor((z + r) / CELL); cz++) {
      const list = world.grid.get(`${cx},${cz}`);
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

/** Ground height at (x, z): bilinear over whichever tile heightfield covers the point, else 0. */
export function groundHeight(world: World, x: number, z: number): number {
  for (const t of world.tiles) {
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
