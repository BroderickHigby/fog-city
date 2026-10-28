// The engine's gearbox: it remembers its gear, so a speed or throttle hovering at a shift point
// does not hunt; a gear is held at least 0.65 s; an upshift cuts the power for about 0.16 s; the
// throttle rises faster than it falls. All of it is the pure `stepGearbox`, driven here frame by
// frame; none of it needs audio or a browser.
import { describe, expect, it } from "vitest";
import {
  DIP_THROTTLE, EngineClock, GEAR_TOP_MPS, IDLE_RPM, LAUNCH_MPS, REDLINE_RPM, THROTTLE_FALL_S, THROTTLE_RISE_S,
  engineParams, engineRpm, enginePower, gearboxRpm, pickGear, rideEngineParams, settleGearbox, stepGearbox, type Gearbox,
} from "../../src/audio/vehicle-sound.ts";
import type { CarState } from "../../src/sim/contract.ts";

const DT = 1 / 60;
// The numbers the sound is specified by, written out here rather than imported, so changing one in
// the source fails a test: a gear is held 0.65 s; an upshift cuts the power for 0.16 s.
const HOLD_S = 0.65;
const DIP_S = 0.16;
const car = (o: Partial<CarState> = {}): CarState => ({
  x: 0, y: 0, z: 0, heading: 0, speed: 0, steer: 0, hits: 0, lateral: 0, yawRate: 0, vy: 0, grounded: true, airTicks: 0,
  grip: 1, pitch: 0, roll: 0, sinceContact: 600, impactSpeed: 0, landingSpeed: 0, personBumps: 0, nearMisses: 0, ...o,
}) as CarState;

/** The speed at which gear `g` (0-based) reaches `rpm`. */
const speedAt = (g: number, rpm: number): number => (rpm * GEAR_TOP_MPS[g]!) / REDLINE_RPM;

interface Frame { t: number; gear: number; dip: boolean; rpm: number; throttle: number; power: number }

/** Run the gearbox over `seconds`, asking for `speed(t)` and `asked(t)` each frame; return every frame. */
function run(start: Gearbox, seconds: number, speed: (t: number) => number, asked: (t: number) => number, dt = DT): Frame[] {
  const frames: Frame[] = [];
  let box = start;
  for (let i = 1; i * dt <= seconds + 1e-9; i++) {
    const t = i * dt;
    box = stepGearbox(box, speed(t), asked(t), dt);
    frames.push({ t, gear: box.gear, dip: box.dipS > 0, rpm: gearboxRpm(box, speed(t)), throttle: box.throttle, power: enginePower(box) });
  }
  return frames;
}

/** The times the gear changed, with the direction (+1 up, -1 down). */
function shifts(frames: Frame[], from: number): { t: number; dir: number; step: number }[] {
  const out: { t: number; dir: number; step: number }[] = [];
  let g = from;
  for (const f of frames) {
    if (f.gear !== g) { out.push({ t: f.t, dir: Math.sign(f.gear - g), step: Math.abs(f.gear - g) }); g = f.gear; }
  }
  return out;
}

describe("a gearbox with no history", () => {
  it("sits where the stateless pick says, so a still engine sounds as it did before gears were remembered", () => {
    for (let v = 0; v <= 40; v += 0.25)
      for (const throttle of [0, 0.3, 0.7, 1]) {
        const box = settleGearbox(v, throttle);
        expect(gearboxRpm(box, v)).toBeCloseTo(engineRpm(v, throttle), 9);
        expect(box.gear).toBe(pickGear(v, throttle));
        expect(box.holdS).toBe(0);
        expect(box.dipS).toBe(0);
      }
    expect(settleGearbox(0, 0).gear).toBe(0);
    expect(gearboxRpm(settleGearbox(0, 0), 0)).toBe(IDLE_RPM);
  });

  it("is what engineParams and rideEngineParams use when given no gearbox", () => {
    const stateless = engineParams(car({ speed: 20 }), car({ speed: 19.9 }), DT);
    const given = engineParams(car({ speed: 20 }), car({ speed: 19.9 }), DT, settleGearbox(20, Math.min(1, (0.1 / DT) / 4)));
    expect(given).toEqual(stateless);
    expect(rideEngineParams(15, 14.9, DT)).toEqual(rideEngineParams(15, 14.9, DT, settleGearbox(15, Math.min(1, (0.1 / DT) / 4))));
  });
});

