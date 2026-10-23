import { PROTECTED_AREAS } from "../../content/places.ts";
import { toLocal } from "../../geo/project.ts";
import { FIDELITY_RADIUS } from "../combat/shared.ts";
import type { CombatActor, ConversionScope } from "../combat/types.ts";
import type { World } from "../world.ts";
import { robotAgentId } from "./runtime.ts";

export interface RobotConversionAnchor { readonly id: string; readonly x: number; readonly z: number }
export interface RobotConversionBaseline { readonly agentId: number; readonly firmware: "good" | "bad" }

interface ProtectedPolygon { readonly id: string; readonly points: readonly { x: number; z: number }[]; readonly minX: number; readonly maxX: number; readonly minZ: number; readonly maxZ: number }
// These immutable authored polygons share SF's explicit local coordinate frame.
const protectedPolygons: readonly ProtectedPolygon[] = [...PROTECTED_AREAS].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(area => {
  const points = area.polygon.map(([lat, lon]) => toLocal(lat, lon));
  return { id: area.id, points, minX: Math.min(...points.map(point => point.x)), maxX: Math.max(...points.map(point => point.x)),
    minZ: Math.min(...points.map(point => point.z)), maxZ: Math.max(...points.map(point => point.z)) };
});
function inclusivePolygon(point: { x: number; z: number }, area: ProtectedPolygon): boolean {
  const epsilon = 0.0001;
  if (point.x < area.minX - epsilon || point.x > area.maxX + epsilon || point.z < area.minZ - epsilon || point.z > area.maxZ + epsilon) return false;
  let inside = false;
  for (let index = 0; index < area.points.length; index++) {
    const a = area.points[index]!, b = area.points[(index + 1) % area.points.length]!;
    const dx = b.x - a.x, dz = b.z - a.z, square = dx * dx + dz * dz;
    const fraction = square === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / square));
    const px = point.x - a.x - fraction * dx, pz = point.z - a.z - fraction * dz;
    if (px * px + pz * pz <= epsilon * epsilon) return true;
    if ((a.z > point.z) !== (b.z > point.z) && point.x < (b.x - a.x) * (point.z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Ephemeral membership budgets. Keep these out of saved state: current bodies and the
 * native-firmware ledger already contain all inputs needed to derive them every tick.
 */
export function deriveRobotConversionScopes(world: World, anchors: readonly RobotConversionAnchor[], actors: readonly CombatActor[],
  baselines: readonly RobotConversionBaseline[], protectedArea = false, worldName?: string): readonly ConversionScope[] {
  if (anchors.length > 24 || actors.length > 4096 || baselines.length > 4096) throw new RangeError("Conversion scope input capacity");
  const orderedAnchors = [...anchors].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (orderedAnchors.some((anchor, i) => !anchor.id || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.z) || i > 0 && anchor.id === orderedAnchors[i - 1]!.id)) throw new RangeError("Invalid conversion anchor");
  const native = new Map<number, "good" | "bad">();
  for (const baseline of baselines) {
    if (!Number.isSafeInteger(baseline.agentId) || baseline.agentId < 0 || (baseline.firmware !== "good" && baseline.firmware !== "bad") || native.has(baseline.agentId)) throw new RangeError("Invalid conversion baseline");
    native.set(baseline.agentId, baseline.firmware);
  }
  const robots = actors.filter(actor => actor.kind === "robot" && actor.firmware !== "none" && actor.inFidelity !== false && robotAgentId(actor.id) !== null)
    .sort((a, b) => robotAgentId(a.id)! - robotAgentId(b.id)!);
  if (robots.some((actor, i) => !Number.isFinite(actor.x) || !Number.isFinite(actor.z) || i > 0 && actor.id === robots[i - 1]!.id)) throw new RangeError("Invalid conversion actor");
  // Synthetic scenes share a coordinate frame, not an asserted SF identity.
  const geographic = world.gameplay?.world === "sf" || worldName === "sf";
  const protectedIds = new Map<string, readonly string[]>();
  if (geographic) for (const robot of robots) {
    protectedIds.set(robot.id, protectedPolygons.filter(area => inclusivePolygon(robot, area)).map(area => area.id));
  }
  const scopes: ConversionScope[] = [];
  const baseCount = (members: readonly CombatActor[]): number => members.filter(actor => native.get(robotAgentId(actor.id)!) === "bad").length;
  for (let index = 0; index < orderedAnchors.length; index++) {
    const anchor = orderedAnchors[index]!;
    const members = robots.filter(actor => {
      const dx = actor.x - anchor.x, dz = actor.z - anchor.z;
      return dx * dx + dz * dz <= FIDELITY_RADIUS * FIDELITY_RADIUS;
    });
    scopes.push({ id: `anchor:${index}`, actorIds: members.map(actor => actor.id), cap: baseCount(members) * (protectedArea ? 1 : 2) });
    if (!geographic) continue;
    for (const area of protectedPolygons) {
      const local = members.filter(actor => protectedIds.get(actor.id)?.includes(area.id));
      if (local.length) scopes.push({ id: `anchor:${index}/protected:${area.id}`, actorIds: local.map(actor => actor.id), cap: baseCount(local) });
    }
  }
  return scopes;
}
