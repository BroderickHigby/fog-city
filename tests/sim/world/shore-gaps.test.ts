// W-21: the gaps cut in the sea wall for roads over water are walled corridors. At every
// corridor (a bridge, a pier road, I-280 over a creek), a car driven along its road onto the
// water and then turned 30, 60 or 90 degrees either way at 10 and 25 m/s stays within 1 m of
// the corridor, and so does a sprinting walker that turns off it; no body ends more than 3 m on
// the water side of any uncut shore line.
import { describe, expect, it } from "vitest";
import { buildWalls, meshGroundHeight, inCorridor, makeCar, makeFoot, onWater, stepCar, stepFoot, wallSide, wallsNear, type CarState, type Walls } from "../../../src/sim/index.ts";
import { loadWorldFiles } from "../../helpers.ts";
import { CITY_MS, SF, bearing, resample, sfWorld } from "./load.ts";

const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** How far (x, z) is outside every corridor while on open water; 0 on land or in a corridor. */
function outside(w: Walls, x: number, z: number): number {
  if (!onWater(w.shore, x, z) || inCorridor(w, x, z)) return 0;
  let best = Infinity;
  for (const c of w.corridors) {
    const r = c.ring;
    const n = r.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = r[2 * j]!;
      const az = r[2 * j + 1]!;
      const ex = r[2 * i]! - ax;
      const ez = r[2 * i + 1]! - az;
      const l2 = ex * ex + ez * ez;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2)) : 0;
      best = Math.min(best, Math.hypot(ax + ex * t - x, az + ez * t - z));
    }
  }
  return best;
}

