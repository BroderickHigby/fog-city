import { Action, type InputFrame } from "../../contract.ts";
import { wrapAngle } from "../../dmath.ts";
import { isGameplayId, type GameplayBody, type GameplayFact } from "../../gameplay-contract.ts";
import { advanceBellDuel, canStartDuel, newBellRound, type BellDuelProgress, type BellDuelRequest, type MechanicEmission } from "./bell-duel.ts";
import { checkParking, nearBay, type ParkingInput, type ParkingProgress, type ParkingVehicle } from "./parking.ts";
import { boardPosition, boardingAccepted, eligibleBoardingSlot, type BoardingIntent, type BoardingProgress, type CableBoardingInput } from "./cable-car.ts";
import { planarDistanceSquared } from "./geometry.ts";
export * from "./bell-duel.ts";
export * from "./parking.ts";
export * from "./cable-car.ts";

export interface MissionMechanicsState { version: 1; tick: number; nextSequence: number; previousInteract: Record<string, boolean>; parking: Record<string, ParkingProgress>; duels: Record<string, BellDuelProgress>; boarding: Record<string, BoardingProgress> }
export interface MissionMechanicsInput { tick: number; seed: number; bodies: readonly GameplayBody[]; vehicles: readonly ParkingVehicle[]; inputs: InputFrame; parking?: ParkingInput; bellDuels?: readonly BellDuelRequest[]; cableBoarding?: CableBoardingInput; /** Reserve from the central world's cursor when it has other producers. */ sequenceFloor?: number }
export function createMissionMechanics(): MissionMechanicsState { return { version: 1, tick: -1, nextSequence: 1, previousInteract: {}, parking: {}, duels: {}, boarding: {} }; }

