import { describe, expect, it } from "vitest";
import { Action } from "../../../src/sim/contract.ts";
import { makeFoot } from "../../../src/sim/foot.ts";
import { allocateActorIds } from "../../../src/sim/identity.ts";
import { createInitialState, step } from "../../../src/sim/step.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import { contextFromState } from "../../../src/sim/combat/adapter.ts";
import { createCombatSystem } from "../../../src/sim/combat/systems.ts";
import { createObservedGameplayProvider } from "../../../src/sim/player/adapter.ts";
import { createAgentsSystem, agentsCombatOptions } from "../../../src/sim/agents/systems.ts";
import { agentsRuntimeOf, type RuntimeSpawn } from "../../../src/sim/agents/runtime.ts";
import { renderWithRuntimeActors } from "../../../src/render/runtime-actors.ts";

const world = buildWorld([]);
const idle = { throttle: 0, steer: 0, brake: 0, actions: 0 };

describe("physical runtime admission boundary", () => {
  it("keeps a blocked actor out of combat, watching and rendering, then admits the same identity", () => {
    const initial = createInitialState(world, 7, ["p"], { x: 0, z: 0, heading: 0 });
    initial.players.p!.mode = "foot";
    initial.players.p!.foot = makeFoot(0, 0, 5, 0);
    const reserved = allocateActorIds(initial, ["blocked"]);
    const id = reserved.ids.blocked!;
    const spawn: RuntimeSpawn = { id: "blocked", numericId: id, model: "footman", firmware: "bad",
      x: 0, y: 0, z: 0, heading: 0, radius: .4, height: 1.8 };
    const systems = [
      createAgentsSystem(() => ({ spawns: [spawn], services: false })),
      createCombatSystem(ctx => ({ context: contextFromState(world, ctx.state, agentsCombatOptions(ctx.state)) })),
    ];
    const observing = createObservedGameplayProvider({ actors: ctx => contextFromState(world, ctx.state, agentsCombatOptions(ctx.state)).actors });
    let state = reserved.state;
    let waitingBrain: string | undefined;
    for (let tick = 0; tick < 40; tick++) {
      const previous = state;
      state = step(world, state, { p: { ...idle, actions: Action.watch | Action.fire } }, [], systems);
      const runtime = agentsRuntimeOf(state)!;
      expect(state.ext.agents!.list.some(body => body.runtimeId === spawn.id)).toBe(false);
      expect(state.ext.combat!.targets[spawn.id]).toBeUndefined();
      expect(agentsCombatOptions(state).extraActors).toEqual([]);
      expect(runtime.attacks).toEqual([]);
      expect(renderWithRuntimeActors(state, Object.values(runtime.actors)).ext.agents!.list).toEqual([]);
      expect(observing({ world, previous, state, inputs: { p: { ...idle, actions: Action.watch } }, events: [] }).observations[0]!.watchingActorId).toBeUndefined();
      expect(state.ext.identities!.ids.blocked).toBe(id);
      if (tick === 0) waitingBrain = JSON.stringify(runtime.actors.blocked!.brain);
      else expect(JSON.stringify(runtime.actors.blocked!.brain)).toBe(waitingBrain);
    }
    state = { ...state, players: { p: { ...state.players.p!, car: { ...state.players.p!.car, x: 40 } } } };
    state = step(world, state, {}, [], systems);
    const runtime = agentsRuntimeOf(state)!;
    expect(state.ext.agents!.list.filter(body => body.runtimeId === spawn.id).map(body => body.id)).toEqual([id]);
    expect(runtime.actors.blocked!.numericId).toBe(id);
    expect(state.ext.combat!.targets[spawn.id]).toBeDefined();
    expect(agentsCombatOptions(state).extraActors!.map(actor => actor.id)).toEqual([spawn.id]);
    expect(renderWithRuntimeActors(state, Object.values(runtime.actors)).ext.agents!.list.map(body => body.id)).toEqual([id]);
  });

  it("retains the existing flying-drone path without a ground proxy", () => {
    const initial = createInitialState(world, 11, ["p"], { x: 30, z: 30, heading: 0 });
    const drone: RuntimeSpawn = { id: "drone", numericId: 20, model: "drone", firmware: "good",
      x: 0, y: 6, z: 0, heading: 0, radius: .4, height: 1 };
    const state = step(world, initial, {}, [], [createAgentsSystem(() => ({ spawns: [drone], services: false }))]);
    expect(state.ext.agents!.list).toEqual([]);
    expect(agentsCombatOptions(state).extraActors!.map(actor => actor.id)).toEqual(["drone"]);
  });

  it("does not let an admitted robot pursue or convert a pending actor", () => {
    const initial = createInitialState(world, 19, ["p"], { x: 0, z: 0, heading: 0 });
    initial.players.p!.mode = "foot";
    initial.players.p!.foot = makeFoot(100, 0, 100, 0);
    const spawns: RuntimeSpawn[] = [
      { id: "waiting", numericId: 10, model: "footman", firmware: "good", x: 0, y: 0, z: 0, heading: 0, radius: .4, height: 1.8 },
      { id: "admitted", numericId: 11, model: "footman", firmware: "bad", x: 2, y: 0, z: 0, heading: -Math.PI / 2, radius: .4, height: 1.8 },
    ];
    const systems = [createAgentsSystem(() => ({ spawns, services: false }))];
    let state = initial;
    for (let tick = 0; tick < 4; tick++) state = step(world, state, {}, [], systems);
    const runtime = agentsRuntimeOf(state)!;
    expect(runtime.actors.waiting!.behavior).toBe("pending-admission");
    expect(state.ext.agents!.list.some(body => body.runtimeId === "admitted")).toBe(true);
    expect(runtime.actors.admitted!.brain!.update).toBeNull();
    expect(runtime.attacks).toEqual([]);
  });
});
