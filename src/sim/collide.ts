// Collision queries for bodies that move through the static world: an oriented rectangle
// (cars) and a circle (people on foot), against building footprints (any polygon, concave
// included), the world's edge and shore walls (boundary.ts) and dynamic obstacle
// circles/boxes. Pure functions; deterministic iteration.

import { WALL_DEPTH_M, circleWallDepth, wallSide, wallsNear, type WallSegment } from "./boundary.ts";
import { dcos, dsin } from "./dmath.ts";
import { closestOnBoundary, nearbyBuildings, pointInPolygon, type World } from "./world.ts";

/** A round obstacle: an agent, a walker, or a slice of another car. */
export interface Circle {
  x: number;
  z: number;
  r: number;
  /** A person (agent or player on foot): bumping one never hurts them; cars count it separately. */
  person: boolean;
}

/** An oriented rectangle: centre, compass heading, half length (along heading) and half width. */
export interface Box {
  x: number;
  z: number;
  heading: number;
  hl: number;
  hw: number;
}

export interface BoxResolve {
  x: number;
  z: number;
  hit: boolean;
  /** Unit direction of the total push (out of the obstacles); 0,0 when no hit. */
  nx: number;
  nz: number;
  /** The deepest push came from a person. */
  person: boolean;
}

const EPS = 1e-4;

/** Points on the box outline (4 corners, 8 along the sides) plus its centre, local [lateral, forward]. */
function samplePoints(hl: number, hw: number): Array<[number, number]> {
  return [
    [hw, hl],
    [-hw, hl],
    [hw, -hl],
    [-hw, -hl],
    [0, hl],
    [0, -hl],
    [hw, 0],
    [-hw, 0],
    [hw, hl / 2],
    [hw, -hl / 2],
    [-hw, hl / 2],
    [-hw, -hl / 2],
  ];
}

/**
 * Deepest penetration of an oriented box into one polygon, as the push (dx, dz) that removes it,
 * or null when they do not overlap.
 */
function boxPolygonPush(
  cx: number,
  cz: number,
  fx: number,
  fz: number,
  rx: number,
  rz: number,
  hl: number,
  hw: number,
  poly: ReadonlyArray<readonly [number, number]>,
): [number, number] | null {
  let bestD2 = 0;
  let px = 0;
  let pz = 0;
  // Box points inside the polygon: push that point to the nearest edge.
  for (const [l, f] of samplePoints(hl, hw)) {
    const x = cx + rx * l + fx * f;
    const z = cz + rz * l + fz * f;
    if (!pointInPolygon(x, z, poly)) continue;
    const c = closestOnBoundary(x, z, poly);
    if (c.d2 > bestD2) {
      bestD2 = c.d2;
      px = c.x - x;
      pz = c.z - z;
    }
  }
  // The centre deep inside: push out by the distance to the edge plus half the width.
  if (pointInPolygon(cx, cz, poly)) {
    const c = closestOnBoundary(cx, cz, poly);
    const d = Math.sqrt(c.d2);
    const push = d + hw;
    if (push * push > bestD2) {
      bestD2 = push * push;
      const ux = d > 1e-9 ? (c.x - cx) / d : rx;
      const uz = d > 1e-9 ? (c.z - cz) / d : rz;
      px = ux * push;
      pz = uz * push;
    }
  }
  // Polygon vertices inside the box: push the box off the vertex along its shallower axis.
  for (const [vx, vz] of poly) {
    const ox = vx - cx;
    const oz = vz - cz;
    const l = ox * rx + oz * rz;
    const f = ox * fx + oz * fz;
    const al = l < 0 ? -l : l;
    const af = f < 0 ? -f : f;
    if (al >= hw || af >= hl) continue;
    const penL = hw - al;
    const penF = hl - af;
    let dx: number;
    let dz: number;
    if (penL <= penF) {
      const s = l > 0 ? -penL : penL;
      dx = rx * s;
      dz = rz * s;
    } else {
      const s = f > 0 ? -penF : penF;
      dx = fx * s;
      dz = fz * s;
    }
    const d2 = dx * dx + dz * dz;
    if (d2 > bestD2) {
      bestD2 = d2;
      px = dx;
      pz = dz;
    }
  }
  if (bestD2 <= 0) return null;
  const d = Math.sqrt(bestD2);
  return [px + (px / d) * EPS, pz + (pz / d) * EPS];
}

