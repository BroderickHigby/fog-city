import { dcos, dsin } from "../../dmath.ts";
import type { GameplayBody } from "../../gameplay-contract.ts";

export interface ParkingVehicle { playerId: string; x: number; y: number; z: number; heading: number; speed: number; lateral: number; halfLength: number; halfWidth: number }
export interface ParkingBay { id: string; edge: string; side: "L" | "R"; x: number; y: number; z: number; heading: number; halfLength: number; halfWidth: number; unrestricted?: boolean }
/** Shapes mirror the existing parking.json / street-cleaning.json source records. */
export interface ParkingRule { edge: string; side: "L" | "R"; kind: string; days: number[]; from: number | null; to: number | null; hourLimit: number | null; permitAreas: string[] }
export interface CleaningRule { edge: string; side: "L" | "R"; day: number; fromHour: number; toHour: number; weeks: number[]; holidays: boolean }
export interface ParkingClock { isoWeekday: number; minute: number; weekOfMonth: number; holiday: boolean }
export interface ParkingRequest { id: string; playerId: string; bayIds: string[]; expectedStayMinutes?: number }
export interface ParkingInput { bays: readonly ParkingBay[]; requests: readonly ParkingRequest[]; rules: readonly ParkingRule[]; cleaning: readonly CleaningRule[]; clock: ParkingClock; permits?: Readonly<Record<string, readonly string[]>>; paidUntilTick?: Readonly<Record<string, number>> }
export interface ParkingProgress { requestId: string; bayId: string; stoppedSince: number; completed: boolean; settledPose: { x: number; y: number; z: number; heading: number } | null }
export interface ParkingCheck { legal: boolean; reason: "legal" | "outside-bay" | "moving" | "unknown-rule" | "restricted" | "street-cleaning" | "unpaid" | "time-limit" | "invalid-clock" }

function windowActive(days: readonly number[], from: number | null, to: number | null, clock: ParkingClock): boolean {
  const start = from ?? 0, end = to ?? 1440;
  const today = days.length === 0 || days.includes(clock.isoWeekday);
  if (start === end) return today;
  if (start <= end) return today && clock.minute >= start && clock.minute < end;
  const yesterday = clock.isoWeekday === 1 ? 7 : clock.isoWeekday - 1;
  return today && clock.minute >= start || (days.length === 0 || days.includes(yesterday)) && clock.minute < end;
}

/** Every corner must fit; a centre inside a bay does not authorize a car across the kerb. */
export function vehicleFitsBay(vehicle: ParkingVehicle, bay: ParkingBay): boolean {
  if (![vehicle.x, vehicle.y, vehicle.z, vehicle.heading, vehicle.halfLength, vehicle.halfWidth, bay.x, bay.y, bay.z, bay.heading, bay.halfLength, bay.halfWidth].every(Number.isFinite)) return false;
  if (vehicle.halfLength <= 0 || vehicle.halfWidth <= 0 || bay.halfLength <= 0 || bay.halfWidth <= 0 || Math.abs(vehicle.y - bay.y) > 0.75) return false;
  const cs = dcos(vehicle.heading), sn = dsin(vehicle.heading), bc = dcos(bay.heading), bs = dsin(bay.heading);
  for (const longitudinal of [-vehicle.halfLength, vehicle.halfLength]) for (const lateral of [-vehicle.halfWidth, vehicle.halfWidth]) {
    const x = vehicle.x + sn * longitudinal + cs * lateral - bay.x;
    const z = vehicle.z - cs * longitudinal + sn * lateral - bay.z;
    if (Math.abs(x * bs - z * bc) > bay.halfLength + 1e-6 || Math.abs(x * bc + z * bs) > bay.halfWidth + 1e-6) return false;
  }
  return true;
}

export function checkParking(vehicle: ParkingVehicle, bay: ParkingBay, input: ParkingInput, tick: number, stayMinutes = 15): ParkingCheck {
  const { clock } = input;
  if (!Number.isInteger(clock.isoWeekday) || clock.isoWeekday < 1 || clock.isoWeekday > 7 || !Number.isFinite(clock.minute) || clock.minute < 0 || clock.minute >= 1440 || !Number.isInteger(clock.weekOfMonth) || clock.weekOfMonth < 1 || clock.weekOfMonth > 5) return { legal: false, reason: "invalid-clock" };
  if (!Number.isFinite(vehicle.speed) || !Number.isFinite(vehicle.lateral) || Math.abs(vehicle.speed) > 0.05 || Math.abs(vehicle.lateral) > 0.05) return { legal: false, reason: "moving" };
  if (!vehicleFitsBay(vehicle, bay)) return { legal: false, reason: "outside-bay" };
  const same = (rule: { edge: string; side: string }): boolean => rule.edge === bay.edge && rule.side === bay.side;
  for (const cleaning of input.cleaning.filter(same)) {
    if (cleaning.day === 0 ? !clock.holiday : clock.holiday && !cleaning.holidays) continue;
    if (!cleaning.weeks.includes(clock.weekOfMonth)) continue;
    const days = cleaning.day === 0 ? [] : [cleaning.day];
    if (windowActive(days, cleaning.fromHour * 60, cleaning.toHour * 60, clock)) return { legal: false, reason: "street-cleaning" };
  }
  const rules = input.rules.filter(same);
  if (rules.length === 0 && !bay.unrestricted) return { legal: false, reason: "unknown-rule" };
  for (const rule of rules) {
    if (rule.kind === "no-parking-any-time") return { legal: false, reason: "restricted" };
    if (!windowActive(rule.days, rule.from, rule.to, clock)) continue;
    const permit = rule.permitAreas.some((area) => input.permits?.[vehicle.playerId]?.includes(area));
    if (rule.kind === "no-parking-any-time" || rule.kind === "no-parking" || rule.kind === "no-stopping") return { legal: false, reason: "restricted" };
    if (rule.kind === "time-limited") {
      if (!permit && (rule.hourLimit === null || !Number.isFinite(stayMinutes) || stayMinutes <= 0 || stayMinutes > rule.hourLimit * 60)) return { legal: false, reason: "time-limit" };
    } else if (rule.kind === "pay-or-permit" || rule.kind === "paid-parking") {
      if (!permit && (input.paidUntilTick?.[`${vehicle.playerId}:${bay.id}`] ?? -1) < tick + stayMinutes * 60 * 60) return { legal: false, reason: "unpaid" };
    } else if (rule.kind !== "unrestricted" && rule.kind !== "free") return { legal: false, reason: "unknown-rule" };
  }
  return { legal: true, reason: "legal" };
}

export function nearBay(body: GameplayBody | undefined, bay: ParkingBay): boolean {
  return !!body && [body.x, body.y, body.z].every(Number.isFinite) && Math.hypot(body.x - bay.x, body.z - bay.z) <= bay.halfLength + 6 && Math.abs(body.y - bay.y) <= 2;
}