describe("hysteresis: no hunting at a shift point", () => {
  it("holds a gear while the speed wobbles across the shift speed with the throttle held", () => {
    for (const [g, throttle] of [[0, 1], [1, 1], [2, 0.5], [3, 0], [0, 0.2]] as const) {
      const shiftRpm = 3200 + 2600 * throttle;
      const vShift = speedAt(g, shiftRpm);
      // Start in the gear below the shift point and wobble 4% either side of the shift speed for 20 s.
      const start: Gearbox = { gear: g, holdS: 0, dipS: 0, throttle };
      const frames = run(start, 20, (t) => vShift * (1 + 0.04 * Math.sin(t * 7)), () => throttle);
      const s = shifts(frames, g);
      // At most the one upshift, and never back down.
      expect(s.length, `gear ${g + 1}, throttle ${throttle}`).toBeLessThanOrEqual(1);
      expect(s.every((x) => x.dir === 1)).toBe(true);
    }
  });

  it("holds a gear when the throttle the car is read to ask for flickers frame to frame (a 144 Hz display on a 60 Hz sim)", () => {
    // Acceleration read from 60 Hz sim ticks on a 144 Hz display alternates between nothing and
    // about 2.4 times the real value. The old per-frame pick followed that flicker every frame.
    for (const [g, mean] of [[0, 0.5], [1, 0.6], [2, 0.3]] as const) {
      const vShift = speedAt(g, 3200 + 2600 * mean);
      const start: Gearbox = { gear: g, holdS: 0, dipS: 0, throttle: mean };
      const frames = run(start, 20, () => vShift, (t) => (Math.round(t * 144) % 2 === 0 ? 0 : 2 * mean), 1 / 144);
      expect(shifts(frames, g).length, `gear ${g + 1}`).toBeLessThanOrEqual(1);
    }
    // Before: the stateless pick flips its gear on that flicker.
    let flips = 0, last = -1;
    for (let i = 0; i < 144 * 20; i++) {
      const gear = pickGear(speedAt(1, 3200 + 2600 * 0.6), i % 2 === 0 ? 0 : 1.2);
      if (gear !== last) flips++;
      last = gear;
    }
    expect(flips).toBeGreaterThan(100);
  });

  it("does not shift straight back after a shift, at any throttle the shift can be followed by", () => {
    // After an upshift at one throttle, every steady throttle after it must leave the gear alone
    // for at least the hold, and a downshift needs the speed to fall well below the shift speed.
    for (let g = 0; g < GEAR_TOP_MPS.length - 1; g++)
      for (const t0 of [0, 0.5, 1]) {
        const v = speedAt(g, 3200 + 2600 * t0) * 1.001;
        const after = stepGearbox({ gear: g, holdS: 0, dipS: 0, throttle: t0 }, v, t0, DT);
        expect(after.gear, `up from ${g + 1} at throttle ${t0}`).toBe(g + 1);
        for (const t1 of [0, 0.25, 0.5, 0.75, 1]) {
          const frames = run(after, HOLD_S - 2 * DT, () => v, () => t1);
          expect(frames.every((f) => f.gear === g + 1), `held after ${g + 1} at ${t0} then ${t1}`).toBe(true);
        }
      }
  });
});

