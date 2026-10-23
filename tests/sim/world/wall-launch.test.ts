// W-06: the water side of a shore wall never launches a car. A car that starts on the water
// side of the shore (inside a wall's reach, or a little farther out) and drives at the wall at
// 5, 15 and 30 m/s stays within 1 m of the surface under it (the ground, or a bridge's deck) and never moves more than speed x DT + 0.5 m
// in a tick. (A flight that takes off before the car has touched anything is the terrain's: at
// one Outer Richmond spot the beach rises 1:3 to a crest on the shore line, and a car at 30 m/s
// leaves it before it reaches the wall, as off any crest; W-35.) The per-PR sample is 200 places
// spread evenly over every shore wall plus the QA's worst sites (Lands End, the Marina, the
// Outer Richmond, Bayview) and the 4th St bridge replay; the nightly sweep runs every 50 m.
import { describe, expect, it } from "vitest";
import { CAR, circleBlocked, circleHitsWall, meshGroundHeight, inCorridor, makeCar, onWater, stepCar, surfaceHeight, wallsNear, type CarState, type WallSegment, type World } from "../../../src/sim/index.ts";
import { toLocal } from "../../../src/geo/project.ts";
import { CITY_MS, SF, bearing, moveExcess, sfWorld } from "./load.ts";

interface Approach {
  at: string;
  /** Peak of car y over the ground at its centre. */
  peak: number;
  excess: number;
}

function approach(world: World, w: Readonly<WallSegment>, px: number, pz: number, back: number, v: number, at: string): Approach | null {
  const sx = px - w.nx * back;
  const sz = pz - w.nz * back;
  // (Not from a place the car's body already straddles a wall at: where two walls meet, a lake's
  // ring and the county line, a start 2.5 m off one can lie across the other.)
  if (circleBlocked(world, sx, sz, 3) || circleHitsWall(world.walls, sx, sz, CAR.halfLength)) return null;
  let car: CarState = { ...makeCar(sx, sz, bearing(w.nx, w.nz), meshGroundHeight(world, sx, sz)), speed: v };
  let peak = 0;
  let excess = -Infinity;
  let touched = false;
  let terrainFlight = false;
  for (let t = 0; t < 240; t++) {
    const p = car;
    car = stepCar(world, car, { throttle: v / 30, steer: 0, brake: 0, actions: 0 });
    excess = Math.max(excess, moveExcess(p, car));
    if (car.sinceContact === 0) touched = true;
    // A flight that took off before any contact is a crest's, followed to its landing.
    if (!car.grounded && p.grounded) terrainFlight = !touched;
    if (car.grounded) terrainFlight = false;
    if (!terrainFlight) peak = Math.max(peak, car.y - surfaceHeight(world, car.x, car.z, car.y));
  }
  return { at, peak, excess };
}

/** The shore wall nearest (lat, lon), and the point on it. */
function wallAt(world: World, lat: number, lon: number): { w: WallSegment; x: number; z: number } {
  const p = toLocal(lat, lon);
  let best: { w: WallSegment; x: number; z: number; d: number } | null = null;
  for (const k of wallsNear(world.walls!, p.x, p.z, 60)) {
    const w = world.walls!.segments[k]!;
    if (w.kind !== "shore") continue;
    const t = Math.max(0, Math.min(w.len, (p.x - w.ax) * w.ux + (p.z - w.az) * w.uz));
    const x = w.ax + w.ux * t;
    const z = w.az + w.uz * t;
    const d = Math.hypot(p.x - x, p.z - z);
    if (!best || d < best.d) best = { w, x, z, d };
  }
  return best!;
}

describe.skipIf(!SF)("shore walls never launch a car from the water side (W-06)", () => {
  it(
    "200 places along the shore and the QA's worst sites: at most 1 m above the ground, no tick beyond speed x DT + 0.5 m",
    () => {
      const { world } = sfWorld();
      const shore = world.walls!.segments.filter((s) => s.kind === "shore");
      const total = shore.reduce((a, s) => a + s.len, 0);
      const places: Array<{ w: WallSegment; x: number; z: number; at: string }> = [];
      // 200 places evenly spaced along the whole shore line.
      let next = total / 400;
      let acc = 0;
      for (const w of shore) {
        while (next < acc + w.len && places.length < 200) {
          const s = next - acc;
          places.push({ w, x: w.ax + w.ux * s, z: w.az + w.uz * s, at: `shore ${Math.round(next)} m` });
          next += total / 200;
        }
        acc += w.len;
      }
      for (const [name, lat, lon] of [
        ["Lands End", 37.78786, -122.50605],
        ["Lands End (worst at 544f67c)", 37.78816, -122.50574],
        ["Marina", 37.80735, -122.43067],
        ["Outer Richmond", 37.78425, -122.51172],
        ["Bayview", 37.75221, -122.37641],
      ] as const) {
        const q = wallAt(world, lat, lon);
        places.push({ ...q, at: name });
      }
      let tests = 0;
      for (const q of places) {
        for (const back of [2.5, 6]) {
          for (const v of [5, 15, 30]) {
            const r = approach(world, q.w, q.x, q.z, back, v, q.at);
            if (!r) continue;
            tests++;
            expect(r.peak, `${r.at}, ${back} m out, ${v} m/s`).toBeLessThanOrEqual(1);
            expect(r.excess, `${r.at}, ${back} m out, ${v} m/s`).toBeLessThanOrEqual(1e-9);
          }
        }
      }
      expect(tests).toBeGreaterThan(1000);
    },
    CITY_MS,
  );

  it(
    "the 4th St bridge replay: a car at 30 m/s from dry land through the gap stays on the ground",
    () => {
      const { world } = sfWorld();
      for (const ang of [-30, -60, 30]) {
        const q = wallAt(world, 37.77483, -122.39233);
        const sx = q.x + q.w.nx * 12;
        const sz = q.z + q.w.nz * 12;
        const a = (ang * Math.PI) / 180;
        const dx = -q.w.nx * Math.cos(a) + q.w.ux * Math.sin(a);
        const dz = -q.w.nz * Math.cos(a) + q.w.uz * Math.sin(a);
        let car: CarState = { ...makeCar(sx, sz, bearing(dx, dz), meshGroundHeight(world, sx, sz)), speed: 30 };
        let touched = false;
        let terrainFlight = false;
        for (let t = 0; t < 300; t++) {
          const p = car;
          car = stepCar(world, car, { throttle: 1, steer: 0, brake: 0, actions: 0 });
          expect(moveExcess(p, car), `${ang} deg, tick ${t}`).toBeLessThanOrEqual(1e-9);
          // (Off the bank into the bridge's dip to the water before touching anything: the
          // terrain's flight, W-12. At 54ee728 this replay went 126 m up off the wall.)
          if (car.sinceContact === 0) touched = true;
          if (!car.grounded && p.grounded) terrainFlight = !touched;
          if (car.grounded) terrainFlight = false;
          if (!terrainFlight) expect(car.y - surfaceHeight(world, car.x, car.z, car.y), `${ang} deg, tick ${t}`).toBeLessThanOrEqual(1);
        }
        // Through the gap it is on the bridge's corridor at most, never on the open creek.
        expect(onWater(world.walls!.shore, car.x, car.z) && !inCorridor(world.walls!, car.x, car.z), `${ang} deg`).toBe(false);
      }
    },
    CITY_MS,
  );
});
