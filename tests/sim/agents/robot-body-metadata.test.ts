import { describe, expect, it } from "vitest";
import { Action, NEUTRAL_INPUT, type SimState } from "../../../src/sim/contract.ts";
import { createInitialState } from "../../../src/sim/step.ts";
import { makeFoot } from "../../../src/sim/foot.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import type { SimSystemContext } from "../../../src/sim/system-contract.ts";
import { enableAgentRuntime } from "../../../src/sim/agents/runtime-state.ts";
import { createRoutineRuntime, stepRoutineRuntime } from "../../../src/sim/agents/routine-runtime.ts";

const world = buildWorld([]);
function context(previous: SimState, burst: boolean, emote: boolean): SimSystemContext {
  return { world, previous, state: { ...previous, tick: previous.tick + 1 },
    inputs: { p: { ...NEUTRAL_INPUT, brake: burst ? 1 : 0, actions: emote ? Action.emote : 0 } },
    events: previous.tick === 0 ? [{ kind: "agents.robot-body.start", tick: 1, playerId: "p", payload: { sequence: 1, model: "footman" } }] : [],
  };
}

describe("controlled robot visual metadata", () => {
  it("publishes current emote and burst tells from the real body policy", () => {
    const state = enableAgentRuntime(createInitialState(world, 4, ["p"], { x: 0, z: 0, heading: 0 }), { wave: 7 });
    state.players.p = { ...state.players.p!, mode: "foot", foot: makeFoot(0, 0, 0, 0) };
    const first = stepRoutineRuntime(context(state, true, true), createRoutineRuntime(), { bodies: [], actors: [], nextActorId: 100, spawnBudget: 0 });
    const metadata = first.actorMetadata["player:p"]!;
    expect(metadata).toMatchObject({ robotBody: true, robotEmote: "wave", robotTells: ["battery-overdraw", "battery-calibrating"] });
    expect(JSON.parse(JSON.stringify(metadata))).toEqual(metadata);
    const next: SimState = { ...state, tick: 1, players: { ...state.players, ...first.playerOverrides } };
    const second = stepRoutineRuntime(context(next, false, false), first.state, { bodies: [], actors: [], nextActorId: first.nextActorId, spawnBudget: 0 });
    expect(second.actorMetadata["player:p"]?.robotEmote).toBe("none");
    expect(second.actorMetadata["player:p"]?.robotTells).toContain("battery-overdraw");
    expect(second.actorMetadata["player:p"]?.robotTells).not.toBe(metadata.robotTells);
    expect(metadata.robotEmote).toBe("wave");
  });
});
