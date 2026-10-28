// The car and feet sound model: engine and road layers follow speed and load, squeal follows
// slip and hard braking, impacts and landings scale with their speed, doors play on getting in
// and out, and footsteps keep a pace-appropriate cadence.
import { describe, expect, it } from "vitest";
import { CRUISE_SHIFT_RPM, FootstepClock, GEAR_TOP_MPS, IDLE_RPM, REDLINE_RPM, STEP_INTERVAL_S, RIDE_CABIN, carOneShots, doorOneShots, engineParams, engineRpm, pace, rideEngineParams } from "../../src/audio/vehicle-sound.ts";
import type { CarState, FootState } from "../../src/sim/contract.ts";

const car = (o: Partial<CarState> = {}): CarState => ({
  x: 0, y: 0, z: 0, heading: 0, speed: 0, steer: 0, hits: 0, lateral: 0, yawRate: 0, vy: 0, grounded: true, airTicks: 0,
  grip: 1, pitch: 0, roll: 0, sinceContact: 600, impactSpeed: 0, landingSpeed: 0, personBumps: 0, nearMisses: 0, ...o,
}) as CarState;
const foot = (o: Partial<FootState> = {}): FootState => ({ x: 0, y: 0, z: 0, heading: 0, speed: 0, sprint: false, vy: 0, grounded: true, dodge: null, ...o }) as FootState;

describe("engine and road", () => {
  it("idles at idle RPM, revs up within a gear, and drops on each upshift", () => {
    const idle = engineParams(car(), car(), 1 / 60);
    expect(idle.firingHz).toBe((IDLE_RPM / 60) * 2); // four cylinders: two firings per turn
    expect(idle.engineGain).toBeGreaterThan(0);
    expect(idle.roarGain).toBe(0);
    for (let v = 0; v <= 40; v += 0.25) {
      expect(engineRpm(v)).toBeGreaterThanOrEqual(IDLE_RPM);
      expect(engineRpm(v)).toBeLessThanOrEqual(REDLINE_RPM);
    }
    expect(engineRpm(6)).toBeGreaterThan(engineRpm(3));
    // Pulling hard revs each gear to the redline before the upshift; cruising shifts early.
    for (const top of GEAR_TOP_MPS.slice(0, -1)) {
      expect(engineRpm(top)).toBeCloseTo(REDLINE_RPM, 6);
      expect(engineRpm(top + 0.1)).toBeLessThan(engineRpm(top) * 0.8);
    }
    expect(engineRpm(30, 0)).toBeLessThanOrEqual(CRUISE_SHIFT_RPM);
    expect(engineRpm(30, 0)).toBeGreaterThan(2500);
    expect(engineRpm(12, 0)).toBeLessThan(engineRpm(12, 1));
    // Road noise rises and brightens with speed.
    let last = idle;
    for (const speed of [5, 10, 20, 30]) {
      const p = engineParams(car({ speed }), car({ speed }), 1 / 60);
      expect(p.roarGain).toBeGreaterThan(last.roarGain);
      expect(p.roarCutoff).toBeGreaterThan(last.roarCutoff);
      last = p;
    }
    // Reversing sounds like driving forward at the same speed.
    expect(engineParams(car({ speed: -8 }), car({ speed: -8 }), 1 / 60).firingHz).toBe(engineParams(car({ speed: 8 }), car({ speed: 8 }), 1 / 60).firingHz);
  });

  it("stays quiet: engine, road and squeal never pass their set ceilings", () => {
    for (let v = 0; v <= 40; v += 0.5)
      for (const prev of [v, v - 0.2, v + 0.3]) {
        const p = engineParams(car({ speed: v, lateral: 6, grip: 0 }), car({ speed: prev }), 1 / 60);
        expect(p.engineGain).toBeLessThanOrEqual(0.135 + 1e-9);
        expect(p.roarGain).toBeLessThanOrEqual(0.08 + 1e-9);
        expect(p.squealGain).toBeLessThanOrEqual(0.25 + 1e-9);
      }
  });

  it("strains under acceleration and goes quiet on the road in the air", () => {
    const cruise = engineParams(car({ speed: 10 }), car({ speed: 10 }), 1 / 60);
    const push = engineParams(car({ speed: 10.1 }), car({ speed: 10 }), 1 / 60); // 6 m/s²
    expect(push.engineGain).toBeGreaterThan(cruise.engineGain);
    expect(push.throttle).toBeGreaterThan(cruise.throttle);
    expect(engineParams(car({ speed: 20, grounded: false }), car({ speed: 20 }), 1 / 60).roarGain).toBe(0);
  });

  it("squeals on a slide, on lost grip and on hard braking at speed, never parked or airborne", () => {
    expect(engineParams(car({ speed: 15 }), car({ speed: 15 }), 1 / 60).squealGain).toBe(0);
    expect(engineParams(car({ speed: 15, lateral: 4 }), car({ speed: 15 }), 1 / 60).squealGain).toBeGreaterThan(0.15);
    expect(engineParams(car({ speed: 15, grip: 0.3 }), car({ speed: 15 }), 1 / 60).squealGain).toBeGreaterThan(0.15);
    expect(engineParams(car({ speed: 14.75 }), car({ speed: 15 }), 1 / 60).squealGain).toBeGreaterThan(0.15); // -15 m/s²
    expect(engineParams(car({ speed: 1, lateral: 4 }), car({ speed: 1 }), 1 / 60).squealGain).toBe(0);
    expect(engineParams(car({ speed: 15, lateral: 4, grounded: false }), car({ speed: 15 }), 1 / 60).squealGain).toBe(0);
  });
});

