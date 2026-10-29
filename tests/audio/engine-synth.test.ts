// The engine's sound sources, without a browser: the firing-pulse loops (one pulse per cylinder
// firing, seamless, in step across banks and takes, brighter on load), the rpm and load
// crossfades (equal power, never pitching a loop far), the lift-off crackle (pops after a lift
// from high rpm, never on an upshift's power cut, at low rpm or when cruising) and the load the
// engine is heard under.
import { describe, expect, it } from "vitest";
import {
  BANK_RPMS, CRACKLE_RPM, CYLINDERS, LIFT_DELAY_S, LOOP_CYCLES, LOOP_PEAK, OFF_LOAD_RMS, ON_LOAD_RMS, OverrunCrackle,
  bankWeights, firingHz, loadWeights, renderEngineLoop,
} from "../../src/audio/vehicle-synth.ts";
import { EngineClock, IDLE_RPM, REDLINE_RPM, engineParams, type EngineParams } from "../../src/audio/vehicle-sound.ts";
import type { CarState } from "../../src/sim/contract.ts";

const RATE = 48_000;
const DT = 1 / 60;
const car = (o: Partial<CarState> = {}): CarState => ({
  x: 0, y: 0, z: 0, heading: 0, speed: 0, steer: 0, hits: 0, lateral: 0, yawRate: 0, vy: 0, grounded: true, airTicks: 0,
  grip: 1, pitch: 0, roll: 0, sinceContact: 600, impactSpeed: 0, landingSpeed: 0, personBumps: 0, nearMisses: 0, ...o,
}) as CarState;

const rms = (d: Float32Array): number => Math.sqrt(d.reduce((s, v) => s + v * v, 0) / d.length);
/** Energy above 400 Hz (a one-pole high-pass), per sample: how much bite a loop has. */
const bite = (d: Float32Array): number => {
  const a = Math.exp((-2 * Math.PI * 400) / RATE);
  let lp = 0, s = 0;
  for (const v of d) {
    lp = a * lp + (1 - a) * v;
    s += (v - lp) ** 2;
  }
  return s / d.length;
};
/** Energy in 0.25 ms frames. */
function envelope(d: Float32Array): number[] {
  const n = Math.round(0.00025 * RATE), out: number[] = [];
  for (let i = 0; i + n <= d.length; i += n) {
    let s = 0;
    for (let j = 0; j < n; j++) s += d[i + j]! ** 2;
    out.push(s);
  }
  return out;
}
/** Circular autocorrelation of a sequence at a lag, normalised. */
function autocorr(e: number[], lag: number): number {
  const m = e.reduce((a, b) => a + b, 0) / e.length;
  let num = 0, den = 0;
  for (let i = 0; i < e.length; i++) {
    num += (e[i]! - m) * (e[(i + lag) % e.length]! - m);
    den += (e[i]! - m) ** 2;
  }
  return num / den;
}
function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  const ma = a.slice(0, n).reduce((s, v) => s + v, 0) / n, mb = b.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i]! - ma) * (b[i]! - mb);
    da += (a[i]! - ma) ** 2;
    db += (b[i]! - mb) ** 2;
  }
  return num / Math.sqrt(da * db);
}

