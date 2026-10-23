import type { Mission, ObjectiveStep } from "../../../content/missions.ts";
import type { InputFrame } from "../../contract.ts";
import { isGameplayId } from "../../gameplay-contract.ts";
import { finiteContext, sortedBodies } from "../../player/common.ts";
import type { GameplayContext, GameplayFact, MissionProgress, MissionState } from "../../player/types.ts";
import {
  createMissionMechanics, stepMissionMechanics,
  type AcceptedBoarding, type BellDuelRequest, type BoardingIntent, type CableBoardingRequest,
  type CableCarBody, type MissionMechanicsState, type ParkingInput, type ParkingRequest, type ParkingVehicle,
} from "./index.ts";

/** Provider-owned bindings identify authored objectives, never player-selected requests. */
export interface MissionMechanicTarget { missionId: string; stepId: string }
export interface MissionParkingTarget extends MissionMechanicTarget { bayIds: readonly string[]; expectedStayMinutes?: number }
export interface MissionBellTarget extends MissionMechanicTarget { opponentId: string; x: number; y: number; z: number; radius?: number }
export interface MissionCableTarget extends MissionMechanicTarget { vehicleId: string }
export interface MissionMechanicsWorld {
  parking?: Omit<ParkingInput, "requests"> & { vehicles: readonly ParkingVehicle[]; targets: readonly MissionParkingTarget[] };
  bellDuels?: readonly MissionBellTarget[];
  cableBoarding?: { vehicles: readonly CableCarBody[]; accepted: readonly AcceptedBoarding[]; targets: readonly MissionCableTarget[] };
}
export interface PrepareMissionMechanicsInput {
  tick: number; seed: number; inputs: InputFrame; context: GameplayContext;
  /** Accepted physical bodies, road rules and objective bindings from the world provider. */
  world?: MissionMechanicsWorld;
  sequenceFloor?: number;
}
export interface PreparedMissionMechanics { mechanics: MissionMechanicsState; facts: GameplayFact[]; boardingIntents: BoardingIntent[] }

const RESERVED_FACTS = new Set([
  "demo.parkedLegally", "bell.duelStarted", "bell.cue", "bell.ring", "bell.roundWon",
  "bell.roundLost", "bell.duelWon", "bell-duel.lost", "cableCar.runningBoardMounted",
]);

/** Only this persisted producer may supply these facts to the gameplay interpreter. */
export function stripMissionMechanicsFacts(facts: readonly GameplayFact[]): GameplayFact[] {
  return facts.filter(fact => !RESERVED_FACTS.has(fact.kind) && fact.id !== "mission-mechanics" && !fact.id.startsWith("mission-mechanics:"));
}

function unique<T>(values: readonly T[], matches: (value: T) => boolean): T | undefined {
  const found = values.filter(matches);
  return found.length === 1 ? found[0] : undefined;
}

function objective(mission: Mission, progress: MissionProgress): ObjectiveStep | undefined {
  const step = unique(mission.steps, value => value.id === progress.stepId);
  return step?.type === "objective" && step.objective.kind === "event" ? step : undefined;
}

function requestId(mission: Mission, step: ObjectiveStep, progress: MissionProgress): string | undefined {
  let anchor = step.id, visit = progress.visits;
  // Demo Day observes the start before asking for the win. Both authored objectives own one duel.
  if (step.objective.event === "bell.duelWon") {
    const starts = mission.steps.filter((value): value is ObjectiveStep => value.type === "objective"
      && value.objective.kind === "event" && value.objective.event === "bell.duelStarted" && value.next === step.id);
    if (starts.length > 1) return undefined;
    if (starts.length === 1) { anchor = starts[0]!.id; visit--; }
  }
  if (!Number.isSafeInteger(progress.startedTick) || progress.startedTick < 0 || !Number.isSafeInteger(visit) || visit < 1) return undefined;
  const id = `${mission.id}:${anchor}:${progress.startedTick}:${visit}`;
  return isGameplayId(id) ? id : undefined;
}

/**
 * Prepare once before the player/heat/mission systems, persist `mechanics`, then merge `facts`
 * into the sanitized provider facts for all systems that tick. It never accepts completion
 * commands. Core consumes the returned boarding intents and supplies accepted attachments on
 * a later tick; without that acceptance and matching physical pose, boarding cannot finish.
 */
