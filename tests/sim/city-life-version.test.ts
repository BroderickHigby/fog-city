// v8 -> v13 (city life, preserving the weather/sprint/ride migrations): a real v8 save (recorded by the v8 sim at integrate/wave2 ff7db5b,
// tests/golden/legacy-saves/v8-parked-car.json) of a robotaxi honking behind a car parked in its
// lane. The upgrade only restamps (the new fields are optional), and the upgraded save steps on:
// the robotaxi backs up, goes round the car and merges back, the same after a JSON round trip.
import { describe, expect, it } from "vitest";
import { SIM_VERSION, agentsOf, canonicalJson, hashState, step, upgradeState, type SimState } from "../../src/sim/index.ts";
import saved from "../golden/legacy-saves/v8-parked-car.json";
import { deepFreeze } from "../helpers.ts";
import { LONG_RUN_MS, gridCity } from "./fixtures.ts";

describe("v8 save of a robotaxi held behind a parked car", () => {
  it("upgrades to the current version with every field kept", () => {
    expect(saved.simVersion).toBe(8);
    expect(saved.sourceCommit).toMatch(/^[a-f0-9]{40}$/);
    const old = deepFreeze(saved.state) as unknown as SimState;
    expect(old.version).toBe(8);
    expect(hashState(old)).toBe(saved.hash);
    const before = canonicalJson(old);
    const upgraded = upgradeState(old);
    expect(SIM_VERSION).toBe(15);
    expect(upgraded).toEqual({ ...old, version: SIM_VERSION });
    expect(canonicalJson(old)).toBe(before);
    expect(upgradeState(upgraded)).toBe(upgraded);
    const waiting = agentsOf(old).find((a) => a.id === saved.waiting[0]!.id)!;
    expect(waiting.mode).toBe("honk");
    expect(waiting.pass).toBeUndefined();
  });

  it("steps on: the honking robotaxi goes round the car, deterministically after a JSON round trip", () => {
    const world = gridCity();
    const id = saved.waiting[0]!.id;
    const run = (source: SimState): { hash: string; passed: boolean } => {
      let state = upgradeState(source);
      let passed = false;
      for (let t = 0; t < 1200; t++) {
        state = step(world, state, {});
        const taxi = agentsOf(state).find((a) => a.id === id);
        passed ||= taxi === undefined || (taxi.x > 158 && Math.abs(taxi.z - 101.75) < 0.2);
      }
      return { hash: hashState(state), passed };
    };
    const a = run(deepFreeze(saved.state) as unknown as SimState);
    const b = run(JSON.parse(JSON.stringify(saved.state)) as SimState);
    expect(a.passed).toBe(true);
    expect(a.hash).toBe(b.hash);
  }, LONG_RUN_MS);
});