describe("the firing-pulse loops", () => {
  const loops = BANK_RPMS.map((rpm) => ({ rpm, on: renderEngineLoop(RATE, rpm, true), off: renderEngineLoop(RATE, rpm, false) }));

  it("hold exactly LOOP_CYCLES four-stroke cycles, finite, centred and under the peak", () => {
    for (const { rpm, on, off } of loops)
      for (const [take, d, target] of [["on", on, ON_LOAD_RMS], ["off", off, OFF_LOAD_RMS]] as const) {
        const name = `${rpm} ${take}`;
        expect(d.length, name).toBe(Math.round(((LOOP_CYCLES * 120) / rpm) * RATE));
        expect(d.every(Number.isFinite), name).toBe(true);
        expect(Math.abs(d.reduce((s, v) => s + v, 0) / d.length), name).toBeLessThan(1e-4);
        expect(d.reduce((m, v) => Math.max(m, Math.abs(v)), 0), name).toBeLessThanOrEqual(LOOP_PEAK + 1e-6);
        expect(rms(d), name).toBeLessThanOrEqual(target + 1e-6);
        expect(rms(d), name).toBeGreaterThan(0.6 * target);
      }
  });

  it("pulse once per cylinder firing: the waveform repeats at the firing interval and is opposed at half of it", () => {
    for (const { rpm, on, off } of loops)
      for (const [take, d] of [["on", on], ["off", off]] as const) {
        // A firing every 120 / (rpm * cylinders) s.
        const lag = Math.round((120 / (rpm * CYLINDERS)) * RATE);
        const whole = autocorr(Array.from(d), lag), half = autocorr(Array.from(d), Math.round(lag / 2));
        expect(whole, `${rpm} ${take}`).toBeGreaterThan(take === "on" ? 0.5 : 0.25);
        expect(whole, `${rpm} ${take}`).toBeGreaterThan(half + 0.3);
      }
    expect(firingHz(IDLE_RPM)).toBeCloseTo((IDLE_RPM / 60) * 2, 9);
  });

  it("render the same every time, and the on and off takes of a bank fire together", () => {
    expect(renderEngineLoop(RATE, 2000, true)).toEqual(loops[2]!.on);
    for (const { rpm, on, off } of loops) {
      expect(on.length).toBe(off.length);
      expect(correlation(envelope(on), envelope(off)), `${rpm}`).toBeGreaterThan(0.3);
    }
  });

  it("are louder and have more bite on load than off load", () => {
    for (const { rpm, on, off } of loops) {
      expect(bite(on), `${rpm}`).toBeGreaterThan(1.3 * bite(off));
      expect(rms(on), `${rpm}`).toBeGreaterThan(rms(off));
    }
  });
});

describe("the crossfades", () => {
  it("blend two neighbouring banks at equal power and never pitch the main one far", () => {
    for (let rpm = IDLE_RPM; rpm <= REDLINE_RPM; rpm += 25) {
      const w = bankWeights(rpm);
      expect(w.reduce((s, v) => s + v * v, 0), `${rpm}`).toBeCloseTo(1, 9);
      const on = w.flatMap((v, i) => (v > 1e-9 ? [i] : []));
      expect(on.length).toBeLessThanOrEqual(2);
      if (on.length === 2) expect(on[1]! - on[0]!).toBe(1);
      w.forEach((v, i) => {
        if (v > 0.5) {
          const rate = rpm / BANK_RPMS[i]!;
          expect(rate, `${rpm} bank ${i}`).toBeGreaterThan(0.75);
          expect(rate, `${rpm} bank ${i}`).toBeLessThan(1.3);
        }
      });
    }
    BANK_RPMS.forEach((rpm, i) => expect(bankWeights(rpm)[i]).toBeCloseTo(1, 9));
    expect(bankWeights(NaN)).toEqual(bankWeights(IDLE_RPM));
    expect(bankWeights(Infinity)).toEqual(bankWeights(IDLE_RPM));
  });

  it("move from the off-load take to the on-load take as the load rises, at equal power", () => {
    let last = loadWeights(0);
    expect(last.off).toBeGreaterThan(0.95);
    for (let l = 0.05; l <= 1; l += 0.05) {
      const w = loadWeights(l);
      expect(w.on * w.on + w.off * w.off).toBeCloseTo(1, 9);
      expect(w.on).toBeGreaterThan(last.on);
      last = w;
    }
    expect(loadWeights(1).on).toBeCloseTo(1, 9);
    expect(loadWeights(NaN)).toEqual(loadWeights(0));
  });
});

/** A drive through EngineClock, as the synth hears it: rpm and power each frame, plus the pops. */
function drive(speedAt: (t: number) => number, seconds: number): { t: number; rpm: number; power: number; pops: number }[] {
  const clock = new EngineClock(), crackle = new OverrunCrackle(), out: { t: number; rpm: number; power: number; pops: number }[] = [];
  let prev: CarState | null = null;
  for (let i = 0; i * DT <= seconds; i++) {
    const c = car({ speed: speedAt(i * DT) });
    const p: EngineParams = clock.car("player", c, prev, DT);
    prev = c;
    const rpm = p.firingHz * 30;
    out.push({ t: i * DT, rpm, power: p.throttle, pops: crackle.step(rpm, p.throttle, DT).length });
  }
  return out;
}

