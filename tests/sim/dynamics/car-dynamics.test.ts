// Vehicle dynamics (car.ts, SIM_VERSION 12): the owner asked for faster, more realistic driving.
// A modern-EV car: 0-100 km/h in 4-6 s, about 180-200 km/h flat out, realistic braking distances
// (longer in the wet), cornering held to the tyres' grip (understeer at the limit), braking and
// cornering sharing that grip (a friction circle), weight transfer, a handbrake that kicks the
// tail out into a controllable slide, calm steering at speed, and reverse.
import { describe, expect, it } from "vitest";
import { CAR, makeCar, stepCar, type CarState, type SimInput } from "../../../src/sim/index.ts";
import { emptyWorld } from "../fixtures.ts";

const I = (throttle: number, steer = 0, brake = 0): SimInput => ({ throttle, steer, brake, actions: 0 });
const KMH = 1 / 3.6;
const w = emptyWorld();

function run(c0: CarState, ticks: number, input: (t: number, c: CarState) => SimInput, traction = 1): CarState[] {
  const out = [c0];
  for (let t = 0; t < ticks; t++) out.push(stepCar(w, out[out.length - 1]!, input(t, out[out.length - 1]!), [], traction));
  return out;
}

describe("straight line", () => {
  it("0-100 km/h takes 4-6 s and top speed is 180-200 km/h", () => {
    const cs = run(makeCar(0, 0, 0), 60 * 60, () => I(1));
    const t100 = cs.findIndex((c) => c.speed >= 100 * KMH) / 60;
    expect(t100).toBeGreaterThanOrEqual(4);
    expect(t100).toBeLessThanOrEqual(6);
    const top = cs[cs.length - 1]!.speed / KMH;
    expect(top).toBeGreaterThanOrEqual(180);
    expect(top).toBeLessThanOrEqual(200);
    // Flat out it has settled: no further gain in its last 10 s.
    expect(cs[cs.length - 1]!.speed - cs[cs.length - 601]!.speed).toBeLessThan(0.3);
  });

  it("stops from 100 km/h in a realistic distance, longer in the wet", () => {
    const stop = (traction: number): number => {
      const cs = run({ ...makeCar(0, 0, 0), speed: 100 * KMH }, 600, () => I(0, 0, 1), traction);
      const end = cs.find((c) => c.speed === 0)!;
      expect(end).toBeDefined();
      return -end.z;
    };
    const dry = stop(1);
    expect(dry).toBeGreaterThan(30);
    expect(dry).toBeLessThan(42);
    const wet = stop(0.72);
    expect(wet).toBeGreaterThan(dry * 1.25);
    expect(wet).toBeLessThan(60);
  });

  it("reverses at up to about 8 m/s", () => {
    const cs = run(makeCar(0, 0, 0), 600, () => I(-1));
    expect(cs[cs.length - 1]!.speed).toBeLessThan(-7);
    expect(cs[cs.length - 1]!.speed).toBeGreaterThanOrEqual(-CAR.maxReverse - 1e-9);
  });
});

describe("cornering", () => {
  /** Full lock at a held speed: the steady lateral acceleration (speed x yaw rate) over the last second. */
  const steady = (v: number, traction = 1): { lat: number; speed: number } => {
    const cs = run({ ...makeCar(0, 0, 0), speed: v }, 300, (t, c) => I(c.speed < v ? 0.4 : 0, 1), traction);
    const tail = cs.slice(-60);
    return { lat: Math.max(...tail.map((c) => Math.abs(c.speed * c.yawRate))), speed: cs[cs.length - 1]!.speed };
  };

  it("holds to the tyres' grip at the limit: about 1 g, never more, and less in the wet", () => {
    for (const v of [12, 20, 28]) {
      const s = steady(v);
      expect(s.lat, `${v} m/s`).toBeGreaterThan(0.75 * CAR.gripAccel);
      expect(s.lat, `${v} m/s`).toBeLessThanOrEqual(CAR.gripAccel * (1 + CAR.maxTransfer) + 0.05);
    }
    expect(steady(20, 0.72).lat).toBeLessThan(steady(20).lat * 0.8);
  });

  it("understeers past the limit: more lock at speed only scrubs speed", () => {
    const s = steady(30);
    expect(s.speed).toBeLessThan(29);
  });

  it("braking and cornering share the grip (friction circle): turning while braking hard turns less", () => {
    const turn = (brakeOn: boolean): number => {
      const cs = run({ ...makeCar(0, 0, 0), speed: 20 }, 40, () => (brakeOn ? I(-1, 0.6) : I(0, 0.6)));
      return Math.abs(cs[cs.length - 1]!.heading);
    };
    expect(turn(true)).toBeLessThan(turn(false));
  });

  it("steering is calm at speed: the wheels turn slower, and to less lock", () => {
    const at = (v: number): number => stepCar(w, { ...makeCar(0, 0, 0), speed: v }, I(0, 1)).steer;
    expect(at(50)).toBeLessThan(at(5) * 0.5);
  });
});

describe("handbrake", () => {
  it("kicks the tail out into a slide toward the steer, which the car recovers from when it is released", () => {
    const cs = run({ ...makeCar(0, 0, 0), speed: 20 }, 240, (t) => I(t < 40 ? 0 : 0.4, t < 120 ? 1 : 0, t < 40 ? 1 : 0));
    // The kick: yaw toward the steer (clockwise) at once.
    expect(cs[1]!.yawRate).toBeGreaterThan(CAR.handbrakeKick * 0.8);
    // It slides (sideways speed and grip lost), then grips again.
    expect(Math.max(...cs.slice(0, 60).map((c) => Math.abs(c.lateral)))).toBeGreaterThan(3);
    expect(Math.min(...cs.slice(0, 60).map((c) => c.grip))).toBeLessThan(0.5);
    expect(cs[cs.length - 1]!.grip).toBeGreaterThan(0.95);
    expect(Math.abs(cs[cs.length - 1]!.lateral)).toBeLessThan(0.5);
  });
});

describe("determinism", () => {
  it("the same inputs give the same car, bit for bit", () => {
    const input = (t: number): SimInput => I(t % 200 < 150 ? 1 : -1, Math.sin(t / 30), t % 300 > 250 ? 1 : 0);
    const a = run(makeCar(0, 0, 0), 1200, input);
    const b = run(makeCar(0, 0, 0), 1200, input);
    expect(JSON.stringify(a[a.length - 1])).toBe(JSON.stringify(b[b.length - 1]));
  });
});
