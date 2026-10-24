// Walking round a stopped vehicle (v10 city life). A walker whose sidewalk route runs into a
// vehicle that is standing still (a player's car parked across the crosswalk or up on the kerb,
// a stopped robotaxi or van) walks round its nearer bumper to the first point of its own route
// clear beyond it, instead of standing at the bumper. Moving vehicles are the dodge's business
// (src/sim/dodge.ts), never this module's.
//
// Pure geometry: the runtime (runtime.ts) supplies the route samples and the vehicle boxes.

import { dcos, dsin } from "../dmath.ts";

/** An oriented vehicle box: centre, compass heading, half length and half width. */
export interface DetourBox { x: number; z: number; heading: number; hl: number; hw: number }

/** A walker keeps this far from a stopped vehicle's body while walking round it, metres (beyond its radius). */
export const DETOUR_CLEAR_M = 0.35;
/** How far along its route a walker looks for a stopped vehicle in its way, metres. */
export const DETOUR_LOOK_M = 3;
/** How far along its route it looks for the first clear point beyond one, metres. */
export const DETOUR_REJOIN_M = 14;
/** A detour still unfinished after this many ticks is dropped (the walker carries on as before). */
export const DETOUR_TICKS = 20 * 60;

/** Distance from a point to a box (0 inside). */
export function boxGap(px: number, pz: number, b: Readonly<DetourBox>): number {
  const fx = dsin(b.heading), fz = -dcos(b.heading);
  const ox = px - b.x, oz = pz - b.z;
  const along = ox * fx + oz * fz, lat = -ox * fz + oz * fx;
  const el = Math.max(0, Math.abs(lat) - b.hw), ef = Math.max(0, Math.abs(along) - b.hl);
  return Math.sqrt(el * el + ef * ef);
}

/** Does the segment a -> b pass within `clear` of the box? (Sampled every 0.1 m.) */
export function segmentNearBox(ax: number, az: number, bx: number, bz: number, b: Readonly<DetourBox>, clear: number): boolean {
  const dx = bx - ax, dz = bz - az, l = Math.sqrt(dx * dx + dz * dz);
  const n = Math.max(1, Math.ceil(l / 0.1));
  for (let i = 0; i <= n; i++) if (boxGap(ax + (dx * i) / n, az + (dz * i) / n, b) < clear) return true;
  return false;
}

/** The four corners of the box grown by `grow`, in order round it. */
function grownCorners(b: Readonly<DetourBox>, grow: number): Array<{ x: number; z: number }> {
  const fx = dsin(b.heading), fz = -dcos(b.heading), sx = -fz, sz = fx;
  const hl = b.hl + grow, hw = b.hw + grow;
  return ([[1, 1], [1, -1], [-1, -1], [-1, 1]] as const).map(([i, j]) => ({ x: b.x + fx * hl * i + sx * hw * j, z: b.z + fz * hl * i + sz * hw * j }));
}

/**
 * The next point a walker at `from` (radius r) heads for to get round box `b` to `to`: `to`
 * itself when the straight line keeps clear, else the first corner of the shortest way round the
 * grown box (one corner, or two adjacent ones) whose legs keep clear and that `walkable` accepts.
 * Null when no way round is walkable.
 */
export function detourWaypoint(from: { x: number; z: number }, to: { x: number; z: number }, b: Readonly<DetourBox>, r: number,
  walkable: (ax: number, az: number, bx: number, bz: number) => boolean): { x: number; z: number } | null {
  const clear = r + DETOUR_CLEAR_M;
  if (!segmentNearBox(from.x, from.z, to.x, to.z, b, clear - 0.02)) return walkable(from.x, from.z, to.x, to.z) ? to : null;
  const corners = grownCorners(b, clear + 0.05);
  const leg = (p: { x: number; z: number }, q: { x: number; z: number }): number => {
    if (segmentNearBox(p.x, p.z, q.x, q.z, b, clear - 0.02) || !walkable(p.x, p.z, q.x, q.z)) return Infinity;
    return Math.sqrt((q.x - p.x) * (q.x - p.x) + (q.z - p.z) * (q.z - p.z));
  };
  let best: { x: number; z: number } | null = null, cost = Infinity;
  corners.forEach((c, i) => {
    const first = leg(from, c);
    if (first === Infinity) return;
    const direct = first + leg(c, to);
    if (direct < cost) { cost = direct; best = c; }
    for (const j of [(i + 1) % 4, (i + 3) % 4]) {
      const via = first + leg(c, corners[j]!) + leg(corners[j]!, to);
      if (via < cost) { cost = via; best = c; }
    }
  });
  return best;
}
