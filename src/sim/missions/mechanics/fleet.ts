// Fleet Week's producers (docs/design.md "Public events": the air-show rehearsal and Pitch
// Window; mission 6): pitch between the jet passes, then recover the coned escape car.
//  - Jet passes repeat every PITCH_PERIOD_TICKS from the moment the window step begins, loud
//    for the first PITCH_LOUD_TICKS. The window opens at the first quiet gap after a pass.
//  - A talking point is interact in a quiet gap within PITCH_RADIUS_M of the pitch spot, at
//    least PITCH_GAP_TICKS after the last. A point made while the jets are overhead is lost
//    (repeat the point, not the deck). Three points complete the pitch.
//  - The getaway: from the chase until it is coned, the staged escape car drives the road
//    graph toward the chase target at GETAWAY_SPEED_MPS (catchable on foot or by car) and
//    waits there. The vehicle follower steers it from the car's observed pose; its state and
//    this tick's controls live here, and the agents lane applies the controls next tick
//    (getawayControls). A cone pull-over caps the car's speed as for any robotaxi.
//  - Recovery: the escape car stopped (a cone pulled it over), the founder on foot within
//    RECOVER_RADIUS_M of it, interact.
import { Action, type SimInput, type SimState } from "../../contract.ts";
import { createFollowerState, type FollowerState } from "../../vehicles/follower.ts";
import { toLocal } from "../../../geo/project.ts";
import { isGameplayId } from "../../gameplay-contract.ts";
import type { Mission, ObjectiveStep } from "../../../content/missions.ts";
import type { GameplayContext, GameplayFact, MissionProgress, MissionState } from "../../player/types.ts";
import { planarDistanceSquared } from "./geometry.ts";

export const PITCH_PERIOD_TICKS = 360;
export const PITCH_LOUD_TICKS = 120;
export const PITCH_GAP_TICKS = 60;
export const PITCH_POINTS = 3;
export const PITCH_RADIUS_M = 100;
export const RECOVER_RADIUS_M = 4;
export const GETAWAY_SPEED_MPS = 7;

export interface FleetPitchProgress { requestId: string; startTick: number; points: number; lastPointTick: number }
export interface FleetGetaway { follower: FollowerState; controls: SimInput }
export interface MissionFleetState { tick: number; nextSequence: number; previousInteract: Record<string, boolean>; pitch: Record<string, FleetPitchProgress>; getaway?: Record<string, FleetGetaway> }

/** Are the jets overhead at `tick` for a window that began at `startTick`? */
export function jetsLoud(startTick: number, tick: number): boolean {
  return tick >= startTick && (tick - startTick) % PITCH_PERIOD_TICKS < PITCH_LOUD_TICKS;
}

function eventStep(mission: Mission, progress: MissionProgress): ObjectiveStep | undefined {
  const step = mission.steps.find(value => value.id === progress.stepId);
  return step?.type === "objective" && step.objective.kind === "event" ? step : undefined;
}

/** The pitch spot: the mission's opening place. */
function pitchSpot(mission: Mission): { x: number; z: number } | undefined {
  const first = mission.steps.find(step => step.id === (mission.start ?? mission.steps[0]?.id));
  return first?.type === "trigger" && first.event.kind === "enterArea" ? toLocal(first.event.place.lat, first.event.place.lon) : undefined;
}

/** One pitch per attempt: the completion step shares the request its opening step began. */
function pitchRequestId(mission: Mission, progress: MissionProgress): string | undefined {
  const id = `${mission.id}:pitch:${progress.startedTick}`;
  return isGameplayId(id) ? id : undefined;
}

