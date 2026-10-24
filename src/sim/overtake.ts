// Going round a stopped vehicle (v10 city life). A robotaxi held behind a vehicle that is not
// moving (a player's parked or abandoned car, a parked service van, a seized robotaxi) waits
// PASS_WAIT_TICKS, checks that the stretch of road it would use is clear (oncoming and adjacent
// traffic predicted along its heading, people with their berth, buildings, the kerb), then
// drives a lateral profile on its own lane: ease out by `off` metres, hold it alongside, ease
// back in. The profile is a pure function of arc length on that lane, so the route walks every
// other system makes (the probe, the people berth, the dodge's prediction) follow exactly where
// the robotaxi will drive.
//
// Pure geometry only; agents.ts decides when to plan, commit or abort a pass.

import { clamp, datan2, dcos, dsin } from "./dmath.ts";
import { offsetPoint, pathPoint, projectOnPath, type Path } from "./roads.ts";

/** A pass on the robotaxi's current lane: lateral offset `off` (metres right of travel) by arc length. */
export interface PassState {
  /** Offset alongside the obstacle, metres right of travel (negative: passing on the left). */
  off: number;
  /** Arc lengths on the lane: easing out over [s0, s1], alongside to s2, easing back in to s3. */
  s0: number;
  s1: number;
  s2: number;
  s3: number;
  /** Arc length at which the robotaxi is committed (its nose reaches the obstacle): no abort after it. */
  commit: number;
  /** The vehicle it is going round: "p:<player id>" (a player's car) or "a:<agent id>". */
  target: string;
}

/** Ticks a robotaxi waits behind a stationary vehicle (1.5 s) before it tries to go round it. */
export const PASS_WAIT_TICKS = 90;
/** How often a waiting robotaxi re-checks the road, ticks. */
export const PASS_RETRY_TICKS = 15;
/** A robotaxi stops this far behind a stationary vehicle it may go round (room to ease out), metres. */
export const PASS_STANDOFF_M = 4;
/** Top speed while going round, m/s. */
export const PASS_SPEED_MPS = 5;
/** Lateral clearance from the stopped vehicle's body alongside it, metres. */
export const PASS_SIDE_CLEAR_M = 0.6;
/** The body keeps at least this far from the stopped vehicle anywhere along the profile, metres. */
export const PASS_TARGET_GAP_M = 0.4;
/** ... and from any other vehicle (stopped, or where a moving one is predicted to be), metres. */
export const PASS_VEHICLE_GAP_M = 0.8;
/** It eases back in only this far past the stopped vehicle's front, metres. */
export const PASS_BEYOND_M = 2;
/** Distance kept from the kerb: the body's side stays this far inside the carriageway, metres. */
export const PASS_KERB_M = 0.25;
/** Ease-out lengths tried, shortest first, metres. */
export const PASS_RAMPS_M: readonly number[] = [7, 9, 11];
/** Spacing of the poses a planned corridor is checked at, metres. */
export const PASS_POSE_STEP_M = 1;

/** Smoothstep 0..1. */
function ease(t: number): number {
  const u = clamp(t, 0, 1);
  return u * u * (3 - 2 * u);
}

/** The pass offset at arc length s. */
export function passLat(p: Readonly<PassState>, s: number): number {
  if (s <= p.s0 || s >= p.s3) return 0;
  if (s < p.s1) return p.off * ease((s - p.s0) / (p.s1 - p.s0));
  if (s <= p.s2) return p.off;
  return p.off * (1 - ease((s - p.s2) / (p.s3 - p.s2)));
}

export interface PassPose {
  x: number;
  z: number;
  /** Unit forward. */
  hx: number;
  hz: number;
}

/** Position and unit forward of a body driving the pass profile on `path`, at arc length s. */
export function passPose(path: Path, p: Readonly<PassState>, s: number): PassPose {
  const o = offsetPoint(path, s, passLat(p, s));
  const lo = Math.max(0, s - 0.25);
  const hi = Math.min(path.len, s + 0.25);
  const a = offsetPoint(path, lo, passLat(p, lo));
  const b = offsetPoint(path, hi, passLat(p, hi));
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l = Math.sqrt(dx * dx + dz * dz);
  if (l > 1e-9) return { x: o.x, z: o.z, hx: dx / l, hz: dz / l };
  const q = pathPoint(path, s);
  return { x: o.x, z: o.z, hx: q.tx, hz: q.tz };
}

/** Compass heading of a unit forward. */
export function poseHeading(q: PassPose): number {
  return datan2(q.hx, -q.hz);
}

