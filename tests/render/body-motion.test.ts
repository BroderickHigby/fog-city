import { describe, expect, it } from "vitest";
import {
  BodySpring, CAR_BODY, CarBodyMotion, HEAVE_SPRING, SpringStepper, TILT_SPRING, advanceAxis, lowestDrop, minHeave, newAccel, updateAccel,
  type BodyFeel,
} from "../../src/render/body-motion.ts";

const level: BodyFeel = { speed: 0, lateral: 0, yawRate: 0, grounded: true, hits: 0, personBumps: 0, impactSpeed: 0, landingSpeed: 0 };
const feel = (o: Partial<BodyFeel>): BodyFeel => ({ ...level, ...o });

/** x'' = k (target - x) - c x' by a very small semi-implicit Euler step: the reference the exact step must meet. */
function integrate(k: number, c: number, x0: number, v0: number, target: number, seconds: number): [number, number] {
  const h = 1e-5;
  let x = x0, v = v0;
  for (let t = 0; t < seconds - 1e-12; t += h) {
    v += (k * (target - x) - c * v) * h;
    x += v * h;
  }
  return [x, v];
}

describe("the exact spring step", () => {
  it("matches a fine numerical integration of Slop's spring from rest and from a kick", () => {
    for (const [stepper, x0, v0, target] of [[TILT_SPRING, 0, 0, 0.05], [TILT_SPRING, -0.03, 1.2, 0.02], [HEAVE_SPRING, 0, -1.4, 0]] as const) {
      for (const dt of [1 / 144, 1 / 60, 0.1, 0.4]) {
        const axis = { x: x0, v: v0 };
        advanceAxis(axis, target, stepper.coeffs(dt));
        const [x, v] = integrate(stepper.stiffness, stepper.damping, x0, v0, target, dt);
        expect(axis.x).toBeCloseTo(x, 3);
        expect(axis.v).toBeCloseTo(v, 2);
      }
    }
  });

  it("is frame-rate independent: one second at 30, 60, 144 or irregular frames lands on the same state", () => {
    const run = (dts: number[]): [number, number] => {
      const a = { x: 0.01, v: -0.8 };
      for (const dt of dts) advanceAxis(a, 0.04, TILT_SPRING.coeffs(dt));
      return [a.x, a.v];
    };
    const ref = run(Array(60).fill(1 / 60));
    const wobbly: number[] = [];
    for (let t = 0, i = 0; t < 1 - 1e-9; i++) { const dt = Math.min(1 - t, 0.004 + 0.02 * ((i * 7919) % 13) / 13); wobbly.push(dt); t += dt; }
    for (const dts of [Array(30).fill(1 / 30), Array(144).fill(1 / 144), wobbly]) {
      const [x, v] = run(dts);
      expect(x).toBeCloseTo(ref[0], 9);
      expect(v).toBeCloseTo(ref[1], 8);
    }
  });

  it("settles on its target and rejects a spring that would not ring", () => {
    const a = { x: 0, v: 0 };
    for (let i = 0; i < 600; i++) advanceAxis(a, 0.05, TILT_SPRING.coeffs(1 / 60));
    expect(a.x).toBeCloseTo(0.05, 6);
    expect(Math.abs(a.v)).toBeLessThan(1e-6);
    expect(() => new SpringStepper(4, 5)).toThrow();
  });

  it("reuses one set of coefficients for every car in a frame", () => {
    const s = new SpringStepper(68, 11.2);
    expect(s.coeffs(1 / 60)).toBe(s.coeffs(1 / 60));
    const a = { ...s.coeffs(1 / 60) };
    s.coeffs(1 / 30);
    expect(s.coeffs(1 / 60)).toEqual(a);
  });
});

