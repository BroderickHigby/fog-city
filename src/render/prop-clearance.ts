// Where street furniture may stand (W-44): never on any road's carriageway (its centreline ±
// half its width, the ribbon the tiles draw, plus a margin), never inside a building's footprint
// and never on water (the Bay, a lake). The road graph's per-edge spots (roads.ts) are made
// without looking at other streets or at buildings, so a lamp on one street's kerb could stand in
// the next street's lane, under a freeway on the street beneath it, or in a row house; this index
// rejects those. Pure and deterministic: tests/render/props-placement.test.ts.

import type { Heightfield, TileCollider } from "../sim/world.ts";
import { roadHalfWidth } from "./roads.ts";
import type { RoadEdge } from "./types.ts";

/** A prop keeps this far from any carriageway's edge, metres. */
export const ROAD_MARGIN_M = 0.5;
/** ... and this far from a building's wall (its trunk or pole and a little of its crown). */
export const BUILDING_MARGIN_M = 0.4;
const CELL = 50;

interface Seg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  hw: number;
}

interface Foot {
  poly: ReadonlyArray<readonly [number, number]>;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

const key = (cx: number, cz: number): number => (cx + 32768) * 65536 + (cz + 32768);

function segDist(px: number, pz: number, s: Seg): number {
  const dx = s.bx - s.ax;
  const dz = s.bz - s.az;
  const L2 = dx * dx + dz * dz;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((px - s.ax) * dx + (pz - s.az) * dz) / L2)) : 0;
  return Math.hypot(px - (s.ax + dx * t), pz - (s.az + dz * t));
}

function inPoly(x: number, z: number, poly: ReadonlyArray<readonly [number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]!;
    const [xj, zj] = poly[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function edgeDist(x: number, z: number, poly: ReadonlyArray<readonly [number, number]>): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j]!;
    const b = poly[i]!;
    best = Math.min(best, segDist(x, z, { ax: a[0], az: a[1], bx: b[0], bz: b[1], hw: 0 }));
  }
  return best;
}

export class PropClearance {
  private readonly roads = new Map<number, Seg[]>();
  private readonly feet = new Map<number, Foot[]>();
  private readonly grounds: Array<Heightfield & { lake?: ArrayLike<number>; cover?: string }> = [];
  private readonly groundGrid = new Map<number, number[]>();
  private maxHw = 0;

  constructor(edges: readonly RoadEdge[], tiles: Iterable<TileCollider>) {
    for (const e of edges) {
      // Every vehicle carriageway counts, freeways and ramps included (their ribbons are drawn
      // on the ground under a deck too); pedestrian ways are not a carriageway.
      if (e.pedestrian) continue;
      const hw = roadHalfWidth(e);
      this.maxHw = Math.max(this.maxHw, hw);
      for (let i = 1; i < e.points.length; i++) {
        const [ax, az] = e.points[i - 1]!;
        const [bx, bz] = e.points[i]!;
        const s: Seg = { ax, az, bx, bz, hw };
        const r = hw + ROAD_MARGIN_M;
        for (let cx = Math.floor((Math.min(ax, bx) - r) / CELL); cx <= Math.floor((Math.max(ax, bx) + r) / CELL); cx++) {
          for (let cz = Math.floor((Math.min(az, bz) - r) / CELL); cz <= Math.floor((Math.max(az, bz) + r) / CELL); cz++) {
            const k = key(cx, cz);
            let l = this.roads.get(k);
            if (!l) this.roads.set(k, (l = []));
            l.push(s);
          }
        }
      }
    }
    for (const t of tiles) {
      for (const b of t.buildings) {
        if (b.footprint.length < 3) continue;
        let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
        for (const [x, z] of b.footprint) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minZ = Math.min(minZ, z);
          maxZ = Math.max(maxZ, z);
        }
        const f: Foot = { poly: b.footprint, minX, minZ, maxX, maxZ };
        const m = BUILDING_MARGIN_M;
        for (let cx = Math.floor((minX - m) / CELL); cx <= Math.floor((maxX + m) / CELL); cx++) {
          for (let cz = Math.floor((minZ - m) / CELL); cz <= Math.floor((maxZ + m) / CELL); cz++) {
            const k = key(cx, cz);
            let l = this.feet.get(k);
            if (!l) this.feet.set(k, (l = []));
            l.push(f);
          }
        }
      }
      const g = t.ground;
      if (g && g.nx >= 2 && g.nz >= 2) {
        const gi = this.grounds.length;
        this.grounds.push(g);
        const x1 = g.x0 + (g.nx - 1) * g.cellSizeM;
        const z1 = g.z0 + (g.nz - 1) * g.cellSizeM;
        for (let cx = Math.floor(g.x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
          for (let cz = Math.floor(g.z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) {
            const k = key(cx, cz);
            let l = this.groundGrid.get(k);
            if (!l) this.groundGrid.set(k, (l = []));
            l.push(gi);
          }
        }
      }
    }
  }

  /** The nearest distance from (x, z) to any carriageway's edge (negative inside one). */
  roadClearance(x: number, z: number): number {
    let best = Infinity;
    for (const s of this.roads.get(key(Math.floor(x / CELL), Math.floor(z / CELL))) ?? []) best = Math.min(best, segDist(x, z, s) - s.hw);
    return best;
  }

  /** True when (x, z) is inside a building's footprint or within BUILDING_MARGIN_M of its wall. */
  inBuilding(x: number, z: number): boolean {
    for (const f of this.feet.get(key(Math.floor(x / CELL), Math.floor(z / CELL))) ?? []) {
      const m = BUILDING_MARGIN_M;
      if (x < f.minX - m || x > f.maxX + m || z < f.minZ - m || z > f.maxZ + m) continue;
      if (inPoly(x, z, f.poly) || edgeDist(x, z, f.poly) < m) return true;
    }
    return false;
  }

  /** True when any lattice corner of the cell under (x, z) is water: the Bay or an inland lake. */
  onWater(x: number, z: number): boolean {
    for (const gi of this.groundGrid.get(key(Math.floor(x / CELL), Math.floor(z / CELL))) ?? []) {
      const g = this.grounds[gi]!;
      const fx = (x - g.x0) / g.cellSizeM;
      const fz = (z - g.z0) / g.cellSizeM;
      if (fx < 0 || fz < 0 || fx > g.nx - 1 || fz > g.nz - 1) continue;
      const i = Math.min(Math.floor(fx), g.nx - 2);
      const k = Math.min(Math.floor(fz), g.nz - 2);
      for (const s of [k * g.nx + i, k * g.nx + i + 1, (k + 1) * g.nx + i, (k + 1) * g.nx + i + 1]) {
        if (g.water?.[s]) return true;
        if (g.lake?.[s]) return true;
        const c = g.cover?.charCodeAt(s) ?? 0;
        if (c === 119 /* w */ || (c >= 48 && c <= 57)) return true;
      }
      return false;
    }
    // Outside every tile: open water.
    return true;
  }

  /** May a prop stand at (x, z)? */
  clear(x: number, z: number): boolean {
    return this.roadClearance(x, z) >= ROAD_MARGIN_M && !this.inBuilding(x, z) && !this.onWater(x, z);
  }
}
