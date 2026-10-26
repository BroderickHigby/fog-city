import type { CarState } from "../../src/sim/contract.ts";

/** Keyboard pursuit respects the car's finite turning radius: brake before turning in. */
export function pursuitKeys(car: CarState, target: { x: number; z: number }, approachSpeed = 5): Set<string> {
  let off = Math.atan2(target.x - car.x, -(target.z - car.z)) - car.heading;
  while (off > Math.PI) off -= 2 * Math.PI;
  while (off < -Math.PI) off += 2 * Math.PI;
  const keys = new Set<string>();
  if (off > 0.06) keys.add("KeyD");
  else if (off < -0.06) keys.add("KeyA");
  const distance = Math.hypot(target.x - car.x, target.z - car.z);
  const desired = Math.abs(off) > 0.5 ? 4 : Math.min(12, Math.max(approachSpeed, distance * 0.6));
  keys.add(car.speed > desired + 0.5 ? "KeyS" : "KeyW");
  return keys;
}