/**
 * Push that moves an oriented box back onto the land side of one wall (boundary.ts), or null.
 * The deepest box sample point behind the wall line (within the wall's reach along it, and no
 * deeper than WALL_DEPTH_M) sets the push, along the wall's land normal. A wall end inside the
 * box (at a gap cut for a road) pushes the box off it along the box's shallower axis.
 */
function boxWallPush(
  cx: number,
  cz: number,
  fx: number,
  fz: number,
  rx: number,
  rz: number,
  hl: number,
  hw: number,
  w: Readonly<WallSegment>,
): [number, number] | null {
  let worst = 0;
  for (const [l, f] of samplePoints(hl, hw)) {
    const d = wallSide(w, cx + rx * l + fx * f, cz + rz * l + fz * f);
    if (d !== null && d < worst && d > -WALL_DEPTH_M) worst = d;
  }
  let px = 0;
  let pz = 0;
  let best = 0;
  if (worst < 0) {
    px = -worst * w.nx;
    pz = -worst * w.nz;
    best = worst * worst;
  }
  for (const [vx, vz] of [
    [w.ax, w.az],
    [w.bx, w.bz],
  ] as const) {
    const ox = vx - cx;
    const oz = vz - cz;
    const l = ox * rx + oz * rz;
    const f = ox * fx + oz * fz;
    const al = l < 0 ? -l : l;
    const af = f < 0 ? -f : f;
    if (al >= hw || af >= hl) continue;
    const penL = hw - al;
    const penF = hl - af;
    let dx: number;
    let dz: number;
    if (penL <= penF) {
      const k = l > 0 ? -penL : penL;
      dx = rx * k;
      dz = rz * k;
    } else {
      const k = f > 0 ? -penF : penF;
      dx = fx * k;
      dz = fz * k;
    }
    const d2 = dx * dx + dz * dz;
    if (d2 > best) {
      best = d2;
      px = dx;
      pz = dz;
    }
  }
  if (best <= 0) return null;
  const d = Math.sqrt(best);
  return [px + (px / d) * EPS, pz + (pz / d) * EPS];
}

/** Push that separates an oriented box from a circle, or null. */
function boxCirclePush(
  cx: number,
  cz: number,
  fx: number,
  fz: number,
  rx: number,
  rz: number,
  hl: number,
  hw: number,
  c: Circle,
): [number, number] | null {
  const ox = c.x - cx;
  const oz = c.z - cz;
  const l = ox * rx + oz * rz;
  const f = ox * fx + oz * fz;
  const ql = l < -hw ? -hw : l > hw ? hw : l;
  const qf = f < -hl ? -hl : f > hl ? hl : f;
  const dl = l - ql;
  const df = f - qf;
  const d2 = dl * dl + df * df;
  if (d2 > 0) {
    if (d2 >= c.r * c.r) return null;
    const d = Math.sqrt(d2);
    const pen = c.r - d + EPS;
    // Move the box away from the circle centre.
    const ul = -dl / d;
    const uf = -df / d;
    return [(rx * ul + fx * uf) * pen, (rz * ul + fz * uf) * pen];
  }
  // Circle centre inside the box: leave along the shallower axis.
  const penL = hw - (l < 0 ? -l : l) + c.r;
  const penF = hl - (f < 0 ? -f : f) + c.r;
  if (penL <= penF) {
    const s = l > 0 ? -penL : penL;
    return [rx * s, rz * s];
  }
  const s = f > 0 ? -penF : penF;
  return [fx * s, fz * s];
}