describe.skipIf(!SF)("road gaps in the sea wall are walled corridors (W-21)", () => {
  it(
    "a car turning off every corridor at 10 and 25 m/s, 30/60/90 degrees either way, stays within 1 m of it",
    () => {
      const { world, roads } = sfWorld();
      const w = world.walls!;
      const byId = new Map(roads.edges.map((e) => [e.id, e]));
      // Every road over water: the bridges, I-280 and its ramps over the creeks, the Embarcadero
      // and the Pier 70 road. (The pier roads, Al Scoma Way and Pier 45 and Pier 50 Vly, run on
      // the pier decks the pipeline now lays as land at deck height, W-13: no corridor.)
      const ids = new Set(w.corridors.map((c) => c.edgeId));
      for (const id of ["c182000", "c183000", "c270002", "c271000", "c197101", "c197201", "c15166000", "c19298000", "c19300000", "c19338000", "c19288000", "c19330000", "c15357000", "c12929000", "c10925000"]) expect(ids.has(id), id).toBe(true);
      let runs = 0;
      const out: string[] = [];
      for (const c of w.corridors) {
        const pts = resample(byId.get(c.edgeId)!.points, 1);
        const wet = pts.map(([x, z]) => inCorridor(w, x, z) && onWater(w.shore, x, z));
        const i0 = wet.indexOf(true);
        const i1 = wet.lastIndexOf(true);
        if (i0 < 0) continue;
        for (const dir of [1, -1]) {
          const path = dir > 0 ? pts.slice(Math.max(0, i0 - 25)) : pts.slice(0, Math.min(pts.length, i1 + 26)).reverse();
          const wetAt = dir > 0 ? i0 - Math.max(0, i0 - 25) : Math.min(pts.length, i1 + 26) - 1 - i1;
          if (path.length < 10) continue;
          for (const v of [10, 25]) {
            for (const ang of [30, 60, 90, -30, -60, -90]) {
              const look = path[Math.min(3, path.length - 1)]!;
              let car: CarState = { ...makeCar(path[0]![0], path[0]![1], bearing(look[0] - path[0]![0], look[1] - path[0]![1]), meshGroundHeight(world, path[0]![0], path[0]![1])), speed: v };
              let phase = 0;
              let h0 = 0;
              let worst = 0;
              for (let t = 0; t < 60 * 15; t++) {
                let steer: number;
                if (phase === 0) {
                  let pi = 0;
                  let pd = Infinity;
                  for (let j = 0; j < path.length; j++) {
                    const d = (path[j]![0] - car.x) ** 2 + (path[j]![1] - car.z) ** 2;
                    if (d < pd) {
                      pd = d;
                      pi = j;
                    }
                  }
                  const a = path[pi]!;
                  const b = path[Math.min(path.length - 1, pi + 2)]!;
                  steer = Math.max(-1, Math.min(1, wrap(bearing(b[0] - a[0], b[1] - a[1]) - car.heading) / 0.3));
                  if (pi >= wetAt + 8 || pi >= path.length - 3) {
                    phase = 1;
                    h0 = car.heading;
                  }
                } else {
                  if (phase === 1 && Math.abs(wrap(car.heading - h0)) >= (Math.abs(ang) * Math.PI) / 180) phase = 2;
                  steer = phase === 1 ? Math.sign(ang) : 0;
                }
                car = stepCar(world, car, { throttle: car.speed < v ? 1 : 0, steer, brake: 0, actions: 0 });
                worst = Math.max(worst, outside(w, car.x, car.z));
              }
              runs++;
              if (worst > 1) out.push(`${c.edgeId} dir ${dir} ${v} m/s ${ang} deg: ${worst.toFixed(1)} m out`);
            }
          }
        }
      }
      expect(runs).toBeGreaterThan(300);
      expect(out, out.join("\n")).toEqual([]);
    },
    CITY_MS,
  );

  it(
    "a sprinting walker that turns off every corridor stays within 1 m of it, and nobody ends 3 m past an uncut shore line",
    () => {
      const { world, roads } = sfWorld();
      const w = world.walls!;
      const files = loadWorldFiles("sf");
      // The shore as drawn, with no road cut: how far past it a body ended.
      const uncut = buildWalls(files.boundary!, null);
      const pastShore = (x: number, z: number): number => {
        let worst = 0;
        for (const k of wallsNear(uncut, x, z, 4)) {
          const s = uncut.segments[k]!;
          if (s.kind !== "shore") continue;
          const d = wallSide(s, x, z);
          if (d !== null && -d > worst && -d < 4) worst = -d;
        }
        return worst;
      };
      const byId = new Map(roads.edges.map((e) => [e.id, e]));
      let walks = 0;
      for (const c of w.corridors) {
        const pts = resample(byId.get(c.edgeId)!.points, 1);
        const i0 = pts.findIndex(([x, z]) => inCorridor(w, x, z) && onWater(w.shore, x, z));
        if (i0 < 0) continue;
        const s = pts[Math.max(0, i0 - 10)]!;
        const n = pts[Math.min(pts.length - 1, i0 + 5)]!;
        for (const turn of [1, -1]) {
          let f = makeFoot(s[0], meshGroundHeight(world, s[0], s[1]), s[1], bearing(n[0] - s[0], n[1] - s[1]));
          let worst = 0;
          for (let t = 0; t < 60 * 30; t++) {
            const steer = t > 60 * 4 && t < 60 * 4.6 ? turn : 0;
            f = stepFoot(world, f, { throttle: 1, steer, brake: 1, actions: 0 }, [], []);
            worst = Math.max(worst, outside(w, f.x, f.z));
          }
          walks++;
          expect(worst, `${c.edgeId} turn ${turn}`).toBeLessThanOrEqual(1);
          // Inside a corridor a body is over the water legitimately; elsewhere it never ends past the shore.
          if (!inCorridor(w, f.x, f.z)) expect(pastShore(f.x, f.z), `${c.edgeId} turn ${turn}`).toBeLessThanOrEqual(3);
        }
      }
      expect(walks).toBeGreaterThanOrEqual(30);
    },
    CITY_MS,
  );
});
