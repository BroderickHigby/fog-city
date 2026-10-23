import { describe, expect, it } from "vitest";
import { buildWorld, canonicalJson, createGameSystems, hashState, SIM_VERSION, step, upgradeState, type SimState } from "../../src/sim/index.ts";
import saved from "../golden/legacy-saves/v7-gameplay.json";
import { deepFreeze } from "../helpers.ts";

describe("v7 to v8 composed gameplay save migration", () => {
  it("preserves every field of a real v7 save, including opaque extensions", () => {
    expect(saved.simVersion).toBe(7);
    expect(saved.sourceCommit).toMatch(/^[a-f0-9]{40}$/);
    const recorded = saved.state as unknown as SimState;
    expect(hashState(recorded)).toBe(saved.hash);
    expect(recorded.ext.missions?.players.p?.missionId).toBe("hot-desk");
    expect(Object.keys(recorded.ext.robots?.actors ?? {}).length).toBeGreaterThan(0);
    expect(recorded.ext.combat).toBeDefined();
    const old = deepFreeze({ ...recorded, ext: { ...recorded.ext, future: { flags: [true, false], nested: { score: 37 } } } });
    const before = canonicalJson(old);
    const upgraded = upgradeState(old);
    expect(SIM_VERSION).toBe(11);
    expect(upgraded).toEqual({ ...old, version: SIM_VERSION });
    expect(canonicalJson(old)).toBe(before);
    expect(upgradeState(upgraded)).toBe(upgraded);
    expect(upgradeState(JSON.parse(before))).toEqual(upgraded);
  });

  it("resumes the recorded mission and combat state deterministically after a JSON round trip", () => {
    const world = buildWorld([]), systems = createGameSystems({ wave: 2 });
    const run = (source: SimState): SimState => {
      let state = upgradeState(source);
      for (let tick = 0; tick < 60; tick++) state = step(world, state, { p: { throttle: 0, steer: .2, brake: 0, actions: 0 } }, [], systems);
      return state;
    };
    const old = deepFreeze(saved.state) as unknown as SimState;
    const a = run(old), b = run(JSON.parse(JSON.stringify(old)));
    expect(hashState(a)).toBe(hashState(b));
    expect(a.tick).toBe(old.tick + 60);
    expect(a.ext.missions?.players.p?.missionId).toBe("hot-desk");
    expect(a.players.p!.car).toEqual(old.players.p!.car);
    expect(() => canonicalJson(a)).not.toThrow();
  });
});
