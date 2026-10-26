import { Action } from "../../contract.ts";
import type { GameplayContext, GameplayFact, MissionState } from "../../player/types.ts";
import { checkParking, nearBay, type ParkingInput, type ParkingProgress, type ParkingVehicle } from "./parking.ts";
import { wrapAngle } from "../../dmath.ts";
import { planarDistanceSquared } from "./geometry.ts";

/** The host supplies real road rules and accepted vehicle bodies, never success flags. */
export interface MissionParkingWorld extends Omit<ParkingInput, "requests"> {
  vehicles: readonly ParkingVehicle[];
  targets: readonly { missionId: string; stepId: string; bayIds: readonly string[]; expectedStayMinutes?: number }[];
}
export interface MissionParkingState {
  tick: number;
  nextSequence: number;
  previousInteract: Record<string, boolean>;
  players: Record<string, ParkingProgress>;
}

/**
 * One tick of a legal stop: the accepted car inside a legal target bay, unmoved for two seconds,
 * then a fresh Interact press. Shared by mission parking and the Search & Park activity.
 */
export function advanceParking(before: ParkingProgress | undefined, requestId: string, world: MissionParkingWorld, bayIds: readonly string[], body: GameplayContext["bodies"][number], vehicle: ParkingVehicle, tick: number, continuousTick: boolean, pressed: boolean, expectedStayMinutes?: number): { progress: ParkingProgress; stopped: string | undefined } {
  if (before?.requestId === requestId && before.completed) return { progress: { ...before }, stopped: undefined };
  const bay = [...world.bays].sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).find(value => bayIds.includes(value.id)
    && nearBay(body, value) && checkParking(vehicle, value, { ...world, requests: [] }, tick, expectedStayMinutes).legal);
  if (!bay) return { progress: { requestId, bayId: "", stoppedSince: -1, completed: false, settledPose: null }, stopped: undefined };
  const pose = before?.settledPose, dy = pose ? vehicle.y - pose.y : 0;
  const unchanged = pose && planarDistanceSquared(vehicle.x, vehicle.z, pose.x, pose.z) + dy * dy <= .05 * .05 && Math.abs(wrapAngle(vehicle.heading - pose.heading)) <= .03;
  const continuous = continuousTick && before?.requestId === requestId && before.bayId === bay.id && before.stoppedSince >= 0 && unchanged;
  const progress: ParkingProgress = { requestId, bayId: bay.id, stoppedSince: continuous ? before.stoppedSince : tick, completed: false,
    settledPose: continuous ? pose : { x: vehicle.x, y: vehicle.y, z: vehicle.z, heading: vehicle.heading } };
  if (tick - progress.stoppedSince >= 120 && pressed) { progress.completed = true; return { progress, stopped: bay.id }; }
  return { progress, stopped: undefined };
}

export function prepareMissionParking(previous: MissionParkingState | undefined, missions: MissionState, ctx: GameplayContext, tick: number): { state: MissionParkingState; facts: GameplayFact[] } {
  const old = previous ?? { tick: -1, nextSequence: 1, previousInteract: {}, players: {} };
  if (tick <= old.tick) return { state: old, facts: [] };
  const state: MissionParkingState = { tick, nextSequence: old.nextSequence, previousInteract: {}, players: {} }, facts: GameplayFact[] = [];
  for (const body of [...ctx.bodies].sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    const interacting = Boolean((ctx.actions?.[body.id] ?? 0) & Action.interact);
    state.previousInteract[body.id] = interacting;
    const progress = missions.players[body.id], world = ctx.missionParking;
    if (!world || !progress || progress.status !== "active") continue;
    const mission = ctx.missions.find(value => value.id === progress.missionId && (value.wave ?? 2) <= ctx.wave);
    const step = mission?.steps.find(value => value.id === progress.stepId);
    if (!mission || step?.type !== "objective" || step.objective.kind !== "event" || step.objective.event !== "demo.parkedLegally") continue;
    const targets = world.targets.filter(value => value.missionId === mission.id && value.stepId === step.id);
    const vehicles = world.vehicles.filter(value => value.playerId === body.id);
    if (targets.length !== 1 || vehicles.length !== 1) continue;
    const target = targets[0]!, vehicle = vehicles[0]!;
    const requestId = `${mission.id}:${step.id}:${progress.startedTick}:${progress.visits}`;
    const { progress: parked, stopped } = advanceParking(old.players[body.id], requestId, world, target.bayIds, body, vehicle, tick, old.tick === tick - 1, interacting && !old.previousInteract[body.id], target.expectedStayMinutes);
    if (stopped) {
      const sequence = state.nextSequence++;
      facts.push({ id: `mission-parking:${sequence}`, source: "world", sequence, tick, kind: "demo.parkedLegally", playerId: body.id, actorId: stopped, detail: requestId });
    }
    state.players[body.id] = parked;
  }
  return { state, facts };
}