/**
 * Push an oriented box out of every building it overlaps below `y` (roof height check) and
 * out of every obstacle circle. Up to four passes, deepest overlap first.
 */
export function resolveBox(
  world: World,
  box: Readonly<Box>,
  y: number,
  circles: readonly Circle[] = [],
): BoxResolve {
  const fx = dsin(box.heading);
  const fz = -dcos(box.heading);
  const rx = -fz;
  const rz = fx;
  let x = box.x;
  let z = box.z;
  let tx = 0;
  let tz = 0;
  let hit = false;
  let person = false;
  let bestPersonDepth = 0;
  let bestOtherDepth = 0;
  const reach = box.hl + box.hw + 1;
  for (let pass = 0; pass < 4; pass++) {
    let best: [number, number] | null = null;
    let bestD2 = 0;
    let bestIsPerson = false;
    for (const b of nearbyBuildings(world, x, z, reach)) {
      if (y >= b.topY || b.topY <= b.baseY) continue;
      const p = boxPolygonPush(x, z, fx, fz, rx, rz, box.hl, box.hw, b.footprint);
      if (!p) continue;
      const d2 = p[0] * p[0] + p[1] * p[1];
      if (d2 > bestD2) {
        bestD2 = d2;
        best = p;
        bestIsPerson = false;
      }
    }
    if (world.walls) {
      for (const k of wallsNear(world.walls, x, z, reach)) {
        const p = boxWallPush(x, z, fx, fz, rx, rz, box.hl, box.hw, world.walls.segments[k]!);
        if (!p) continue;
        const d2 = p[0] * p[0] + p[1] * p[1];
        if (d2 > bestD2) {
          bestD2 = d2;
          best = p;
          bestIsPerson = false;
        }
      }
    }
    for (const c of circles) {
      const dx = c.x - x;
      const dz = c.z - z;
      const lim = reach + c.r;
      if (dx * dx + dz * dz > lim * lim) continue;
      const p = boxCirclePush(x, z, fx, fz, rx, rz, box.hl, box.hw, c);
      if (!p) continue;
      const d2 = p[0] * p[0] + p[1] * p[1];
      if (d2 > bestD2) {
        bestD2 = d2;
        best = p;
        bestIsPerson = c.person;
      }
    }
    if (!best) break;
    x += best[0];
    z += best[1];
    tx += best[0];
    tz += best[1];
    hit = true;
    if (bestIsPerson) bestPersonDepth = Math.max(bestPersonDepth, bestD2);
    else bestOtherDepth = Math.max(bestOtherDepth, bestD2);
  }
  person = hit && bestPersonDepth > bestOtherDepth;
  const tl = Math.sqrt(tx * tx + tz * tz);
  return { x, z, hit, nx: tl > 1e-12 ? tx / tl : 0, nz: tl > 1e-12 ? tz / tl : 0, person };
}

/** Does an oriented box overlap any building (below y) or circle? */
export function boxBlocked(world: World, box: Readonly<Box>, y: number, circles: readonly Circle[] = []): boolean {
  const fx = dsin(box.heading);
  const fz = -dcos(box.heading);
  const rx = -fz;
  const rz = fx;
  for (const b of nearbyBuildings(world, box.x, box.z, box.hl + box.hw + 1)) {
    if (y >= b.topY || b.topY <= b.baseY) continue;
    if (boxPolygonPush(box.x, box.z, fx, fz, rx, rz, box.hl, box.hw, b.footprint)) return true;
  }
  if (world.walls) {
    for (const k of wallsNear(world.walls, box.x, box.z, box.hl + box.hw + 1)) {
      if (boxWallPush(box.x, box.z, fx, fz, rx, rz, box.hl, box.hw, world.walls.segments[k]!)) return true;
    }
  }
  for (const c of circles) if (boxCirclePush(box.x, box.z, fx, fz, rx, rz, box.hl, box.hw, c)) return true;
  return false;
}

