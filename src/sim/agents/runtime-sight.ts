import type { Vec3 } from "../combat-contract.ts";
import type { SimState } from "../contract.ts";
import type { SimSystemContext } from "../system-contract.ts";
import { meshGroundHeight, pointInPolygon, segmentBlocked, UNDER_CLEARANCE_M, type World } from "../world.ts";

export interface RecordedMicroclimate extends Vec3 {
  readonly id: number;
  readonly ownerId: string;
  readonly radius: number;
  readonly untilTick: number;
}

const MAX_RECORDED_GADGETS = 4096;
const FOG_CELL_M = 128;
const coordinate = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e7;

// Same closed-segment predicate as the world's footprint sight test.
function segmentsMeet(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): boolean {
  const d1 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx), d2 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  const d3 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax), d4 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const on = (px: number, pz: number, qx: number, qz: number, rx: number, rz: number): boolean =>
    rx >= Math.min(px, qx) && rx <= Math.max(px, qx) && rz >= Math.min(pz, qz) && rz <= Math.max(pz, qz);
  return d1 === 0 && on(cx, cz, dx, dz, ax, az) || d2 === 0 && on(cx, cz, dx, dz, bx, bz) ||
    d3 === 0 && on(ax, az, bx, bz, cx, cz) || d4 === 0 && on(ax, az, bx, bz, dx, dz);
}

function wallBlocksSight(world: World, from: Vec3, to: Vec3): boolean {
  if (!coordinate(from.x) || !coordinate(from.y) || !coordinate(from.z) || !coordinate(to.x) || !coordinate(to.y) || !coordinate(to.z)) return true;
  const minX = Math.min(from.x, to.x), maxX = Math.max(from.x, to.x), minZ = Math.min(from.z, to.z), maxZ = Math.max(from.z, to.z);
  // world.segmentBlocked indexes 50 m cells. Keep its normal path unchanged but
  // do not enumerate billions of empty cells for a long recorded sensor ray.
  const cells = (Math.floor(maxX / 50) - Math.floor(minX / 50) + 1) * (Math.floor(maxZ / 50) - Math.floor(minZ / 50) + 1);
  if (cells <= 4096) return segmentBlocked(world, from.x, from.z, to.x, to.z);
  let ground: number | undefined;
  for (const tile of world.tiles) for (const building of tile.buildings) {
    if (building.topY <= building.baseY) continue;
    const poly = building.footprint;
    let lowX = Infinity, highX = -Infinity, lowZ = Infinity, highZ = -Infinity;
    for (const [x, z] of poly) { lowX = Math.min(lowX, x); highX = Math.max(highX, x); lowZ = Math.min(lowZ, z); highZ = Math.max(highZ, z); }
    if (maxX < lowX || minX > highX || maxZ < lowZ || minZ > highZ) continue;
    if (building.underY !== undefined) {
      ground ??= Math.max(meshGroundHeight(world, from.x, from.z), meshGroundHeight(world, to.x, to.z));
      if (building.underY - ground >= UNDER_CLEARANCE_M) continue;
    }
    if (pointInPolygon(from.x, from.z, poly) || pointInPolygon(to.x, to.z, poly)) return true;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      if (segmentsMeet(from.x, from.z, to.x, to.z, poly[j]![0], poly[j]![1], poly[i]![0], poly[i]![1])) return true;
    }
  }
  return false;
}

/** Read the published combat gadget shape without creating weather or moving its centre.
 * Earlier combat schemas cannot produce this gadget but may replay a recorded one.
 */
