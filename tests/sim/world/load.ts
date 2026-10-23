// The sf world as the game boots it (collider pack, roads.json, boundary.json through
// buildWorld), built once per test file, and the drivers the world-continuity tests share: a
// road follower around stepCar (the QA critic's Stanley controller) and seeded randomness.
// Sim-World's own copy for tests/sim/world/: the gate's helpers live in tests/helpers/.

import { buildWorld, meshGroundHeight, stepCar, makeCar, type CarState, type RoadsFile, type SimInput, type World } from "../../../src/sim/index.ts";
import { loadWorldFiles, readJson, worldExists } from "../../helpers.ts";

export const SF = worldExists("sf");

/** Timeout for a test that builds the whole city and drives in it. */
export const CITY_MS = 240_000;

let cached: { world: World; roads: RoadsFile } | null = null;

/** The sf world with roads and walls (built on first use, then shared by the file's tests). */
export function sfWorld(): { world: World; roads: RoadsFile } {
  if (!cached) {
    const files = loadWorldFiles("sf");
    const roads = files.roads as unknown as RoadsFile;
    cached = { world: buildWorld(files.tiles, roads, files.boundary), roads };
  }
  return cached;
}

/** A fixture beside these tests (tests/sim/world/fixtures/). */
export function fixture<T>(name: string): T {
  return readJson<T>(`tests/sim/world/fixtures/${name}`);
}

/** Deterministic uniform [0, 1) from a seed (an LCG; test-side only). */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A polyline resampled every `step` metres (both ends kept). */
export function resample(points: ReadonlyArray<readonly number[]>, step = 1): Array<[number, number]> {
  const out: Array<[number, number]> = [[points[0]![0]!, points[0]![1]!]];
  for (let i = 1; i < points.length; i++) {
    const ax = points[i - 1]![0]!;
    const az = points[i - 1]![1]!;
    const bx = points[i]![0]!;
    const bz = points[i]![1]!;
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
  }
  return out;
}

/** Compass bearing of the direction (dx, dz). */
export const bearing = (dx: number, dz: number): number => Math.atan2(dx, -dz);
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** How far a tick moved the car beyond what its speed allows: |move| - (speed * DT + 0.5 m); <= 0 is within the bound. */
export function moveExcess(prev: Readonly<CarState>, next: Readonly<CarState>): number {
  const d = Math.hypot(next.x - prev.x, next.z - prev.z);
  const v = Math.max(Math.abs(prev.speed), Math.hypot(next.speed, next.lateral));
  return d - (v / 60 + 0.5);
}

export interface Drive {
  reached: boolean;
  /** Metres along the path reached. */
  progressM: number;
  lenM: number;
  /** Ticks with any wall, building or body contact. */
  contactTicks: number;
  /** Building and wall hits (impact events) on the way. */
  hits: number;
  /** Longest airborne run, seconds. */
  maxAirS: number;
  maxMoveExcess: number;
  end: CarState;
}

/**
 * Drive a car along a path ([x, z] every metre) at up to vmax with the QA critic's Stanley
 * controller around stepCar. Stuck (throttle held under 0.5 m/s for 2 s) ends the run.
 */
export function drivePath(
  world: World,
  path: ReadonlyArray<readonly [number, number]>,
  vmax: number,
  startSpeed = Math.min(vmax, 8),
  onTick?: (c: CarState) => void,
  startY = meshGroundHeight(world, path[0]![0], path[0]![1]),
): Drive {
  const look = path[Math.min(3, path.length - 1)]!;
  let car: CarState = { ...makeCar(path[0]![0], path[0]![1], bearing(look[0] - path[0]![0], look[1] - path[0]![1]), startY), speed: startSpeed };
  const len = path.length - 1;
  const limit = Math.ceil((len / Math.max(3, vmax * 0.5)) * 60) + 600;
  let idx = 0;
  let stuck = 0;
  let air = 0;
  let maxAir = 0;
  let contact = 0;
  let excess = -Infinity;
  let reached = false;
  for (let t = 0; t < limit; t++) {
    let bi = idx;
    let bd = Infinity;
    for (let j = idx; j < Math.min(path.length, idx + 40); j++) {
      const d = (path[j]![0] - car.x) ** 2 + (path[j]![1] - car.z) ** 2;
      if (d < bd) {
        bd = d;
        bi = j;
      }
    }
    idx = bi;
    if (idx >= len - 2) {
      reached = true;
      break;
    }
    const a = path[idx]!;
    const b = path[Math.min(len, idx + 2)]!;
    const ph = bearing(b[0] - a[0], b[1] - a[1]);
    const cte = (car.x - a[0]) * Math.cos(ph) + (car.z - a[1]) * Math.sin(ph);
    const v = Math.max(0, car.speed);
    const delta = wrap(ph - car.heading) - Math.atan2(1.2 * cte, v + 1.5);
    const lim = 0.6 / (1 + v / 11);
    let maxTurn = 0;
    const j2 = Math.min(len, idx + 25);
    for (let j = idx; j + 4 <= j2; j += 3) {
      const h1 = bearing(path[j + 1]![0] - path[j]![0], path[j + 1]![1] - path[j]![1]);
      const h2 = bearing(path[j + 4]![0] - path[j + 3]![0], path[j + 4]![1] - path[j + 3]![1]);
      maxTurn = Math.max(maxTurn, Math.abs(wrap(h2 - h1)) / 3);
    }
    const vt = Math.min(vmax, Math.sqrt(4 / Math.max(maxTurn, 1e-4)));
    const input: SimInput = { throttle: Math.max(-1, Math.min(1, (vt - car.speed) * 0.6)), steer: Math.max(-1, Math.min(1, delta / lim)), brake: 0, actions: 0 };
    if (input.throttle < 0 && car.speed > 0) {
      input.brake = Math.min(1, -input.throttle);
      input.throttle = 0;
    }
    const prev = car;
    car = stepCar(world, car, input);
    onTick?.(car);
    excess = Math.max(excess, moveExcess(prev, car));
    if (car.sinceContact === 0) contact++;
    if (!car.grounded) {
      air++;
      maxAir = Math.max(maxAir, air);
    } else air = 0;
    if (input.throttle > 0.5 && Math.abs(car.speed) < 0.5) {
      if (++stuck >= 120) break;
    } else stuck = 0;
  }
  return { reached, progressM: idx, lenM: len, contactTicks: contact, hits: car.hits, maxAirS: maxAir / 60, maxMoveExcess: excess, end: car };
}
