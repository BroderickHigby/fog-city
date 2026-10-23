import { describe, expect, it } from "vitest";
import type { CombatEvent } from "../../../src/sim/combat-contract.ts";
import { createRoyale, royaleCircle, stepRoyale, type RoyaleConfig, type RoyaleContext, type RoyaleState } from "../../../src/sim/modes/royale.ts";

const config = (): RoyaleConfig => ({ id: "royale", seed: 51, playerIds: ["a", "b"], initialCircle: { x: 0, z: 0, radius: 1000 }, finalLandmarks: [{ id: "dogpatch", x: 300, z: 200, radius: 100 }] });
const positions = { a: { x: 0, y: 0, z: 0 }, b: { x: 1, y: 0, z: 0 }, c: { x: 2, y: 0, z: 0 } };
const context = (tick: number, extra: Partial<RoyaleContext> = {}): RoyaleContext => ({ tick, positions, ...extra });
const damage = (tick: number, targetId: string, amount: number, id = tick): CombatEvent => ({ id, tick, kind: "player.runway", sourceId: "robot", targetId, amount, detail: "attack" });
function advance(state: RoyaleState, count: number, ctx: Partial<RoyaleContext> = {}): RoyaleState { for (let i = 0; i < count; i++) state = stepRoyale(state, context(state.tick + 1, ctx)).state; return state; }

describe("Fog Royale phases and actual positions", () => {
  it("has exactly five 90s holds and 60s closes, ending at the seeded built landmark", () => {
    const state = createRoyale(config());
    expect(state.circles).toHaveLength(6);
    expect(royaleCircle({ ...state, elapsedTicks: 5400 })).toEqual(state.circles[0]);
    for (let phase = 1; phase <= 5; phase++) {
      expect(royaleCircle({ ...state, elapsedTicks: phase * 9000 })).toEqual(state.circles[phase]);
      const held = royaleCircle({ ...state, elapsedTicks: (phase - 1) * 9000 + 5399 });
      expect(held).toEqual(state.circles[phase - 1]);
    }
    expect(royaleCircle({ ...state, elapsedTicks: 90000 })).toEqual({ x: 300, z: 200, radius: 100 });
  });

  it("drains one month per three outside seconds and half as fast with a fleece crate", () => {
    const cfg = config(); cfg.crates = [{ id: "fleece", kind: "fleece", x: 1100, y: 0, z: 0 }];
    const outside = { a: { x: 1100, y: 0, z: 0 }, b: positions.b };
    let normal = createRoyale(cfg), fleece = createRoyale(cfg);
    fleece = stepRoyale(fleece, context(1, { positions: outside, inputs: { a: { crateId: "fleece" } } })).state;
    normal = advance(normal, 180, { positions: outside });
    fleece = advance(fleece, 179, { positions: outside });
    expect(normal.players.a!.runway).toBe(17); expect(fleece.players.a!.runway).toBe(18);
    expect(normal.players.b!.runway).toBe(18);
    fleece = advance(fleece, 179, { positions: outside }); expect(fleece.players.a!.runway).toBe(17);
  });

  it("freezes all active-duration timers during a global pause", () => {
    const state = createRoyale(config());
    const paused = stepRoyale(state, context(10000, { paused: true })).state;
    expect(paused.elapsedTicks).toBe(0); expect(royaleCircle(paused)).toEqual(state.circles[0]);
    const resumed = stepRoyale(paused, context(10001)).state;
    expect(resumed.elapsedTicks).toBe(1);
  });

  it("requires finite accepted poses and refuses an invalid arena", () => {
    expect(() => stepRoyale(createRoyale(config()), { tick: 1, positions: { a: positions.a } })).toThrow("Missing accepted");
    expect(() => createRoyale({ ...config(), finalLandmarks: [{ id: "bad", x: 2000, z: 0, radius: 10 }] })).toThrow("nested");
  });
});