describe("minimum hold", () => {
  it("keeps every gear at least 0.65 s, through a speed and throttle swept up and down and shaken", () => {
    // A rough drive: speed swinging between a crawl and 33 m/s (never stopping: a stop resets to first at once), throttle jumping about.
    const speed = (t: number): number => 18 + 14 * Math.sin(t * 0.9) + 1.5 * Math.sin(t * 11);
    const asked = (t: number): number => (Math.sin(t * 5.3) > 0.2 ? 1 : Math.sin(t * 2.1) > 0 ? 0.4 : 0);
    const frames = run(settleGearbox(speed(0), 0), 120, speed, asked);
    const s = shifts(frames, frames[0]!.gear);
    expect(Math.min(...frames.map((f) => f.rpm))).toBeGreaterThanOrEqual(IDLE_RPM);
    expect(s.length).toBeGreaterThan(20); // the drive does shift: the test is not vacuous
    // A one-gear shift always waits out the hold; only a jump of two or more gears (a crash-sized
    // change of speed, which this rough drive can make) may cut it short.
    for (let i = 1; i < s.length; i++) if (s[i]!.step === 1) expect(s[i]!.t - s[i - 1]!.t, `shift ${i}`).toBeGreaterThanOrEqual(HOLD_S - 1e-9);
    expect(s.filter((x) => x.step === 1).length).toBeGreaterThan(20);
  });

  it("makes a kick-down right after an upshift wait out the hold, then take it", () => {
    // Lift off and shift up at the cruise shift point, then stab the pedal at once.
    const v = speedAt(0, 3200) * 1.01;
    const up = stepGearbox({ gear: 0, holdS: 0, dipS: 0, throttle: 0 }, v, 0, DT);
    expect(up.gear).toBe(1);
    const frames = run(up, 2, () => v, () => 1);
    const down = shifts(frames, 1)[0]!;
    expect(down.dir).toBe(-1);
    expect(down.t).toBeGreaterThanOrEqual(HOLD_S - 2 * DT);
    expect(down.t).toBeLessThanOrEqual(HOLD_S + 2 * DT); // and it is taken as soon as the hold ends
  });

  it("holds after a launch reset too, and a stop sends the box back to first at once", () => {
    const high: Gearbox = { gear: 4, holdS: 0.4, dipS: 0.1, throttle: 0.3 };
    const stopped = stepGearbox(high, LAUNCH_MPS - 0.01, 0, DT);
    expect(stopped.gear).toBe(0);
    expect(stopped.holdS).toBe(0);
    expect(stopped.dipS).toBe(0);
    expect(gearboxRpm(stopped, 0)).toBe(IDLE_RPM);
    // A pull-away is in first until the first shift point, then the usual upshift.
    const frames = run(stopped, 4, (t) => 5 * t, () => 1);
    expect(frames[0]!.gear).toBe(0);
    expect(shifts(frames, 0)[0]).toMatchObject({ dir: 1 });
  });

  it("a held low gear tops out at the redline rather than screaming past it", () => {
    const box: Gearbox = { gear: 0, holdS: 0.5, dipS: 0, throttle: 1 };
    expect(gearboxRpm(box, 25)).toBe(REDLINE_RPM);
    // One gear up waits out the hold; a speed that needs two or more goes there at once (below).
    const oneUp = speedAt(1, 3000);
    expect(stepGearbox({ ...box, holdS: 0.5 }, oneUp, 1, DT).gear).toBe(pickGear(oneUp, 1) >= 2 ? pickGear(oneUp, 1) : 0);
  });
});

describe("a crash or a jump in speed", () => {
  it("goes straight to the right gear instead of lugging one shift per hold after a hard stop", () => {
    let box = settleGearbox(30, 1);
    box = stepGearbox(box, 30, 1, DT);
    box = { ...box, holdS: HOLD_S };
    const after = stepGearbox(box, 6, 1, DT);
    expect(after.gear).toBe(pickGear(6, after.throttle));
    expect(gearboxRpm(after, 6)).toBeGreaterThanOrEqual(1400);
  });
  it("goes straight up when a jump in speed would hold a low gear on the limiter", () => {
    const box = { ...settleGearbox(3, 1), holdS: HOLD_S };
    const after = stepGearbox(box, 30, 1, DT);
    expect(after.gear).toBe(pickGear(30, after.throttle));
    expect(after.dipS).toBe(0);
  });
  it("shrugs off a non-finite frame and recovers on the next one", () => {
    const box = stepGearbox(settleGearbox(12, 0.5), NaN, NaN, NaN);
    expect(Number.isFinite(box.throttle)).toBe(true);
    const next = stepGearbox({ ...box, throttle: NaN }, 12, 0.5, DT);
    expect(Number.isFinite(next.throttle)).toBe(true);
  });
});

