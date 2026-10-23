import { describe, expect, it } from "vitest";
import { createWorldEvents, stepWorldEvents } from "../../../src/sim/activities/world-events.ts";
import { createDoomClock, doomEffects, factionFor, moveDoomClock, stepDoomClock } from "../../../src/sim/progression/doom-clock.ts";
import { createEconomy, stepEconomy } from "../../../src/sim/economy/system.ts";
import { createHeat, stepHeat } from "../../../src/sim/heat/system.ts";
import { createPlayerSystems, gameplaySnapshot, combatLoadout, playerView } from "../../../src/sim/player/adapter.ts";
import { createProgression, createProgressionPlayer } from "../../../src/sim/progression/system.ts";
import { applyModeSettlements } from "../../../src/sim/player/settlements.ts";
import { createInitialState, step } from "../../../src/sim/step.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import { DEFAULT_CATALOG } from "../../../src/sim/player/catalog.ts";
import type { GameplayContext, GameplayEvent, GameplayFact } from "../../../src/sim/player/types.ts";

const body = { id: "p", x: 0, y: 0, z: 0, mode: "foot" as const, speed: 0 };
function ctx(overrides: Partial<GameplayContext> = {}): GameplayContext {
  return { ...DEFAULT_CATALOG, wave: 4, bodies: [body], observations: [], actors: [], facts: [], commands: [], day: 1, month: 1, ...overrides };
}
function fact(sequence: number, tick: number, playerId = "p", source: GameplayFact["source"] = "world"): GameplayFact {
  return { id: `activities:${sequence}`, source, sequence, tick, playerId, actorId: "faction-pauser", kind: "faction.pauser-completed" };
}
function grant(id: number, tick: number): GameplayEvent {
  return { id, tick, kind: "streak.grant", playerId: "p", targetId: "agi", amount: 1, detail: "" };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}

