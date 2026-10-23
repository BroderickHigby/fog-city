// Street incidents on the map (v11 city life): a bad robot the director staged for this player
// shows as a bounty blip at its position and as a BotBounty card; once melted, neither shows.
import { describe, expect, it } from "vitest";
import { createGameSystems, createInitialState, makeFoot, step, type SimState } from "../../src/sim/index.ts";
import { agentsRuntimeOf } from "../../src/sim/agents/runtime.ts";
import { uiProjection } from "../../src/ui/projection.ts";
import type { RoadGraph } from "../../src/render/types.ts";
import { gridCity } from "../sim/fixtures.ts";

describe("street-level bounties", () => {
  it("a staged incident's bad robot is a bounty blip and a BotBounty card for its player only", () => {
    const world = gridCity(), systems = createGameSystems({ wave: 2, protectedArea: () => false });
    let s = createInitialState(world, 7, ["p1", "p2"], { x: -20, z: 150, heading: 0 });
    s = { ...s, players: { ...s.players, p1: { ...s.players.p1!, mode: "foot", foot: makeFoot(150, 0, 107, Math.PI / 2) } } };
    for (let t = 0; t < 5; t++) s = step(world, s, {}, [], systems);
    const activities = s.ext.activities as unknown as Record<string, unknown>;
    s = { ...s, ext: { ...s.ext, activities: { ...activities, events: [{ id: 9999, tick: s.tick, kind: "director.stage", playerId: "p1", targetId: "crosswalk-squatter", amount: 0, detail: "" }] } as never } } as SimState;
    s = step(world, s, {}, [], systems);
    const incident = Object.values(agentsRuntimeOf(s)!.incidents!)[0]!;
    const target = agentsRuntimeOf(s)!.actors[incident.targetIds[0]!]!;
    const view = uiProjection(s, "p1", world.roads as unknown as RoadGraph);
    const blip = view.map.blips.find((b) => b.kind === "bounty");
    expect(blip).toBeDefined();
    expect(blip!.label).toBe("Crosswalk squatter");
    expect(Math.hypot(blip!.x - target.x, blip!.z - target.z)).toBeLessThan(0.01);
    expect(view.bounties?.map((b) => b.title)).toEqual(["Crosswalk squatter"]);
    const other = uiProjection(s, "p2", world.roads as unknown as RoadGraph);
    expect(other.map.blips.some((b) => b.kind === "bounty")).toBe(false);
    // Melted (any phase but active): no longer on the map.
    const combat = s.ext.combat!;
    const melted = { ...s, ext: { ...s.ext, combat: { ...combat, targets: { ...combat.targets, [target.id]: { ...(combat.targets[target.id] ?? {}), phase: "heap" } } } } } as SimState;
    expect(uiProjection(melted, "p1", world.roads as unknown as RoadGraph).map.blips.some((b) => b.kind === "bounty")).toBe(false);
  });
});
