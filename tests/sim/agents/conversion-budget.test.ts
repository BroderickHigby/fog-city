// The forced-update budget is live: converted robots may at most match the bad robots now
// active that were not converted. A base fixed at the runtime's first tick went stale as the
// city admitted more robots, so every forced update stopped (in SF: base 5, 19 bad active).
import { describe, expect, it } from "vitest";
import { buildWorld, createGameSystems, createInitialState, makeFoot, step, type SimState } from "../../../src/sim/index.ts";
import { createAgentsRuntime, naturalBadCount, type RuntimeSpawn } from "../../../src/sim/agents/runtime.ts";
import { agentsCombatOptions } from "../../../src/sim/agents/systems.ts";

const world = buildWorld([]);
const bot = (id: string, numericId: number, firmware: "good" | "bad", x: number, z: number, heading = 0): RuntimeSpawn =>
  ({ id, numericId, model: "footman", firmware, x, y: 0, z, heading, radius: 0.4, height: 1.8 });

/** Two bad robots at the first tick; six once the city has grown. */
function grown(): SimState {
  let state = createInitialState(world, 31, ["p"], { x: 0, z: 30, heading: 0 });
  state = { ...state, players: { p: { ...state.players.p!, mode: "foot", foot: makeFoot(0, 0, 14, Math.PI) } } };
  const first = createAgentsRuntime(state, { spawns: [bot("early-a", 10, "bad", 80, 0), bot("early-b", 11, "bad", -80, 0)] });
  expect(first.baseBadCount).toBe(2);
  // The pusher faces the good robot 2 m east of it; the player stands 14 m south, looking away.
  const later = createAgentsRuntime(state, { spawns: [
    bot("early-a", 10, "bad", 80, 0), bot("early-b", 11, "bad", -80, 0),
    bot("pusher", 12, "bad", 0, 0, Math.PI / 2), bot("late-a", 13, "bad", 0, -60), bot("late-b", 14, "bad", 60, -60), bot("late-c", 15, "bad", -60, -60),
    bot("mark", 16, "good", 2, 0),
  ] });
  const runtime = { ...later, baseBadCount: first.baseBadCount };
  return { ...state, ext: { ...state.ext, robots: runtime as unknown as NonNullable<SimState["ext"]["robots"]> } };
}

describe("live conversion budget", () => {
  it("counts the bad robots active now, not the first tick's", () => {
    const state = grown();
    expect(state.ext.robots!.baseBadCount).toBe(2);
    expect(naturalBadCount(state)).toBe(6);
    expect(agentsCombatOptions(state).conversionCap).toBe(12);
  });

  it("still lets an update pusher start a forced update after the population passes twice the first count", () => {
    let state = grown();
    const systems = createGameSystems({ wave: 3, protectedArea: () => false });
    let started = false;
    for (let tick = 0; tick < 900 && !started; tick++) {
      state = step(world, state, { p: { throttle: 0, steer: 0, brake: 0, actions: 0 } }, [], systems);
      started = (state.ext.combat?.attacks ?? []).some(attack => attack.kind === "forced-update" && attack.attackerId === "pusher");
    }
    expect(started).toBe(true);
  });

  it("converted robots never count toward the base", () => {
    const state = grown();
    const robots = state.ext.robots!;
    const converted = { ...robots, actors: { ...robots.actors, mark: { ...robots.actors.mark!, firmware: "bad" as const, converted: true } } };
    expect(naturalBadCount({ ...state, ext: { ...state.ext, robots: converted } })).toBe(6);
  });
});
