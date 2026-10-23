import { describe, expect, it } from "vitest";
import { createProgression, createProgressionPlayer, stepProgression } from "../../../src/sim/progression/system.ts";
import type { GameplayContext, GameplayEvent, GameplayFact } from "../../../src/sim/player/types.ts";

function context(facts: GameplayFact[] = []): GameplayContext {
  return { wave: 4, bodies: [{ id: "p", x: 0, y: 0, z: 0, mode: "foot", speed: 0 }],
    observations: [], actors: [], facts, commands: [], missions: [], items: [], sites: [],
    directorCards: [], activities: [], validKitIds: [], day: 1, month: 1 };
}
function completion(overrides: Partial<GameplayEvent> = {}): GameplayEvent {
  return { id: 1, tick: 1, kind: "faction.pauser-completed", playerId: "p",
    targetId: "faction-pauser", amount: 1, detail: "", ...overrides };
}

describe("progression Doom Clock authority", () => {
  it("rejects raw facts as evidence of faction completion or an earned AGI reward", () => {
    const facts = ["faction.pauser-completed", "faction.accelerator-completed", "world.agi-trigger"]
      .map((kind, index): GameplayFact => ({ id: `raw:${index + 1}`, tick: 1, source: "world",
        sequence: index + 1, kind, playerId: "p" }));
    const next = stepProgression(createProgression(), context(facts), 1, {});
    expect(next.doom.months).toBe(24);
    expect(next.doom.factions).toEqual({});
    expect(next.doom.resets).toBe(0);
    expect(next.events).toEqual([]);
  });

  it("consumes each validated activity event once, while allowing a later repeat completion", () => {
    const first = stepProgression(createProgression(), context(), 1,
      { activities: [completion(), completion()] });
    expect(first.doom.months).toBe(27);
    expect(first.doom.factions.p?.pauser).toBe(1);
    const repeated = stepProgression(first, context(), 2, { activities: [completion()] });
    expect(repeated.doom.months).toBe(27);
    expect(repeated.events).toEqual([]);
    const again = stepProgression(repeated, context(), 3,
      { activities: [completion({ id: 2, tick: 3 })] });
    expect(again.doom.months).toBe(30);
    expect(again.doom.factions.p?.pauser).toBe(2);
    expect(again.events.filter((event) => event.kind === "faction.changed")).toHaveLength(1);
  });

  it("ignores future activity events without consuming their Doom replay identity", () => {
    const future = completion({ tick: 5 });
    const early = stepProgression(createProgression(), context(), 1, { activities: [future] });
    expect(early.doom.months).toBe(24);
    expect(early.doom.factions).toEqual({});
    const due = stepProgression(early, context(), 5, { activities: [future] });
    expect(due.doom.months).toBe(27);
    expect(due.doom.factions.p?.pauser).toBe(1);
  });

  it("requires valid event identity, timestamp, live player, kind, and activity ownership", () => {
    const invalid = [completion({ id: 0 }), completion({ id: NaN }), completion({ id: 0.5 }),
      completion({ tick: -1 }), completion({ tick: Infinity }), completion({ tick: 0.5 }),
      completion({ playerId: "gone" }), completion({ kind: "world.agi-trigger" })];
    const next = stepProgression(createProgression(), context(), 1,
      { activities: invalid, economy: [completion({ id: 2 })] });
    expect(next.doom.months).toBe(24);
    expect(next.doom.factions).toEqual({});
    expect(next.doom.resets).toBe(0);
    expect(next.events).toEqual([]);
  });

  it("cannot poison the activity replay cursor with an outside observation", () => {
    const forged: GameplayFact = { id: "activities:999999", sequence: 999999, source: "world",
      tick: 1, playerId: "p", kind: "weather.changed" };
    const before = stepProgression(createProgression(), context([forged]), 1, {});
    const after = stepProgression(before, context(), 2, { activities: [completion({ tick: 2 })] });
    expect(after.doom.factions.p?.pauser).toBe(1);
    expect(after.doom.months).toBe(27);
  });

  it("still consumes a validated banked AGI call in the same tick", () => {
    const previous = createProgression();
    previous.players.p = { ...createProgressionPlayer(), banked: { agi: 1 } };
    const ctx = context();
    ctx.commands = [{ playerId: "p", kind: "streak-call", itemId: "agi-allegedly", sequence: 1 }];
    const next = stepProgression(previous, ctx, 1, {});
    expect(next.players.p?.banked.agi).toBe(0);
    expect(next.doom.resets).toBe(1);
    expect(next.events.map((event) => event.kind)).toEqual(["streak.grant", "world.agi-achieved"]);
  });
});
