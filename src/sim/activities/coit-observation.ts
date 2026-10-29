import landmarkData from "../../../content/landmarks.json" with { type: "json" };
import { toLatLon, toLocal } from "../../geo/project.ts";
import { protectedAreaAt } from "../../content/places.ts";
import { agentsRuntimeOf } from "../agents/runtime.ts";
import { datan2, PI, sq, wrapAngle } from "../dmath.ts";
import { sortedIds, type SimState } from "../contract.ts";
import type { SimSystemContext } from "../system-contract.ts";
import { groundHeight, nearbyBuildings, type BuildingCollider, type World } from "../world.ts";
import { coitAngles, coitCameraPose, coitSessionActive, COIT_VIEW, type CoitContext, type CoitLandmark, type CoitObservedActor, type CoitPlayerContext } from "./coit-viewer.ts";

const LABELS: Readonly<Record<string, string>> = { "ferry-building": "Ferry Building", "600-montgomery": "Transamerica Pyramid", "415-mission": "Salesforce Tower" };
const ROBOT_MODELS = new Set(["footman", "trundle", "robotaxi", "drone", "patrol", "sign-spinner", "tidy", "walker"]);
interface Point3 { x: number; y: number; z: number }
function inside(x: number, z: number, polygon: readonly (readonly [number, number])[]): boolean {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!, b = polygon[j]!;
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}
function blockedByBuilding(a: Point3, b: Point3, building: BuildingCollider): boolean {
  const dx = b.x - a.x, dz = b.z - a.z, breaks = [0, 1];
  for (let i = 0, j = building.footprint.length - 1; i < building.footprint.length; j = i++) {
    const p = building.footprint[j]!, q = building.footprint[i]!, ex = q[0] - p[0], ez = q[1] - p[1];
    const determinant = dx * ez - dz * ex;
    if (Math.abs(determinant) < 1e-10) continue;
    const ox = p[0] - a.x, oz = p[1] - a.z, t = (ox * ez - oz * ex) / determinant, u = (ox * dz - oz * dx) / determinant;
    if (t > 0 && t < 1 && u >= 0 && u <= 1) breaks.push(t);
  }
  breaks.sort((a, b) => a - b);
  for (let index = 1; index < breaks.length; index++) {
    const from = breaks[index - 1]!, to = breaks[index]!, middle = (from + to) / 2;
    if (!inside(a.x + dx * middle, a.z + dz * middle, building.footprint)) continue;
    const ya = a.y + (b.y - a.y) * from, yb = a.y + (b.y - a.y) * to;
    if (Math.max(ya, yb) >= (building.underY ?? building.baseY) && Math.min(ya, yb) <= building.topY) return true;
  }
  return false;
}

