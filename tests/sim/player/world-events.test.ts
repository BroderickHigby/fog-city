import { describe, expect, it } from "vitest";
import { createWorldEvents, doomModifiers, factionOf, moveDoomClock, stepWorldEvents } from "../../../src/sim/activities/world-events.ts";
import { createActivities, stepActivities } from "../../../src/sim/activities/system.ts";
import { createMissions } from "../../../src/sim/missions/system.ts";
import { createEconomy, stepEconomy } from "../../../src/sim/economy/system.ts";
import { createHeat, stepHeat } from "../../../src/sim/heat/system.ts";
import { createPlayerSystems, gameplaySnapshot, combatLoadout, playerView } from "../../../src/sim/player/adapter.ts";
import { createProgressionPlayer } from "../../../src/sim/progression/system.ts";
import { applyModeSettlements } from "../../../src/sim/player/settlements.ts";
import { createInitialState, step } from "../../../src/sim/step.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import { DEFAULT_CATALOG } from "../../../src/sim/player/catalog.ts";
import type { GameplayContext, GameplayEvent, GameplayFact } from "../../../src/sim/player/types.ts";

const body = { id: "p", x: 0, y: 0, z: 0, mode: "foot" as const, speed: 0 };
function ctx(overrides: Partial<GameplayContext> = {}): GameplayContext {
  return { ...DEFAULT_CATALOG, wave: 4, bodies: [body], observations: [], actors: [], facts: [], commands: [], day: 1, month: 1, ...overrides };
}
function fact(sequence: number, tick: number, actorId: string, source: GameplayFact["source"] = "world"): GameplayFact {
  return { id: `contracts:${sequence}`, source, sequence, tick, playerId: "p", actorId, kind: "faction.contract-completed" };
}
function grant(id: number, tick: number): GameplayEvent {
  return { id, tick, kind: "streak.grant", playerId: "p", targetId: "agi", amount: 1, detail: "" };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}