describe("impacts, landings and doors", () => {
  it("plays an impact per new hit, louder and lower the harder it was", () => {
    expect(carOneShots(car({ hits: 2 }), car({ hits: 2 }))).toEqual([]);
    const soft = carOneShots(car({ hits: 1, impactSpeed: 2 }), car())[0]!;
    const hard = carOneShots(car({ hits: 1, impactSpeed: 14 }), car())[0]!;
    expect(soft.sound).toBe("impact");
    expect(hard.gain).toBeGreaterThan(soft.gain);
    expect(hard.rate!).toBeLessThan(soft.rate!);
    expect(carOneShots(car({ hits: 1 }), null)).toEqual([]);
  });

  it("thumps on landing from a real jump only", () => {
    expect(carOneShots(car({ grounded: true, landingSpeed: 6 }), car({ grounded: false, airTicks: 30 }))[0]).toMatchObject({ sound: "impact", landing: true });
    expect(carOneShots(car({ grounded: true, landingSpeed: 0.5 }), car({ grounded: false }))).toEqual([]);
  });

  it("opens and shuts a door getting in or out, and only then", () => {
    expect(doorOneShots("vehicle", "foot").map((d) => d.sound)).toEqual(["door-open", "door-close"]);
    expect(doorOneShots("foot", "vehicle").map((d) => d.sound)).toEqual(["door-open", "door-close"]);
    expect(doorOneShots("foot", "foot")).toEqual([]);
    expect(doorOneShots(undefined, "vehicle")).toEqual([]);
    expect(doorOneShots("foot", "vehicle")[1]!.delayS).toBeGreaterThan(0);
  });
});

describe("footsteps", () => {
  it("reads the pace from speed and sprint", () => {
    expect(pace(foot())).toBe("still");
    expect(pace(foot({ speed: 1.4 }))).toBe("walk");
    expect(pace(foot({ speed: 3 }))).toBe("jog");
    expect(pace(foot({ speed: 3, sprint: true }))).toBe("sprint");
    expect(pace(foot({ speed: 3, grounded: false }))).toBe("still");
  });

  it("steps at the pace's cadence, the first promptly, cycling four variants, silent when still", () => {
    for (const [p, f] of [["walk", foot({ speed: 1.4 })], ["jog", foot({ speed: 3 })], ["sprint", foot({ speed: 6, sprint: true })]] as const) {
      const clock = new FootstepClock();
      const times: number[] = [], variants: number[] = [];
      for (let t = 0; t < 10; t += 1 / 60) {
        const s = clock.update(f, 1 / 60);
        if (s) { times.push(t); variants.push(s.variant); }
      }
      expect(times[0]!, p).toBeLessThan(0.2);
      const expected = Math.floor((10 - times[0]!) / STEP_INTERVAL_S[p]) + 1;
      expect(Math.abs(times.length - expected), p).toBeLessThanOrEqual(1);
      for (let i = 1; i < variants.length; i++) expect(variants[i]).not.toBe(variants[i - 1]);
      expect(new Set(variants).size).toBe(4);
    }
    const still = new FootstepClock();
    for (let i = 0; i < 600; i++) expect(still.update(foot(), 1 / 60)).toBeNull();
    expect(still.update(null, 1 / 60)).toBeNull();
  });
});

describe("riding a robotaxi", () => {
  it("hears the taxi's engine from the back seat: softer than driving, rising with speed, never a squeal", () => {
    const slow = rideEngineParams(4, 4, 1 / 60), fast = rideEngineParams(20, 20, 1 / 60);
    expect(fast.firingHz).toBeGreaterThan(slow.firingHz);
    expect(fast.roarGain).toBeGreaterThan(slow.roarGain);
    const driving = engineParams(car({ speed: 20 }), car({ speed: 20 }), 1 / 60);
    expect(fast.engineGain).toBeCloseTo(driving.engineGain * RIDE_CABIN, 9);
    expect(fast.roarGain).toBeCloseTo(driving.roarGain * RIDE_CABIN, 9);
    expect(rideEngineParams(20, 26, 1 / 60).squealGain).toBe(0);
    expect(rideEngineParams(0, null, 0).firingHz).toBe((IDLE_RPM / 60) * 2);
  });
});