describe("Fog Royale rewards and recovery", () => {
  it("claims nearby crates once and only rewards known bad robot heaps", () => {
    const cfg = config(); cfg.crates = [{ id: "cloud", kind: "cloud-credit", x: 0, y: 0, z: 0 }];
    let state = createRoyale(cfg); state.players.a!.runway = 10;
    const event: CombatEvent = { id: 1, tick: 1, kind: "robot.heap", sourceId: "a", targetId: "bad", amount: 1, detail: "footman" };
    state = stepRoyale(state, context(1, { inputs: { a: { crateId: "cloud" } }, combatEvents: [event], badRobotIds: ["bad"] })).state;
    expect(state.players.a!.runway).toBe(14); expect(state.players.a!.score).toBe(150);
    state = stepRoyale(state, context(2, { inputs: { a: { crateId: "cloud" } }, combatEvents: [event, { ...event, id: 2, tick: 2 }], badRobotIds: ["bad"] })).state;
    expect(state.players.a!.runway).toBe(14); expect(state.players.a!.score).toBe(150);
  });

  it("revives the first zero in place, then pairs second failures and confirms a taxi redeploy", () => {
    let state = createRoyale({ ...config(), playerIds: ["a", "b", "c"] });
    state = stepRoyale(state, context(1, { combatEvents: [damage(1, "a", -18), damage(1, "b", -18, 2)] })).state;
    expect(state.players.a!.runway).toBe(6); expect(state.players.a!.bridgeUsed).toBe(true);
    state = stepRoyale(state, context(2, { combatEvents: [damage(2, "a", -6), damage(2, "b", -6, 2)] })).state;
    expect(state.duels).toHaveLength(1); expect(state.duels[0]!.players).toEqual(["a", "b"]);
    state = stepRoyale(state, context(3, { duelResults: [{ sequence: 1, duelId: state.duels[0]!.id, winnerId: "a" }] })).state;
    expect(state.players.a!.status).toBe("redeploy"); expect(state.players.b!.status).toBe("spectating");
    const request = state.pendingRedeploys[0]!;
    state = stepRoyale(state, context(4, { acceptedRedeploys: [{ ...request, x: 0, y: 0, z: 0 }] })).state;
    expect(state.players.a!.status).toBe("redeploy");
    const accepted = { id: request.id, playerId: "a", x: request.x, y: 0, z: request.z };
    state = stepRoyale(state, context(5, { positions: { ...positions, a: accepted }, acceptedRedeploys: [accepted] })).state;
    expect(state.players.a!.status).toBe("active"); expect(state.players.a!.runway).toBe(6);
    state = stepRoyale(state, context(6, { positions: { ...positions, a: accepted }, combatEvents: [damage(6, "a", -6)] })).state;
    expect(state.players.a!.status).toBe("spectating"); expect(state.result?.winners).toEqual(["c"]);
  });

  it("uses a bot associate after twenty seconds and never invents a duel win", () => {
    let state = createRoyale(config());
    state = stepRoyale(state, context(1, { combatEvents: [damage(1, "a", -18)] })).state;
    state = stepRoyale(state, context(2, { combatEvents: [damage(2, "a", -6)] })).state;
    state = advance(state, 1200);
    expect(state.duels[0]!.associateId).toMatch(/^associate:/);
    expect(state.players.a!.status).toBe("duel"); expect(state.pendingRedeploys).toEqual([]);
  });

  it("deduplicates combat IDs within a tick but accepts a later tick after an ID reset", () => {
    let state = createRoyale(config());
    const hit = damage(1, "a", -1, 8);
    state = stepRoyale(state, context(1, { combatEvents: [hit, hit] })).state;
    expect(state.players.a!.runway).toBe(17);
    state = stepRoyale(state, context(2, { combatEvents: [hit, damage(2, "a", -1, 1)] })).state;
    expect(state.players.a!.runway).toBe(16);
  });
});

describe("solo bot plumbing", () => {
  it("creates seven rival founder bodies and supplies intents without moving or awarding them", () => {
    const state = createRoyale({ ...config(), playerIds: ["human"], solo: true });
    const poses = Object.fromEntries(Object.keys(state.players).map((id, i) => [id, { x: i, y: 0, z: 0 }]));
    const result = stepRoyale(state, { tick: 1, positions: poses });
    expect(result.anchors).toHaveLength(8); expect(result.botIntents).toHaveLength(7);
    expect(result.botIntents.every((i) => i.flowerTargetId !== i.playerId)).toBe(true);
    expect(Object.keys(poses)).toHaveLength(8); expect(result.state.events).toEqual([]);
    expect(stepRoyale(state, { tick: 1, positions: poses })).toEqual(result);
    expect(state.elapsedTicks).toBe(0);
  });
});