describe("shared Doom Clock and event lifecycle", () => {
  it("drifts on absolute game days, never on repeated ticks, missing dates or a backward calendar", () => {
    const start = stepWorldEvents(undefined, ctx({ gameDay: 4 }), 1).state;
    const snapshot = JSON.stringify(start);
    const next = stepWorldEvents(freeze(start), ctx({ gameDay: 8 }), 2).state;
    expect(next.doom.months).toBe(20);
    expect(JSON.stringify(start)).toBe(snapshot);
    expect(stepWorldEvents(next, ctx({ gameDay: 8 }), 2).state).toBe(next);
    expect(stepWorldEvents(next, ctx({ gameDay: 6 }), 3).state.doom.months).toBe(20);
    expect(stepWorldEvents(next, ctx(), 3).state.doom.months).toBe(20);
  });

  it("handles long calendar gaps in bounded work and expires the old chime", () => {
    const first = stepWorldEvents(undefined, ctx({ gameDay: 0 }), 0).state;
    const result = stepWorldEvents(first, ctx({ gameDay: 24_001 }), 1);
    const next = result.state;
    expect(result.emissions.some(e => e.kind === "doom.agi")).toBe(false);
    expect(next.doom.resets).toBe(1000);
    expect(next.doom.months).toBe(23);
    expect(next.doom.phase).toBe("normal");
    expect(next.doom.pauseUntilTick).toBe(0);
  });

  it("applies authored, world-confirmed faction contracts once and never trusts arbitrary completion", () => {
    const context = ctx({ factionContracts: [{ id: "pause", faction: "pausers", wave: 4, cashCents: 25000 }], facts: [fact(1, 1, "pause", "combat"), fact(2, 1, "unknown"), fact(3, 1, "pause")] });
    const first = stepWorldEvents(undefined, context, 1);
    expect(first.state.doom.months).toBe(27);
    expect(factionOf(first.state.doom.factions.p)).toBe("pausers");
    expect(first.emissions.filter(e => e.kind === "activity.cash").map(e => e.amount)).toEqual([25000]);
    const again = stepWorldEvents(first.state, { ...context, facts: [fact(4, 2, "pause")] }, 2);
    expect(again.state.doom.months).toBe(27);
    expect(again.emissions).toEqual([]);
  });

  it("reaches both boundaries, resets to 24 and expires the one-day effects", () => {
    const base = createWorldEvents().doom;
    const winter = moveDoomClock({ ...base, months: 45, lastGameDay: 10 }, 3, 5);
    expect(winter.doom).toMatchObject({ months: 24, resets: 1, phase: "winter", phaseUntilDay: 11 });
    expect(doomModifiers(winter.doom).robotSpeedFactor).toBe(0.9);
    const expired = stepWorldEvents({ ...createWorldEvents(), doom: winter.doom, tick: 5 }, ctx({ gameDay: 11 }), 6).state;
    expect(expired.doom.phase).toBe("normal");
    const midnight = moveDoomClock({ ...base, months: 3 }, -3, 90);
    expect(midnight.doom).toMatchObject({ months: 24, resets: 1, phase: "agi", pauseUntilTick: 270 });
    expect(midnight.emissions.filter(e => e.kind === "doom.agi")).toHaveLength(1);
  });

  it("keeps slash-bearing player and contract identities separate", () => {
    const result = stepWorldEvents(undefined, ctx({
      bodies: [{ ...body, id: "a" }, { ...body, id: "a/b" }],
      factionContracts: [
        { id: "b/c", faction: "pausers", wave: 4, cashCents: 100 },
        { id: "c", faction: "accelerators", wave: 4, cashCents: 200 },
      ],
      facts: [{ ...fact(1, 1, "b/c"), playerId: "a" }, { ...fact(2, 1, "c"), playerId: "a/b" }],
    }), 1);
    expect(result.state.doom.factions.a).toEqual({ pausers: 1, accelerators: 0 });
    expect(result.state.doom.factions["a/b"]).toEqual({ pausers: 0, accelerators: 1 });
    expect(result.emissions.filter(e => e.kind === "activity.cash").map(e => [e.playerId, e.amount])).toEqual([["a", 100], ["a/b", 200]]);
  });

  it("keeps match-local AGI out of free roam and deduplicates a free-roam streak", () => {
    const local = stepWorldEvents(undefined, ctx({ mode: "botSweep" }), 1, [grant(1, 1)]);
    expect(local.state.doom.resets).toBe(0);
    const first = stepWorldEvents(undefined, ctx(), 1, [grant(1, 1)]);
    expect(first.state.doom.resets).toBe(1);
    expect(stepWorldEvents(first.state, ctx(), 2, [grant(1, 2)]).state.doom.resets).toBe(1);
  });

  it("announces Conference Week transitions once and rejects a backward week", () => {
    const first = stepWorldEvents(undefined, ctx({ gameWeek: 2 }), 1);
    expect(first.state.conferenceWeek).toBe(true);
    expect(first.emissions.filter(e => e.kind === "world.conference")).toHaveLength(1);
    const same = stepWorldEvents(first.state, ctx({ gameWeek: 2 }), 2);
    expect(same.emissions).toEqual([]);
    const back = stepWorldEvents(same.state, ctx({ gameWeek: 1 }), 3);
    expect(back.state.conferenceWeek).toBe(true);
    const off = stepWorldEvents(back.state, ctx({ gameWeek: 3 }), 4);
    expect(off.state.conferenceWeek).toBe(false);
  });

  it("carries a winning faction move out of a match exactly once", () => {
    const world = buildWorld([]), state = createInitialState(world, 7, ["p"], { x: 0, z: 0, heading: 0 });
    const activities = createActivities();
    activities.worldEvents!.doom.factions.p = { pausers: 2, accelerators: 0 };
    state.ext.activities = activities as unknown as NonNullable<typeof state.ext.activities>;
    const original = JSON.stringify(state);
    const payout = { id: "match:1", playerId: "p", xp: 550, cashCents: 100, achievements: [], factionClockMoves: 1 as const };
    const first = applyModeSettlements(freeze(state), [payout]);
    expect(gameplaySnapshot({ state: first }).activities.worldEvents!.doom.months).toBe(25);
    expect(applyModeSettlements(first, [payout])).toEqual(first);
    expect(JSON.stringify(state)).toBe(original);
  });
});

