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