/** Caller supplies authoritative active requests, accepted body poses, calendar and road rules. */
export function stepMissionMechanics(previous: MissionMechanicsState, input: MissionMechanicsInput): { state: MissionMechanicsState; events: GameplayFact[]; boardingIntents: BoardingIntent[] } {
  if (!Number.isSafeInteger(input.tick) || input.tick < 0) throw new Error("Mission mechanics require a valid tick");
  if (input.sequenceFloor !== undefined && (!Number.isSafeInteger(input.sequenceFloor) || input.sequenceFloor < 1)) throw new Error("Invalid world sequence floor");
  const bodyIds = new Set<string>();
  for (const body of input.bodies) {
    if (!isGameplayId(body.id) || bodyIds.has(body.id)) throw new Error("Invalid or duplicate mechanic player ID");
    bodyIds.add(body.id);
  }
  for (const requests of [input.parking?.requests ?? [], input.bellDuels ?? [], input.cableBoarding?.requests ?? []]) {
    const players = new Set<string>();
    for (const request of requests) {
      if (!isGameplayId(request.id) || !isGameplayId(request.playerId) || players.has(request.playerId)) throw new Error("At most one active mechanic request per player and kind");
      players.add(request.playerId);
    }
  }
  if (input.tick <= previous.tick) return { state: previous, events: [], boardingIntents: [] };
  const state: MissionMechanicsState = { ...previous, tick: input.tick, nextSequence: Math.max(previous.nextSequence, input.sequenceFloor ?? 1), previousInteract: {}, parking: {}, duels: {}, boarding: {} };
  const events: GameplayFact[] = [];
  const boardingIntents: BoardingIntent[] = [];
  const emit = (event: MechanicEmission): void => { const sequence = state.nextSequence++; events.push({ ...event, id: `mission-mechanics:${sequence}`, source: "world", sequence, tick: input.tick }); };
  const bodies = new Map(input.bodies.map((body) => [body.id, body]));
  const pressed = (id: string): boolean => (input.inputs[id]?.actions ?? 0) & Action.interact ? !previous.previousInteract[id] : false;
  for (const body of input.bodies) state.previousInteract[body.id] = ((input.inputs[body.id]?.actions ?? 0) & Action.interact) !== 0;
  const parking = input.parking;
  if (parking) for (const request of [...parking.requests].sort((a, b) => a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : a.id < b.id ? -1 : 1)) {
    const old = previous.parking[request.playerId];
    if (old?.requestId === request.id && old.completed) { state.parking[request.playerId] = { ...old }; continue; }
    const vehicle = input.vehicles.find((v) => v.playerId === request.playerId);
    const bay = vehicle && parking.bays.filter((b) => request.bayIds.includes(b.id)).sort((a, b) => a.id < b.id ? -1 : 1).find((b) => nearBay(bodies.get(request.playerId), b) && checkParking(vehicle, b, parking, input.tick, request.expectedStayMinutes).legal);
    if (!bay || !vehicle) { state.parking[request.playerId] = { requestId: request.id, bayId: "", stoppedSince: -1, completed: false, settledPose: null }; continue; }
    const settled = old?.settledPose;
    const vertical = settled ? vehicle.y - settled.y : 0;
    const unchanged = settled && planarDistanceSquared(vehicle.x, vehicle.z, settled.x, settled.z) + vertical * vertical <= 0.05 * 0.05
      && Math.abs(wrapAngle(vehicle.heading - settled.heading)) <= 0.03;
    const continuous = input.tick === previous.tick + 1 && old?.requestId === request.id && old.bayId === bay.id && old.stoppedSince >= 0 && unchanged;
    const stoppedSince = continuous ? old.stoppedSince : input.tick;
    const settledPose = continuous ? settled : { x: vehicle.x, y: vehicle.y, z: vehicle.z, heading: vehicle.heading };
    const progress: ParkingProgress = { requestId: request.id, bayId: bay.id, stoppedSince, completed: false, settledPose };
    if (input.tick - stoppedSince >= 120 && pressed(request.playerId)) {
      progress.completed = true;
      emit({ kind: "demo.parkedLegally", playerId: request.playerId, actorId: bay.id, detail: request.id });
    }
    state.parking[request.playerId] = progress;
  }
  for (const request of [...(input.bellDuels ?? [])].sort((a, b) => a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : a.id < b.id ? -1 : 1)) {
    const body = bodies.get(request.playerId), old = previous.duels[request.playerId];
    if (old?.requestId === request.id) state.duels[request.playerId] = advanceBellDuel(old, request, body, input.seed, input.tick, previous.tick, pressed(request.playerId), emit);
    else if (pressed(request.playerId) && canStartDuel(body, request)) {
      state.duels[request.playerId] = newBellRound(request.id, request.opponentId, input.seed, 1, input.tick);
      emit({ kind: "bell.duelStarted", playerId: request.playerId, actorId: request.opponentId, detail: request.id });
    }
  }
  const boarding = input.cableBoarding;
  if (boarding) for (const request of [...boarding.requests].sort((a, b) => a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : a.id < b.id ? -1 : 1)) {
    const body = bodies.get(request.playerId), old = previous.boarding?.[request.playerId];
    if (old?.requestId === request.id && input.tick - old.requestedTick <= 120) {
      const progress = { ...old };
      if (!progress.mounted && boardingAccepted(progress, body, boarding, input.tick)) {
        progress.mounted = true;
        emit({ kind: "cableCar.runningBoardMounted", playerId: request.playerId, actorId: progress.vehicleId, detail: request.id });
      }
      state.boarding[request.playerId] = progress;
      continue;
    }
    if (old?.requestId === request.id && old.mounted) { state.boarding[request.playerId] = { ...old }; continue; }
    const vehicle = boarding.vehicles.find((v) => v.id === request.vehicleId);
    const slot = vehicle && eligibleBoardingSlot(body, vehicle);
    if (!pressed(request.playerId) || !vehicle || !slot) continue;
    const id = `${request.id}:${request.playerId}:${input.tick}`;
    const progress: BoardingProgress = { requestId: request.id, intentId: id, vehicleId: vehicle.id, slotId: slot.id, requestedTick: input.tick, mounted: false };
    state.boarding[request.playerId] = progress;
    boardingIntents.push({ id, requestId: request.id, playerId: request.playerId, vehicleId: vehicle.id, slotId: slot.id, tick: input.tick, target: boardPosition(vehicle, slot) });
  }
  return { state, events, boardingIntents };
}
