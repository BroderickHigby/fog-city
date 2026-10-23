import { afterEach, describe, expect, it, vi } from "vitest";
import { Action } from "../../../src/sim/contract.ts";
import type { CombatActor } from "../../../src/sim/combat-contract.ts";
import { makeFoot } from "../../../src/sim/foot.ts";
import { createInitialState } from "../../../src/sim/step.ts";
import * as geometry from "../../../src/sim/world.ts";
import { enableAgentRuntime } from "../../../src/sim/agents/runtime-state.ts";
import { createRoutineRuntime, stepRoutineRuntime, type RoutineRuntimeOptions } from "../../../src/sim/agents/routine-runtime.ts";

const world = geometry.buildWorld([]);
const good: CombatActor = { id: "agent:40", kind: "robot", firmware: "good", model: "footman", x: 2, y: 0, z: 0,
  heading: 0, speed: 0, radius: 0.4, height: 1.8 };
const bad: CombatActor = { ...good, id: "agent:41", firmware: "bad", x: 3 };
function run(options: Partial<RoutineRuntimeOptions>, activeRoster = false) {
  const initial = enableAgentRuntime(createInitialState(world, 13, ["p"], { x: 0, z: 0, heading: 0 }), { wave: 4 });
  const previous = { ...initial, players: { p: { ...initial.players.p!, mode: "foot" as const, foot: makeFoot(0, 0, 0, 0) } } };
  const routine = createRoutineRuntime();
  if (activeRoster) routine.recruits = [{ playerId: "p", state: { lastTick: 0, roster: [
    { id: good.id, ownerId: "p", x: good.x, y: good.y, z: good.z, phase: "follow", nextSpotTick: 0, requestSequence: 0 },
  ] } }];
  return stepRoutineRuntime({ world, previous, state: { ...previous, tick: 1 },
    inputs: { p: { throttle: 0, steer: 0, brake: 0, actions: Action.interact } }, events: [] }, routine,
  { bodies: [], actors: [good, bad], nextActorId: 1000, spawnBudget: 0, ...options });
}

afterEach(() => vi.restoreAllMocks());
describe("lazy recruit sight", () => {
  it.each([
    { reputations: { p: 0 } },
    { reputations: { p: 59 }, recruitOffers: { [good.id]: { playerId: "p", offeredTick: 0 } } },
    { reputations: { p: 60 }, recruitOffers: { [bad.id]: { playerId: "p", offeredTick: 0 } } },
  ])("does no line-of-sight work without a roster or eligible joining actor", options => {
    const spy = vi.spyOn(geometry, "segmentBlocked");
    const result = run(options);
    expect(result.state.recruits[0]!.state.roster).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("retains same-tick sight and spotting for a newly accepted recruit", () => {
    const spy = vi.spyOn(geometry, "segmentBlocked");
    const result = run({ reputations: { p: 60 }, recruitOffers: { [good.id]: { playerId: "p", offeredTick: 0 } } });
    expect(result.state.recruits[0]!.state.roster.map(recruit => recruit.id)).toEqual([good.id]);
    expect(result.effects.some(effect => effect.kind === "recruit.spot" && effect.targetId === bad.id)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("keeps existing recruits' sight even when reputation later falls", () => {
    const spy = vi.spyOn(geometry, "segmentBlocked");
    const result = run({ reputations: { p: 0 } }, true);
    expect(result.effects.some(effect => effect.kind === "recruit.spot" && effect.targetId === bad.id)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
