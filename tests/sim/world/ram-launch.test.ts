// W-23: ramming a building on a hill never launches the car. The QA's 360 seeded rams at
// 25 m/s into buildings on ground of 15% or steeper (Russian Hill, west of Twin Peaks, Bernal
// Heights; the same seed and rule as its measurement), each car already driving (on the ground,
// rising or falling with the slope, as a car at 25 m/s is):
//  - no tick moves the car more than speed x DT + 0.5 m;
//  - the hit itself launches nothing: no flight that takes off while the car touches the
//    building or on the tick after (the collision's own effect on the car's motion) lasts more
//    than 0.3 s or rises more than 0.5 m above the ground (the QA measured 176 of 360 launched at 54ee728, up to 27 m);
//  - flights in the quarter second after a hit, which on Twin Peaks' 50% hillsides include a
//    car deflected over a brow at 23 m/s (the terrain's: W-14, W-31), stay within the residual
//    measured: none over 1 s or 3 m, and at most 8 over the gate's 0.3 s / 0.5 m. (It was 4 on
//    the world before qa/pipeline's terraces. The regenerated world accounts for 6: the previous
//    sim (9bda563, before qa/sim's surface layer) gives 6 on it. The surface layer (wheels sampling
//    along the body's tilt, roofs as surfaces) adds 2. Of the 8, 6 never rise above where they
//    left the ground, falls off a terrace's or a hillside's ledge after a glancing hit, and 2
//    leave a hill brow climbing at 24 m/s, the steepest 34%. Lower the cap when W-05/W-31 land.)
import { describe, expect, it } from "vitest";
import { boxBlocked, groundHeight, meshGroundHeight, makeCar, sampleGround, stepCar, type BuildingCollider, type CarState } from "../../../src/sim/index.ts";
import { CITY_MS, SF, moveExcess, sfWorld } from "./load.ts";

const centroid = (fp: ReadonlyArray<readonly [number, number]>): [number, number] => [fp.reduce((a, p) => a + p[0], 0) / fp.length, fp.reduce((a, p) => a + p[1], 0) / fp.length];

describe.skipIf(!SF)("ramming buildings on the hills (W-23)", () => {
  it(
    "360 seeded rams at 25 m/s: the hit launches nothing, no tick beyond speed x DT + 0.5 m",
    () => {
      const { world } = sfWorld();
      // The QA picked its buildings and starts on the lattice's bilinear ground; the flights are
      // measured over the drawn ground the car stands on.
      const H = (x: number, z: number): number => groundHeight(world, x, z);
      const M = (x: number, z: number): number => meshGroundHeight(world, x, z);
      // The QA's generator, kept bit for bit (doubles, as it ran).
      let seed = 99;
      const rnd = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
      let rams = 0;
      let contacts = 0;
      const fails: string[] = [];
      const after: string[] = [];
      for (const [area, tile] of [
        ["Russian Hill", "t-5_-2"],
        ["west of Twin Peaks", "t-10_8"],
        ["Bernal Heights", "t-4_13"],
      ] as const) {
        const bs = world.tiles.find((t) => t.tileId === tile)!.buildings.filter((b: BuildingCollider) => b.topY - b.baseY > 4);
        let n = 0;
        let tries = 0;
        while (n < 120 && tries < 5000) {
          tries++;
          const b = bs[Math.floor(rnd() * bs.length)]!;
          const [bx, bz] = centroid(b.footprint);
          const slope = Math.hypot(H(bx + 5, bz) - H(bx - 5, bz), H(bx, bz + 5) - H(bx, bz - 5)) / 10;
          if (slope < 0.15) continue;
          const a = rnd() * 2 * Math.PI;
          const sx = bx + Math.sin(a) * 30;
          const sz = bz - Math.cos(a) * 30;
          const heading = Math.atan2(bx - sx, -(bz - sz));
          if (boxBlocked(world, { x: sx, z: sz, heading, hl: 2.2, hw: 0.95 }, H(sx, sz) + 0.5)) continue;
          n++;
          rams++;
          const g0 = sampleGround(world, sx, sz, heading);
          let c: CarState = { ...makeCar(sx, sz, heading, g0.h), speed: 25, vy: 25 * g0.slopeF };
          let contactT = -1;
          let air = 0;
          let off = -1;
          let worstAir = [0, 0];
          let worstUp = [0, 0];
          let excess = -Infinity;
          for (let t = 0; t < 240; t++) {
            const p = c;
            c = stepCar(world, c, { throttle: 1, steer: 0, brake: 0, actions: 0 });
            excess = Math.max(excess, moveExcess(p, c));
            if (contactT < 0 && c.sinceContact === 0) contactT = t;
            if (contactT < 0 || t - contactT > 180) continue;
            if (c.grounded) {
              air = 0;
              continue;
            }
            // How soon after a contact this flight took off from the ground: 0 = the hit's own
            // tick or the next (the collision's effect), 1 = within a quarter second, -1 = later.
            if (air === 0) {
              const since = Math.min(p.sinceContact, c.sinceContact);
              off = !p.grounded ? -1 : since <= 1 ? 0 : since <= 15 ? 1 : -1;
            }
            air++;
            if (off < 0) continue;
            for (let k = off; k < 2; k++) {
              worstAir[k] = Math.max(worstAir[k]!, air);
              worstUp[k] = Math.max(worstUp[k]!, c.y - M(c.x, c.z));
            }
          }
          if (contactT >= 0) contacts++;
          const say = (k: number): string => `${area} ${b.id}: ${(worstAir[k]! / 60).toFixed(2)} s, ${worstUp[k]!.toFixed(2)} m up`;
          if (worstAir[0]! / 60 > 0.3 || worstUp[0]! > 0.5) fails.push(`launched by the hit: ${say(0)}`);
          if (excess > 1e-9) fails.push(`${area} ${b.id}: one tick moved ${excess.toFixed(2)} m too far`);
          if (worstAir[1]! / 60 > 0.3 || worstUp[1]! > 0.5) after.push(say(1));
          if (worstAir[1]! / 60 > 1 || worstUp[1]! > 3) fails.push(`flew too far after the hit: ${say(1)}`);
        }
      }
      expect(rams).toBe(360);
      expect(contacts).toBeGreaterThan(300);
      expect(fails, fails.slice(0, 10).join("\n")).toEqual([]);
      expect(after.length, after.join("\n")).toBeLessThanOrEqual(8);
    },
    CITY_MS,
  );
});
