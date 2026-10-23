import { dcos, dsin } from "../../dmath.ts";
import type { GameplayBody } from "../../gameplay-contract.ts";
import { planarDistanceSquared } from "./geometry.ts";

export interface RunningBoardSlot { id: string; lateral: number; forward: number; height: number }
export interface CableCarBody { id: string; kind: "cable-car" | "bus"; x: number; y: number; z: number; heading: number; speed: number; atStop: boolean; boardingOpen: boolean; slots: readonly RunningBoardSlot[] }
export interface CableBoardingRequest { id: string; playerId: string; vehicleId: string }
export interface BoardingIntent { id: string; requestId: string; playerId: string; vehicleId: string; slotId: string; tick: number; target: { x: number; y: number; z: number } }
/** This record must come from core's accepted physical attachment, never a UI command. */
export interface AcceptedBoarding { intentId: string; playerId: string; vehicleId: string; slotId: string }
export interface CableBoardingInput { requests: readonly CableBoardingRequest[]; vehicles: readonly CableCarBody[]; accepted: readonly AcceptedBoarding[] }
export interface BoardingProgress { requestId: string; intentId: string; vehicleId: string; slotId: string; requestedTick: number; mounted: boolean }

export function boardPosition(vehicle: CableCarBody, slot: RunningBoardSlot): { x: number; y: number; z: number } {
  const cs = dcos(vehicle.heading), sn = dsin(vehicle.heading);
  return { x: vehicle.x + cs * slot.lateral + sn * slot.forward, y: vehicle.y + slot.height, z: vehicle.z + sn * slot.lateral - cs * slot.forward };
}

function finiteVehicle(vehicle: CableCarBody, slot: RunningBoardSlot): boolean {
  return !!vehicle.id && !!slot.id && [vehicle.x, vehicle.y, vehicle.z, vehicle.heading, vehicle.speed, slot.lateral, slot.forward, slot.height].every(Number.isFinite);
}

export function eligibleBoardingSlot(body: GameplayBody | undefined, vehicle: CableCarBody): RunningBoardSlot | null {
  if (!body || body.mode !== "foot" || ![body.x, body.y, body.z, body.speed].every(Number.isFinite) || Math.abs(body.speed) > 2 || vehicle.kind !== "cable-car" || !vehicle.atStop || !vehicle.boardingOpen || Math.abs(vehicle.speed) > 0.3) return null;
  return [...vehicle.slots].filter((slot) => {
    if (!finiteVehicle(vehicle, slot)) return false;
    const point = boardPosition(vehicle, slot);
    return planarDistanceSquared(body.x, body.z, point.x, point.z) <= 4 && Math.abs(body.y - point.y) <= 1.5;
  }).sort((a, b) => {
    const pa = boardPosition(vehicle, a), pb = boardPosition(vehicle, b);
    return planarDistanceSquared(body.x, body.z, pa.x, pa.z) - planarDistanceSquared(body.x, body.z, pb.x, pb.z) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  })[0] ?? null;
}

export function boardingAccepted(progress: BoardingProgress, body: GameplayBody | undefined, input: CableBoardingInput, tick: number): boolean {
  if (!body || body.mode !== "foot" || tick <= progress.requestedTick || tick - progress.requestedTick > 120) return false;
  const vehicle = input.vehicles.find((v) => v.id === progress.vehicleId && v.kind === "cable-car");
  const slot = vehicle?.slots.find((s) => s.id === progress.slotId);
  if (!vehicle || !slot || !finiteVehicle(vehicle, slot)) return false;
  const accepted = input.accepted.some((a) => a.intentId === progress.intentId && a.playerId === body.id && a.vehicleId === progress.vehicleId && a.slotId === progress.slotId);
  const point = boardPosition(vehicle, slot);
  return accepted && [body.x, body.y, body.z].every(Number.isFinite) && planarDistanceSquared(body.x, body.z, point.x, point.z) <= 0.75 * 0.75 && Math.abs(body.y - point.y) <= 0.75;
}
