import { describe, expect, it } from "vitest";
import { canonicalJson, createInitialState, hashState, step, type InputFrame, type SimState } from "../../src/sim/index.ts";
import { deepFreeze, loadWorld } from "../helpers.ts";

const { world, manifest } = loadWorld("dev");

/** A scripted drive: accelerate, weave, brake, reverse. Two players. */
function inputsAt(t: number): InputFrame {
  return {
    p1: { throttle: t < 300 ? 1 : t < 400 ? -1 : 0.4, steer: Math.sign(((t / 45) | 0) % 2 - 0.5), brake: t > 500 ? 1 : 0, actions: 0 },
    p2: { throttle: 0.7, steer: t % 120 < 60 ? 0.6 : -0.3, brake: 0, actions: 0 },
  };
}

function run(ticks: number): SimState {
  let s = createInitialState(world, 42, ["p1", "p2"], manifest.spawn);
  for (let t = 0; t < ticks; t++) s = step(world, s, inputsAt(t));
  return s;
}

describe("sim determinism", () => {
  it("same seed + same inputs => identical state", () => {
    expect(hashState(run(600))).toBe(hashState(run(600)));
  });

  it("step never mutates its input state", () => {
    let s = deepFreeze(createInitialState(world, 7, ["p1"], manifest.spawn));
    for (let t = 0; t < 120; t++) s = deepFreeze(step(world, s, inputsAt(t)));
    expect(s.tick).toBe(120);
  });

  it("state survives a canonical JSON round trip unchanged", () => {
    const s = run(240);
    const copy = JSON.parse(canonicalJson(s)) as SimState;
    expect(hashState(step(world, copy, inputsAt(240)))).toBe(hashState(step(world, s, inputsAt(240))));
  });

  it("player.join events spawn a player on the right tick", () => {
    let s = createInitialState(world, 1, ["p1"], manifest.spawn);
    s = step(world, s, {}, [{ tick: 1, kind: "player.join", playerId: "p9", payload: { x: 10, z: 5, heading: 0 } }]);
    expect(Object.keys(s.players).sort()).toEqual(["p1", "p9"]);
    expect(() => step(world, s, {}, [{ tick: 99, kind: "player.leave", playerId: "p9" }])).toThrow();
  });
});

// ---------------------------------------------------------------- v2: players + agents

import { Action, SIM_VERSION, agentsOf, upgradeState } from "../../src/sim/index.ts";
import { gridCity, loadDevWorldWithRoads } from "./fixtures.ts";

/** Two players: p1 drives, slides, gets out, walks, gets back in; p2 joins later and weaves. */
function richInputs(t: number): InputFrame {
  const p1 =
    t < 400
      ? { throttle: 1, steer: Math.sign(((t / 50) | 0) % 2 - 0.5) * 0.6, brake: t > 300 && t < 340 ? 1 : 0, actions: 0 }
      : t < 900
        ? { throttle: t < 700 ? 0.8 : -0.5, steer: Math.sin(t / 30), brake: t % 200 < 20 ? 1 : 0, actions: t === 800 ? Action.enterExit : 0 }
        : { throttle: 1, steer: Math.sin(t / 40) * 0.5, brake: t % 300 < 30 ? 1 : 0, actions: t === 1200 || t === 1500 ? Action.enterExit : 0 };
  return { p1, p2: { throttle: 0.6, steer: t % 240 < 120 ? 0.5 : -0.4, brake: 0, actions: t === 2000 ? Action.enterExit : 0 } };
}

function richRun(world: typeof gridWorld, ticks: number, from?: SimState): SimState {
  let s = from ?? createInitialState(world, 99, ["p1"], { x: -20, z: 150, heading: 0 });
  for (let t = s.tick; t < ticks; t++) {
    const events = t + 1 === 600 ? [{ tick: 600, kind: "player.join", playerId: "p2", payload: { x: -25, z: 120, heading: 1 } }] : [];
    s = step(world, s, richInputs(t), events);
  }
  return s;
}

const gridWorld = gridCity(true);

