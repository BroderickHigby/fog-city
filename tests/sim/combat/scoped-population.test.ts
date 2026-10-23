import { describe, expect, it } from "vitest";
import type { CombatActor, CombatContext } from "../../../src/sim/combat-contract.ts";
import { createCombatState } from "../../../src/sim/combat/system.ts";
import { stepAttacks } from "../../../src/sim/combat/attacks.ts";

function actor(id: string, x: number, firmware: "good" | "bad" = "bad", model: "footman" | "walker" = "footman"): CombatActor {
  return { id, x, y: 0, z: 0, heading: 0, speed: 0, kind: "robot", firmware, model, radius: 0.4, height: 1.8, inFidelity: true };
}

describe("scoped physical conversion population", () => {
  it("counts a real Walker but leaves its exposed joint proxies out of global headroom", () => {
    const physical = [actor("agent:1", 0), actor("agent:2", 2, "good"), actor("agent:3", 20, "bad", "walker")];
    const joints = [0, 1, 2, 3].map(index => actor(`agent:3/weak/${index}`, 20, "bad", "walker"));
    const context: CombatContext = { actors: [...physical, ...joints], players: [], walls: [], refills: [], conversionCap: 3,
      conversionScopes: [{ id: "local", actorIds: physical.map(actor => actor.id), cap: 3 }],
      attacks: [{ id: "update", sequence: 1, attackerId: "agent:1", targetId: "agent:2", kind: "forced-update" }] };
    const state = createCombatState(1, context);
    state.tick = 1; stepAttacks(state, context, {});
    expect(state.attacks).toHaveLength(1);
    const until = state.attacks[0]!.resolveTick;
    while (state.tick < until) { state.tick++; state.events = []; stepAttacks(state, { ...context, attacks: [] }, {}); }
    expect(state.events.filter(event => event.kind === "robot.converted")).toMatchObject([{ targetId: "agent:2" }]);
    // Removing the physical Walker's own allowance is still enough to deny conversion.
    const full = createCombatState(1, { ...context, conversionCap: 2 });
    full.tick = 1; stepAttacks(full, { ...context, conversionCap: 2 }, {});
    expect(full.attacks).toEqual([]);
  });

  it("preserves the unscoped legacy actor count", () => {
    const context: CombatContext = { actors: [actor("agent:1", 0), actor("agent:2", 2, "good"), actor("joint", 20, "bad", "walker")],
      players: [], walls: [], refills: [], conversionCap: 2,
      attacks: [{ id: "update", sequence: 1, attackerId: "agent:1", targetId: "agent:2", kind: "forced-update" }] };
    const state = createCombatState(1, context);
    state.tick = 1; stepAttacks(state, context, {});
    expect(state.attacks).toEqual([]);
  });
});