describe("canonical Doom Clock and event lifecycle", () => {
  it("drifts on absolute game days, never on repeated ticks, missing dates or a backward calendar", () => {
    const start = stepDoomClock(createDoomClock(), ctx({ gameDay: 4 }), 1).state;
    const snapshot = JSON.stringify(start);
    const next = stepDoomClock(freeze(start), ctx({ gameDay: 8 }), 2).state;
    expect(next.months).toBe(20);
    expect(JSON.stringify(start)).toBe(snapshot);
    expect(stepDoomClock(next, ctx({ gameDay: 8 }), 2).state).toBe(next);
    expect(stepDoomClock(next, ctx({ gameDay: 6 }), 3).state.months).toBe(20);
    expect(stepDoomClock(next, ctx({ day: Number.NaN }), 3).state.months).toBe(20);
  });

  it("handles long calendar gaps in bounded work and expires the historical chime", () => {
    const first = stepDoomClock(createDoomClock(), ctx({ gameDay: 0 }), 0).state;
    const result = stepDoomClock(first, ctx({ gameDay: 24_001 }), 1);
    expect(result.events.some(e => e.kind === "world.agi-achieved")).toBe(false);
    expect(result.state.resets).toBe(1000);
    expect(result.state.winters).toBe(0);
    expect(result.state.months).toBe(23);
    expect(result.state.pausedUntil).toBe(0);
  });

  it("preserves legacy clock state and defaults its missing tick/grant cursors", () => {
    const legacy = { months: 20, lastDay: 2, resets: 4, winters: 1, pausedUntil: 0,
      winterUntilDay: -1, factions: { p: { pauser: 2, accelerator: 1 } }, factCursors: {} };
    const next = stepDoomClock(freeze(legacy), ctx({ gameDay: 3 }), 10);
    expect(next.state.months).toBe(19);
    expect(next.state.resets).toBe(4);
    expect(factionFor(next.state, "p")).toBe("pauser");
    expect(stepDoomClock(JSON.parse(JSON.stringify(next.state)), ctx({ gameDay: 3 }), 11).state.months).toBe(19);
  });

  it("counts each measured completion once but allows a later run of the same activity", () => {
    const first = stepDoomClock(createDoomClock(), ctx({ facts: [fact(1, 1)] }), 1);
    expect(first.state.months).toBe(27);
    const repeat = stepDoomClock(first.state, ctx({ facts: [fact(1, 2)] }), 2);
    expect(repeat.state.months).toBe(27);
    expect(repeat.events).toEqual([]);
    const later = stepDoomClock(repeat.state, ctx({ facts: [fact(2, 3)] }), 3);
    expect(later.state.months).toBe(30);
    expect(later.state.factions.p).toEqual({ pauser: 2, accelerator: 0 });
    expect(later.events.some(e => e.kind.includes("cash"))).toBe(false);
  });

  it("does not accept a combat fact as a faction completion", () => {
    const next = stepDoomClock(createDoomClock(), ctx({ facts: [fact(1, 1, "p", "combat")] }), 1);
    expect(next.state.months).toBe(24);
    expect(next.state.factions).toEqual({});
  });

  it("reaches both boundaries immediately and keeps winter separate from AGI resets", () => {
    const base = createDoomClock();
    const winter = moveDoomClock({ ...base, months: 45, lastDay: 10 }, 3, 5);
    expect(winter.state).toMatchObject({ months: 24, resets: 0, winters: 1, winterUntilDay: 11 });
    expect(doomEffects(winter.state, 10, 6).robotSpeedMultiplier).toBe(0.9);
    expect(doomEffects(winter.state, 11, 6).robotSpeedMultiplier).toBe(1);
    const midnight = moveDoomClock({ ...base, months: 1 }, -1, 90);
    expect(midnight.state).toMatchObject({ months: 24, resets: 1, winters: 0, pausedUntil: 270 });
    expect(midnight.events.filter(e => e.kind === "world.agi-achieved")).toHaveLength(1);
  });

  it("expires winter by tick when no calendar is available, and never rewinds an expired date", () => {
    const winter = moveDoomClock({ ...createDoomClock(), months: 47 }, 1, 10).state;
    expect(doomEffects(winter, Number.NaN, 11).robotSpeedMultiplier).toBe(0.9);
    expect(doomEffects(winter, Number.NaN, 10 + 86400).robotSpeedMultiplier).toBe(1);
    const dated = { ...winter, lastDay: 12, winterUntilDay: 11 };
    expect(doomEffects(dated, 9, 11).robotSpeedMultiplier).toBe(1);
  });

  it("keeps slash-bearing player identities separate", () => {
    const result = stepDoomClock(createDoomClock(), ctx({
      bodies: [{ ...body, id: "a" }, { ...body, id: "a/b" }],
      facts: [fact(1, 1, "a"), { ...fact(2, 1, "a/b"), kind: "faction.accelerator-completed" }],
    }), 1);
    expect(result.state.factions.a).toEqual({ pauser: 1, accelerator: 0 });
    expect(result.state.factions["a/b"]).toEqual({ pauser: 0, accelerator: 1 });
    expect(result.state.months).toBe(24);
  });

  it("keeps match-local AGI out of free roam and deduplicates a free-roam streak", () => {
    const local = stepDoomClock(createDoomClock(), ctx({ mode: "botSweep" }), 1, [grant(1, 1)]);
    expect(local.state.resets).toBe(0);
    const first = stepDoomClock(createDoomClock(), ctx(), 1, [grant(1, 1)]);
    expect(first.state.resets).toBe(1);
    expect(stepDoomClock(first.state, ctx(), 2, [grant(1, 2)]).state.resets).toBe(1);
    expect(stepDoomClock(first.state, ctx(), 2, [grant(2, 2)]).state.resets).toBe(2);
  });

  it("ignores malformed and future streak grants without poisoning the producer cursor", () => {
    const next = stepDoomClock(createDoomClock(), ctx(), 1, [grant(NaN, 1), grant(100, 2), grant(1, 1)]);
    expect(next.state.streakCursor).toBe(1);
    expect(next.state.resets).toBe(1);
  });

  it("announces Conference Week transitions once and rejects a backward week", () => {
    const first = stepWorldEvents(undefined, ctx({ gameWeek: 2 }), 1);
    expect(first.state.conferenceWeek).toBe(true);
    expect(first.emissions.filter(e => e.kind === "world.conference")).toHaveLength(1);
    expect(stepWorldEvents(first.state, ctx({ gameWeek: 2 }), 2).emissions).toEqual([]);
    const back = stepWorldEvents(first.state, ctx({ gameWeek: 1 }), 2);
    expect(back.state.conferenceWeek).toBe(true);
    expect(stepWorldEvents(back.state, ctx({ gameWeek: 3 }), 3).state.conferenceWeek).toBe(false);
    expect(first.state).not.toHaveProperty("doom");
  });

  it("Conference Week ignores faction facts and never pays a duplicate activity reward", () => {
    const next = stepWorldEvents(undefined, ctx({ gameWeek: 0, facts: [fact(1, 1)] }), 1);
    expect(next.emissions).toEqual([]);
    expect(next.state).toEqual({ ...createWorldEvents(), tick: 1, lastGameWeek: 0 });
  });

  it("carries a winning faction move out of a match exactly once", () => {
    const world = buildWorld([]), state = createInitialState(world, 7, ["p"], { x: 0, z: 0, heading: 0 });
    const progression = createProgression();
    progression.doom.factions.p = { pauser: 2, accelerator: 0 };
    state.ext.progression = progression as unknown as NonNullable<typeof state.ext.progression>;
    const original = JSON.stringify(state);
    const payout = { id: "match:1", playerId: "p", xp: 550, cashCents: 100, achievements: [], factionClockMoves: 1 as const };
    const first = applyModeSettlements(freeze(state), [payout]);
    expect(gameplaySnapshot({ state: first }).progression.doom.months).toBe(25);
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
    expect(gameplaySnapshot({ state: one }).progression.doom.resets).toBe(1);
    expect(gameplaySnapshot({ state: two }).heat.players.p!.vcQuarters).toBe(4);
    expect(step(world, one, {}, [], createPlayerSystems(() => ({ ...context, gameDay: 24 })))).toEqual(two);
    expect(() => JSON.stringify(two)).not.toThrow();
  });

  it("exposes one shared AGI event to every player's heat exactly once", () => {
    const context = ctx({ bodies: [body, { ...body, id: "q" }] });
    const event: GameplayEvent = { id: 1, tick: 1, kind: "world.agi-achieved", playerId: "p", targetId: "", amount: 1, detail: "" };
    const first = stepHeat(createHeat(), context, 2, [], [], [event]);
    expect(first.players.p!.vcQuarters).toBe(4);
    expect(first.players.q!.vcQuarters).toBe(4);
    const next = stepHeat(first, context, 3, [], [], [event]);
    expect(next.players.p!.vcQuarters).toBe(4);
    expect(next.players.q!.vcQuarters).toBe(4);
  });
});
