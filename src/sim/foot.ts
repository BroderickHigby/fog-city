// On foot: a walker (FootState in contract.ts) that turns with steer, walks with throttle,
// sprints with the brake held, follows the terrain, and collides with buildings, cars,
// robots and people. Getting out of the car and back in is handled in step.ts with the
// helpers here (exitSpot, canEnterCar): never through a wall, and never into a building.
//
// Vertical (v3):
//  - The walker stands on the surface (surfaceHeight): the ground, or a roof within
//    ROOF_STEP_M of its feet, so from a hillside above a roof it walks onto the roof instead of
//    meeting an invisible wall, and a building blocks it only between its feet plus that step
//    and the top of its head (blocksBand).
//  - It follows the surface down while the drop over the tick stays within FOOT.maxGrade of
//    its travel (plus FOOT.dropTolerance); a steeper drop (a roof edge, a retaining wall, a
//    bluff) is walked off: it falls under gravity, keeps its horizontal speed with no control,
//    and lands when its feet reach the surface again.
//  - It cannot walk up ground that rises more than FOOT.maxGrade * FOOT.gradeReach within
//    FOOT.gradeReach ahead (a slope steeper than 1:1 that is taller than a metre); it slides
//    along such a bank instead. A short steep bank (a step) is climbed.
//  - Pushes out of buildings and bodies are capped at FOOT.maxPush a tick.
//  - On a deck or in a tunnel bore the walker is held by the deck's rails and the bore's walls
//    (world.ts railPush): it never walks off a viaduct or into the hill around a bore; in a bore
//    the ceiling is over its head.

import { DT, type CarState, type FootState, type SimInput } from "./contract.ts";
import { approach, clamp, dcos, dsin, wrapAngle } from "./dmath.ts";
import { resolveCircleAll, type Band, type Box, type Circle } from "./collide.ts";
import { CAR } from "./car.ts";
import { segmentCrossesWall } from "./boundary.ts";
import { ROOF_STEP_M, circleBlocked, railPush, segmentBlocked, supported, surfaceAt, surfaceHeight, type World } from "./world.ts";

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
  /** Top of the head above the feet, metres: passes under a structure whose underside is higher. */
  height: 1.8,
  gravity: 9.81,
  /** Steepest ground the walker walks up or down in control, rise per metre. */
  maxGrade: 1,
  /** How far ahead the walker looks for a bank too steep to climb, metres. */
  gradeReach: 1,
  /** Extra drop per tick still followed on foot (lattice corners, a kerb), metres. */
  dropTolerance: 0.02,
  /** Most the walker is pushed out of buildings and bodies in one tick, metres. */
  maxPush: 0.5,
} as const;

export function makeFoot(x: number, y: number, z: number, heading: number): FootState {
  return { x, y, z, heading: wrapAngle(heading), speed: 0, sprint: false, vy: 0, grounded: true };
}

/** The walker's band for building checks: feet plus the step onto a roof, to the top of the head. */
function bandAt(y: number): Band {
  return { bottom: y + ROOF_STEP_M, top: y + FOOT.height };
}

/** Is the ground within FOOT.gradeReach of (x, z) along (dx, dz) (a unit vector) too steep to walk up from feet height y? */
function tooSteep(world: World, x: number, z: number, y: number, dx: number, dz: number): boolean {
  const r = FOOT.gradeReach;
  // (A hair of tolerance: exactly 1:1 is climbable whatever the rounding.)
  return surfaceHeight(world, x + dx * r, z + dz * r, y) - y > FOOT.maxGrade * r + 1e-9;
}