describe("upshift dip", () => {
  it("cuts the power for about 0.16 s on an upshift, and only on an upshift", () => {
    // Pull away flat out: the first shift is an upshift from first.
    const frames = run(settleGearbox(0, 1), 5, (t) => 4 * t, () => 1);
    const up = frames.findIndex((f) => f.gear === 1);
    expect(up).toBeGreaterThan(0);
    const dipFrames = frames.slice(up).findIndex((f) => !f.dip);
    expect(dipFrames * DT).toBeGreaterThanOrEqual(DIP_S - 1e-9);
    expect(dipFrames * DT).toBeLessThanOrEqual(DIP_S + 2 * DT);
    for (const f of frames.slice(up, up + dipFrames)) expect(f.power).toBeLessThanOrEqual(DIP_THROTTLE + 1e-12);
    // Before the shift and after the dip the engine shows its full smoothed throttle.
    expect(frames[up - 1]!.power).toBeCloseTo(frames[up - 1]!.throttle, 12);
    expect(frames[up + dipFrames]!.power).toBeCloseTo(frames[up + dipFrames]!.throttle, 12);
    expect(frames[up + dipFrames]!.power).toBeGreaterThan(0.8);
    // A downshift (kick-down: a hard push in a high gear) does not cut the power.
    const down = run({ gear: 3, holdS: 0, dipS: 0, throttle: 1 }, 1, () => speedAt(3, 2000), () => 1);
    const d = down.findIndex((f) => f.gear === 2);
    expect(d).toBeGreaterThanOrEqual(0);
    expect(down.slice(d).every((f) => !f.dip)).toBe(true);
  });

  it("dips the sound a player hears: the exhaust throttle drops for the shift, then returns", () => {
    const clock = new EngineClock();
    let prev: CarState | null = null;
    const throttles: number[] = [];
    const gains: number[] = [];
    let gear = 1;
    const gearsSeen: number[] = [];
    for (let i = 0; i <= 60 * 6; i++) {
      const c = car({ speed: Math.min(30, 4.5 * i * DT) });
      const p = clock.car("car", c, prev, i === 0 ? 0 : DT);
      prev = c;
      throttles.push(p.throttle);
      gains.push(p.engineGain);
      gearsSeen.push(clock.reading()!.gear);
      gear = clock.reading()!.gear;
    }
    expect(gear).toBeGreaterThan(1);
    const shiftAt = gearsSeen.findIndex((g) => g > 1);
    expect(Math.min(...throttles.slice(shiftAt, shiftAt + 6))).toBeLessThanOrEqual(DIP_THROTTLE + 1e-12);
    expect(Math.max(...throttles.slice(shiftAt - 10, shiftAt))).toBeGreaterThan(0.5);
    expect(Math.max(...throttles.slice(shiftAt + 14, shiftAt + 30))).toBeGreaterThan(0.5);
  });
});

