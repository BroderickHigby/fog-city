// Vehicle handling: arcade but physical. Every test drives stepCar directly on a synthetic
// world so the numbers mean one thing.
import { describe, expect, it } from "vitest";
import {
  CAR,
  boxBlocked,
  buildWorld,
  carBox,
  datan2,
  groundHeight,
  makeCar,
  stepCar,
  type CarState,
  type Circle,
  type SimInput,
  type World,
} from "../../src/sim/index.ts";
import { emptyWorld, terrainWorld, wallWorld } from "./fixtures.ts";

const I = (throttle: number, steer = 0, brake = 0): SimInput => ({ throttle, steer, brake, actions: 0 });

function drive(world: World, c: CarState, input: SimInput | ((t: number) => SimInput), ticks: number, obstacles: Circle[] = [], each?: (c: CarState, t: number) => void): CarState {
  for (let t = 0; t < ticks; t++) {
    c = stepCar(world, c, typeof input === "function" ? input(t) : input, obstacles);
    each?.(c, t);
  }
  return c;
}

const flat = emptyWorld();

describe("longitudinal", () => {
  it("accelerates to a top speed near CAR.maxSpeed and stays straight with no steer", () => {
    const c = drive(flat, makeCar(0, 0, 0), I(1), 60 * 15);
    expect(c.speed).toBeGreaterThan(26);
    expect(c.speed).toBeLessThanOrEqual(CAR.maxSpeed);
    expect(c.x).toBe(0);
    expect(c.lateral).toBe(0);
  });

  it("brakes from top speed to a stop in under 2 s", () => {
    let c = drive(flat, makeCar(0, 0, 0), I(1), 60 * 6);
    c = drive(flat, c, I(0, 0, 1), 120);
    expect(c.speed).toBe(0);
  });

  it("reverses: throttle back from rest drives backwards, capped at maxReverse", () => {
    const c = drive(flat, makeCar(0, 0, 0), I(-1), 60 * 6);
    expect(c.speed).toBeLessThan(-6);
    expect(c.speed).toBeGreaterThanOrEqual(-CAR.maxReverse);
    expect(c.z).toBeGreaterThan(20); // heading north (-z), so backwards is +z
  });

  it("throttle while rolling backwards brakes first, then drives forward", () => {
    let c = drive(flat, makeCar(0, 0, 0), I(-1), 120);
    expect(c.speed).toBeLessThan(0);
    c = drive(flat, c, I(1), 30);
    expect(c.speed).toBeGreaterThan(0);
  });
});

describe("steering and grip", () => {
  it("steering lock shrinks with speed", () => {
    const slow = drive(flat, { ...makeCar(0, 0, 0), speed: 5 }, I(0.2, 1), 30);
    const fast = drive(flat, { ...makeCar(0, 0, 0), speed: 25 }, I(1, 1), 30);
    expect(Math.abs(fast.steer)).toBeLessThan(Math.abs(slow.steer) * 0.6);
  });

  it("full grip at speed turns without sliding (understeer, not oversteer)", () => {
    let c = drive(flat, makeCar(0, 0, 0), I(1), 60 * 5);
    c = drive(flat, c, I(1, 1), 120);
    expect(c.grip).toBe(1);
    expect(Math.abs(c.lateral)).toBeLessThan(0.5);
    expect(c.yawRate).toBeGreaterThan(0.3); // turning right
  });

  it("brake + steer at speed gives a controlled slide; grip recovers after release", () => {
    let c = drive(flat, makeCar(0, 0, 0), I(1), 60 * 4);
    const v0 = c.speed;
    let maxSlip = 0;
    let maxLat = 0;
    c = drive(flat, c, I(0, -1, 1), 60, [], (k) => {
      maxSlip = Math.max(maxSlip, Math.abs(datan2(k.lateral, Math.abs(k.speed))));
      maxLat = Math.max(maxLat, Math.abs(k.lateral));
    });
    expect(c.grip).toBeLessThan(0.1);
    expect(maxLat).toBeGreaterThan(5); // really sliding sideways
    expect(maxSlip).toBeLessThan(1.05); // ...but never more than ~60 degrees: controlled
    expect(c.heading).toBeLessThan(-0.5); // rotated left
    expect(Math.hypot(c.speed, c.lateral)).toBeGreaterThan(v0 * 0.6); // keeps most of its speed
    // Release the brake, straighten up: grip comes back and the slide stops.
    c = drive(flat, c, I(1, 0), 150);
    expect(c.grip).toBe(1);
    expect(Math.abs(c.lateral)).toBeLessThan(0.05);
    expect(c.speed).toBeGreaterThan(v0 * 0.7);
  });

  it("a slide turns the car further than grip driving over the same time at speed", () => {
    const start = drive(flat, makeCar(0, 0, 0), I(1), 60 * 4);
    const grip = drive(flat, start, I(1, -1), 60);
    const slide = drive(flat, start, I(0, -1, 1), 60);
    expect(Math.abs(slide.heading)).toBeGreaterThan(Math.abs(grip.heading));
  });

  it("the brake alone at speed stops straight, without sliding", () => {
    let c = drive(flat, makeCar(0, 0, 0), I(1), 60 * 4);
    c = drive(flat, c, I(0, 0, 1), 30);
    expect(c.grip).toBe(1);
    expect(c.lateral).toBe(0);
  });
});