describe("player-system wiring and perk effects", () => {
  it("changes actual bounty output by the clock and Default Alive, without double-paying", () => {
    const context = ctx({ doomPayFactor: 1.25, actors: [{ id: "bad", firmware: "bad" }], facts: [{ id: "combat:1", source: "combat", sequence: 1, tick: 1, playerId: "p", actorId: "bad", kind: "robot.heap" }] });
    const previous = createEconomy();
    previous.players.p = { cashCents: 0, runwayMonths: 10, reputation: 50, paidActorIds: [], ownedItemIds: [], ownedSiteIds: [], commandSequence: 0 };
    const plain = stepEconomy(previous, context, 1);
    const perk = stepEconomy(freeze(previous), context, 1, [], undefined, [], [], {}, { p: ["default-alive"] });
    expect(plain.players.p!.cashCents).toBe(18750);
    expect(plain.players.p!.runwayMonths).toBe(10.5);
    expect(perk.players.p!.runwayMonths).toBe(11);
    const replay = stepEconomy(perk, { ...context, facts: [{ ...context.facts[0]!, sequence: 2, id: "combat:2", tick: 2 }] }, 2, [], undefined, [], [], {}, { p: ["default-alive"] });
    expect(replay.players.p!.runwayMonths).toBe(11);
  });

  it("greys out coastline-only perks and preserves other actual combat modifiers", () => {
    const state = createInitialState(buildWorld([]), 1, ["p"], { x: 0, z: 0, heading: 0 });
    const snapshot = gameplaySnapshot({ state });
    snapshot.progression.players.p = { ...createProgressionPlayer(), perks: ["lean", "brackish", "unknown"] };
    expect(combatLoadout(snapshot, body, 0, { mode: "botSweep", hasCoastline: false }).perks).toEqual(["lean"]);
    expect(combatLoadout(snapshot, body, 0, { mode: "botSweep", hasCoastline: true }).perks).toEqual(["lean", "brackish"]);
    expect(playerView(snapshot, "p", { hasCoastline: false }).perks.find(p => p.id === "brackish")).toMatchObject({ equipped: true, enabled: false });
  });

  it("propagates world events to economic/heat consumers with deterministic ownership", () => {
    const world = buildWorld([]), initial = createInitialState(world, 7, ["p"], { x: 0, z: 0, heading: 0 });
    const context = ctx({ gameDay: 0 });
    const systems = createPlayerSystems(() => context);
    const first = step(world, freeze(initial), {}, [], systems);
    const one = step(world, first, {}, [], createPlayerSystems(() => ({ ...context, gameDay: 24 })));
    const two = step(world, one, {}, [], createPlayerSystems(() => ({ ...context, gameDay: 24 })));
    expect(gameplaySnapshot({ state: one }).activities.worldEvents!.doom.resets).toBe(1);
    expect(gameplaySnapshot({ state: two }).heat.players.p!.vcQuarters).toBe(4);
    expect(step(world, one, {}, [], createPlayerSystems(() => ({ ...context, gameDay: 24 })))).toEqual(two);
    expect(() => JSON.stringify(two)).not.toThrow();
  });

  it("exposes one shared AGI event to every player's heat exactly once", () => {
    const context = ctx({ bodies: [body, { ...body, id: "q" }] });
    const event: GameplayEvent = { id: 1, tick: 1, kind: "doom.agi", playerId: "p", targetId: "", amount: 1, detail: "" };
    const first = stepHeat(createHeat(), context, 2, [], [], [event]);
    expect(first.players.p!.vcQuarters).toBe(4);
    expect(first.players.q!.vcQuarters).toBe(4);
    const next = stepHeat(first, context, 3, [], [], [event]);
    expect(next.players.p!.vcQuarters).toBe(4);
    expect(next.players.q!.vcQuarters).toBe(4);
  });
});