describe("throttle smoothing", () => {
  /** The throttle after `seconds` of asking for `to` from `from`, in 100 even steps. */
  const settle = (from: number, to: number, seconds: number): number => {
    let box: Gearbox = { gear: 0, holdS: 0, dipS: 0, throttle: from };
    for (let i = 0; i < 100; i++) box = stepGearbox(box, 3, to, seconds / 100);
    return box.throttle;
  };

  it("rises faster than it falls", () => {
    // After one time constant the throttle has covered 1 - 1/e of the way; the fall is slower.
    expect(settle(0, 1, THROTTLE_RISE_S)).toBeCloseTo(1 - Math.exp(-1), 2);
    expect(settle(1, 0, THROTTLE_FALL_S)).toBeCloseTo(Math.exp(-1), 2);
    expect(settle(0, 1, 0.3)).toBeGreaterThan(1 - settle(1, 0, 0.3));
    expect(THROTTLE_RISE_S).toBeLessThan(THROTTLE_FALL_S);
  });

  it("stays in 0..1, ignores a zero or negative frame time, and never overshoots", () => {
    const box: Gearbox = { gear: 1, holdS: 0.2, dipS: 0.05, throttle: 0.4 };
    expect(stepGearbox(box, 10, 0.9, 0)).toEqual({ ...box });
    expect(stepGearbox(box, 10, 0.9, -1)).toEqual({ ...box });
    expect(stepGearbox(box, 10, 7, 100).throttle).toBeLessThanOrEqual(1);
    expect(stepGearbox(box, 10, -7, 100).throttle).toBeGreaterThanOrEqual(0);
  });
});

describe("purity", () => {
  it("returns a new state and leaves its input alone; the same input gives the same output", () => {
    const box: Gearbox = Object.freeze({ gear: 1, holdS: 0.3, dipS: 0.1, throttle: 0.5 });
    const a = stepGearbox(box, 14, 1, DT), b = stepGearbox(box, 14, 1, DT);
    expect(a).toEqual(b);
    expect(a).not.toBe(box);
    expect(box).toEqual({ gear: 1, holdS: 0.3, dipS: 0.1, throttle: 0.5 });
  });
});

describe("EngineClock", () => {
  it("keeps the gear across frames, starts a fresh gearbox for a new owner, and forgets on stop", () => {
    const clock = new EngineClock();
    expect(clock.reading()).toBeNull();
    // Drive up through the gears, flat out.
    let prev: CarState | null = null;
    for (let i = 0; i <= 60 * 8; i++) {
      const c = car({ speed: Math.min(32, 5 * i * DT) });
      clock.car("car", c, prev, i === 0 ? 0 : DT);
      prev = c;
    }
    expect(clock.reading()!.gear).toBeGreaterThanOrEqual(3);
    // The same speed under another owner (a taxi taken over) settles from scratch: no throttle history, so it picks high.
    const fresh = clock.ride("ride:7", 32, null, 0);
    expect(fresh.firingHz).toBeCloseTo((engineRpm(32, 0) / 60) * 2, 9);
    expect(clock.reading()!.gear).toBe(pickGear(32, 0) + 1);
    expect(clock.stop()).toBeNull();
    expect(clock.reading()).toBeNull();
  });

  it("keeps the engine at the loudness it had: gain never over the set ceiling, through a full drive", () => {
    const clock = new EngineClock();
    let prev: CarState | null = null;
    let peak = 0;
    for (let i = 0; i <= 60 * 40; i++) {
      const t = i * DT;
      const speed = t < 14 ? 32 * (1 - Math.exp(-t / 5)) : t < 24 ? 32 - 0.6 * (t - 14) : Math.max(0, 26 - 8 * (t - 24));
      const c = car({ speed });
      const p = clock.car("car", c, prev, i === 0 ? 0 : DT);
      prev = c;
      peak = Math.max(peak, p.engineGain);
      expect(p.engineGain).toBeLessThanOrEqual(0.135 + 1e-9);
      expect(p.roarGain).toBeLessThanOrEqual(0.08 + 1e-9);
      expect(p.firingHz).toBeGreaterThanOrEqual((IDLE_RPM / 60) * 2 - 1e-9);
      expect(p.firingHz).toBeLessThanOrEqual((REDLINE_RPM / 60) * 2 + 1e-9);
    }
    expect(peak).toBeGreaterThan(0.09);
  });
});
