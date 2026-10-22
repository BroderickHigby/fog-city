// W-51: a car placed overlapping a footprint (a respawn, a teleport, a mission placement, a join
// offset) never launches. At each of the QA's 58 street starts whose start pose overlapped a
// footprint (on the world before W-01 cleared the streets), at each of them moved 1 m into its
// nearest building, and at the QA's three worst sites, a car placed there and driven on for 10 s rises
// less than 0.5 m above the ground (on it, or in any flight that starts within a second of a
// contact) and never moves more than speed x DT + 0.5 m in a tick; a spawn or a
// join asked there is moved to a clear spot first, and the 8 multiplayer slots at the sf spawn
// are clear as asked.
import { describe, expect, it } from "vitest";
import {
  CAR,
  ROOF_STEP_M,
  blocksBand,
  boxBlocked,
  carBox,
  closestOnBoundary,
  nearbyBuildings,
  createInitialState,
  meshGroundHeight,
  makeCar,
  sampleGround,
  segmentCrossesWall,
  step,
  stepCar,
  surfaceHeight,
  type CarState,
  type World,
} from "../../../src/sim/index.ts";
import { loadWorldFiles } from "../../helpers.ts";
import { CITY_MS, SF, bearing, fixture, moveExcess, resample, sfWorld } from "./load.ts";

/**
 * Place a car and drive it straight on for 10 s at about v: the highest it sits above the
 * surface under it (the ground, a deck, a roof) on the ground, or rises above where it took off
 * in a flight that took off within a second of touching something (the placement's
 * overlap; a flight off a crest farther down the street, long after any contact, is the
 * terrain's: W-14), and the largest per-tick move beyond speed x DT + 0.5 m.
 */
function placed(world: World, x: number, z: number, heading: number, v: number): { rise: number; excess: number; end: CarState } {
  let car: CarState = { ...makeCar(x, z, heading, sampleGround(world, x, z, heading).h), speed: v };
  let rise = 0;
  let excess = -Infinity;
  let fromContact = false;
  let takeoff = 0;
  for (let t = 0; t < 600; t++) {
    const p = car;
    car = stepCar(world, car, { throttle: car.speed < v ? 1 : 0, steer: 0, brake: 0, actions: 0 });
    excess = Math.max(excess, moveExcess(p, car));
    if (car.grounded) {
      rise = Math.max(rise, car.y - surfaceHeight(world, car.x, car.z, car.y));
      continue;
    }
    if (p.grounded) {
      fromContact = Math.min(p.sinceContact, car.sinceContact) < 60;
      takeoff = p.y;
    }
    // In the air the rise is how far it went up from where it left the ground (a car falling
    // off a steep street's crest after brushing a wall rises nothing).
    if (fromContact) rise = Math.max(rise, car.y - takeoff);
  }
  return { rise, excess, end: car };
}

