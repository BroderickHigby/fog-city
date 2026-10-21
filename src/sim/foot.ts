// On foot: a walker (FootState in contract.ts) that turns with steer, walks with throttle,
// sprints with the brake held, follows the terrain, and collides with buildings, cars,
// robots and people. Getting out of the car and back in is handled in step.ts with the
// helpers here (exitSpot, canEnterCar): never through a wall, and never into a building.

import { DT, type CarState, type FootState, type SimInput } from "./contract.ts";
import { approach, clamp, dcos, dsin, wrapAngle } from "./dmath.ts";
import { resolveCircleAll, type Box, type Circle } from "./collide.ts";
import { CAR } from "./car.ts";
import { segmentCrossesWall } from "./boundary.ts";
import { circleBlocked, groundHeight, segmentBlocked, type World } from "./world.ts";

export const FOOT = {
  /** Walking speed, m/s. */
  walk: 1.6,
  /** Sprinting speed (brake held), m/s. */
  sprint: 4.8,
  /** Stepping backwards, m/s. */
  back: 1.0,
  accel: 8,
  decel: 12,
  /** Turning rate at full steer, rad/s. */
  turnRate: 3.0,
  sprintTurnRate: 2.2,
  radius: 0.35,
  /** Uphill slows walking: speed / (1 + uphill * rise-per-metre). */
  uphill: 1.5,
  /** Gap between the car's side and the walker when getting out, metres. */
  exitGap: 0.45,
  /** Get back in when within this distance of the car's body, metres. */
  enterRange: 3.0,
  /** Above this speed (m/s) enterExit first brakes the car to a stop, then the player gets out. */
  exitSpeed: 2.5,
} as const;

export function makeFoot(x: number, y: number, z: number, heading: number): FootState {
  return { x, y, z, heading: wrapAngle(heading), speed: 0, sprint: false };
}

export function stepFoot(
  world: World,
  f: Readonly<FootState>,
  input: Readonly<SimInput>,
  boxes: ReadonlyArray<Readonly<Box>>,
  circles: readonly Circle[],
): FootState {
  const sprint = input.brake > 0.5 && input.throttle > 0.1;
  const heading = wrapAngle(f.heading + input.steer * (sprint ? FOOT.sprintTurnRate : FOOT.turnRate) * DT);
  const fx = dsin(heading);
  const fz = -dcos(heading);

  let target = input.throttle > 0 ? input.throttle * (sprint ? FOOT.sprint : FOOT.walk) : input.throttle * FOOT.back;
  if (target !== 0) {
    const ahead = groundHeight(world, f.x + fx * 0.5, f.z + fz * 0.5);
    const behind = groundHeight(world, f.x - fx * 0.5, f.z - fz * 0.5);
    const rise = ((ahead - behind) / 1.0) * (target > 0 ? 1 : -1);
    if (rise > 0) target /= 1 + FOOT.uphill * rise;
  }
  const speedingUp = (target < 0 ? -target : target) > (f.speed < 0 ? -f.speed : f.speed);
  const speed0 = approach(f.speed, target, (speedingUp ? FOOT.accel : FOOT.decel) * DT);

  const res = resolveCircleAll(world, f.x + fx * speed0 * DT, f.z + fz * speed0 * DT, FOOT.radius, boxes, circles);
  // Report the speed actually achieved along the heading (pressing into a wall reads as 0).
  const speed = clamp(((res.x - f.x) * fx + (res.z - f.z) * fz) / DT, -FOOT.sprint, FOOT.sprint);
  return { x: res.x, y: groundHeight(world, res.x, res.z), z: res.z, heading, speed, sprint };
}

/** Distance from a point to the car's body rectangle (0 inside). */
export function distanceToCar(c: Readonly<Pick<CarState, "x" | "z" | "heading">>, x: number, z: number): number {
  const fx = dsin(c.heading);
  const fz = -dcos(c.heading);
  const ox = x - c.x;
  const oz = z - c.z;
  const l = ox * -fz + oz * fx;
  const f = ox * fx + oz * fz;
  const dl = Math.max(0, (l < 0 ? -l : l) - CAR.halfWidth);
  const df = Math.max(0, (f < 0 ? -f : f) - CAR.halfLength);
  return Math.sqrt(dl * dl + df * df);
}

/** The point of the car's body rectangle closest to (x, z) (the point itself when inside). */
export function closestOnCar(c: Readonly<Pick<CarState, "x" | "z" | "heading">>, x: number, z: number): { x: number; z: number } {
  const fx = dsin(c.heading);
  const fz = -dcos(c.heading);
  const ox = x - c.x;
  const oz = z - c.z;
  const l = clamp(ox * -fz + oz * fx, -CAR.halfWidth, CAR.halfWidth);
  const f = clamp(ox * fx + oz * fz, -CAR.halfLength, CAR.halfLength);
  return { x: c.x + fx * f - fz * l, z: c.z + fz * f + fx * l };
}

/**
 * Can a walker at (x, z) get into the car? Within FOOT.enterRange of its body, with a clear
 * line (no building in between) to the nearest point of the body or to its centre: nobody
 * gets in through a wall.
 */
export function canEnterCar(world: World, c: Readonly<Pick<CarState, "x" | "z" | "heading">>, x: number, z: number): boolean {
  if (distanceToCar(c, x, z) > FOOT.enterRange) return false;
  const p = closestOnCar(c, x, z);
  if (segmentCrossesWall(world.walls, x, z, c.x, c.z)) return false;
  return !segmentBlocked(world, x, z, p.x, p.z) || !segmentBlocked(world, x, z, c.x, c.z);
}

/**
 * Where a player steps out of a parked car: the driver's (left) side, else the right, behind,
 * in front. The first spot that is clear of buildings and obstacles, and that the player can
 * reach from the car without crossing a building, wins. When none qualifies the player stays
 * in the car (null): nobody is ever placed inside or beyond a wall.
 */
export function exitSpot(
  world: World,
  c: Readonly<CarState>,
  boxes: ReadonlyArray<Readonly<Box>>,
  circles: readonly Circle[],
): FootState | null {
  const fx = dsin(c.heading);
  const fz = -dcos(c.heading);
  const rx = -fz;
  const rz = fx;
  const side = CAR.halfWidth + FOOT.exitGap + FOOT.radius;
  const end = CAR.halfLength + FOOT.exitGap + FOOT.radius;
  const spots: Array<[number, number]> = [
    [c.x - rx * side, c.z - rz * side],
    [c.x + rx * side, c.z + rz * side],
    [c.x - fx * end, c.z - fz * end],
    [c.x + fx * end, c.z + fz * end],
  ];
  for (const [x, z] of spots) {
    if (circleBlocked(world, x, z, FOOT.radius)) continue;
    if (segmentBlocked(world, c.x, c.z, x, z)) continue;
    if (segmentCrossesWall(world.walls, c.x, c.z, x, z)) continue;
    const res = resolveCircleAll(world, x, z, FOOT.radius, boxes, circles);
    if (res.hit) continue;
    return makeFoot(x, groundHeight(world, x, z), z, c.heading);
  }
  return null;
}