export function prepareMissionFleet(previous: MissionFleetState | undefined, missions: MissionState, ctx: GameplayContext, tick: number): { state: MissionFleetState; facts: GameplayFact[] } {
  const old = previous ?? { tick: -1, nextSequence: 1, previousInteract: {}, pitch: {} };
  if (tick <= old.tick) return { state: old, facts: [] };
  const state: MissionFleetState = { tick, nextSequence: old.nextSequence, previousInteract: {}, pitch: {} }, facts: GameplayFact[] = [];
  const getaway: Record<string, FleetGetaway> = {};
  const emit = (kind: string, playerId: string, actorId: string, amount: number, detail: string): void => {
    const sequence = state.nextSequence++;
    facts.push({ id: `mission-fleet:${sequence}`, source: "world", sequence, tick, kind, playerId, actorId, amount, detail });
  };
  for (const body of [...ctx.bodies].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    const interacting = Boolean((ctx.actions?.[body.id] ?? 0) & Action.interact);
    state.previousInteract[body.id] = interacting;
    const pressed = interacting && !old.previousInteract[body.id];
    const progress = missions.players[body.id];
    if (!progress || progress.status !== "active") continue;
    const mission = ctx.missions.find(value => value.id === progress.missionId && (value.wave ?? 2) <= ctx.wave);
    const chase = mission && getawayOf(mission, progress.stepId);
    if (mission && chase && ctx.missionDrive && (mission.wave ?? 2) >= 4) {
      const observation = ctx.observations.find(value => value.playerId === body.id);
      const carId = observation?.actorBindings?.[chase.actor] ?? `mission:${mission.id}:${chase.actor}`;
      const car = ctx.actorBodies?.find(actor => actor.id === carId);
      if (car && !getaway[carId]) {
        const pose = { x: car.x, z: car.z, heading: car.heading, speed: car.speed };
        const drive = ctx.missionDrive(pose, old.getaway?.[carId]?.follower ?? createFollowerState(pose), chase.target, GETAWAY_SPEED_MPS);
        getaway[carId] = { follower: drive.state, controls: drive.input };
      }
    }
    const step = mission && eventStep(mission, progress);
    if (!mission || !step || step.objective.kind !== "event") continue;
    const expected = step.objective.event;
    if (expected === "pitch.windowOpened" || expected === "pitch.windowCompleted") {
      const id = pitchRequestId(mission, progress), spot = pitchSpot(mission);
      if (!id || !spot) continue;
      const before = old.pitch[body.id];
      const pitch: FleetPitchProgress = before?.requestId === id ? { ...before } : { requestId: id, startTick: tick, points: 0, lastPointTick: -PITCH_GAP_TICKS };
      state.pitch[body.id] = pitch;
      const near = planarDistanceSquared(body.x, body.z, spot.x, spot.z) <= PITCH_RADIUS_M * PITCH_RADIUS_M;
      const loud = jetsLoud(pitch.startTick, tick), passed = tick - pitch.startTick >= PITCH_LOUD_TICKS;
      if (expected === "pitch.windowOpened") {
        if (near && passed && !loud) emit("pitch.windowOpened", body.id, mission.id, 0, id);
        continue;
      }
      if (!pressed || !near) continue;
      if (loud) { emit("pitch.missed", body.id, mission.id, pitch.points, id); continue; }
      if (tick - pitch.lastPointTick < PITCH_GAP_TICKS) continue;
      pitch.points++;
      pitch.lastPointTick = tick;
      emit("pitch.point", body.id, mission.id, pitch.points, id);
      if (pitch.points >= PITCH_POINTS) emit("pitch.windowCompleted", body.id, mission.id, pitch.points, id);
    } else if (expected === "vehicle.recovered") {
      const observation = ctx.observations.find(value => value.playerId === body.id);
      const carId = observation?.actorBindings?.escapeCar ?? `mission:${mission.id}:escapeCar`;
      const car = ctx.actorBodies?.find(actor => actor.id === carId);
      if (!car || !pressed || body.mode !== "foot" || Math.abs(car.speed) > 0.5) continue;
      if (planarDistanceSquared(body.x, body.z, car.x, car.z) > RECOVER_RADIUS_M * RECOVER_RADIUS_M) continue;
      emit("vehicle.recovered", body.id, carId, 0, `${mission.id}:${progress.startedTick}`);
    }
  }
  if (Object.keys(getaway).length) state.getaway = getaway;
  return { state, facts };
}

/** The controls the agents lane applies to escape cars this tick (planned on the last one). */
export function getawayControls(sim: Readonly<SimState>): Record<string, SimInput> {
  const getaway = (sim.ext.missions as MissionState | undefined)?.fleet?.getaway, controls: Record<string, SimInput> = {};
  for (const id of Object.keys(getaway ?? {}).sort()) controls[id] = getaway![id]!.controls;
  return controls;
}

/** The chase a getaway drives: a goto step whose next step cones a staged vehicle. */
function getawayOf(mission: Mission, stepId: string): { actor: string; target: { x: number; z: number } } | undefined {
  for (const step of mission.steps) {
    if (step.type !== "goto") continue;
    const next = mission.steps.find(value => value.id === step.next);
    if (next?.type !== "objective" || next.objective.kind !== "cone" || !next.objective.actor) continue;
    if (stepId !== step.id && stepId !== next.id) continue;
    if (mission.actors?.[next.objective.actor]?.kind !== "rogueTaxi") continue;
    return { actor: next.objective.actor, target: toLocal(step.target.lat, step.target.lon) };
  }
  return undefined;
}

