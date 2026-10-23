// Stairway barriers never stand in a street's carriageway (world QA W-33 with W-01): the ring of
// walls round a stairway is cut back to the kerb of every street meeting it, and a bollard line
// along that kerb closes the stairway's mouth. Before (8abc772) a stairway leaving a street at a
// shallow angle kept its bollard line and its sides inside the street: the Twin Peaks Blvd paper
// stairway c12766000, 15 to 20 degrees off the drive for 20 m, walled the drive's carriageway and
// held the gate's "Market St, Castro, Twin Peaks summit" route at 37.75756,-122.44789.
import { describe, expect, it } from "vitest";
import { CAR, buildStairBarriers, buildWorld, makeCar, stepCar, type CarState, type RoadsFile } from "../../src/sim/index.ts";

const HALF = 5.5;
const D2R = Math.PI / 180;

/** A street along +x through node "n" at the origin, and two stairways from n: one 15 degrees off the street, one square to it. */
function roads(): RoadsFile {
  const sh = 15 * D2R;
  return {
    version: 1,
    nodes: [
      { id: "w", x: -100, z: 0 },
      { id: "n", x: 0, z: 0 },
      { id: "e", x: 100, z: 0 },
      { id: "s1", x: 80 * Math.cos(sh), z: 80 * Math.sin(sh) },
      { id: "s2", x: -40, z: -60 },
      { id: "n2", x: -40, z: 0 },
    ],
    edges: [
      { id: "st-w", a: "w", b: "n2", kind: "residential", lanes: 2, oneway: false, widthM: 2 * HALF, points: [[-100, 0], [-40, 0]] },
      { id: "st-m", a: "n2", b: "n", kind: "residential", lanes: 2, oneway: false, widthM: 2 * HALF, points: [[-40, 0], [0, 0]] },
      { id: "st-e", a: "n", b: "e", kind: "residential", lanes: 2, oneway: false, widthM: 2 * HALF, points: [[0, 0], [100, 0]] },
      { id: "shallow", a: "n", b: "s1", kind: "other", lanes: 1, oneway: false, widthM: 3, pedestrian: true, stairs: true, points: [[0, 0], [80 * Math.cos(sh), 80 * Math.sin(sh)]] },
      { id: "square", a: "n2", b: "s2", kind: "other", lanes: 1, oneway: false, widthM: 3, pedestrian: true, stairs: true, points: [[-40, 0], [-40, -60]] },
    ],
  };
}

/** Distance from (x, z) to the street's centreline (z = 0, x from -100 to 100). */
const toStreet = (x: number, z: number): number => (x < -100 ? Math.hypot(x + 100, z) : x > 100 ? Math.hypot(x - 100, z) : Math.abs(z));

describe("stairway barriers stop at the kerb", () => {
  it("no barrier wall, with its end reach, stands within the carriageway of a street meeting the stairway", () => {
    const b = buildStairBarriers(roads())!;
    expect(b.segments.length).toBeGreaterThan(0);
    for (const w of b.segments) {
      // The wall and its reach past both ends.
      const ax = w.ax - w.ux * w.reachA;
      const az = w.az - w.uz * w.reachA;
      const bx = w.bx + w.ux * w.reachB;
      const bz = w.bz + w.uz * w.reachB;
      for (let t = 0; t <= 1; t += 0.05) expect(toStreet(ax + (bx - ax) * t, az + (bz - az) * t)).toBeGreaterThanOrEqual(HALF - 1e-6);
    }
  });

  it("a car drives the street's whole carriageway past both stairways", () => {
    const world = buildWorld([], roads());
    for (const lane of [-HALF + CAR.halfWidth + 0.1, -1.6, 0, 1.6, HALF - CAR.halfWidth - 0.1]) {
      let c: CarState = { ...makeCar(-90, lane, Math.PI / 2, 0), speed: 10 };
      for (let t = 0; t < 1200 && c.x < 95; t++) c = stepCar(world, c, { throttle: c.speed < 10 ? 1 : 0, steer: 0, brake: 0, actions: 0 });
      expect(c.x, `lane ${lane}`).toBeGreaterThan(95);
      expect(Math.abs(c.z - lane), `lane ${lane}`).toBeLessThan(0.05);
    }
  });

  it("a car driven from the street up either stairway is stopped at the kerb", () => {
    const world = buildWorld([], roads());
    for (const [id, deg, x0] of [["shallow", 15, 0], ["square", -90, -40]] as const) {
      const ux = Math.cos(deg * D2R);
      const uz = Math.sin(deg * D2R);
      // From 4 m back along the stairway's line, on the street, heading up it.
      let c: CarState = { ...makeCar(x0 - ux * 4, -uz * 4, Math.atan2(ux, -uz), 0), speed: 8 };
      let deepest = 0;
      for (let t = 0; t < 480; t++) {
        c = stepCar(world, c, { throttle: 1, steer: 0, brake: 0, actions: 0 });
        // How far the car's centre got along the stairway beyond the kerb (outside the carriageway).
        const along = (c.x - x0) * ux + c.z * uz;
        const off = Math.abs(-(c.x - x0) * uz + c.z * ux);
        if (off < 2 && toStreet(c.x, c.z) > HALF + 0.5) deepest = Math.max(deepest, along);
      }
      expect(deepest, id).toBe(0);
    }
  });
});
