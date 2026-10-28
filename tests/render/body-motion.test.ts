import { describe, expect, it } from "vitest";
import {
  BodySpring, CAR_BODY, CarBodyMotion, HEAVE_SPRING, SpringStepper, TILT_SPRING, LEAN_DROP_MAX, TRAFFIC_BODY, TrafficLean, advanceAxis, bodyFeel, lowestDrop, minHeave, newAccel,
  updateAccel,
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

  it("jolts against the hit: a frontal hit dives the nose and bounces the body up, a side hit tips the roof toward the wall", () => {
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
    expect(sideRight.roll.v).toBeGreaterThan(0); // roll + = right side down: the roof goes toward the wall
    const sideLeft = new BodySpring();
    sideLeft.hit(8, 0, -1);
    expect(sideLeft.roll.v).toBeLessThan(0);
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
    for (const fps of [30, 60, 144, 240, 480, 1000]) expect(at(fps), `${fps} fps`).toBeCloseTo(4, 2);
  });

  it("reads the sideways acceleration with the right sign: a growing rightward sideways speed is a push to the right", () => {
    for (const fps of [60, 480]) {
      const s = newAccel(), dt = 1 / fps;
      for (let t = 0; t <= 1.5 + 1e-9; t += dt) updateAccel(s, dt, 10, 5 * t, 0, CAR_BODY); // 5 m/s^2 toward the right
      expect(s.aLat, `${fps} fps`).toBeCloseTo(5, 2);
      expect(s.aLong, `${fps} fps`).toBeCloseTo(0, 6);
    }
    const left = newAccel();
    for (let t = 0; t <= 1.5 + 1e-9; t += 1 / 60) updateAccel(left, 1 / 60, 10, -5 * t, 0, CAR_BODY);
    expect(left.aLat).toBeCloseTo(-5, 2);
  });

  it("keeps the frame's own turning: sliding sideways while yawing takes -yawRate * lateral off the forward acceleration and adds yawRate * speed to the lateral", () => {
    const s = newAccel();
    for (let i = 0; i < 240; i++) updateAccel(s, 1 / 60, 20, 3, 0.5, CAR_BODY); // constant velocity in a turning frame
    expect(s.aLong).toBeCloseTo(-0.5 * 3, 6);
    expect(s.aLat).toBeCloseTo(0.5 * 20, 6); // 10, within the 12 cap
  });

  it("an input that is not a number holds its last good value, and a bad dt skips the frame", () => {
    const s = newAccel();
    updateAccel(s, 1 / 60, NaN, 0, 0, CAR_BODY); // the first sample waits for a good one
    expect(s.has).toBe(false);
    for (let i = 0; i < 120; i++) updateAccel(s, 1 / 60, 4 * i / 60, 0, 0, CAR_BODY);
    const good = s.aLong;
    expect(good).toBeCloseTo(4, 1);
    updateAccel(s, 1 / 60, NaN, NaN, NaN, CAR_BODY);
    updateAccel(s, 1 / 60, Infinity, -Infinity, NaN, CAR_BODY);
    for (const dt of [NaN, Infinity, -1, 0]) updateAccel(s, dt, 1e9, 1e9, 1e9, CAR_BODY);
    expect(Number.isFinite(s.aLong) && Number.isFinite(s.aLat) && Number.isFinite(s.speed)).toBe(true);
    for (let i = 120; i < 240; i++) updateAccel(s, 1 / 60, 4 * i / 60, 0, 0, CAR_BODY);
    expect(s.aLong).toBeCloseTo(4, 1); // recovered, not stuck on NaN
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

describe("bad numbers never stick in the body", () => {
  const finiteBody = (b: BodySpring): boolean => [b.pitch.x, b.pitch.v, b.roll.x, b.roll.v, b.heave.x, b.heave.v].every(Number.isFinite);

  it("an Infinity or NaN dt skips the step, and a NaN or Infinity acceleration asks for level", () => {
    const b = new BodySpring();
    for (let i = 0; i < 60; i++) b.step(1 / 60, 6, 6);
    const before = [b.pitch.x, b.roll.x, b.heave.x];
    for (const dt of [Infinity, -Infinity, NaN, -1, 0]) b.step(dt, 6, 6);
    expect([b.pitch.x, b.roll.x, b.heave.x]).toEqual(before);
    for (let i = 0; i < 600; i++) b.step(1 / 60, NaN, -Infinity);
    expect(finiteBody(b)).toBe(true);
    expect(Math.abs(b.pitch.x)).toBeLessThan(1e-6); // NaN asks for level
    expect(b.roll.x).toBeGreaterThan(0.05); // -Infinity is a hard left-down lean, capped, not NaN
  });

  it("a spring that is somehow non-finite is put back at rest instead of carrying NaN forever", () => {
    const a = { x: NaN, v: 1 };
    advanceAxis(a, 0.05, TILT_SPRING.coeffs(1 / 60));
    expect(a).toEqual({ x: 0, v: 0 });
    const b = { x: 0.01, v: 0 };
    advanceAxis(b, NaN, TILT_SPRING.coeffs(1 / 60));
    expect(Number.isFinite(b.x) && Number.isFinite(b.v)).toBe(true);
  });

  it("kicks, hits and landings ignore non-finite numbers", () => {
    const b = new BodySpring();
    b.kick(NaN, Infinity, NaN);
    b.hit(NaN, 1, 0);
    b.land(NaN);
    b.hit(10, NaN, NaN);
    expect(finiteBody(b)).toBe(true);
    b.step(1 / 60, 0, 0);
    expect(finiteBody(b)).toBe(true);
  });

  it("one NaN speed among good frames costs a frame, not the car: the body recovers and still jolts", () => {
    const m = new CarBodyMotion();
    for (let i = 0; i < 120; i++) m.update(1 / 60, feel({ speed: 4 * i / 60 }));
    m.update(1 / 60, feel({ speed: NaN, lateral: NaN, yawRate: NaN, hits: NaN, impactSpeed: NaN, landingSpeed: NaN, personBumps: NaN }));
    expect(finiteBody(m.spring)).toBe(true);
    for (let i = 121; i < 300; i++) m.update(1 / 60, feel({ speed: 4 * i / 60 }));
    expect(finiteBody(m.spring)).toBe(true);
    expect(m.spring.pitch.x).toBeCloseTo(CAR_BODY.pitchPerAccel * 4, 3); // back to the throttle's lean
    m.update(1 / 60, feel({ speed: 20, hits: 1, impactSpeed: 10 })); // a hit after the bad frame still counts
    expect(m.spring.pitch.v).toBeLessThan(-0.3);
  });

  it("an Infinity dt never reaches the body", () => {
    const m = new CarBodyMotion();
    for (let i = 0; i < 30; i++) m.update(1 / 60, feel({ speed: 10 }));
    m.update(Infinity, feel({ speed: 10 }));
    m.update(NaN, feel({ speed: 10 }));
    expect(finiteBody(m.spring)).toBe(true);
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

  it("settles on a landing that fell between two frames: a new landing speed with no grounded flip", () => {
    const m = new CarBodyMotion();
    drive(m, feel({ speed: 15, landingSpeed: 0 }), 10);
    m.update(1 / 60, feel({ speed: 15, landingSpeed: 6 })); // grounded the whole time the frames saw
    expect(m.spring.heave.v).toBeLessThan(-0.8);
    const v = m.spring.heave.v;
    m.update(1 / 60, feel({ speed: 15, landingSpeed: 6 })); // the same landing is not a second one
    expect(m.spring.heave.v).toBeGreaterThan(v);
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

describe("ambient traffic's lean", () => {
  const frames = (l: TrafficLean, n: number, speed: (k: number) => number, heading: (k: number) => number, dt = 1 / 60): void => {
    for (let k = 0; k < n; k++) l.update(dt, speed(k * dt), heading(k * dt));
  };

  it("is lighter than the player's car, and the spring overshoots its capped target by no more than a few per cent", () => {
    expect(TRAFFIC_BODY.pitchMax).toBeLessThan(CAR_BODY.pitchMax);
    expect(TRAFFIC_BODY.rollMax).toBeLessThan(CAR_BODY.rollMax);
    const l = new TrafficLean();
    frames(l, 240, (t) => 30 * t, (t) => 4 * t);
    expect(Math.abs(l.spring.pitch.x)).toBeLessThanOrEqual(TRAFFIC_BODY.pitchMax * 1.1);
    expect(Math.abs(l.spring.roll.x)).toBeLessThanOrEqual(TRAFFIC_BODY.rollMax * 1.1);
  });

  it("squats, dives and leans out of a turn from the drawn speed and heading alone", () => {
    const up = new TrafficLean(), down = new TrafficLean(), right = new TrafficLean(), level = new TrafficLean();
    frames(up, 90, (t) => 3 * t, () => 0);
    frames(down, 90, (t) => 20 - 6 * t, () => 0);
    frames(right, 90, () => 14, (t) => 0.5 * t); // heading + = clockwise = turning right
    frames(level, 90, () => 14, () => 1.2);
    expect(up.spring.pitch.x).toBeGreaterThan(0.012);
    expect(down.spring.pitch.x).toBeLessThan(-0.02);
    expect(right.spring.roll.x).toBeLessThan(-0.03); // left side down
    expect(level.spring.pitch.x).toBe(0);
    expect(level.spring.roll.x).toBe(0);
  });

  it("is the same lean at 30, 60 and 144 fps", () => {
    const at = (fps: number): [number, number] => {
      const l = new TrafficLean();
      const dt = 1 / fps;
      for (let t = 0; t < 2 - 1e-9; t += dt) l.update(dt, Math.min(12, 4 * t), 0.35 * t);
      return [l.spring.pitch.x, l.spring.roll.x];
    };
    const ref = at(60);
    for (const fps of [30, 144]) {
      const [p, r] = at(fps);
      expect(p).toBeCloseTo(ref[0], 2);
      expect(r).toBeCloseTo(ref[1], 2);
    }
  });

  it("turns across the compass seam without a lurch, and ignores a respawn's heading jump", () => {
    const l = new TrafficLean(), ref = new TrafficLean();
    // A steady right turn through north: 6.1 -> 0.1 rad.
    frames(l, 60, () => 12, (t) => (6.0 + 0.5 * t) % (Math.PI * 2));
    frames(ref, 60, () => 12, (t) => 1.0 + 0.5 * t);
    expect(l.spring.roll.x).toBeCloseTo(ref.spring.roll.x, 9);
    const jump = new TrafficLean();
    frames(jump, 30, () => 10, () => 0);
    jump.update(1 / 60, 10, 3); // a 3 rad jump in a frame: capped, never a full-roll spike
    expect(Math.abs(jump.spring.roll.x)).toBeLessThanOrEqual(TRAFFIC_BODY.rollMax);
  });

  it("starts level after a reset and when dt is zero", () => {
    const l = new TrafficLean();
    frames(l, 60, (t) => 6 * t, () => 0);
    expect(l.spring.pitch.x).not.toBe(0);
    l.reset();
    expect(l.spring.pitch.x).toBe(0);
    l.update(0, 5, 1);
    expect(l.spring.pitch.x).toBe(0);
  });

  it("at the caps an axle of a whole-tilted vehicle dips or floats by less than 5 cm", () => {
    expect(1.35 * Math.sin(TRAFFIC_BODY.pitchMax)).toBeLessThan(0.05); // CAR.axle from the centre
    expect(0.8 * Math.sin(TRAFFIC_BODY.rollMax)).toBeLessThan(0.05); // CAR.track
  });

  it("braking hard through a turn, pitch and roll together still move a wheel no more than LEAN_DROP_MAX", () => {
    const l = new TrafficLean();
    let worst = 0, scaled = false;
    for (let k = 0; k < 240; k++) {
      const t = k / 60;
      l.update(1 / 60, Math.max(0, 25 - 9 * t), 0.6 * t); // full brake while turning right
      worst = Math.max(worst, lowestDrop(l.pitch, l.roll, 1.35, 0.8));
      if (Math.abs(l.pitch) < Math.abs(l.spring.pitch.x) - 1e-12) scaled = true;
    }
    expect(scaled).toBe(true); // the unscaled spring would have gone past it
    expect(worst).toBeLessThanOrEqual(LEAN_DROP_MAX + 1e-12);
    // One axis alone within the caps is drawn as the spring has it.
    const up = new TrafficLean();
    for (let k = 0; k < 90; k++) up.update(1 / 60, 3 * k / 60, 0);
    expect(up.pitch).toBe(up.spring.pitch.x);
  });

  it("a NaN heading costs a frame of turning, never a roll stuck on a straight road", () => {
    const l = new TrafficLean();
    for (let k = 0; k < 60; k++) l.update(1 / 60, 14, 0.5 * k / 60); // turning right
    expect(l.roll).toBeLessThan(-0.02);
    l.update(1 / 60, 14, NaN);
    for (let k = 0; k < 180; k++) l.update(1 / 60, 14, 1.2); // then straight
    expect(Math.abs(l.roll)).toBeLessThan(1e-4);
    const first = new TrafficLean();
    first.update(1 / 60, 14, NaN); // a NaN very first heading
    for (let k = 0; k < 60; k++) first.update(1 / 60, 14, 0.5 * k / 60);
    expect(first.roll).toBeLessThan(-0.02);
    expect(Number.isFinite(first.pitch) && Number.isFinite(first.roll)).toBe(true);
  });
});

describe("bodyFeel: the sim's two ticks to one frame's inputs", () => {
  const a: BodyFeel = { speed: 10, lateral: -2, yawRate: 0.2, grounded: false, hits: 3, personBumps: 0, impactSpeed: 5, landingSpeed: 1 };
  const b: BodyFeel = { speed: 20, lateral: 2, yawRate: 0.6, grounded: true, hits: 4, personBumps: 1, impactSpeed: 9, landingSpeed: 7 };

  it("interpolates speed, sideways speed and yaw rate, and takes the events from the newer tick", () => {
    const out = bodyFeel(a, b, 0.25, { ...level });
    expect(out.speed).toBeCloseTo(12.5, 12);
    expect(out.lateral).toBeCloseTo(-1, 12);
    expect(out.yawRate).toBeCloseTo(0.3, 12);
    expect([out.grounded, out.hits, out.personBumps, out.impactSpeed, out.landingSpeed]).toEqual([true, 4, 1, 9, 7]);
    expect(bodyFeel(a, b, 0, { ...level }).speed).toBe(10);
    expect(bodyFeel(a, b, 1, { ...level }).speed).toBe(20);
  });

  it("returns and fills the object it is given and never writes its inputs", () => {
    const out = { ...level }, fa = Object.freeze({ ...a }), fb = Object.freeze({ ...b });
    expect(bodyFeel(fa, fb, 0.5, out)).toBe(out);
    expect(out.speed).toBe(15);
  });
});