describe("sim determinism with players and agents", () => {
  it("same seed + same inputs => identical state after 3000 ticks with traffic, robots and people", () => {
    const a = richRun(gridWorld, 3000);
    const b = richRun(gridWorld, 3000);
    expect(agentsOf(a).length).toBeGreaterThan(50);
    expect(Object.keys(a.players).sort()).toEqual(["p1", "p2"]);
    expect(hashState(a)).toBe(hashState(b));
  });

  it("a canonical JSON round trip mid-run changes nothing downstream", () => {
    const mid = richRun(gridWorld, 1500);
    const copy = JSON.parse(canonicalJson(mid)) as SimState;
    expect(hashState(copy)).toBe(hashState(mid));
    expect(hashState(richRun(gridWorld, 3000, copy))).toBe(hashState(richRun(gridWorld, 3000, mid)));
  });

  it("state is plain JSON at every step (no undefined, NaN, Infinity, Map or class)", () => {
    let s = createInitialState(gridWorld, 5, ["p1"], { x: -20, z: 150, heading: 0 });
    for (let t = 0; t < 1200; t++) {
      s = step(gridWorld, s, richInputs(t));
      if (t % 50 !== 0) continue;
      // canonicalJson throws on undefined and non-finite numbers; a dropped key, a Map (which
      // serialises as {}) or a class instance would change the text after a round trip.
      const text = canonicalJson(s);
      expect(canonicalJson(JSON.parse(text))).toBe(text);
      expect(JSON.parse(JSON.stringify(s))).toEqual(JSON.parse(text));
    }
  });

  it("step never mutates its input, with agents, walkers and joins", () => {
    let s = deepFreeze(createInitialState(gridWorld, 3, ["p1"], { x: -20, z: 150, heading: 0 }));
    for (let t = 0; t < 1300; t++) {
      const events = t + 1 === 600 ? [{ tick: 600, kind: "player.join", playerId: "p2", payload: { x: -25, z: 120, heading: 1 } }] : [];
      s = deepFreeze(step(gridWorld, s, richInputs(t), events));
    }
    expect(s.tick).toBe(1300);
    expect(s.players.p1!.mode).toBe("foot"); // got out at t = 1200
  });

  it("the dev world with its roads.json is deterministic over 3000 ticks", () => {
    const { world, spawn } = loadDevWorldWithRoads();
    const go = (): SimState => {
      let s = createInitialState(world, 42, ["p1", "p2"], spawn);
      for (let t = 0; t < 3000; t++) s = step(world, s, inputsAt(t));
      return s;
    };
    const a = go();
    expect(agentsOf(a).length).toBeGreaterThan(5);
    expect(hashState(a)).toBe(hashState(go()));
  });

  it("different seeds give different worlds", () => {
    const a = createInitialState(gridWorld, 1, ["p1"], { x: -20, z: 150, heading: 0 });
    const b = createInitialState(gridWorld, 2, ["p1"], { x: -20, z: 150, heading: 0 });
    expect(hashState(a)).not.toBe(hashState(b));
  });

  it("upgradeState lifts a v1 save to the current version", () => {
    const v1 = {
      version: 1,
      tick: 10,
      seed: 4,
      rng: [1, 2, 3, 4],
      players: { p1: { id: "p1", mode: "vehicle", car: { x: 1, y: 0, z: 2, heading: 0.5, speed: 3, steer: 0.1, hits: 2 } } },
      ext: {},
    } as unknown as SimState;
    const v2 = upgradeState(v1);
    expect(v2.version).toBe(SIM_VERSION);
    expect(v2.players.p1!.car).toMatchObject({ x: 1, z: 2, heading: 0.5, speed: 3, steer: 0.1, hits: 2, grip: 1, grounded: true });
    expect(v2.players.p1!.foot).toBeNull();
    expect(v2.players.p1!.exitPending).toBe(false);
    expect(() => step(loadWorld("dev").world, v2, {})).not.toThrow();
    expect(upgradeState(v2)).toBe(v2);
  });
});
