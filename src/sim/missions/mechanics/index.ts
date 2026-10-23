import { Action, type InputFrame } from "../../contract.ts";
import type { GameplayBody, GameplayFact } from "../../gameplay-contract.ts";
import { advanceBellDuel, canStartDuel, newBellRound, type BellDuelProgress, type BellDuelRequest, type MechanicEmission } from "./bell-duel.ts";
import { checkParking, nearBay, type ParkingInput, type ParkingProgress, type ParkingVehicle } from "./parking.ts";
export * from "./bell-duel.ts";
export * from "./parking.ts";

export interface MissionMechanicsState { version: 1; tick: number; nextSequence: number; previousInteract: Record<string, boolean>; parking: Record<string, ParkingProgress>; duels: Record<string, BellDuelProgress> }
export interface MissionMechanicsInput { tick: number; seed: number; bodies: readonly GameplayBody[]; vehicles: readonly ParkingVehicle[]; inputs: InputFrame; parking?: ParkingInput; bellDuels?: readonly BellDuelRequest[]; /** Reserve from the central world's cursor when it has other producers. */ sequenceFloor?: number }
export function createMissionMechanics(): MissionMechanicsState { return { version: 1, tick: -1, nextSequence: 1, previousInteract: {}, parking: {}, duels: {} }; }

/** Caller supplies authoritative active requests, accepted body poses, calendar and road rules. */
export function stepMissionMechanics(previous: MissionMechanicsState, input: MissionMechanicsInput): { state: MissionMechanicsState; events: GameplayFact[] } {
  if (!Number.isSafeInteger(input.tick) || input.tick < 0) throw new Error("Mission mechanics require a valid tick");
  if (input.sequenceFloor !== undefined && (!Number.isSafeInteger(input.sequenceFloor) || input.sequenceFloor < 1)) throw new Error("Invalid world sequence floor");
  for (const requests of [input.parking?.requests ?? [], input.bellDuels ?? []]) {
    const players = new Set<string>();
    for (const request of requests) {
      if (!request.id || !request.playerId || players.has(request.playerId)) throw new Error("At most one active mechanic request per player and kind");
      players.add(request.playerId);
    }
  }
  if (input.tick <= previous.tick) return { state: previous, events: [] };
  const state: MissionMechanicsState = { ...previous, tick: input.tick, nextSequence: Math.max(previous.nextSequence, input.sequenceFloor ?? 1), previousInteract: {}, parking: {}, duels: {} };
  const events: GameplayFact[] = [];
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
    const unchanged = settled && Math.hypot(vehicle.x - settled.x, vehicle.y - settled.y, vehicle.z - settled.z) <= 0.05
      && Math.abs(Math.atan2(Math.sin(vehicle.heading - settled.heading), Math.cos(vehicle.heading - settled.heading))) <= 0.03;
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
  return { state, events };
}
