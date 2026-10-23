import { describe, expect, it } from "vitest";
import { NEUTRAL_INPUT } from "../../../src/sim/contract.ts";
import type { CombatActor, CombatEvent } from "../../../src/sim/combat-contract.ts";
import { createCombatState } from "../../../src/sim/combat/system.ts";
import { createInitialState } from "../../../src/sim/step.ts";
import { buildWorld, type World } from "../../../src/sim/world.ts";
import { createRobotRuntime, stepRobotRuntime, type RobotRuntimeOptions } from "../../../src/sim/robots/runtime.ts";

const bad: CombatActor = { id: "agent:1", kind: "robot", model: "footman", firmware: "bad", x: 0, y: 0, z: 0,
  heading: 0, speed: 0, radius: 0.4, height: 1.8, inFidelity: true };
const good = { ...bad, id: "agent:2", firmware: "good" as const, z: -2 };
function run(options: Partial<RobotRuntimeOptions> = {}, events: CombatEvent[] = [], world: World = buildWorld([]), player = { x: 20, z: 20 }) {
  const actors = options.actors ?? [bad, good], state = createInitialState(world, 17, ["p"], { ...player, heading: 0 });
  state.ext.combat = createCombatState(17, { actors, players: [], refills: [], walls: [] });
  state.ext.combat.events = events;
  return stepRobotRuntime(createRobotRuntime(), { world, previous: state, state: { ...state, tick: 1 }, inputs: { p: NEUTRAL_INPUT }, events: [] },
    { actors, conversion: { baseBadCount: 1, protectedArea: false }, ...options });
}

describe("runtime catalog goals and tells", () => {
  it("uses the chosen catalog goal and leaves unsupported sabotage pending", () => {
    expect(run().attacks[0]?.kind).toBe("forced-update");
    const updater = run({ catalog: true, catalogArchetypes: { "1": { bad: "updatePusher" } } });
    expect(updater.attacks[0]?.kind).toBe("forced-update");
    expect(updater.catalog.find(item => item.agentId === 1)).toMatchObject({ catalogArchetypeId: "updatePusher", sabotageActive: true });
    const prowler = run({ catalog: true, catalogArchetypes: { "1": { bad: "prowler" } } });
    expect(prowler.attacks).toEqual([]);
    expect(prowler.locomotion.find(item => item.agentId === 1)?.intent.kind).toBe("errand");
    expect(prowler.catalog.find(item => item.agentId === 1)?.pendingGoalIds).toContain("tryCarDoor");
  });

  it("serializes the current wary hide decision without claiming pending tells are visible", () => {
    const config = { catalog: true, catalogLevel: 3, catalogArchetypes: { "1": { bad: "snatcher" } } };
    const normal = run(config).catalog.find(item => item.agentId === 1)!;
    const ping: CombatEvent = { id: 1, tick: 0, kind: "robot.wary", sourceId: "p", targetId: "agent:1", amount: 600, detail: "ping" };
    const wary = run(config, [ping]).catalog.find(item => item.agentId === 1)!;
    expect(normal.tellIds).toContain("emptyBag");
    expect(wary).toMatchObject({ hideOneTell: true, hiddenTellId: "emptyBag", sabotageActive: false });
    expect(wary.tellIds).not.toContain("emptyBag");
    expect(wary.pendingTellIds).toContain("avoidWater");
    expect(wary.presentation.bagFull).toBe(false);
    expect(wary.presentation.bagSwing).toBe(1);
  });

  it("does not turn hearing behind a wall into visual head tracking", () => {
    const config = { actors: [bad], catalog: true, catalogLevel: 2, catalogArchetypes: { "1": { bad: "snatcher" } } };
    const water: CombatEvent = { id: 1, tick: 0, kind: "weapon.water", sourceId: "p", targetId: "", amount: 1, detail: "spray" };
    const wall = buildWorld([{ tileId: "wall", ground: null, buildings: [{ id: "wall", baseY: 0, topY: 10,
      footprint: [[1, -6], [2, -6], [2, 1], [1, 1]] }] }]);
    const hearing = run(config, [water], wall, { x: 5, z: -5 });
    expect(hearing.state.robots[0]?.brain?.knowledge[0]?.channel).toBe("hearing");
    expect(hearing.catalog[0]?.presentation.headYaw).toBeNull();
    expect(run(config, [], buildWorld([]), { x: 5, z: -5 }).catalog[0]?.presentation.headYaw).toBeLessThan(-0.7);
  });

  it("is deterministic under input order and keeps profile selection stable", () => {
    const options = { catalog: true, catalogLevel: 2 };
    const first = run(options), second = run({ ...options, actors: [good, bad] });
    expect(second).toEqual(first);
    expect(JSON.parse(JSON.stringify(first.catalog))).toEqual(first.catalog);
  });

  it("keeps a regenerated ambient incarnation's appearance when its numeric ID changes", () => {
    const source = { seed: 321, key: '["ambient",7,"2,-3",4,9]' };
    const first = run({ actors: [bad], catalog: true, catalogLevel: 3, catalogSources: { "1": source } });
    const reincarnated = run({ actors: [{ ...bad, id: "agent:701" }], catalog: true, catalogLevel: 3,
      catalogSources: { "701": JSON.parse(JSON.stringify(source)) } });
    const { agentId: originalId, ...original } = first.catalog[0]!;
    const { agentId: newId, ...appearance } = reincarnated.catalog[0]!;
    expect(originalId).toBe(1);
    expect(newId).toBe(701);
    expect(appearance).toEqual(original);
    expect(reincarnated.actors[0]?.firmware).toBe("bad");
  });
});
