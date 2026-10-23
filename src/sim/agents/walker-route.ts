import { circleHitsWall, onWater, segmentCrossesWall } from "../boundary.ts";
import { TICK_HZ } from "../contract.ts";
import { pathPoint, type RoadEdgeInfo } from "../roads.ts";
import { hashState } from "../serialize.ts";
import { cellKey, circleBlocked, circleBlockedBand, meshGroundHeight, meshGroundRange, type Heightfield, type World } from "../world.ts";
import type { FinalePoint, FinaleRoute, FinaleWaypoint, ProtectedFinaleBody } from "../robots/finale.ts";

/** Covers the Walker's 4 m by 2 m half-extents at every heading. */
export const WALKER_PATROL_RADIUS_M = 4.5;
export const WALKER_PATROL_STEP_M = 4;
export const WALKER_PATROL_LENGTH_M = 24;
const SAMPLE_M = 1;
const MIN_DISTANCE_M = 80;
const MAX_DISTANCE_M = 150;
const PREFERRED_DISTANCE_M = 110;
const MAX_CANDIDATES = 256;
const GROUND_INDEX_CELL_M = 250;
const HEIGHT_M = 3;
const EPSILON_M = 0.001;

export type WalkerRouteDiagnostic = "walker-route-invalid-input" | "walker-route-no-drivable-road" | "walker-route-no-nearby-segment" | "walker-route-no-safe-segment" | "walker-route-search-capacity";
export interface WalkerPatrolResult {
  readonly route: FinaleRoute | null;
  readonly entry: { readonly x: number; readonly y: number; readonly z: number } | null;
  readonly edgeId: string | null;
  readonly diagnostic: WalkerRouteDiagnostic | null;
}
interface Candidate { readonly edge: RoadEdgeInfo; readonly s: number; readonly score: number }

const pointValid = (p: FinalePoint): boolean => Number.isFinite(p.x) && Number.isFinite(p.z) && Math.abs(p.x) <= 1e7 && Math.abs(p.z) <= 1e7;
const compareId = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const compareCandidate = (a: Candidate, b: Candidate): number => a.score - b.score || compareId(a.edge.id, b.edge.id) || a.s - b.s;
const distance2 = (a: FinalePoint, b: FinalePoint): number => (a.x - b.x) * (a.x - b.x) + (a.z - b.z) * (a.z - b.z);
const failure = (diagnostic: WalkerRouteDiagnostic): WalkerPatrolResult => ({ route: null, entry: null, edgeId: null, diagnostic });

/** Prove coverage of the complete rectangle; sampling a missing field as height zero is unsafe. */
function knownGroundBox(world: World, minX: number, minZ: number, maxX: number, maxZ: number): boolean {
  const fields: Heightfield[] = [];
  const xs = [minX, maxX], zs = [minZ, maxZ];
  let lowest = Infinity, highest = -Infinity;
  for (let cx = Math.floor(minX / GROUND_INDEX_CELL_M); cx <= Math.floor(maxX / GROUND_INDEX_CELL_M); cx++) {
    for (let cz = Math.floor(minZ / GROUND_INDEX_CELL_M); cz <= Math.floor(maxZ / GROUND_INDEX_CELL_M); cz++) {
      for (const tile of world.groundIndex.get(cellKey(cx, cz)) ?? []) {
        const g = tile.ground;
        if (!g || fields.includes(g)) continue;
        if (!Number.isFinite(g.cellSizeM) || g.cellSizeM <= 0 || !Number.isInteger(g.nx) || !Number.isInteger(g.nz) || g.nx < 2 || g.nz < 2 || g.heights.length !== g.nx * g.nz) return false;
        const x1 = g.x0 + (g.nx - 1) * g.cellSizeM, z1 = g.z0 + (g.nz - 1) * g.cellSizeM;
        if (x1 < minX || g.x0 > maxX || z1 < minZ || g.z0 > maxZ) continue;
        fields.push(g);
        if (g.x0 > minX && g.x0 < maxX) xs.push(g.x0);
        if (x1 > minX && x1 < maxX) xs.push(x1);
        if (g.z0 > minZ && g.z0 < maxZ) zs.push(g.z0);
        if (z1 > minZ && z1 < maxZ) zs.push(z1);
        const ix0 = Math.max(0, Math.floor((minX - g.x0) / g.cellSizeM));
        const ix1 = Math.min(g.nx - 1, Math.ceil((maxX - g.x0) / g.cellSizeM));
        const iz0 = Math.max(0, Math.floor((minZ - g.z0) / g.cellSizeM));
        const iz1 = Math.min(g.nz - 1, Math.ceil((maxZ - g.z0) / g.cellSizeM));
        for (let iz = iz0; iz <= iz1; iz++) {
          for (let ix = ix0; ix <= ix1; ix++) {
            const at = iz * g.nx + ix;
            // Conservatively include the lattice corners of all touched ground triangles.
            const height = g.heights[at]!;
            if (!Number.isFinite(height) || g.water?.[at] === 1) return false;
            lowest = Math.min(lowest, height); highest = Math.max(highest, height);
            if (highest - lowest > 1.5 + 1e-7) return false;
          }
        }
      }
    }
  }
  xs.sort((a, b) => a - b); zs.sort((a, b) => a - b);
  for (let ix = 1; ix < xs.length; ix++) {
    for (let iz = 1; iz < zs.length; iz++) {
      if (xs[ix] === xs[ix - 1] || zs[iz] === zs[iz - 1]) continue;
      const x = (xs[ix]! + xs[ix - 1]!) / 2, z = (zs[iz]! + zs[iz - 1]!) / 2;
      if (!fields.some(g => x >= g.x0 && z >= g.z0 && x <= g.x0 + (g.nx - 1) * g.cellSizeM && z <= g.z0 + (g.nz - 1) * g.cellSizeM)) return false;
    }
  }
  return fields.length > 0;
}