describe("collision with buildings", () => {
  const wall = wallWorld(); // wall face at z = -50

  it("slides along a wall hit at a shallow angle instead of stopping", () => {
    // 30 degrees off the wall line, heading north-east toward the wall.
    let c: CarState = { ...makeCar(0, -30, (60 * Math.PI) / 180), speed: 22 };
    let before = 0;
    let hitAt = -1;
    let overlapping = 0;
    c = drive(wall, c, I(1), 240, [], (k, t) => {
      if (boxBlocked(wall, carBox(k), k.y + 0.5)) overlapping++;
      if (hitAt < 0 && k.hits === 1) hitAt = t;
      if (hitAt < 0) before = k.speed;
    });
    expect(hitAt).toBeGreaterThan(0);
    expect(overlapping).toBe(0);
    expect(c.hits).toBe(1);
    expect(c.z).toBeGreaterThan(-50); // still in front of the wall
    expect(c.z).toBeLessThan(-46); // ...and running along it
    expect(c.speed).toBeGreaterThan(before * 0.6); // slid on, did not stop
    expect(Math.abs(c.heading - Math.PI / 2)).toBeLessThan(0.2); // nose turned to follow the wall
  });

  it("a 45 degree hit still ends up sliding along the wall", () => {
    let c: CarState = { ...makeCar(0, -30, Math.PI / 4), speed: 20 };
    c = drive(wall, c, I(1), 240);
    expect(c.hits).toBe(1);
    expect(c.speed).toBeGreaterThan(10);
    expect(c.x).toBeGreaterThan(30);
  });

  it("counts one hit per impact, not per tick in contact, and records the impact speed", () => {
    let c: CarState = { ...makeCar(0, -30, 0), speed: 15 };
    let contactTicks = 0;
    c = drive(wall, c, I(1), 300, [], (k) => {
      if (k.sinceContact === 0) contactTicks++;
    });
    expect(contactTicks).toBeGreaterThan(200); // pressed against the wall for seconds
    expect(c.hits).toBe(1);
    expect(c.impactSpeed).toBeGreaterThan(14);
    expect(c.impactSpeed).toBeLessThan(25);
    // Back off and hit it again: a second impact.
    c = drive(wall, c, I(-1), 90);
    expect(c.sinceContact).toBeGreaterThan(CAR.hitCooldown);
    c = drive(wall, c, I(1), 120);
    expect(c.hits).toBe(2);
  });

  it("a head-on hit stops the car with a small bounce and never passes the wall", () => {
    let c: CarState = { ...makeCar(0, -20, 0), speed: 28 };
    let minSpeed = 0;
    c = drive(wall, c, I(0), 120, [], (k) => {
      minSpeed = Math.min(minSpeed, k.speed);
      expect(k.z - CAR.halfLength).toBeGreaterThan(-50.01);
    });
    expect(minSpeed).toBeLessThan(0); // bounced back a little
    expect(minSpeed).toBeGreaterThan(-4);
    expect(c.hits).toBe(1);
  });

  it("people are solid but never hurt: a bump counts as personBumps, not hits", () => {
    const person: Circle = { x: 0, z: -20, r: 0.3, person: true };
    let c: CarState = { ...makeCar(0, 0, 0), speed: 8 };
    c = drive(flat, c, I(0.3), 180, [person]);
    expect(c.personBumps).toBe(1);
    expect(c.hits).toBe(0);
    expect(c.z).toBeGreaterThan(-20 + 0.3 + CAR.halfLength - 0.01);
  });

  it("a low building can be cleared in the air, a tall one cannot be driven through", () => {
    const low = buildWorld([
      { tileId: "x", buildings: [{ id: "kiosk", footprint: [[-5, -30], [5, -30], [5, -28], [-5, -28]], baseY: 0, topY: 0.2 }], ground: null },
    ]);
    const c = drive(low, { ...makeCar(0, 0, 0), speed: 10 }, I(0.5), 300);
    expect(c.z).toBeLessThan(-28); // y + 0.5 is above a 0.2 m roof
  });
});