/** An oriented box: centre, unit forward, half extents. */
export interface Rect {
  x: number;
  z: number;
  fx: number;
  fz: number;
  hl: number;
  hw: number;
}

export function rectAt(x: number, z: number, heading: number, hl: number, hw: number): Rect {
  return { x, z, fx: dsin(heading), fz: -dcos(heading), hl, hw };
}

/** Distance from a point to a box (0 inside). */
export function pointRectGap(px: number, pz: number, r: Readonly<Rect>): number {
  const ox = px - r.x;
  const oz = pz - r.z;
  const along = ox * r.fx + oz * r.fz;
  const lat = -ox * r.fz + oz * r.fx;
  const el = Math.max(0, (lat < 0 ? -lat : lat) - r.hw);
  const ef = Math.max(0, (along < 0 ? -along : along) - r.hl);
  return Math.sqrt(el * el + ef * ef);
}

function corners(r: Readonly<Rect>): Array<[number, number]> {
  const sx = -r.fz;
  const sz = r.fx;
  const out: Array<[number, number]> = [];
  for (const i of [-1, 1]) for (const j of [-1, 1]) out.push([r.x + r.fx * r.hl * i + sx * r.hw * j, r.z + r.fz * r.hl * i + sz * r.hw * j]);
  return out;
}

/** Gap between two boxes (0 when they touch or overlap). */
export function rectGap(a: Readonly<Rect>, b: Readonly<Rect>): number {
  const ca = corners(a);
  const cb = corners(b);
  let separated = false;
  for (const [ax, az] of [[a.fx, a.fz], [-a.fz, a.fx], [b.fx, b.fz], [-b.fz, b.fx]] as Array<[number, number]>) {
    let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
    for (const [x, z] of ca) { const v = x * ax + z * az; amin = Math.min(amin, v); amax = Math.max(amax, v); }
    for (const [x, z] of cb) { const v = x * ax + z * az; bmin = Math.min(bmin, v); bmax = Math.max(bmax, v); }
    if (amax <= bmin || bmax <= amin) { separated = true; break; }
  }
  if (!separated) return 0;
  let best = Infinity;
  for (const [x, z] of ca) best = Math.min(best, pointRectGap(x, z, b));
  for (const [x, z] of cb) best = Math.min(best, pointRectGap(x, z, a));
  return best;
}

/** Where a box lies relative to a lane path: arc-length span and lateral span (+ = right of travel). */
export function rectOnPath(path: Path, r: Readonly<Rect>): { sMin: number; sMax: number; latMin: number; latMax: number } {
  let sMin = Infinity, sMax = -Infinity, latMin = Infinity, latMax = -Infinity;
  for (const [x, z] of corners(r)) {
    const p = projectOnPath(path, x, z);
    sMin = Math.min(sMin, p.s);
    sMax = Math.max(sMax, p.s);
    latMin = Math.min(latMin, p.d);
    latMax = Math.max(latMax, p.d);
  }
  return { sMin, sMax, latMin, latMax };
}

/**
 * The candidate offsets for going round a box: left and right, each the smallest that clears it
 * by PASS_SIDE_CLEAR_M, kept only if the body stays inside the carriageway (laneLat is the lane
 * centre's offset from the road centreline, halfRoad half the road width). Smallest first, left
 * first on a tie.
 */
export function passOffsets(span: { latMin: number; latMax: number }, bodyHalfWidth: number, laneLat: number, halfRoad: number): number[] {
  const out: number[] = [];
  const limit = halfRoad - bodyHalfWidth - PASS_KERB_M;
  const left = Math.min(0, span.latMin - bodyHalfWidth - PASS_SIDE_CLEAR_M);
  const right = Math.max(0, span.latMax + bodyHalfWidth + PASS_SIDE_CLEAR_M);
  if (left < 0 && Math.abs(laneLat + left) <= limit) out.push(left);
  if (right > 0 && Math.abs(laneLat + right) <= limit) out.push(right);
  return out.sort((a, b) => Math.abs(a) - Math.abs(b) || a - b);
}

/** Seconds a robotaxi setting off from standing (accelerating at `accel` to PASS_SPEED_MPS) needs to cover d metres. */
export function passTime(d: number, accel: number): number {
  const dAccel = (PASS_SPEED_MPS * PASS_SPEED_MPS) / (2 * accel);
  if (d <= dAccel) return Math.sqrt((2 * Math.max(0, d)) / accel);
  return PASS_SPEED_MPS / accel + (d - dAccel) / PASS_SPEED_MPS;
}
