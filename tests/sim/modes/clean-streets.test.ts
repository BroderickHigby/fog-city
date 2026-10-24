import { describe, expect, it } from "vitest";
import { Action } from "../../../src/sim/contract.ts";
import { PI } from "../../../src/sim/dmath.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import { hashState } from "../../../src/sim/serialize.ts";
import { botSweepView, createBotSweep, stepBotSweep } from "../../../src/sim/modes/botsweep.ts";
import { modeSessionOf } from "../../../src/sim/modes/session.ts";
import { MATCH_RULES } from "../../../src/sim/modes/match.ts";
import { MODE_END_EVENT } from "../../../src/sim/modes/systems.ts";

const world = buildWorld([], null, null, { version: 1, world: "fixture", sourceSnapshot: "test", refills: [{ id: "water", kind: "hydrant", x: 0, y: 0, z: 10, radius: 3, salt: false }], anchors: [], tiles: [], territories: [] });
const config = { id: "room-cs", seed: 3, players: ["p1", "p2"], spawn: { x: 0, z: 0, heading: 0 }, mode: "cleanStreets" as const };
const idle = { throttle: 0, steer: 0, brake: 0, actions: 0 };
const lob = (aimYaw: number) => ({ ...idle, actions: Action.altFire, aimYaw });

describe("Clean Streets match instance", () => {
  it("posts 30 bad robots among 120, no Update Relay, and splits people and bots into two teams", () => {
    const state = createBotSweep(world, { ...config, bots: 2 }), match = modeSessionOf(state)!.match;
    expect(match.mode).toBe("cleanStreets");
    expect(match.remainingBad).toHaveLength(30);
    expect(match.relayId).toBe("");
    expect(match.durationTicks).toBe(MATCH_RULES.cleanStreetsTicks);
    const teams = Object.fromEntries(Object.keys(match.players).sort().map((id) => [id, match.players[id]!.team]));
    expect(teams).toEqual({ "bot-1": 0, "bot-2": 1, p1: 0, p2: 1 });
    expect(stepBotSweep(world, state, {}).ext.agents!.list).toHaveLength(120);
    expect(botSweepView(state)).toMatchObject({ mode: "cleanStreets", teamScores: [0, 0], objectivesRemaining: 30, relayStanding: false });
  });

  it("scores a flower lob on a rival in sight and range, distracts them, and limits lobs to one per 1.5 s", () => {
    let state = stepBotSweep(world, createBotSweep(world, config), {});
    const toward = PI / 2; // p2 spawns 4 m east of p1
    state = stepBotSweep(world, state, { p1: lob(toward) });
    let view = botSweepView(state)!;
    expect(view.players.p1!.score).toBe(MATCH_RULES.flowerPoints);
    expect(view.players.p2).toMatchObject({ distracted: true, flowers: 1 });
    expect(view.teamScores).toEqual([25, 0]);
    // Again too soon: nothing. Aimed the wrong way: nothing.
    state = stepBotSweep(world, state, { p1: lob(toward) });
    for (let i = 0; i < MATCH_RULES.flowerCooldownTicks; i++) state = stepBotSweep(world, state, { p1: lob(-toward) });
    view = botSweepView(state)!;
    expect(view.players.p1!.score).toBe(25);
    expect(view.players.p2!.distracted).toBe(false);
    state = stepBotSweep(world, state, { p1: lob(toward) });
    expect(botSweepView(state)!.players.p1!.score).toBe(50);
  });

  it("strips a distracted player's spray, scan and lobs, and never scores a teammate", () => {
    let state = stepBotSweep(world, createBotSweep(world, config), {});
    state = stepBotSweep(world, state, { p1: lob(PI / 2) });
    // p2 lobs back while distracted: blocked.
    state = stepBotSweep(world, state, { p2: lob(-PI / 2) });
    expect(botSweepView(state)!.players.p2!.score).toBe(0);
    let team = stepBotSweep(world, createBotSweep(world, { ...config, players: ["p1", "p2", "p3"] }), {});
    team = stepBotSweep(world, team, { p1: lob(PI / 2) });
    // p1 and p3 share team 0; the nearest east is p2 (team 1) at 4 m, p3 at 8 m behind it.
    expect(botSweepView(team)!.players.p3!.flowers).toBe(0);
  });

  it("finishes on the clock with the higher team winning, and pays everyone once", () => {
    let state = createBotSweep(world, { ...config, durationTicks: 120 });
    state = stepBotSweep(world, state, {});
    state = stepBotSweep(world, state, { p1: lob(PI / 2) });
    for (let i = 0; i < 130; i++) state = stepBotSweep(world, state, {});
    const view = botSweepView(state)!;
    expect(view.result).toMatchObject({ reason: "time", winners: ["p1"] });
    expect(view.payouts.map((p) => [p.id, p.xp])).toEqual([["room-cs:p1", 102], ["room-cs:p2", 25]]);
  });

  it("replays identically and ends on a recorded decision", () => {
    let a = createBotSweep(world, { ...config, bots: 2 }), b = createBotSweep(world, { ...config, bots: 2 });
    for (let i = 0; i < 200; i++) {
      const inputs = { p1: i % 50 === 0 ? lob(PI / 2) : { ...idle, throttle: .3 }, p2: { ...idle, steer: .2, throttle: .3 } };
      a = stepBotSweep(world, a, inputs); b = stepBotSweep(world, JSON.parse(JSON.stringify(b)), inputs);
    }
    expect(hashState(a)).toBe(hashState(b));
    a = stepBotSweep(world, a, {}, [{ tick: a.tick + 1, kind: MODE_END_EVENT }]);
    expect(botSweepView(a)!.result!.reason).toBe("ended");
  });
});
