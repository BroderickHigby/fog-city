import { describe, expect, it } from "vitest";
import {
  Action, HALF_PI, SIM_VERSION, canonicalJson, createInitialState, hashState,
  sanitizeInput, step, upgradeState, type InputFrame, type SimState, type SimSystem,
} from "../../src/sim/index.ts";
import baseline from "../golden/wave1-v2.json";
import v11Replay from "../golden/wave2-v11.json";
import currentReplay from "../golden/wave2-v14.json";
import { deepFreeze, loadWorld } from "../helpers.ts";
import { loadDevWorldWithRoads } from "./fixtures.ts";

describe("wave-2 shared interface", () => {
  it("preserves all existing action bits and assigns distinct new bits", () => {
    expect([Action.enterExit, Action.fire, Action.scan, Action.horn]).toEqual([1, 2, 4, 8]);
    expect([Action.gadget, Action.cone, Action.interact, Action.streak, Action.emote, Action.watch, Action.altFire])
      .toEqual([16, 32, 64, 128, 256, 512, 1024]);
  });

  it("preserves missing legacy aim and clamps supplied controls to finite values", () => {
    const legacy = { throttle: 2, steer: -2, brake: -1, actions: 0 };
    expect(sanitizeInput(legacy)).toEqual({ throttle: 1, steer: -1, brake: 0, actions: 0 });
    expect(sanitizeInput({ ...legacy, aimYaw: NaN, aimPitch: Infinity })).toEqual(sanitizeInput(legacy));
    const aimed = sanitizeInput({ ...legacy, aimYaw: 1e300, aimPitch: 2 });
    expect(Number.isFinite(aimed.aimYaw)).toBe(true);
    expect(Math.abs(aimed.aimYaw!)).toBeLessThanOrEqual(Math.PI);
    expect(aimed.aimPitch).toBe(HALF_PI);
    expect(sanitizeInput({ ...legacy, aimPitch: -2 }).aimPitch).toBe(-HALF_PI);
    expect(sanitizeInput({ ...legacy, aimYaw: 0, aimPitch: 0 })).toHaveProperty("aimYaw", 0);
    expect(() => canonicalJson(aimed)).not.toThrow();
  });

  it("upgrades the actual v2 snapshot without resetting player, traffic or unknown state", () => {
    const old = deepFreeze({ ...baseline.initial, ext: { ...baseline.initial.ext, future: { keep: [1, true] } } }) as unknown as SimState;
    const upgraded = upgradeState(old);
    expect(upgraded.version).toBe(SIM_VERSION);
    expect(upgraded).toMatchObject({ ...old, version: SIM_VERSION });
    expect(upgraded.players.p1!.car.nearMisses).toBe(0);
    expect(old.version).toBe(2);
    expect(upgradeState(upgraded)).toBe(upgraded);
    const walking = deepFreeze({ ...old, players: { ...old.players, p1: { ...old.players.p1!, mode: "foot" as const, foot: { x: 1, y: 2, z: 3, heading: .5, speed: 1, sprint: false }, exitPending: true } } });
    expect(upgradeState(walking as unknown as SimState).players.p1).toMatchObject(walking.players.p1);
  });

  it("repairs every intermediate save without mutating or resetting live fields", () => {
    for (const version of [2, 3, 4, 5, 6]) {
      const old = deepFreeze({ ...baseline.initial, version, players: {
        ...baseline.initial.players, p1: { ...baseline.initial.players.p1,
          mode: "foot", foot: { x: 1, y: 2, z: 3, heading: .5, speed: 1, sprint: false },
        },
      }, ext: { future: { keep: true } } }) as unknown as SimState;
      const upgraded = upgradeState(old);
      expect(upgraded.version).toBe(SIM_VERSION);
      expect(upgraded.players.p1!.foot).toMatchObject({ vy: 0, grounded: true, dodge: null });
      expect(upgraded.players.p1!.car.nearMisses).toBe(0);
      expect(upgraded.ext.future).toEqual({ keep: true });
      expect(old.version).toBe(version);
      const live = deepFreeze({ ...upgraded, version, players: { ...upgraded.players,
        p1: { ...upgraded.players.p1!, car: { ...upgraded.players.p1!.car, nearMisses: 12 },
          foot: { ...upgraded.players.p1!.foot!, vy: -2, grounded: false } },
      } });
      expect(upgradeState(live).players.p1).toMatchObject({ car: { nearMisses: 12 }, foot: { vy: -2, grounded: false } });
      expect(upgradeState(JSON.parse(JSON.stringify(old)))).toEqual(upgraded);
    }
  });

  it("isolates extension slots from the previous tick before hooks and reducers", () => {
    const { world, manifest } = loadWorld("dev");
    const previous = deepFreeze(createInitialState(world, 42, ["p1"], manifest.spawn));
    const system: SimSystem = { key: "combat", prepare: context => {
      context.state.ext.prepared = true;
      return { state: context.state, motions: [] };
    }, step: context => {
      context.state.ext.reduced = true;
      return context.state;
    } };
    const next = step(world, previous, {}, [], [system]);
    expect(previous.ext).toEqual({});
    expect(next.ext).toMatchObject({ prepared: true, reduced: true });
  });

  it("replays the unchanged wave-1 input log through the deliberate physics migration", () => {
    const { world } = loadDevWorldWithRoads();
    let state = upgradeState(deepFreeze(baseline.initial) as unknown as SimState);
    for (let i = 0; i < baseline.segments.length; i++) {
      const segment = baseline.segments[i]!;
      for (let tick = 0; tick < segment.ticks; tick++) state = step(world, state, segment.inputs as InputFrame, [], []);
      // v11 changes the on-foot pace, which the log's last (walking) segment uses; v14
      // (impacts.ts) changes it only where a car meets a robotaxi (player 2 rear-ends one in the
      // last segment). The first four segments still match the v11 fixture payload exactly.
      // Normalize only the version header for an exact payload check.
      expect(hashState({ ...state, version: currentReplay.simVersion })).toBe(currentReplay.hashes[i]);
      if (i < 4) expect(hashState({ ...state, version: v11Replay.simVersion })).toBe(v11Replay.hashes[i]);
    }
    expect(state.players.p1!.mode).toBe("foot");
    expect(state.tick).toBe(300);
  });

  it("rejects unavailable intermediate and future migrations", () => {
    for (const version of [0, -1, 2.5, 9, SIM_VERSION + 1, NaN]) {
      expect(() => upgradeState({ ...baseline.initial, version } as unknown as SimState)).toThrow("cannot upgrade");
    }
  });

  it("runs systems in fixed order after movement even without roads", () => {
    const { world, manifest } = loadWorld("dev");
    const previous = deepFreeze(createInitialState(world, 42, ["z", "a"], manifest.spawn));
    const calls: string[] = [];
    const combat: SimSystem = { key: "combat", step: context => {
      calls.push("combat");
      expect(context.previous.tick).toBe(0);
      expect(context.state.tick).toBe(1);
      expect(context.state.players.a!.car.z).not.toBe(previous.players.a!.car.z);
      expect(Object.keys(context.inputs)).toEqual(["a", "z"]);
      expect(context.inputs.a!.throttle).toBe(1);
      expect(context.inputs.z).toEqual({ throttle: 0, steer: 0, brake: 0, actions: 0 });
      return { ...context.state, ext: { ...context.state.ext, future: { order: "combat" } } };
    } };
    const missions: SimSystem = { key: "missions", step: context => {
      calls.push("missions");
      expect(context.state.ext.future).toEqual({ order: "combat" });
      return { ...context.state, ext: { ...context.state.ext, future: { started: true } } };
    } };
    const inputs = deepFreeze({ a: { throttle: 5, steer: 0, brake: 0, actions: 0 } });
    const a = step(world, previous, inputs, [], Object.freeze([missions, combat]));
    expect(calls).toEqual(["combat", "missions"]);
    calls.length = 0;
    expect(step(world, previous, inputs, [], [combat, missions])).toEqual(a);
    expect(previous.ext).toEqual({});
    expect(inputs.a.throttle).toBe(5);
  });

  it("rejects duplicate registrations and reducers that change the clock", () => {
    const { world, manifest } = loadWorld("dev");
    const previous = createInitialState(world, 1, ["p1"], manifest.spawn);
    const noop: SimSystem = { key: "combat", step: context => context.state };
    expect(() => step(world, previous, {}, [], [noop, noop])).toThrow("duplicate");
    const bad: SimSystem = { key: "combat", step: context => ({ ...context.state, tick: context.state.tick + 1 }) };
    expect(() => step(world, previous, {}, [], [bad])).toThrow("changed tick or version");
    const wrongVersion: SimSystem = { key: "combat", step: context => ({ ...context.state, version: 999 }) };
    expect(() => step(world, previous, {}, [], [wrongVersion])).toThrow("changed tick or version");
    expect(() => step(world, previous, {}, [], [{ ...noop, key: "unknown" } as unknown as SimSystem])).toThrow("Invalid");
  });
});
