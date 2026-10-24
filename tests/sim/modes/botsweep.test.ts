import { describe, expect, it } from "vitest";
import { buildWorld } from "../../../src/sim/world.ts";
import { hashState } from "../../../src/sim/serialize.ts";
import { createInitialState, step } from "../../../src/sim/step.ts";
import { createGameSystems } from "../../../src/sim/game-systems.ts";
import { botSweepArena, botSweepView, createBotSweep, isBotSweep, stepBotSweep } from "../../../src/sim/modes/botsweep.ts";
import { modeSessionOf } from "../../../src/sim/modes/session.ts";
import { agentsRuntimeOf } from "../../../src/sim/agents/runtime.ts";
import { defaultMatchContext, MODE_END_EVENT } from "../../../src/sim/modes/systems.ts";
import { applyMatchSettlement, settledModeIds } from "../../../src/sim/modes/settlement.ts";
import { gameplaySnapshot } from "../../../src/sim/player/adapter.ts";

const world = buildWorld([], null, null, { version: 1, world: "fixture", sourceSnapshot: "test", refills: [{ id: "water", kind: "hydrant", x: 0, y: 0, z: 10, radius: 3, salt: false }], anchors: [], tiles: [], territories: [] });
const config = { id: "room-abc", seed: 7, players: ["p2", "p1"], spawn: { x: 0, z: 0, heading: 0 } };
const go = { throttle: .4, steer: .1, brake: 0, actions: 0 };

describe("Bot Sweep match instance", () => {
  it("admits 10 + 4 per player beta units and the Update Relay among 120 robots, with no free-roam state", () => {
    const initial = createBotSweep(world, config), session = modeSessionOf(initial)!;
    expect(isBotSweep(initial)).toBe(true);
    expect(session.match.mode).toBe("botSweep");
    expect(session.match.remainingBad).toHaveLength(18);
    expect(session.match.relayId).toBe("mission:mode-room-abc:update-relay");
    expect(Object.keys(initial.players)).toEqual(["p1", "p2"]);
    expect(initial.ext.economy).toBeUndefined(); expect(initial.ext.missions).toBeUndefined();
    expect(stepBotSweep(world, initial, {}).ext.economy).toBeUndefined();
    const state = stepBotSweep(world, initial, {}), runtime = agentsRuntimeOf(state)!;
    for (const id of [...session.match.remainingBad, session.match.relayId]) expect(runtime.actors[id]).toBeDefined();
    expect(state.ext.agents!.list).toHaveLength(121);
    expect(botSweepView(state)).toMatchObject({ phase: "active", objectivesRemaining: 19, relayStanding: true, lives: 5 });
    expect(botSweepArena(state)).toEqual({ center: { x: 0, y: 0, z: 0 }, radius: 120 });
  });

  it("replays identically from the same inputs and events (relay and browsers agree)", () => {
    let a = createBotSweep(world, config), b = createBotSweep(world, config);
    expect(hashState(a)).toBe(hashState(b));
    for (let i = 0; i < 90; i++) {
      const inputs = { p1: go, p2: { ...go, steer: -.3, actions: i % 20 === 0 ? 2 : 0 } };
      a = stepBotSweep(world, a, inputs); b = stepBotSweep(world, JSON.parse(JSON.stringify(b)), inputs);
    }
    expect(hashState(a)).toBe(hashState(b));
    expect(a.players.p1!.car.speed).toBeGreaterThan(0);
  });

  it("ends on a recorded mode.end decision and settles payouts that persist", () => {
    let state = createBotSweep(world, config);
    for (let i = 0; i < 5; i++) state = stepBotSweep(world, state, {});
    state = stepBotSweep(world, state, {}, [{ tick: state.tick + 1, kind: MODE_END_EVENT }]);
    const view = botSweepView(state)!;
    expect(view.phase).toBe("finished"); expect(view.result!.reason).toBe("ended");
    expect(view.payouts.map((p) => p.id)).toEqual(["room-abc:p1", "room-abc:p2"]);
    for (const p of view.payouts) { expect(p.cashCents).toBe(0); expect(p.xp).toBe(25); }
    const later = stepBotSweep(world, stepBotSweep(world, state, {}), {});
    expect(botSweepView(later)!.payouts).toEqual(view.payouts);
  });

  it("caps a shortened clock and rejects invalid participants and locations", () => {
    expect(() => createBotSweep(world, { ...config, durationTicks: 30 })).toThrow();
    expect(() => createBotSweep(world, { ...config, durationTicks: 13 * 3600 })).toThrow();
    expect(() => createBotSweep(world, { ...config, players: ["p1", "p2", "p3", "p4", "p5"] })).toThrow();
    expect(() => createBotSweep(world, { ...config, players: ["p1", "p1"] })).toThrow();
    expect(() => createBotSweep(world, { ...config, id: "__proto__" })).toThrow();
    expect(() => createBotSweep(world, { ...config, id: "bad id" })).toThrow();
    let state = createBotSweep(world, { ...config, durationTicks: 60 });
    for (let i = 0; i < 60; i++) state = stepBotSweep(world, state, {});
    expect(botSweepView(state)!.result!.reason).toBe("relay-update");
  });

  it("ignores a downed player's controls", () => {
    const start = stepBotSweep(world, createBotSweep(world, config), {});
    Object.assign(modeSessionOf(start)!.match.players.p1!, { downUntil: start.tick + 100, respawnAt: start.tick + 100 });
    let held = start, idle = start;
    for (let i = 0; i < 30; i++) { held = stepBotSweep(world, held, { p1: { throttle: 1, steer: 1, brake: 0, actions: 2 } }); idle = stepBotSweep(world, idle, {}); }
    expect(hashState(held)).toBe(hashState(idle));
  });

  it("credits interrupted updates to the player who blinded the robot", () => {
    const state = stepBotSweep(world, createBotSweep(world, config), {});
    state.ext.combat!.events = [
      { id: 1, tick: state.tick, kind: "robot.blinded", sourceId: "p1", targetId: "bad", amount: 180, detail: "" },
      { id: 2, tick: state.tick, kind: "update.interrupted", sourceId: "bad", targetId: "good", amount: 0, detail: "interrupted" },
    ];
    expect(defaultMatchContext({ world, previous: state, state, inputs: {}, events: [] }).combatEvents![1]!.sourceId).toBe("p1");
  });
});

