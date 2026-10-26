import { describe, expect, it } from "vitest";
import { buildWorld, canonicalJson, createGameSystems, hashState, SIM_VERSION, step, upgradeState, type SimState } from "../../src/sim/index.ts";
import saved from "../golden/legacy-saves/v7-gameplay.json";
import saved8 from "../golden/legacy-saves/v8-gameplay.json";
import saved10 from "../golden/legacy-saves/v10-gameplay.json";
import { deepFreeze } from "../helpers.ts";

describe("v7 to current composed gameplay save migration", () => {
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
    // v7 -> v8 -> v10 -> v11 -> v12 -> v13 (v9 is reserved for the structural world): behaviour only, every field kept;
    // v13 -> v14 (people dodging on their feet) changes only dodges in flight: this save has none.
    expect(SIM_VERSION).toBe(15);
    expect(upgraded).toEqual({ ...old, version: SIM_VERSION });
    expect(upgradeState(deepFreeze({ ...old, version: 8 }))).toEqual(upgraded);
    expect(upgradeState(deepFreeze({ ...old, version: 10 }))).toEqual(upgraded);
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

describe("v8 to v10 weather save migration (v9 is the structural world's reserved stamp)", () => {
  it("preserves every field of a real wave-3 v8 save and never writes stamp 9", () => {
    expect(saved8.simVersion).toBe(8);
    expect(saved8.wave).toBe(3);
    expect(saved8.sourceCommit).toMatch(/^[a-f0-9]{40}$/);
    const recorded = saved8.state as unknown as SimState;
    expect(hashState(recorded)).toBe(saved8.hash);
    expect(recorded.ext.fog).toBeUndefined();
    const old = deepFreeze({ ...recorded, ext: { ...recorded.ext, future: { kept: [1, 2] } } });
    const before = canonicalJson(old);
    const upgraded = upgradeState(old);
    // (Through weather, sprint, rides, unlimited water and on-foot dodging: no fields change here.)
    expect(upgraded).toEqual({ ...old, version: SIM_VERSION });
    expect(canonicalJson(old)).toBe(before);
    expect(upgradeState(upgraded)).toBe(upgraded);
    expect(() => upgradeState({ ...old, version: 9 })).toThrow("cannot upgrade");
  });

  it("resumes at wave 3 with the weather reducer filling ext.fog, deterministically after a JSON round trip", () => {
    const world = buildWorld([]), systems = createGameSystems({ wave: 3 });
    const run = (source: SimState): SimState => {
      let state = upgradeState(source);
      for (let tick = 0; tick < 60; tick++) state = step(world, state, { p: { throttle: 0, steer: .2, brake: 0, actions: 0 } }, [], systems);
      return state;
    };
    const old = deepFreeze(saved8.state) as unknown as SimState;
    const a = run(old), b = run(JSON.parse(JSON.stringify(old)));
    expect(hashState(a)).toBe(hashState(b));
    expect(a.tick).toBe(old.tick + 60);
    expect(a.ext.fog).toEqual({ version: 1, missionCursor: expect.any(Number), windows: [] });
    expect(a.ext.missions?.players.p?.missionId).toBe(old.ext.missions?.players.p?.missionId);
    expect(() => canonicalJson(a)).not.toThrow();
  });
});

describe("v10 to current unlimited-water save migration", () => {
  it("preserves every field of a real wave-3 v10 save", () => {
    expect(saved10.simVersion).toBe(10);
    expect(saved10.sourceCommit).toMatch(/^[a-f0-9]{40}$/);
    const recorded = saved10.state as unknown as SimState;
    expect(hashState(recorded)).toBe(saved10.hash);
    expect(recorded.ext.fog).toBeDefined();
    const old = deepFreeze({ ...recorded, ext: { ...recorded.ext, future: { kept: [1, 2] } } });
    const before = canonicalJson(old);
    const upgraded = upgradeState(old);
    expect(upgraded).toEqual({ ...old, version: SIM_VERSION });
    expect(canonicalJson(old)).toBe(before);
    expect(upgradeState(upgraded)).toBe(upgraded);
  });

  it("keeps spraying from a saved, nearly empty tank without draining it", () => {
    const world = buildWorld([]), systems = createGameSystems({ wave: 3 });
    let state = upgradeState(deepFreeze(saved10.state) as unknown as SimState);
    const combat = state.ext.combat!;
    state = { ...state, ext: { ...state.ext, combat: { ...combat, players: { ...combat.players, p: { ...combat.players.p!, water: 0.01 } } } } };
    let shots = 0;
    for (let tick = 0; tick < 120; tick++) {
      state = step(world, state, { p: { throttle: 0, steer: 0, brake: 0, actions: 2, aimYaw: tick * 0.05, aimPitch: 0 } }, [], systems);
      shots += state.ext.combat!.events.filter(event => event.kind === "weapon.water").length;
    }
    expect(shots).toBeGreaterThanOrEqual(15);
    expect(state.ext.combat!.players.p!.water).toBe(0.01);
  });
});

describe("v13 to v14 live conversion budget save migration", () => {
  it("preserves every field of a real wave-3 v10 save (through v13), including the saved baseBadCount", () => {
    expect(saved10.simVersion).toBe(10);
    const recorded = saved10.state as unknown as SimState;
    expect(hashState(recorded)).toBe(saved10.hash);
    const old = deepFreeze({ ...recorded, ext: { ...recorded.ext, future: { kept: [1, 2] } } });
    const before = canonicalJson(old);
    const upgraded = upgradeState(old);
    expect(upgraded).toEqual({ ...old, version: SIM_VERSION });
    expect(upgraded.ext.robots?.baseBadCount).toBe(recorded.ext.robots?.baseBadCount);
    expect(canonicalJson(old)).toBe(before);
    expect(upgradeState(upgraded)).toBe(upgraded);
  });
});
