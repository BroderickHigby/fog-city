import { describe, expect, it } from "vitest";
import {
  Action, createInitialState, step, type SimState, type SimSystem,
} from "../../src/sim/index.ts";
import { deepFreeze } from "../helpers.ts";
import { loadDevWorldWithRoads } from "./fixtures.ts";

const { world, spawn } = loadDevWorldWithRoads();

function pausedState(until = 180): SimState {
  const state = createInitialState(world, 91, ["p1", "p2"], spawn);
  return {
    ...state,
    ext: { ...state.ext, combat: {
      version: 1, tick: 0, rng: [...state.rng], nextId: 1, players: {}, targets: {},
      projectiles: [], gadgets: [], attacks: [], attackSequence: {}, events: [], pauseUntil: until,
    } },
  };
}

/** Only advances the combat clock; the combat lane owns all combat deadline adjustments. */
const combat: SimSystem = { key: "combat", step: context => ({
  ...context.state,
  ext: { ...context.state.ext, combat: { ...context.state.ext.combat!, tick: context.state.tick } },
}) };

describe("AGI world pause", () => {
  it("freezes movement, traffic, RNG and other systems for exactly 180 ticks", () => {
    const before = deepFreeze(pausedState());
    let state: SimState = before;
    let otherCalls = 0;
    let prepareCalls = 0;
    const robots: SimSystem = { key: "robots", prepare: context => {prepareCalls++;return {state:context.state,motions:[]};}, step: context => {
      otherCalls++;
      return context.state;
    } };
    const input = { p1: { throttle: 1, steer: .5, brake: 0, actions: Action.enterExit } };
    for (let tick = 1; tick <= 180; tick++) {
      state = step(world, state, input, [], [robots, combat]);
      expect(state.tick).toBe(tick);
      expect(state.ext.combat!.tick).toBe(tick);
      expect(state.players).toEqual(before.players);
      expect(state.ext.agents).toEqual(before.ext.agents);
      expect(state.rng).toEqual(before.rng);
    }
    expect(otherCalls).toBe(0);
    expect(prepareCalls).toBe(0);
    state = step(world, state, input, [], [robots, combat]);
    expect(state.tick).toBe(181);
    expect(state.players.p1!.mode).toBe("foot");
    expect(otherCalls).toBe(1);
    expect(prepareCalls).toBe(1);
    expect(state.ext.agents).not.toEqual(before.ext.agents);
  });

  it("consumes membership events and exposes sanitized inputs while paused", () => {
    const before = deepFreeze(pausedState(2));
    const events = deepFreeze([
      { tick: 1, kind: "player.leave", playerId: "p2" },
      { tick: 1, kind: "player.join", playerId: "p3", payload: { x: 100, z: 10, heading: 0 } },
    ]);
    let calls = 0;
    const observer: SimSystem = { key: "combat", step: context => {
      calls++;
      expect(Object.keys(context.state.players).sort()).toEqual(["p1", "p3"]);
      expect(context.previous.players.p2).toBeUndefined();
      expect(context.inputs.p3!.throttle).toBe(1);
      expect(context.state.players.p3!.car).toMatchObject({ x: 100, z: 10, speed: 0 });
      expect(context.events).toEqual(events);
      return combat.step!(context);
    } };
    const state = step(world, before, { p3: { throttle: 3, steer: 0, brake: 0, actions: 0 } }, events, [observer]);
    expect(state.tick).toBe(1);
    expect(state.players.p1).toEqual(before.players.p1);
    expect(state.players.p2).toBeUndefined();
    expect(before.players.p2).toBeDefined();
    expect(calls).toBe(1);
  });
});