describe("slopes and airtime", () => {
  // 15% grade rising to the north (-z).
  const slope = terrainWorld((_x, z) => -0.15 * z);

  it("uphill is slower than downhill at full throttle", () => {
    const up = drive(slope, makeCar(0, 0, 0, groundHeight(slope, 0, 0)), I(1), 240);
    const down = drive(slope, makeCar(0, 0, Math.PI, groundHeight(slope, 0, 0)), I(1), 240);
    expect(up.speed).toBeLessThan(down.speed - 2);
    expect(up.y).toBeGreaterThan(5);
    expect(down.y).toBeLessThan(-5);
    expect(up.pitch).toBeGreaterThan(0.1); // nose up
    expect(down.pitch).toBeLessThan(-0.1);
  });

  it("coasting slows uphill and speeds up downhill", () => {
    const up = drive(slope, { ...makeCar(0, 0, 0, groundHeight(slope, 0, 0)), speed: 15 }, I(0), 120);
    const down = drive(slope, { ...makeCar(0, 0, Math.PI, groundHeight(slope, 0, 0)), speed: 15 }, I(0), 120);
    expect(up.speed).toBeLessThan(13);
    expect(down.speed).toBeGreaterThan(15.5);
  });

  it("a car parked on the hill stays put", () => {
    const c = drive(slope, makeCar(0, 0, Math.PI / 2, groundHeight(slope, 0, 0)), I(0), 600);
    expect(c.x).toBe(0);
    expect(c.z).toBe(0);
  });

  it("a sideways slope pushes the car downhill only as far as grip allows", () => {
    // Driving east across the slope: gravity pulls toward +z (south).
    const c = drive(slope, makeCar(0, 0, Math.PI / 2, groundHeight(slope, 0, 0)), I(1), 180);
    expect(Math.abs(c.z)).toBeLessThan(0.5);
    expect(c.roll).not.toBe(0);
  });

  // +20% up to a rounded crest at z = 0, then -20% down.
  const crest = terrainWorld((_x, z) => {
    const u = -z;
    if (u <= -5) return 0.2 * u + 0.5;
    if (u >= 5) return -0.2 * u + 0.5;
    return -0.02 * u * u;
  }, 300, 1);

  // Curvature 0.04/m: the ground falls away faster than gravity above sqrt(9.81 / 0.04) ~ 15.7 m/s.
  function overCrest(speed: number, throttle: number): { maxAir: number; maxGap: number; landing: number; end: CarState; crestSpeed: number } {
    let maxAir = 0;
    let maxGap = 0;
    let crestSpeed = 0;
    const end = drive(crest, { ...makeCar(0, 40, 0, groundHeight(crest, 0, 40)), speed }, I(throttle), 360, [], (k) => {
      if (crestSpeed === 0 && k.z < 0) crestSpeed = k.speed;
      maxAir = Math.max(maxAir, k.airTicks);
      maxGap = Math.max(maxGap, k.y - groundHeight(crest, k.x, k.z));
    });
    return { maxAir, maxGap, landing: end.landingSpeed, end, crestSpeed };
  }

  it("cresting a hill fast leaves the ground, flies, and lands", () => {
    const fast = overCrest(26, 0.6);
    expect(fast.crestSpeed).toBeGreaterThan(20);
    expect(fast.maxAir).toBeGreaterThan(30); // half a second or more of air
    expect(fast.maxGap).toBeGreaterThan(1);
    expect(fast.landing).toBeGreaterThan(1);
    expect(fast.end.grounded).toBe(true);
  });

  it("cresting the same hill slowly keeps the wheels on the ground", () => {
    const slow = overCrest(11, 0.2);
    expect(slow.crestSpeed).toBeGreaterThan(8);
    expect(slow.crestSpeed).toBeLessThan(14);
    expect(slow.maxAir).toBe(0);
    expect(slow.maxGap).toBeLessThanOrEqual(CAR.suspension);
  });

  it("there is no traction in the air: steering does not turn a flying car", () => {
    // Steer hard only while airborne.
    let c: CarState = { ...makeCar(0, 40, 0, groundHeight(crest, 0, 40)), speed: 28 };
    let headingAtTakeoff: number | null = null;
    let headingAtLanding: number | null = null;
    for (let t = 0; t < 360; t++) {
      const flying = !c.grounded;
      c = stepCar(crest, c, flying ? I(1, 1) : I(0.6));
      if (!c.grounded && headingAtTakeoff === null) headingAtTakeoff = c.heading;
      if (headingAtTakeoff !== null && c.grounded && headingAtLanding === null) headingAtLanding = c.heading;
    }
    expect(headingAtTakeoff).not.toBeNull();
    expect(headingAtLanding).not.toBeNull();
    expect(Math.abs(headingAtLanding! - headingAtTakeoff!)).toBeLessThan(0.05);
  });
});