function clearSample(world: World, p: FinalePoint, radius: number, protectedBodies: readonly ProtectedFinaleBody[]): boolean {
  if (!knownGroundBox(world, p.x - radius, p.z - radius, p.x + radius, p.z + radius)) return false;
  const range = meshGroundRange(world, p.x - radius, p.z - radius, p.x + radius, p.z + radius);
  if (!Number.isFinite(range.min) || !Number.isFinite(range.max) || range.max - range.min > 1.5 + 1e-7) return false;
  if (circleBlocked(world, p.x, p.z, radius) || circleBlockedBand(world, p.x, p.z, radius, range.min, range.max + HEIGHT_M) || circleHitsWall(world.walls, p.x, p.z, radius)) return false;
  if (world.walls && onWater(world.walls.shore, p.x, p.z)) return false;
  for (const body of protectedBodies) {
    const clearance = radius + 3 + body.radius;
    if (distance2(p, body) <= clearance * clearance) return false;
  }
  return true;
}

function clearSegment(world: World, a: FinalePoint, b: FinalePoint, protectedBodies: readonly ProtectedFinaleBody[]): boolean {
  if (segmentCrossesWall(world.walls, a.x, a.z, b.x, b.z)) return false;
  const distance = Math.sqrt(distance2(a, b));
  const count = Math.max(1, Math.ceil(distance / SAMPLE_M));
  // These overlapping discs cover the continuous swept circle, including thin obstacles
  // between sample centres. The extra epsilon also rejects boundary-touching footprints.
  const radius = WALKER_PATROL_RADIUS_M + distance / count / 2 + EPSILON_M;
  let previousHeight = 0;
  for (let i = 0; i <= count; i++) {
    const p = { x: a.x + (b.x - a.x) * i / count, z: a.z + (b.z - a.z) * i / count };
    if (!clearSample(world, p, radius, protectedBodies)) return false;
    const y = meshGroundHeight(world, p.x, p.z);
    if (!Number.isFinite(y) || (i > 0 && Math.abs(y - previousHeight) > 0.25 * distance / count + 0.01)) return false;
    previousHeight = y;
  }
  return true;
}

function candidatePoints(candidate: Candidate): FinalePoint[] | null {
  const path = candidate.edge.center;
  const start = candidate.s - WALKER_PATROL_LENGTH_M / 2, end = candidate.s + WALKER_PATROL_LENGTH_M / 2;
  const positions = [start, end];
  for (let s = start + WALKER_PATROL_STEP_M; s < end; s += WALKER_PATROL_STEP_M) positions.push(s);
  // Preserve every source bend: no straight shortcut across the inside of a road corner.
  for (const s of path.cum) if (s > start && s < end) positions.push(s);
  positions.sort((a, b) => a - b);
  const points: FinalePoint[] = [];
  for (let i = 0; i < positions.length; i++) {
    if (i > 0 && positions[i]! - positions[i - 1]! < 1e-7) continue;
    const p = pathPoint(path, positions[i]!);
    points.push({ x: p.x, z: p.z });
  }
  // Out and back, without duplicate turnaround points; the closing leg is short too.
  if (points.length > 64) return null;
  return [...points, ...points.slice(1, -1).reverse()];
}

/**
 * A ground-only fallback for threat-five Walker deployment. It never changes the world or
 * bodies. Protected bodies are a current complete snapshot; the routine must still recheck
 * dynamic clearance before movement and every landing.
 */