describe.skipIf(!SF)("cars placed overlapping a footprint (W-51)", () => {
  /** The 58 start poses: [x, z, heading] at the start of each edge in its direction. */
  function starts(): Array<{ id: string; x: number; z: number; heading: number }> {
    const { roads } = sfWorld();
    const byId = new Map(roads.edges.map((e) => [e.id, e]));
    return fixture<{ starts: Array<[string, number]> }>("start-blocked.json").starts.map(([id, dir]) => {
      let pts = resample(byId.get(id)!.points, 1);
      if (dir < 0) pts = pts.reverse();
      const look = pts[Math.min(3, pts.length - 1)]!;
      return { id: `${id} (${dir > 0 ? "+" : "-"})`, x: pts[0]![0], z: pts[0]![1], heading: bearing(look[0] - pts[0]![0], look[1] - pts[0]![1]) };
    });
  }

  it(
    "placed at the 58 start-blocked street starts and the QA's worst sites: rises under 0.5 m, never moves beyond speed x DT + 0.5 m",
    () => {
      const { world } = sfWorld();
      const all = starts();
      expect(all).toHaveLength(58);
      // Since the pipeline cleared the carriageways of footprints (W-01) only a few of them still
      // overlap one, so each start is also placed overlapping the nearest building within 25 m:
      // its centre 1 m inside that building's nearest wall, facing as the street does.
      const overlapping = all.flatMap((q) => {
        const y = meshGroundHeight(world, q.x, q.z);
        let best: { x: number; z: number; d2: number } | null = null;
        for (const b of nearbyBuildings(world, q.x, q.z, 25)) {
          if (!blocksBand(b, y + ROOF_STEP_M, y + CAR.bodyHeight)) continue;
          const c = closestOnBoundary(q.x, q.z, b.footprint);
          if (c.d2 > 625 || (best && c.d2 >= best.d2)) continue;
          const d = Math.sqrt(c.d2);
          if (d < 1e-6) continue;
          best = { x: c.x + ((c.x - q.x) / d) * 1, z: c.z + ((c.z - q.z) / d) * 1, d2: c.d2 };
        }
        return best ? [{ id: `${q.id} into its nearest building`, x: best.x, z: best.z, heading: q.heading }] : [];
      });
      const blocked = [...all, ...overlapping].filter((q) => boxBlocked(world, carBox(q), meshGroundHeight(world, q.x, q.z) + ROOF_STEP_M));
      expect(blocked.length).toBeGreaterThan(40);
      for (const s of [...all, ...overlapping]) {
        const r = placed(world, s.x, s.z, s.heading, 8);
        expect(r.rise, s.id).toBeLessThan(0.5);
        expect(r.excess, s.id).toBeLessThanOrEqual(1e-9);
      }
      // The QA's worst: Congdon St (178 m up at 54ee728), Market St at Octavia (144 m), Octavia St.
      for (const [name, x, z, heading] of [
        ["Congdon St", -2831.0, 7020.6, -2.8061863148802146],
        ["Market St", -2678.9, 2651.0, 1.1285167918209196],
        ["Octavia St", -2665.1, 2571.5, 2.3561944901923626],
      ] as const) {
        const r = placed(world, x, z, heading, 15);
        expect(r.rise, name).toBeLessThan(0.5);
        expect(r.excess, name).toBeLessThanOrEqual(1e-9);
      }
    },
    CITY_MS,
  );

  it(
    "a join asked at a blocked start spawns at a clear spot near it, on the same side of every wall",
    () => {
      const { world } = sfWorld();
      let s = createInitialState(world, 7, ["host"], loadWorldFiles("sf").manifest.spawn);
      const ask = starts().filter((q) => boxBlocked(world, carBox(q), meshGroundHeight(world, q.x, q.z) + ROOF_STEP_M)).slice(0, 12);
      for (const [i, q] of ask.entries()) {
        s = step(world, s, {}, [{ tick: s.tick + 1, kind: "player.join", playerId: `j${i}`, payload: { x: q.x, z: q.z, heading: q.heading } }]);
        const c = s.players[`j${i}`]!.car;
        expect(boxBlocked(world, carBox(c), c.y + ROOF_STEP_M, [], c.y + CAR.bodyHeight), q.id).toBe(false);
        expect(Math.hypot(c.x - q.x, c.z - q.z), q.id).toBeLessThanOrEqual(30);
        expect(segmentCrossesWall(world.walls, q.x, q.z, c.x, c.z), q.id).toBe(false);
      }
    },
    CITY_MS,
  );

  it(
    "the 8 multiplayer slots at the sf spawn are clear and spawn exactly where asked",
    () => {
      const { world } = sfWorld();
      const spawn = loadWorldFiles("sf").manifest.spawn;
      const ids = ["p0", "p1", "p2", "p3", "p4", "p5", "p6", "p7"];
      const s = createInitialState(world, 3, ids, spawn);
      ids.forEach((id, n) => {
        const c = s.players[id]!.car;
        expect(c.x, id).toBe(spawn.x + n * 4);
        expect(c.z, id).toBe(spawn.z);
        expect(boxBlocked(world, carBox(c), c.y + ROOF_STEP_M)).toBe(false);
      });
    },
    CITY_MS,
  );
});
