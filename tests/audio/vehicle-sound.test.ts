// The car and feet sound model: engine and road layers follow speed and load, squeal follows
// slip and hard braking, impacts and landings scale with their speed, doors play on getting in
// and out, and footsteps keep a pace-appropriate cadence.
import { describe, expect, it } from "vitest";
import { FootstepClock, IDLE_WHINE_HZ, STEP_INTERVAL_S, RIDE_CABIN, carOneShots, doorOneShots, engineParams, pace, rideEngineParams } from "../../src/audio/vehicle-sound.ts";
import type { CarState, FootState } from "../../src/sim/contract.ts";

const car = (o: Partial<CarState> = {}): CarState => ({
  x: 0, y: 0, z: 0, heading: 0, speed: 0, steer: 0, hits: 0, lateral: 0, yawRate: 0, vy: 0, grounded: true, airTicks: 0,
  grip: 1, pitch: 0, roll: 0, sinceContact: 600, impactSpeed: 0, landingSpeed: 0, personBumps: 0, nearMisses: 0, ...o,
}) as CarState;
const foot = (o: Partial<FootState> = {}): FootState => ({ x: 0, y: 0, z: 0, heading: 0, speed: 0, sprint: false, vy: 0, grounded: true, dodge: null, ...o }) as FootState;

describe("engine and road", () => {
  it("idles with a faint hum, and the whine rises in pitch and level with speed", () => {
    const idle = engineParams(car(), car(), 1 / 60);
    expect(idle.whineHz).toBe(IDLE_WHINE_HZ);
    expect(idle.whineGain).toBeGreaterThan(0);
    expect(idle.roarGain).toBe(0);
    let last = idle;
    for (const speed of [5, 10, 20, 30]) {
      const p = engineParams(car({ speed }), car({ speed }), 1 / 60);
      expect(p.whineHz).toBeGreaterThan(last.whineHz);
      expect(p.whineGain).toBeGreaterThan(last.whineGain);
      expect(p.roarGain).toBeGreaterThan(last.roarGain);
      expect(p.roarCutoff).toBeGreaterThan(last.roarCutoff);
      last = p;
    }
    // Reversing sounds like driving forward at the same speed.
    expect(engineParams(car({ speed: -8 }), car({ speed: -8 }), 1 / 60).whineHz).toBe(engineParams(car({ speed: 8 }), car({ speed: 8 }), 1 / 60).whineHz);
  });

  it("strains under acceleration and goes quiet on the road in the air", () => {
    const cruise = engineParams(car({ speed: 10 }), car({ speed: 10 }), 1 / 60);
    const push = engineParams(car({ speed: 10.1 }), car({ speed: 10 }), 1 / 60); // 6 m/s²
    expect(push.whineGain).toBeGreaterThan(cruise.whineGain);
    expect(engineParams(car({ speed: 20, grounded: false }), car({ speed: 20 }), 1 / 60).roarGain).toBe(0);
  });

  it("squeals on a slide, on lost grip and on hard braking at speed, never parked or airborne", () => {
    expect(engineParams(car({ speed: 15 }), car({ speed: 15 }), 1 / 60).squealGain).toBe(0);
    expect(engineParams(car({ speed: 15, lateral: 4 }), car({ speed: 15 }), 1 / 60).squealGain).toBeGreaterThan(0.2);
    expect(engineParams(car({ speed: 15, grip: 0.3 }), car({ speed: 15 }), 1 / 60).squealGain).toBeGreaterThan(0.2);
    expect(engineParams(car({ speed: 14.75 }), car({ speed: 15 }), 1 / 60).squealGain).toBeGreaterThan(0.2); // -15 m/s²
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
  it("hears the taxi's motor from the back seat: softer than driving, rising with speed, never a squeal", () => {
    const slow = rideEngineParams(4, 4, 1 / 60), fast = rideEngineParams(20, 20, 1 / 60);
    expect(fast.whineHz).toBeGreaterThan(slow.whineHz);
    expect(fast.roarGain).toBeGreaterThan(slow.roarGain);
    const driving = engineParams(car({ speed: 20 }), car({ speed: 20 }), 1 / 60);
    expect(fast.whineGain).toBeCloseTo(driving.whineGain * RIDE_CABIN, 9);
    expect(fast.roarGain).toBeCloseTo(driving.roarGain * RIDE_CABIN, 9);
    expect(rideEngineParams(20, 26, 1 / 60).squealGain).toBe(0);
    expect(rideEngineParams(0, null, 0).whineHz).toBe(IDLE_WHINE_HZ);
  });
});
