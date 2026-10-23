// World geometry only. Dynamic buildings/body clearance is still decided by spawn's safeSpot.
import { lanePath, pathPoint, walkPath } from "../roads.ts";
import { meshGroundHeight, type World } from "../world.ts";
import type { RoutinePoint } from "./routines.ts";

type SpawnMode = "walking" | "vehicle";
interface Candidate {
  readonly x: number;
  readonly z: number;
  readonly order: number;
  ground: number | null;
}
interface SpawnIndex { readonly cells: ReadonlyMap<string, readonly Candidate[]> }
const CELL_M = 150;
const MIN_DISTANCE_SQ = 15 * 15;
const MAX_DISTANCE_SQ = 150 * 150;
const indices = new WeakMap<World, Partial<Record<SpawnMode, SpawnIndex>>>();
const cellKey = (x: number, z: number): string => `${x},${z}`;

function indexOf(world: World, mode: SpawnMode): SpawnIndex {
  let modes = indices.get(world);
  if (!modes) { modes = {}; indices.set(world, modes); }
  const cached = modes[mode];
  if (cached) return cached;
  const cells = new Map<string, Candidate[]>();
  let order = 0;
  // Retain native road/offset order as the final stable tie-break used by the old scan.
  for (const edge of world.roads?.edges ?? []) {
    if (mode === "vehicle" ? !edge.drivable || edge.laneCount[0] === 0 : !edge.walkable) continue;
    const path = mode === "vehicle" ? lanePath(edge, 1, 0) : walkPath(edge, 1, 1);
    for (const offset of [0.25, 0.5, 0.75]) {
      const point = pathPoint(path, path.len * offset);
      const key = cellKey(Math.floor(point.x / CELL_M), Math.floor(point.z / CELL_M));
      let cell = cells.get(key);
      if (!cell) { cell = []; cells.set(key, cell); }
      // Height is sampled lazily, once, only if this point enters a spawn query.
      cell.push({ x: point.x, z: point.z, order: order++, ground: null });
    }
  }
  const index: SpawnIndex = { cells };
  modes[mode] = index;
  return index;
}

/** Exact 15..150m candidate order from the original scan, with fresh result objects. */
export function routineSpawnCandidates(world: World, near: { readonly x: number; readonly z: number }, mode: SpawnMode, altitude = 0): RoutinePoint[] {
  // Non-finite query positions previously failed every finite distance comparison.
  if (!Number.isFinite(near.x) || !Number.isFinite(near.z)) return [];
  const index = indexOf(world, mode);
  const found: { candidate: Candidate; distance: number }[] = [];
  const minX = Math.floor((near.x - 150) / CELL_M), columns = Math.floor((near.x + 150) / CELL_M) - minX;
  const minZ = Math.floor((near.z - 150) / CELL_M), rows = Math.floor((near.z + 150) / CELL_M) - minZ;
  for (let column = 0; column <= columns; column++) {
    for (let row = 0; row <= rows; row++) {
      const cx = minX + column, cz = minZ + row;
      for (const candidate of index.cells.get(cellKey(cx, cz)) ?? []) {
        const dx = candidate.x - near.x, dz = candidate.z - near.z;
        const distance = dx * dx + dz * dz;
        if (distance >= MIN_DISTANCE_SQ && distance <= MAX_DISTANCE_SQ) found.push({ candidate, distance });
      }
    }
  }
  found.sort((a, b) => a.distance - b.distance || a.candidate.x - b.candidate.x || a.candidate.z - b.candidate.z || a.candidate.order - b.candidate.order);
  return found.map(({ candidate }) => {
    candidate.ground ??= meshGroundHeight(world, candidate.x, candidate.z);
    return { x: candidate.x, y: candidate.ground + altitude, z: candidate.z };
  });
}