describe("what the body does", () => {
  const settle = (b: BodySpring, aLong: number, aLat: number, seconds = 2): void => {
    for (let t = 0; t < seconds; t += 1 / 60) b.step(1 / 60, aLong, aLat);
  };

  it("squats (nose up) when speeding up, dives (nose down) under the brakes, and sits level when coasting", () => {
    const up = new BodySpring(), down = new BodySpring(), flat = new BodySpring();
    settle(up, 6, 0); settle(down, -11, 0); settle(flat, 0, 0);
    expect(up.pitch.x).toBeGreaterThan(0.04);
    expect(down.pitch.x).toBeLessThan(-0.07);
    expect(flat.pitch.x).toBe(0);
    expect(flat.roll.x).toBe(0);
    expect(flat.heave.x).toBe(0);
  });

  it("leans out of a corner: a right turn rolls the left side down", () => {
    const right = new BodySpring(), left = new BodySpring();
    settle(right, 0, 9); settle(left, 0, -9);
    expect(right.roll.x).toBeLessThan(-0.05); // roll + = right side down
    expect(left.roll.x).toBeGreaterThan(0.05);
  });

  it("caps how far it tilts, whatever the acceleration", () => {
    const b = new BodySpring();
    settle(b, 500, 500, 4);
    expect(b.pitch.x).toBeCloseTo(CAR_BODY.pitchMax, 5);
    expect(b.roll.x).toBeCloseTo(-CAR_BODY.rollMax, 5);
    // A kick cannot throw it past the hard limits either.
    for (let i = 0; i < 20; i++) { b.kick(-9, 9, -9); b.step(1 / 60, 0, 0); expect(Math.abs(b.pitch.x)).toBeLessThanOrEqual(CAR_BODY.pitchLimit + 1e-12); }
    expect(b.heave.x).toBeGreaterThanOrEqual(CAR_BODY.heaveDown - 1e-12);
  });

  it("dips on a landing and comes back to level, harder for a harder fall", () => {
    const soft = new BodySpring(), hard = new BodySpring();
    soft.land(3); hard.land(9);
    let lowSoft = 0, lowHard = 0;
    for (let i = 0; i < 40; i++) {
      soft.step(1 / 60, 0, 0); hard.step(1 / 60, 0, 0);
      lowSoft = Math.min(lowSoft, soft.heave.x); lowHard = Math.min(lowHard, hard.heave.x);
    }
    expect(lowSoft).toBeLessThan(-0.02);
    expect(lowHard).toBeLessThan(lowSoft);
    for (let i = 0; i < 180; i++) hard.step(1 / 60, 0, 0);
    expect(Math.abs(hard.heave.x)).toBeLessThan(1e-4);
    const none = new BodySpring();
    none.land(0.5);
    expect(none.heave.v).toBe(0);
  });

  it("jolts against the hit: a frontal hit dives the nose and bounces the body up, a side hit rolls it away", () => {
    const front = new BodySpring();
    front.hit(12, 1, 0);
    expect(front.pitch.v).toBeLessThan(0);
    expect(front.heave.v).toBeGreaterThan(0);
    expect(front.roll.v).toBe(0);
    const rear = new BodySpring();
    rear.hit(12, -1, 0); // reversing into a wall
    expect(rear.pitch.v).toBeGreaterThan(0);
    const sideRight = new BodySpring();
    sideRight.hit(8, 0, 1); // sliding into a wall on its right
    expect(sideRight.roll.v).toBeGreaterThan(0);
    const light = new BodySpring();
    light.hit(12, 1, 0, 0.35);
    expect(Math.abs(light.pitch.v)).toBeLessThan(Math.abs(front.pitch.v));
    const tap = new BodySpring();
    tap.hit(0.8, 1, 0);
    expect(tap.pitch.v).toBe(0);
  });
});

describe("the acceleration it reads", () => {
  it("is d(speed)/dt, and the same number at 30, 60 and 144 fps", () => {
    const at = (fps: number): number => {
      const s = newAccel();
      const dt = 1 / fps;
      for (let t = 0; t <= 1.5 + 1e-9; t += dt) updateAccel(s, dt, 4 * t, 0, 0, CAR_BODY);
      return s.aLong;
    };
    for (const fps of [30, 60, 144]) expect(at(fps)).toBeCloseTo(4, 2);
  });

  it("adds the centripetal term: a right turn at speed pushes the car to the right", () => {
    const s = newAccel();
    for (let i = 0; i < 120; i++) updateAccel(s, 1 / 60, 20, 0, 0.4, CAR_BODY);
    expect(s.aLat).toBeCloseTo(8, 2); // speed * yawRate
    expect(s.aLong).toBeCloseTo(0, 6);
  });

  it("ignores a one-tick collision spike (the kick's job) and its first sample", () => {
    const s = newAccel();
    updateAccel(s, 1 / 60, 30, 0, 0, CAR_BODY);
    expect(s.aLong).toBe(0);
    updateAccel(s, 1 / 60, 0, 0, 0, CAR_BODY); // 30 m/s gone in a tick
    expect(Math.abs(s.aLong)).toBeLessThanOrEqual(CAR_BODY.accelCap);
  });
});