export function prepareMissionMechanics(previous: MissionMechanicsState | undefined, missions: MissionState, input: PrepareMissionMechanicsInput): PreparedMissionMechanics {
  const mechanics = previous ?? createMissionMechanics(), world = input.world;
  if (input.sequenceFloor !== undefined && (!Number.isSafeInteger(input.sequenceFloor) || input.sequenceFloor < 1)) throw new Error("Invalid world sequence floor");
  finiteContext(input.context);
  const bodies = sortedBodies(input.context);
  const parking: ParkingRequest[] = [], bellDuels: BellDuelRequest[] = [], cableBoarding: CableBoardingRequest[] = [];
  for (const body of bodies) {
    const progress = missions.players[body.id];
    if (!progress || progress.status !== "active") continue;
    const mission = unique(input.context.missions, value => value.id === progress.missionId && (value.wave ?? 2) <= input.context.wave);
    if (!mission || !isGameplayId(mission.id)) continue;
    const step = objective(mission, progress), id = step && requestId(mission, step, progress);
    if (!step || !id) continue;
    const matches = (target: MissionMechanicTarget): boolean => target.missionId === mission.id && target.stepId === step.id;
    const actor = step.objective.actor;
    const actorId = actor ? input.context.observations.find(value => value.playerId === body.id)?.actorBindings?.[actor] ?? `mission:${mission.id}:${actor}` : undefined;
    if (actorId !== undefined && !isGameplayId(actorId)) continue;
    if (step.objective.event === "demo.parkedLegally" && world?.parking) {
      const target = unique(world.parking.targets, matches);
      if (!target || target.expectedStayMinutes !== undefined && (!Number.isFinite(target.expectedStayMinutes) || target.expectedStayMinutes <= 0)) continue;
      const bayIds = [...new Set(target.bayIds)].filter(bayId => isGameplayId(bayId)
        && (!actorId || actorId === bayId) && unique(world.parking!.bays, bay => bay.id === bayId)).sort();
      if (bayIds.length) parking.push({ id, playerId: body.id, bayIds, expectedStayMinutes: target.expectedStayMinutes });
    } else if (step.objective.event === "bell.duelStarted" || step.objective.event === "bell.duelWon") {
      const target = unique(world?.bellDuels ?? [], matches);
      if (!target || !isGameplayId(target.opponentId) || actorId && actorId !== target.opponentId) continue;
      const old = mechanics.duels[body.id];
      if (old?.requestId === id && old.opponentId !== target.opponentId) continue;
      bellDuels.push({ id, playerId: body.id, opponentId: target.opponentId, x: target.x, y: target.y, z: target.z, radius: target.radius });
    } else if (step.objective.event === "cableCar.runningBoardMounted" && world?.cableBoarding) {
      const target = unique(world.cableBoarding.targets, matches);
      if (!target || !isGameplayId(target.vehicleId) || actorId && actorId !== target.vehicleId
        || !unique(world.cableBoarding.vehicles, vehicle => vehicle.id === target.vehicleId)) continue;
      const old = mechanics.boarding[body.id];
      if (old?.requestId === id && old.vehicleId !== target.vehicleId) continue;
      cableBoarding.push({ id, playerId: body.id, vehicleId: target.vehicleId });
    }
  }
  const result = stepMissionMechanics(mechanics, {
    tick: input.tick, seed: input.seed, inputs: input.inputs, bodies,
    vehicles: (world?.parking?.vehicles ?? []).filter(vehicle => unique(world!.parking!.vehicles, value => value.playerId === vehicle.playerId)),
    ...(world?.parking ? { parking: { ...world.parking, requests: parking } } : {}),
    bellDuels,
    ...(world?.cableBoarding ? { cableBoarding: { ...world.cableBoarding, requests: cableBoarding } } : {}),
    sequenceFloor: Math.max(input.sequenceFloor ?? 1, (missions.factCursors["world:mission-mechanics"] ?? 0) + 1),
  });
  return { mechanics: result.state, facts: result.events, boardingIntents: result.boardingIntents };
}
