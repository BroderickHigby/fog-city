import { describe, expect, it } from "vitest";
import { createInitialState, makeFoot, canonicalJson, type SimState } from "../../../src/sim/index.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import { planAgentRuntime, type AgentRuntimeOptions } from "../../../src/sim/agents/runtime.ts";

const world = buildWorld([]);
const spawn = { id: "rogue", numericId: 10, model: "footman" as const, firmware: "bad" as const,
  x: 0, y: 0, z: 0, heading: 0, radius: .4, height: 1.8 };
const options: AgentRuntimeOptions = { wave: 3, engagePlayers: true, services: false, spawns: [spawn] };

function initial(version = 17): SimState {
  const state = createInitialState(world, 1, ["p"], { x: 0, z: -4, heading: Math.PI });
  return { ...state, version };
}

describe("encounter protection query reuse", () => {
  it.each([16, 17])("evaluates the driving actor's protection once in v%s while retaining sight and eligibility", version => {
    const state = initial(version), before = canonicalJson(state), calls: [number, number][] = [];
    const runtime = planAgentRuntime(world, state, {}, { ...options, protectedArea: (x, z) => { calls.push([x, z]); return false; } });
    expect(calls).toEqual([[0, 0]]);
    const brain = runtime.actors.rogue!.brain!;
    expect(brain.mode).toBe("disguised");
    expect(brain.knowledge).toMatchObject([{ playerId: "p", channel: "sight" }]);
    if (version >= 17) expect(brain.knowledge[0]!.targetable).toBe(false);
    else expect(brain.knowledge[0]).not.toHaveProperty("targetable");
    expect(canonicalJson(state)).toBe(before);
  });

  it("retains independent foot-player protection and mixed-player encounter selection", () => {
    const state = initial(), calls: [number, number][] = [];
    state.players.p = { ...state.players.p!, mode: "foot", foot: makeFoot(0, 0, -4, Math.PI) };
    state.players.q = { ...state.players.p, id: "q", foot: makeFoot(2, 0, -3, Math.PI) };
    const runtime = planAgentRuntime(world, state, {}, { ...options,
      protectedArea: (x, z) => { calls.push([x, z]); return x > 1 && z < 0; },
    });
    expect(calls).toEqual([[0, 0], [0, -4], [2, -3]]);
    const brain = runtime.actors.rogue!.brain!;
    expect(brain.mode).toBe("alerted");
    expect(brain.knowledge.find(player => player.playerId === "p")!.targetable).toBe(true);
    expect(brain.knowledge.find(player => player.playerId === "q")!.targetable).toBe(false);
    expect(runtime.actors.rogue!.intent!.movement).toMatchObject({ kind: "hold", face: { x: 0, z: -4 } });
  });
});