export function deriveWalkerPatrolRoute(world: World, player: FinalePoint, protectedBodies: readonly ProtectedFinaleBody[] = []): WalkerPatrolResult {
  if (!pointValid(player) || protectedBodies.length > 4096 || protectedBodies.some(b => !pointValid(b) || (b.kind !== "person" && b.kind !== "animal") || !Number.isFinite(b.radius) || b.radius < 0)) return failure("walker-route-invalid-input");
  const roads = world.roads;
  if (!roads) return failure("walker-route-no-drivable-road");
  const candidates: Candidate[] = [];
  let drivable = false, truncated = false;
  const add = (edge: RoadEdgeInfo, s: number, low: number, high: number): void => {
    if (s < low || s > high || candidates.some(c => c.edge.id === edge.id && Math.abs(c.s - s) < 1e-7)) return;
    const d = Math.sqrt(distance2(pathPoint(edge.center, s), player));
    if (d < MIN_DISTANCE_M || d > MAX_DISTANCE_M) return;
    candidates.push({ edge, s, score: Math.abs(d - PREFERRED_DISTANCE_M) });
    if (candidates.length > MAX_CANDIDATES) {
      candidates.sort(compareCandidate); candidates.pop(); truncated = true;
    }
  };
  for (const edge of [...roads.edges].sort((a, b) => compareId(a.id, b.id))) {
    if (!edge.drivable || edge.widthM < 2 * WALKER_PATROL_RADIUS_M) continue;
    drivable = true;
    const path = edge.center;
    const low = roads.nodes[edge.a]!.radius + WALKER_PATROL_RADIUS_M + 1 + WALKER_PATROL_LENGTH_M / 2;
    const high = path.len - roads.nodes[edge.b]!.radius - WALKER_PATROL_RADIUS_M - 1 - WALKER_PATROL_LENGTH_M / 2;
    if (low > high) continue;
    for (let i = 1; i < path.cum.length; i++) {
      const length = path.cum[i]! - path.cum[i - 1]!;
      if (length <= 0) continue;
      const origin = path.cum[i - 1]!;
      const first = Math.max(0, low - origin), last = Math.min(length, high - origin);
      if (first > last) continue;
      const x = path.xs[i - 1]!, z = path.zs[i - 1]!;
      const ux = (path.xs[i]! - x) / length, uz = (path.zs[i]! - z) / length;
      const px = player.x - x, pz = player.z - z;
      const projected = px * ux + pz * uz;
      const perpendicular2 = Math.max(0, px * px + pz * pz - projected * projected);
      if (perpendicular2 > MAX_DISTANCE_M * MAX_DISTANCE_M) continue;
      const reach = Math.sqrt(MAX_DISTANCE_M * MAX_DISTANCE_M - perpendicular2);
      const start = Math.max(first, projected - reach), end = Math.min(last, projected + reach);
      if (start > end) continue;
      add(edge, origin + start, low, high); add(edge, origin + end, low, high);
      add(edge, origin + Math.max(start, Math.min(end, projected)), low, high);
      if (perpendicular2 <= PREFERRED_DISTANCE_M * PREFERRED_DISTANCE_M) {
        const preferred = Math.sqrt(PREFERRED_DISTANCE_M * PREFERRED_DISTANCE_M - perpendicular2);
        add(edge, origin + projected - preferred, low, high); add(edge, origin + projected + preferred, low, high);
      }
      for (let s = start + 8; s < end; s += 8) add(edge, origin + s, low, high);
    }
  }
  if (!drivable) return failure("walker-route-no-drivable-road");
  if (!candidates.length) return failure("walker-route-no-nearby-segment");
  candidates.sort(compareCandidate);
  for (const candidate of candidates) {
    const points = candidatePoints(candidate);
    if (!points || points.some(p => distance2(p, player) < MIN_DISTANCE_M * MIN_DISTANCE_M || distance2(p, player) > MAX_DISTANCE_M * MAX_DISTANCE_M)) continue;
    let clear = true;
    for (let i = 0; i < points.length; i++) {
      if (!clearSegment(world, points[i]!, points[(i + 1) % points.length]!, protectedBodies)) { clear = false; break; }
    }
    if (!clear) continue;
    const id = `walker-road:${hashState({ edge: candidate.edge.id, points })}`;
    const waypoints: FinaleWaypoint[] = points.map((p, i) => ({ ...p, id: `${id}:${i}`, phase: "patrol", footprint: { kind: "circle", radius: WALKER_PATROL_RADIUS_M }, windupTicks: TICK_HZ, shedRobots: 0 }));
    const entry = points[0]!;
    return { route: { id, waypoints }, entry: { ...entry, y: meshGroundHeight(world, entry.x, entry.z) }, edgeId: candidate.edge.id, diagnostic: null };
  }
  return failure(truncated ? "walker-route-search-capacity" : "walker-route-no-safe-segment");
}
