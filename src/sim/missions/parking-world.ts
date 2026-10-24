import type { SimSystemContext } from "../system-contract.ts";
import type { World } from "../world.ts";
import { groundHeight, groundWater } from "../world.ts";
import { boxBlocked } from "../collide.ts";
import { CAR } from "../car.ts";
import { datan2 } from "../dmath.ts";
import { gameTime } from "../clock/calendar.ts";
import { toLocal } from "../../geo/project.ts";
import { MISSIONS } from "../../content/catalog.ts";
import { ACTIVITY_DEFINITIONS } from "../../content/gameplay.ts";
import type { MissionState } from "../player/types.ts";
import type { MissionParkingWorld } from "./mechanics/runtime.ts";
import type { ParkingBay, ParkingRule, CleaningRule } from "./mechanics/parking.ts";
import { checkParking } from "./mechanics/parking.ts";
import type { SimState } from "../contract.ts";

const cache = new WeakMap<World, { rules: readonly ParkingRule[]; bays: Map<string, ParkingBay[]> }>();

/** Where a mission's or a parking activity's bays are searched for, and how far out. */
function parkingCentre(id: string): { center: { x: number; z: number }; radius: number } | undefined {
  const mission = MISSIONS.find(value => value.id === id);
  const approach = mission?.steps.find(value => value.type === "goto");
  if (approach?.type === "goto") return { center: toLocal(approach.target.lat, approach.target.lon), radius: 350 };
  // A Search & Park activity parks around its final checkpoint, the signed street.
  const activity = ACTIVITY_DEFINITIONS.find(value => value.id === id && value.kind === "parking");
  const park = activity?.checkpoints.at(-1);
  return park ? { center: toLocal(park.lat, park.lon), radius: park.radiusM + 60 } : undefined;
}

/** Derive painted parking positions from real curb sides; never label an unknown side legal. */
function missionBays(world: World, missionId: string, rules: readonly ParkingRule[]): ParkingBay[] {
  let cached = cache.get(world);
  if (!cached || cached.rules !== rules) { cached = { rules, bays: new Map() }; cache.set(world, cached); }
  const known = cached.bays.get(missionId);
  if (known) return known;
  const area = parkingCentre(missionId), center = area?.center;
  if (!area || !center || !world.roads) return [];
  const sides = new Map<string, Set<string>>();
  for (const rule of rules) { const group = sides.get(rule.edge) ?? new Set(); group.add(rule.side); sides.set(rule.edge, group); }
  const bays: ParkingBay[] = [];
  for (const road of world.roads.edges) {
    const allowed = sides.get(road.id);
    if (!allowed || !road.drivable || road.widthM < 5) continue;
    const path = road.center;
    for (let segment = 0; segment < path.xs.length - 1; segment++) {
      const ax = path.xs[segment]!, az = path.zs[segment]!, dx = path.xs[segment + 1]! - ax, dz = path.zs[segment + 1]! - az;
      const length = Math.sqrt(dx * dx + dz * dz);
      if (length < 8) continue;
      const ux = dx / length, uz = dz / length, heading = datan2(ux, -uz);
      // Stay clear of junction corners and divide long curb segments into full car-sized bays.
      for (let distance = 5; distance < length - 4; distance += 8) for (const side of ["L", "R"] as const) {
        if (!allowed.has(side)) continue;
        const offset = (road.widthM / 2 - 1.35) * (side === "R" ? 1 : -1);
        const x = ax + ux * distance - uz * offset, z = az + uz * distance + ux * offset;
        if ((x - center.x) * (x - center.x) + (z - center.z) * (z - center.z) > area.radius * area.radius || groundWater(world, x, z)) continue;
        const y = groundHeight(world, x, z);
        if (boxBlocked(world, { x, z, heading, hl: CAR.halfLength + .2, hw: CAR.halfWidth + .2 }, y, [], y + CAR.bodyHeight)) continue;
        bays.push({ id: `parking:${road.id}:${side}:${segment}:${distance}`, edge: road.id, side, x, y, z, heading, halfLength: 3.5, halfWidth: 1.3 });
      }
    }
  }
  bays.sort((a,b) => (a.x-center.x)*(a.x-center.x)+(a.z-center.z)*(a.z-center.z)-((b.x-center.x)*(b.x-center.x)+(b.z-center.z)*(b.z-center.z)) || (a.id < b.id ? -1 : 1));
  const bounded = bays.slice(0, 64);
  cached.bays.set(missionId, bounded);
  return bounded;
}