/** Push a circle out of an oriented box, or null when apart. */
function circleBoxPush(x: number, z: number, r: number, b: Readonly<Box>): [number, number] | null {
  const fx = dsin(b.heading);
  const fz = -dcos(b.heading);
  const rx = -fz;
  const rz = fx;
  const p = boxCirclePush(b.x, b.z, fx, fz, rx, rz, b.hl, b.hw, { x, z, r, person: false });
  // p moves the box away from the circle; the circle moves the opposite way.
  return p ? [-p[0], -p[1]] : null;
}

/**
 * Push a circle (a walker) out of buildings, boxes (cars) and other circles. Up to four passes.
 * Returns the corrected position and whether anything was touched.
 */
export function resolveCircleAll(
  world: World,
  x: number,
  z: number,
  r: number,
  boxes: ReadonlyArray<Readonly<Box>>,
  circles: readonly Circle[],
): { x: number; z: number; hit: boolean } {
  let hit = false;
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (const b of nearbyBuildings(world, x, z, r + 1)) {
      if (b.topY <= b.baseY) continue;
      const inside = pointInPolygon(x, z, b.footprint);
      const c = closestOnBoundary(x, z, b.footprint);
      if (!inside && c.d2 >= r * r) continue;
      const d = Math.sqrt(c.d2);
      // Outward unit normal at the closest boundary point: inside, from us through the wall;
      // outside, from the wall to us.
      let ux = d > 1e-9 ? (inside ? c.x - x : x - c.x) / d : 1;
      let uz = d > 1e-9 ? (inside ? c.z - z : z - c.z) / d : 0;
      if (d <= 1e-9) {
        ux = 1;
        uz = 0;
      }
      x = c.x + ux * (r + EPS);
      z = c.z + uz * (r + EPS);
      hit = true;
      moved = true;
    }
    if (world.walls) {
      for (const k of wallsNear(world.walls, x, z, r + 1)) {
        const w = world.walls.segments[k]!;
        const depth = circleWallDepth(w, x, z, r);
        if (depth > 0) {
          x += w.nx * (depth + EPS);
          z += w.nz * (depth + EPS);
          hit = true;
          moved = true;
          continue;
        }
        // Round a wall's free end (a gap cut for a road): keep r from the end point.
        for (const [ex, ez] of [
          [w.ax, w.az],
          [w.bx, w.bz],
        ] as const) {
          const dx = x - ex;
          const dz = z - ez;
          const d2 = dx * dx + dz * dz;
          if (d2 >= r * r || wallSide(w, x, z) !== null) continue;
          const d = Math.sqrt(d2);
          const ux = d > 1e-9 ? dx / d : w.nx;
          const uz = d > 1e-9 ? dz / d : w.nz;
          x = ex + ux * (r + EPS);
          z = ez + uz * (r + EPS);
          hit = true;
          moved = true;
        }
      }
    }
    for (const b of boxes) {
      const dx = b.x - x;
      const dz = b.z - z;
      const lim = b.hl + b.hw + r;
      if (dx * dx + dz * dz > lim * lim) continue;
      const p = circleBoxPush(x, z, r, b);
      if (!p) continue;
      x += p[0];
      z += p[1];
      hit = true;
      moved = true;
    }
    for (const c of circles) {
      const dx = x - c.x;
      const dz = z - c.z;
      const lim = r + c.r;
      const d2 = dx * dx + dz * dz;
      if (d2 >= lim * lim) continue;
      const d = Math.sqrt(d2);
      const ux = d > 1e-9 ? dx / d : 1;
      const uz = d > 1e-9 ? dz / d : 0;
      x = c.x + ux * (lim + EPS);
      z = c.z + uz * (lim + EPS);
      hit = true;
      moved = true;
    }
    if (!moved) break;
  }
  return { x, z, hit };
}