export function recordedMicroclimates(state: Readonly<SimState>, atTick = state.tick): readonly RecordedMicroclimate[] {
  const combat = state.ext.combat;
  if (!combat || combat.version !== 1 || !Number.isSafeInteger(atTick) || atTick < 0 || !Array.isArray(combat.gadgets)) return [];
  if (combat.gadgets.length > MAX_RECORDED_GADGETS) throw new RangeError("Recorded gadget capacity exceeded");
  const result: RecordedMicroclimate[] = [];
  for (const value of combat.gadgets as readonly unknown[]) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const gadget = value as Record<string, unknown>;
    if (gadget.kind !== "microclimate" || !Number.isSafeInteger(gadget.id) || Number(gadget.id) < 0 ||
        typeof gadget.ownerId !== "string" || gadget.ownerId.length === 0 || gadget.ownerId.length > 256 ||
        !coordinate(gadget.x) || !coordinate(gadget.y) || !coordinate(gadget.z) ||
        typeof gadget.radius !== "number" || !Number.isFinite(gadget.radius) || gadget.radius <= 0 || gadget.radius > 128 ||
        !Number.isSafeInteger(gadget.untilTick) || Number(gadget.untilTick) <= atTick) continue;
    result.push({ id: Number(gadget.id), ownerId: gadget.ownerId, x: gadget.x, y: gadget.y, z: gadget.z,
      radius: gadget.radius, untilTick: Number(gadget.untilTick) });
  }
  return result.sort((a, b) => a.id - b.id || a.x - b.x || a.y - b.y || a.z - b.z || a.radius - b.radius || a.untilTick - b.untilTick);
}

/** Matches the published combat sphere/ray test, including tangency and observers inside. */
export function microclimateOccludes(zones: readonly RecordedMicroclimate[], from: Vec3, to: Vec3): boolean {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const length2 = dx * dx + dy * dy + dz * dz;
  for (const zone of zones) {
    const fraction = length2 > 0 ? Math.max(0, Math.min(1,
      ((zone.x - from.x) * dx + (zone.y - from.y) * dy + (zone.z - from.z) * dz) / length2)) : 0;
    const x = from.x + dx * fraction - zone.x, y = from.y + dy * fraction - zone.y, z = from.z + dz * fraction - zone.z;
    if (x * x + y * y + z * z <= zone.radius * zone.radius) return true;
  }
  return false;
}

/** Compile only the last accepted combat snapshot once for this sensing pass.
 * Sound, radio messages, remembered positions and physical path clearance use other rules.
 */
export function createRuntimeVisualSensor(context: Pick<SimSystemContext, "world" | "previous" | "state">): (from: Vec3, to: Vec3) => boolean {
  const zones = recordedMicroclimates(context.previous, context.state.tick);
  if (!zones.length) return (from, to) => !wallBlocksSight(context.world, from, to);
  const cells = new Map<string, RecordedMicroclimate[]>();
  for (const zone of zones) {
    const minX = Math.floor((zone.x - zone.radius) / FOG_CELL_M), maxX = Math.floor((zone.x + zone.radius) / FOG_CELL_M);
    const minZ = Math.floor((zone.z - zone.radius) / FOG_CELL_M), maxZ = Math.floor((zone.z + zone.radius) / FOG_CELL_M);
    for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) {
      const key = `${x},${z}`, list = cells.get(key);
      if (list) list.push(zone);
      else cells.set(key, [zone]);
    }
  }
  return (from, to) => {
    if (wallBlocksSight(context.world, from, to)) return false;
    const minX = Math.floor(Math.min(from.x, to.x) / FOG_CELL_M), maxX = Math.floor(Math.max(from.x, to.x) / FOG_CELL_M);
    const minZ = Math.floor(Math.min(from.z, to.z) / FOG_CELL_M), maxZ = Math.floor(Math.max(from.z, to.z) / FOG_CELL_M);
    // Long external rays stay bounded; ordinary 30 m sensors inspect at most four cells.
    if ((maxX - minX + 1) * (maxZ - minZ + 1) > MAX_RECORDED_GADGETS) return !microclimateOccludes(zones, from, to);
    const candidates = new Set<RecordedMicroclimate>();
    for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) {
      for (const zone of cells.get(`${x},${z}`) ?? []) candidates.add(zone);
    }
    return !microclimateOccludes([...candidates], from, to);
  };
}