export function stepFoot(
  world: World,
  f: Readonly<FootState>,
  input: Readonly<SimInput>,
  boxes: ReadonlyArray<Readonly<Box>>,
  circles: readonly Circle[],
): FootState {
  const band = bandAt(f.y);
  if (!f.grounded) {
    // Falling: no control. Horizontal speed carries on along the heading; gravity pulls down.
    const fx = dsin(f.heading);
    const fz = -dcos(f.heading);
    const res = resolveCircleAll(world, f.x + fx * f.speed * DT, f.z + fz * f.speed * DT, FOOT.radius, boxes, circles, f.x, f.z, band, FOOT.maxPush);
    const vyB = f.vy - FOOT.gravity * DT;
    const yB = f.y + vyB * DT;
    const s1 = surfaceHeight(world, res.x, res.z, f.y);
    // What it achieved along the heading, never more than it had: a push is not a stride.
    const speed = clamp(((res.x - f.x) * fx + (res.z - f.z) * fz) / DT, f.speed < 0 ? f.speed : 0, f.speed > 0 ? f.speed : 0);
    if (yB <= s1) return { x: res.x, y: s1, z: res.z, heading: f.heading, speed, sprint: f.sprint, vy: 0, grounded: true };
    return { x: res.x, y: yB, z: res.z, heading: f.heading, speed, sprint: f.sprint, vy: vyB, grounded: false };
  }

  const sprint = input.brake > 0.5 && input.throttle > 0.1;
  const heading = wrapAngle(f.heading + input.steer * (sprint ? FOOT.sprintTurnRate : FOOT.turnRate) * DT);
  const fx = dsin(heading);
  const fz = -dcos(heading);

  let target = input.throttle > 0 ? input.throttle * (sprint ? FOOT.sprint : FOOT.walk) : input.throttle * FOOT.back;
  if (target !== 0) {
    const ahead = surfaceHeight(world, f.x + fx * 0.5, f.z + fz * 0.5, f.y);
    const behind = surfaceHeight(world, f.x - fx * 0.5, f.z - fz * 0.5, f.y);
    const rise = ((ahead - behind) / 1.0) * (target > 0 ? 1 : -1);
    if (rise > 0) target /= 1 + FOOT.uphill * rise;
  }
  const speedingUp = (target < 0 ? -target : target) > (f.speed < 0 ? -f.speed : f.speed);
  const speed0 = approach(f.speed, target, (speedingUp ? FOOT.accel : FOOT.decel) * DT);

  // The intended step, kept off banks too steep to climb: slide along one, or stop.
  let dx = fx * speed0 * DT;
  let dz = fz * speed0 * DT;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len > 0 && tooSteep(world, f.x, f.z, f.y, dx / len, dz / len)) {
    // Drop the uphill part of the step (the surface gradient's direction).
    const e = 0.5;
    const gx = surfaceHeight(world, f.x + e, f.z, f.y) - surfaceHeight(world, f.x - e, f.z, f.y);
    const gz = surfaceHeight(world, f.x, f.z + e, f.y) - surfaceHeight(world, f.x, f.z - e, f.y);
    const g = Math.sqrt(gx * gx + gz * gz);
    const up = g > 0 ? (dx * gx + dz * gz) / g : 0;
    if (up > 0) {
      dx -= (up * gx) / g;
      dz -= (up * gz) / g;
    }
    const l2 = Math.sqrt(dx * dx + dz * dz);
    if (l2 <= 1e-9 || tooSteep(world, f.x, f.z, f.y, dx / l2, dz / l2)) {
      dx = 0;
      dz = 0;
    }
  }

  let res = resolveCircleAll(world, f.x + dx, f.z + dz, FOOT.radius, boxes, circles, f.x, f.z, band, FOOT.maxPush);
  const s0 = surfaceAt(world, f.x, f.z, f.y);
  if (s0.kind === "deck" || s0.kind === "tunnel") {
    // Held by the rail or the bore wall, a radius inside the ribbon's edge; where that is not
    // enough (a corner), it stays where it was.
    const p = railPush(world, res.x, res.z, f.y, FOOT.radius);
    if (p) {
      const x = res.x + p.dx;
      const z = res.z + p.dz;
      res = supported(world, x, z, f.y, false) && !segmentCrossesWall(world.walls, f.x, f.z, x, z) ? { x, z, hit: true } : { x: f.x, z: f.z, hit: true };
    } else if (!supported(world, res.x, res.z, f.y, false)) res = { x: f.x, z: f.z, hit: true };
  }
  // Report the speed actually achieved along the heading (pressing into a wall reads as 0), never
  // more than the walker's own: being pushed out of a building or a car is not walking.
  const speed = clamp(((res.x - f.x) * fx + (res.z - f.z) * fz) / DT, speed0 < 0 ? speed0 : 0, speed0 > 0 ? speed0 : 0);
  const mx = res.x - f.x;
  const mz = res.z - f.z;
  const moved = Math.sqrt(mx * mx + mz * mz);
  const s1 = surfaceHeight(world, res.x, res.z, f.y);
  if (s1 < f.y - (FOOT.maxGrade * moved + FOOT.dropTolerance)) {
    // Walked off a drop: start falling from here (never upward: there is no jump).
    const vy0 = f.vy < 0 ? f.vy : 0;
    const vyB = vy0 - FOOT.gravity * DT;
    const yB = f.y + vyB * DT;
    if (yB > s1) return { x: res.x, y: yB, z: res.z, heading, speed, sprint, vy: vyB, grounded: false };
  }
  // On the surface: its rise along the walk, as a rate, limited to what walking can climb.
  const lim = (moved / DT) * FOOT.maxGrade;
  const vy = clamp((s1 - f.y) / DT, -lim, lim);
  return { x: res.x, y: s1, z: res.z, heading, speed, sprint, vy: vy + 0, grounded: true };
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
    // On a deck or in a bore: never out over the rail or into the bore's wall.
    const on = surfaceAt(world, c.x, c.z, c.y).kind;
    if ((on === "deck" || on === "tunnel") && !supported(world, x, z, c.y, false)) continue;
    return makeFoot(x, surfaceHeight(world, x, z, c.y), z, c.heading);
  }
  return null;
}