describe("a car driven by the sim's fields", () => {
  const drive = (m: CarBodyMotion, f: BodyFeel, frames: number): void => { for (let i = 0; i < frames; i++) m.update(1 / 60, f); };

  it("sits level at constant speed", () => {
    const m = new CarBodyMotion();
    drive(m, feel({ speed: 20 }), 120);
    expect(m.spring.pitch.x).toBe(0);
    expect(m.spring.roll.x).toBe(0);
  });

  it("squats while speed climbs and dives while it drops", () => {
    const up = new CarBodyMotion(), down = new CarBodyMotion();
    for (let i = 0; i < 90; i++) up.update(1 / 60, feel({ speed: 6 * i / 60 }));
    for (let i = 0; i < 90; i++) down.update(1 / 60, feel({ speed: 30 - 11 * i / 60 }));
    expect(up.spring.pitch.x).toBeGreaterThan(0.03);
    expect(down.spring.pitch.x).toBeLessThan(-0.04);
  });

  it("jolts once per counted hit, not on the first sample and not while the count stands still", () => {
    const m = new CarBodyMotion();
    m.update(1 / 60, feel({ speed: 20, hits: 5, impactSpeed: 9 })); // a car that has hit things before it was drawn
    expect(m.spring.pitch.v).toBe(0);
    m.update(1 / 60, feel({ speed: 20, hits: 5, impactSpeed: 9 }));
    expect(m.spring.pitch.v).toBe(0);
    m.update(1 / 60, feel({ speed: 4, hits: 6, impactSpeed: 12 }));
    expect(m.spring.pitch.v).toBeLessThan(-0.3); // nose dives
    expect(m.spring.heave.v).toBeGreaterThan(0);
    const v = m.spring.pitch.v;
    m.update(1 / 60, feel({ speed: 4, hits: 6, impactSpeed: 12 }));
    expect(m.spring.pitch.v).toBeGreaterThan(v); // no second kick: only the spring pulls it back
  });

  it("settles on touchdown: a landing sends the body down and a person bump is gentler than a wall", () => {
    const m = new CarBodyMotion();
    drive(m, feel({ speed: 15, grounded: false }), 30);
    m.update(1 / 60, feel({ speed: 15, grounded: true, landingSpeed: 7 }));
    expect(m.spring.heave.v).toBeLessThan(-0.8);
    const wall = new CarBodyMotion(), person = new CarBodyMotion();
    drive(wall, feel({ speed: 10 }), 3); drive(person, feel({ speed: 10 }), 3);
    wall.update(1 / 60, feel({ speed: 10, hits: 1, impactSpeed: 10 }));
    person.update(1 / 60, feel({ speed: 10, personBumps: 1, impactSpeed: 10 }));
    expect(Math.abs(person.spring.pitch.v)).toBeLessThan(Math.abs(wall.spring.pitch.v));
    expect(person.spring.pitch.v).toBeLessThan(0);
  });

  it("starts level after a respawn", () => {
    const m = new CarBodyMotion();
    m.spring.kick(1, 1, 1);
    m.reset();
    m.update(1 / 60, feel({ speed: 25, hits: 9 }));
    expect(m.spring.pitch.v).toBe(0);
    expect(m.spring.heave.v).toBe(0);
  });

  it("only reads the sim's fields: a frozen sample is never written", () => {
    const m = new CarBodyMotion(), f = Object.freeze(feel({ speed: 12, yawRate: 0.3 }));
    expect(() => drive(m, f, 10)).not.toThrow();
  });
});

describe("never into the road", () => {
  // The glb body: half length 2.19, half width 1.135, 0.22 m under it; the margin the renderer keeps is 0.03.
  const hl = 2.19, hw = 1.135, clearance = 0.22, margin = 0.03;

  it("lowestDrop is the worst corner's sink", () => {
    expect(lowestDrop(0, 0, hl, hw)).toBe(0);
    expect(lowestDrop(0.05, 0, hl, hw)).toBeCloseTo(hl * Math.sin(0.05), 12);
    expect(lowestDrop(-0.05, 0.05, hl, hw)).toBeCloseTo(hl * Math.sin(0.05) + hw * Math.sin(0.05), 12);
  });

  it("each cap of the player's tune fits the clearance alone, both at once need a small lift, and nothing is ever lower than the margin", () => {
    expect(minHeave(CAR_BODY.pitchMax, 0, hl, hw, clearance, margin)).toBeLessThanOrEqual(0);
    expect(minHeave(0, CAR_BODY.rollMax, hl, hw, clearance, margin)).toBeLessThanOrEqual(0);
    expect(minHeave(CAR_BODY.pitchMax, CAR_BODY.rollMax, hl, hw, clearance, margin)).toBeLessThan(0.08);
    for (let p = -CAR_BODY.pitchLimit; p <= CAR_BODY.pitchLimit; p += 0.02) {
      for (let r = -CAR_BODY.rollLimit; r <= CAR_BODY.rollLimit; r += 0.02) {
        for (const heave of [CAR_BODY.heaveDown, 0, CAR_BODY.heaveUp]) {
          const shown = Math.max(heave, minHeave(p, r, hl, hw, clearance, margin));
          expect(shown - lowestDrop(p, r, hl, hw) + clearance).toBeGreaterThanOrEqual(margin - 1e-9);
        }
      }
    }
  });
});
