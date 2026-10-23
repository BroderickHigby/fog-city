import type { CombatState, Gadget, Vec3 } from "./types.ts";

export interface CombatFogZone extends Vec3 { id: number; ownerId: string; radius: number; untilTick: number }
function liveFog(state: Readonly<CombatState>, g: Gadget): boolean { return g.kind === "microclimate" && g.untilTick > state.tick && g.radius > 0 && [g.x, g.y, g.z, g.radius].every(Number.isFinite); }
export function activeFogZones(state: Readonly<CombatState>): CombatFogZone[] {
  return state.gadgets.filter((g) => liveFog(state, g))
    .sort((a, b) => a.id - b.id).map(({ id, ownerId, x, y, z, radius, untilTick }) => ({ id, ownerId, x, y, z, radius, untilTick }));
}
export function pointInFog(point: Vec3, zone: CombatFogZone): boolean {
  const dx = point.x - zone.x, dy = point.y - zone.y, dz = point.z - zone.z;
  return dx * dx + dy * dy + dz * dz <= zone.radius * zone.radius;
}
export function fogAtPoint(state: Readonly<CombatState>, point: Vec3): CombatFogZone | undefined {
  let selected: CombatFogZone | undefined;
  for (const zone of state.gadgets) if (liveFog(state, zone) && pointInFog(point, zone) && (!selected || zone.id < selected.id)) selected = zone;
  return selected;
}
/** Fog blocks the sight ray even when observer and target stand beyond opposite edges. */
export function microclimateBlocksSight(state: Readonly<CombatState>, from: Vec3, to: Vec3): boolean {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z, length2 = dx * dx + dy * dy + dz * dz;
  for (const zone of state.gadgets) {
    if (!liveFog(state, zone)) continue;
    const t = length2 > 0 ? Math.max(0, Math.min(1, ((zone.x - from.x) * dx + (zone.y - from.y) * dy + (zone.z - from.z) * dz) / length2)) : 0;
    if (pointInFog({ x: from.x + dx * t, y: from.y + dy * t, z: from.z + dz * t }, zone)) return true;
  }
  return false;
}