/** Elevated 3D sight: low roofs do not block a ray above them; tall roofs and hills do. */
export function coitLineOfSight(world: World, a: Point3, b: Point3, ignoreIds: readonly string[] = []): boolean {
  const distance = Math.sqrt(sq(b.x - a.x) + sq(b.z - a.z));
  if (!Number.isFinite(distance) || distance > COIT_VIEW.maxRangeM + 150) return false;
  const buildings = new Map<string, BuildingCollider>(), steps = Math.max(1, Math.ceil(distance / 40));
  for (let index = 0; index <= steps; index++) {
    const t = index / steps;
    for (const building of nearbyBuildings(world, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t, 30)) buildings.set(building.id, building);
  }
  for (const building of buildings.values()) if (!ignoreIds.includes(building.id) && blockedByBuilding(a, b, building)) return false;
  for (let distanceAlong = 4; distanceAlong < distance - 2; distanceAlong += 4) {
    const t = distanceAlong / distance;
    if (a.y + (b.y - a.y) * t < groundHeight(world, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t) + .03) return false;
  }
  return true;
}
export function coitLandmarks(world: World): CoitLandmark[] {
  return landmarkData.landmarks.filter(entry => LABELS[entry.id]).map(entry => {
    const at = toLocal(entry.lat, entry.lon), ground = groundHeight(world, at.x, at.z);
    const own = nearbyBuildings(world, at.x, at.z, 45).filter(building => entry.replacesBuildingIds?.includes(building.id));
    const top = own.reduce((height, building) => Math.max(height, building.topY), ground + 20);
    return { id: entry.id, label: LABELS[entry.id]!, ...at, y: ground + (top - ground) * .65 };
  });
}
function angleError(origin: Point3, target: Point3, yaw: number, pitch: number): number {
  const distance = Math.sqrt(sq(target.x - origin.x) + sq(target.z - origin.z));
  return Math.max(Math.abs(wrapAngle(datan2(target.x - origin.x, -(target.z - origin.z)) - yaw)), Math.abs(datan2(target.y - origin.y, distance) - pitch));
}
export function coitPlayerContext(state: Readonly<SimState>, world: World, playerId: string, aim?: { aimYaw?: number; aimPitch?: number }): CoitPlayerContext {
  const player = state.players[playerId], viewer = state.ext.activities?.players[playerId]?.recon?.viewer;
  const angles = coitAngles(aim?.aimYaw ?? viewer?.yaw ?? PI, aim?.aimPitch ?? viewer?.pitch ?? -.2);
  const result: CoitPlayerContext = { cashCents: state.ext.economy?.players[playerId]?.cashCents ?? 0,
    usable: !!player && !player.ride, aimYaw: angles.yaw, aimPitch: angles.pitch, actors: [], landmark: null };
  if (state.version < 27 || !coitSessionActive(viewer, state.tick)) return result;
  const pose = coitCameraPose(world, angles), runtime = agentsRuntimeOf(state), occupied = new Set(sortedIds(state.players).flatMap(id => state.players[id]!.ride ? [state.players[id]!.ride!.agentId] : []));
  const actors: CoitObservedActor[] = [];
  for (const id of sortedIds(runtime?.actors ?? {})) {
    const actor = runtime!.actors[id]!;
    if (actor.retired || actor.fidelity !== "full" || !ROBOT_MODELS.has(actor.model) || actor.protected || actor.child || actor.mobilityAid ||
        actor.model === "robotaxi" && occupied.has(actor.numericId) || (state.ext.combat?.targets[id]?.phase ?? "active") !== "active") continue;
    const position = { x: actor.x, y: actor.y + actor.height * .6, z: actor.z };
    if (Math.sqrt(sq(actor.x - pose.aim.x) + sq(actor.z - pose.aim.z)) > COIT_VIEW.anchorRadiusM || angleError(pose, position, angles.yaw, angles.pitch) > COIT_VIEW.fovRadians / 2) continue;
    const point = toLatLon(actor.x, actor.z);
    if (protectedAreaAt([point.lat, point.lon]) || !coitLineOfSight(world, pose, position)) continue;
    const attack = state.ext.combat?.attacks.find(attack => attack.attackerId === id && attack.startTick <= state.tick && state.tick < Math.max(attack.resolveTick, attack.endTick));
    const action = actor.intent?.action;
    const behavior = attack ? attack.kind : actor.intent?.sabotageActive && action && ["windup", "attack", "update"].includes(action.kind) ? action.kind : "";
    actors.push({ id, behavior, visible: true, firmware: actor.firmware, protected: false, active: true });
    if (actors.length === 32) break;
  }
  result.actors = actors;
  const landmarks = coitLandmarks(world).filter(landmark => angleError(pose, landmark, angles.yaw, angles.pitch) <= COIT_VIEW.fovRadians * .7 &&
    coitLineOfSight(world, pose, landmark, landmarkData.landmarks.find(entry => entry.id === landmark.id)?.replacesBuildingIds ?? []))
    .sort((a, b) => angleError(pose, a, angles.yaw, angles.pitch) - angleError(pose, b, angles.yaw, angles.pitch) || (a.id < b.id ? -1 : 1));
  result.landmark = landmarks[0] ?? null;
  return result;
}
export function coitContext(context: SimSystemContext): CoitContext {
  return { players: Object.fromEntries(sortedIds(context.state.players).map(id => [id, coitPlayerContext(context.state, context.world, id, context.inputs[id])])) };
}
