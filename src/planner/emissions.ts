// Fuel and CO2 per vehicle, second by second, from speed and acceleration (data.ts ARRB).
import { ARRB, CO2_G_PER_ML } from "./data.ts";

/** Fuel rate in mL/s for a car at speed v (m/s) and acceleration a (m/s^2) on level road. */
export function fuelRateMlPerS(v: number, a: number): number {
  const { alphaMlPerS, beta1, beta2, massT, d1, d2, d3 } = ARRB;
  const speed = Math.max(0, v);
  const power = d1 * speed + d2 * speed * speed * speed + d3 * speed * speed + massT * a * speed;
  if (power <= 0) return alphaMlPerS;
  const accel = a > 0 ? a : 0;
  return alphaMlPerS + beta1 * power + beta2 * massT * accel * accel * speed;
}

export function co2GramsFromFuelMl(ml: number): number { return ml * CO2_G_PER_ML; }

/**
 * Extra fuel (mL) one stop costs: braking from v to 0 and accelerating back at `accel`, compared
 * with passing at v. Used for cross-street queues, which are modelled as counts, not cars.
 */
export function stopPenaltyMl(v: number, accel = 1.5, decel = 2): number {
  const dt = 0.1;
  let ml = 0, dist = 0;
  for (let u = v; u > 0; u -= decel * dt) { ml += fuelRateMlPerS(u, -decel) * dt; dist += u * dt; }
  for (let u = 0; u < v; u += accel * dt) { ml += fuelRateMlPerS(u, accel) * dt; dist += u * dt; }
  const cruise = fuelRateMlPerS(v, 0) * (dist / v);
  return Math.max(0, ml - cruise);
}