/** Full throttle from a stop (about 4.6 m/s², easing with speed), to 27.8 m/s by about 7.9 s. */
const pull = (t: number): number => (4.6 / 0.07) * (1 - Math.exp(-0.07 * t));
const PULL_END = Math.log(1 - (27.8 * 0.07) / 4.6) / -0.07;

describe("the lift-off crackle", () => {
  it("never pops through a full-throttle run up the gears, upshift cuts included", () => {
    const frames = drive(pull, PULL_END);
    expect(frames.some((f) => f.power < 0.1 && f.t > 1)).toBe(true); // the upshift cuts are in the run
    expect(frames.reduce((s, f) => s + f.pops, 0)).toBe(0);
  });

  it("pops after a lift from high rpm, not before LIFT_DELAY_S of lifted throttle, and dies away", () => {
    const top = pull(PULL_END);
    const frames = drive((t) => (t < PULL_END ? pull(t) : Math.max(0, top - 1.1 * (t - PULL_END))), PULL_END + 6);
    const after = frames.filter((f) => f.t >= PULL_END);
    const first = after.find((f) => f.pops > 0);
    expect(first).toBeTruthy();
    expect(first!.rpm).toBeGreaterThan(CRACKLE_RPM);
    const lifted = after.find((f) => f.power < 0.2)!;
    expect(first!.t - lifted.t).toBeGreaterThanOrEqual(LIFT_DELAY_S - DT);
    const pops = after.reduce((s, f) => s + f.pops, 0);
    expect(pops).toBeGreaterThanOrEqual(4);
    expect(pops).toBeLessThan(80);
    expect(after.filter((f) => f.t > PULL_END + 4.5).reduce((s, f) => s + f.pops, 0)).toBe(0);
  });

  it("stays quiet on a lift at low rpm, when cruising, and stops at once back on the throttle", () => {
    const low = new OverrunCrackle();
    let n = 0;
    for (let i = 0; i < 60; i++) n += low.step(2000, 0.9, DT).length;
    for (let i = 0; i < 240; i++) n += low.step(2000, 0, DT).length;
    expect(n).toBe(0);
    const cruise = new OverrunCrackle();
    for (let i = 0; i < 600; i++) n += cruise.step(3500, 0.1, DT).length;
    expect(n).toBe(0);
    const back = new OverrunCrackle();
    for (let i = 0; i < 60; i++) back.step(5000, 0.9, DT);
    let lifted = 0;
    for (let i = 0; i < 40; i++) lifted += back.step(5000, 0, DT).length;
    expect(lifted).toBeGreaterThan(0);
    let again = 0;
    for (let i = 0; i < 60; i++) again += back.step(5000, 0.9, DT).length;
    expect(again).toBe(0);
  });

  it("takes non-finite input without throwing or returning a non-finite pop", () => {
    const c = new OverrunCrackle();
    for (let i = 0; i < 60; i++) c.step(5000, 0.9, DT);
    for (const [rpm, power, dt] of [[NaN, 0, DT], [5000, NaN, DT], [5000, 0, NaN], [Infinity, 0, Infinity], [5000, 0, DT]] as const)
      for (let i = 0; i < 30; i++)
        for (const p of c.step(rpm, power, dt)) for (const v of Object.values(p)) expect(Number.isFinite(v)).toBe(true);
  });
});

describe("the load the engine is heard under", () => {
  it("rises with the throttle, holds some at a steady speed, and drops on a coast", () => {
    for (let v = 0; v <= 40; v += 0.5)
      for (const prev of [v, v - 0.2, v + 0.3]) {
        const l = engineParams(car({ speed: v }), car({ speed: prev }), DT).load;
        expect(l).toBeGreaterThanOrEqual(0);
        expect(l).toBeLessThanOrEqual(1);
      }
    const hold = engineParams(car({ speed: 25 }), car({ speed: 25 }), DT).load;
    const push = engineParams(car({ speed: 25.06 }), car({ speed: 25 }), DT).load;
    const coast = engineParams(car({ speed: 24.98 }), car({ speed: 25 }), DT).load; // -1.2 m/s²
    expect(push).toBeGreaterThan(hold);
    expect(hold).toBeGreaterThan(0.1);
    expect(coast).toBeLessThan(0.05);
    expect(engineParams(car(), car(), DT).load).toBe(0);
  });
});