/** Called by the shared game composition after physical movement. */
export function buildMissionParkingWorld(context: SimSystemContext, rules: readonly ParkingRule[], cleaning: readonly CleaningRule[], holiday = false): MissionParkingWorld {
  const calendar = gameTime(context.state);
  const missions = context.state.ext.missions as MissionState | undefined;
  const targets: MissionParkingWorld["targets"][number][] = [], all = new Map<string, ParkingBay>();
  for (const playerId of Object.keys(missions?.players ?? {}).sort()) {
    const progress = missions!.players[playerId]!;
    if (progress.status !== "active") continue;
    const mission = MISSIONS.find(value => value.id === progress.missionId), step = mission?.steps.find(value => value.id === progress.stepId);
    if (step?.type !== "objective" || step.objective.event !== "demo.parkedLegally") continue;
    const bays = missionBays(context.world, progress.missionId, rules);
    for (const bay of bays) all.set(bay.id, bay);
    if (!targets.some(value => value.missionId === progress.missionId && value.stepId === progress.stepId)) targets.push({ missionId: progress.missionId, stepId: progress.stepId, bayIds: bays.map(bay => bay.id), expectedStayMinutes: 30 });
  }
  // A running Search & Park offers the bays on its signed street, as target "<activity>:park".
  const activities = context.state.ext.activities as { players?: Record<string, { activeActivityId?: string }> } | undefined;
  for (const playerId of Object.keys(activities?.players ?? {}).sort()) {
    const id = activities!.players![playerId]!.activeActivityId;
    if (!id || !ACTIVITY_DEFINITIONS.some(value => value.id === id && value.kind === "parking") || targets.some(value => value.missionId === id)) continue;
    const bays = missionBays(context.world, id, rules);
    for (const bay of bays) all.set(bay.id, bay);
    targets.push({ missionId: id, stepId: "park", bayIds: bays.map(bay => bay.id), expectedStayMinutes: 30 });
  }
  const edges = new Set([...all.values()].map(bay => bay.edge));
  return {
    bays: [...all.values()], targets,
    rules: rules.filter(rule => edges.has(rule.edge)), cleaning: cleaning.filter(rule => edges.has(rule.edge)),
    clock: { isoWeekday: calendar.weekday || 7, minute: calendar.hour * 60 + calendar.minute, weekOfMonth: Math.ceil(calendar.day / 7), holiday },
    vehicles: Object.keys(context.state.players).sort().map(playerId => { const car = context.state.players[playerId]!.car; return { playerId, x:car.x, y:car.y, z:car.z, heading:car.heading, speed:car.speed, lateral:car.lateral, halfLength:CAR.halfLength, halfWidth:CAR.halfWidth, height:CAR.bodyHeight }; }),
  };
}

/** Navigation hint only: success still requires the accepted physical body in the reducer. */
export function missionParkingDestination(world: World, state: SimState, playerId: string): { x: number; z: number } | undefined {
  const own = state.players[playerId];
  if (!own) return undefined;
  const parking = buildMissionParkingWorld({ world, state, previous: state, inputs: {}, events: [] }, world.parking?.rules ?? [], world.streetCleaning?.rules ?? []);
  const progress = state.ext.missions?.players[playerId];
  const activity = (state.ext.activities as { players?: Record<string, { activeActivityId?: string }> } | undefined)?.players?.[playerId]?.activeActivityId;
  const target = parking.targets.find(value => value.missionId === progress?.missionId && value.stepId === progress?.stepId)
    ?? parking.targets.find(value => value.missionId === activity && value.stepId === "park");
  const vehicle = parking.vehicles.find(value => value.playerId === playerId);
  if (!target || !vehicle) return undefined;
  const legal = parking.bays.filter(bay => target.bayIds.includes(bay.id) && checkParking(
    { ...vehicle, x: bay.x, y: bay.y, z: bay.z, heading: bay.heading, speed: 0, lateral: 0 },
    bay, { ...parking, requests: [] }, state.tick, target.expectedStayMinutes,
  ).legal);
  legal.sort((a, b) => (a.x-own.car.x)*(a.x-own.car.x)+(a.z-own.car.z)*(a.z-own.car.z)-((b.x-own.car.x)*(b.x-own.car.x)+(b.z-own.car.z)*(b.z-own.car.z)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const bay = legal[0];
  return bay ? { x: bay.x, z: bay.z } : undefined;
}