describe("Bot Sweep bot teammates", () => {
  it("adds bots as match players who get out and move on their own, identically on every replay", () => {
    const solo = { ...config, players: ["p1"], bots: 2 };
    let a = createBotSweep(world, solo), b = createBotSweep(world, solo);
    expect(Object.keys(a.players)).toEqual(["bot-1", "bot-2", "p1"]);
    expect(Object.keys(modeSessionOf(a)!.match.players)).toEqual(["bot-1", "bot-2", "p1"]);
    expect(modeSessionOf(a)!.match.remainingBad).toHaveLength(22);
    const start = { ...a.players["bot-1"]!.car };
    for (let i = 0; i < 400; i++) {
      // A peer's input keyed by a bot id is ignored: bots are driven by the sim alone.
      a = stepBotSweep(world, a, { p1: go, "bot-1": { throttle: -1, steer: 1, brake: 0, actions: 0 } });
      b = stepBotSweep(world, JSON.parse(JSON.stringify(b)), { p1: go });
    }
    expect(hashState(a)).toBe(hashState(b));
    expect(a.players["bot-1"]!.mode).toBe("foot");
    const foot = a.players["bot-1"]!.foot!;
    expect(Math.hypot(foot.x - start.x, foot.z - start.z)).toBeGreaterThan(2);
  });
  it("keeps a team at four and bot ids away from people", () => {
    expect(() => createBotSweep(world, { ...config, players: ["p1"], bots: 4 })).toThrow();
    expect(() => createBotSweep(world, { ...config, players: ["p1", "p2", "p3"], bots: 2 })).toThrow();
    expect(() => createBotSweep(world, { ...config, players: ["bot-1"] })).toThrow();
    expect(() => createBotSweep(world, { ...config, players: ["p1"], bots: 1.5 })).toThrow();
  });
});

describe("match settlement into the city", () => {
  const systems = createGameSystems({ wave: 3 });
  const city = () => step(world, createInitialState(world, 1, ["p1"], { x: 0, z: 0, heading: 0 }), { p1: { throttle: 0, steer: 0, brake: 0, actions: 0 } }, [], systems);
  const payout = { id: "room-abc:p2", playerId: "p2", xp: 140, cashCents: 3500, achievements: ["botSweep:win"], factionClockMoves: 1 };

  it("pays a match payout into the local player's wallet and XP exactly once", () => {
    const before = city(), wallet = gameplaySnapshot({ state: before }).economy.players.p1!;
    const paid = applyMatchSettlement(before, payout, "p1");
    const after = gameplaySnapshot({ state: paid });
    expect(after.economy.players.p1!.cashCents).toBe(wallet.cashCents + 3500);
    expect(after.progression.players.p1!.xp).toBe(140);
    expect((after.progression.players.p1 as { achievements?: string[] }).achievements).toEqual(["botSweep:win"]);
    expect(settledModeIds(paid)).toEqual(["room-abc:p2"]);
    expect(applyMatchSettlement(paid, payout, "p1")).toBe(paid);
    // The city is untouched apart from the wallet, progression and the settlement ledger.
    expect(paid.players).toBe(before.players); expect(paid.tick).toBe(before.tick);
    expect(gameplaySnapshot({ state: before }).economy.players.p1!.cashCents).toBe(wallet.cashCents);
  });

  it("survives the city's own ticks and refuses malformed payouts and match states", () => {
    const paid = applyMatchSettlement(city(), payout, "p1");
    const next = step(world, paid, { p1: { throttle: 0, steer: 0, brake: 0, actions: 0 } }, [], systems);
    expect(settledModeIds(next)).toEqual(["room-abc:p2"]);
    expect(applyMatchSettlement(next, payout, "p1")).toBe(next);
    const base = city();
    for (const bad of [{ ...payout, id: "no-colon" }, { ...payout, cashCents: -1 }, { ...payout, xp: 1.5 }]) expect(applyMatchSettlement(base, bad, "p1")).toBe(base);
    expect(applyMatchSettlement(base, payout, "nobody")).toBe(base);
    expect(() => applyMatchSettlement(createBotSweep(world, config), payout, "p1")).toThrow();
  });
});
