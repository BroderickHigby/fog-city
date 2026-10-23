import { describe, expect, it } from "vitest";
import type { Mission } from "../../../src/content/missions.ts";
import { MISSIONS } from "../../../src/content/catalog.ts";
import { Action, NEUTRAL_INPUT } from "../../../src/sim/contract.ts";
import type { JsonObject } from "../../../src/sim/extensions.ts";
import { createEconomy, stepEconomy } from "../../../src/sim/economy/system.ts";
import { createHeat } from "../../../src/sim/heat/system.ts";
import { createMissionProgress, createMissions, stepMissions } from "../../../src/sim/missions/system.ts";
import { boardPosition, type MissionMechanicsState } from "../../../src/sim/missions/mechanics/index.ts";
import { prepareMissionMechanics, stripMissionMechanicsFacts, type MissionMechanicsWorld } from "../../../src/sim/missions/mechanics/runtime.ts";
import { DEFAULT_CATALOG } from "../../../src/sim/player/catalog.ts";
import { createPlayerSystems, defaultGameplayProvider, gameplaySnapshot, makeGameplaySystem, type GameplayProvider } from "../../../src/sim/player/adapter.ts";
import { createPlayer } from "../../../src/sim/player/system.ts";
import type { GameplayContext, GameplayFact, MissionState } from "../../../src/sim/player/types.ts";
import { createInitialState, step } from "../../../src/sim/step.ts";
import { buildWorld } from "../../../src/sim/world.ts";

const body = { id: "p", x: 0, y: 1, z: 0, speed: 0, mode: "foot" as const };
const bay = { id: "bay", edge: "street", side: "L" as const, x: 0, y: 1, z: 0, heading: 0, halfLength: 3, halfWidth: 1.3 };
const car = { playerId: "p", x: 0, y: 1, z: 0, speed: 0, lateral: 0, heading: 0, halfLength: 2, halfWidth: 0.8 };
function mission(event: string): Mission {
  return {
    id: "mechanics-fixture", version: 1, title: "Mechanics fixture", wave: 4, cast: {}, meters: {},
    outcomes: { success: { label: "Done", kind: "success" } },
    steps: [
      { id: "objective", type: "objective", objective: { kind: "event", event }, next: "reward" },
      { id: "reward", type: "reward", outcome: "success", grants: [{ kind: "stat", stat: "cash", delta: 10 }] },
    ],
  };
}
function context(authored: Mission, changes: Partial<GameplayContext> = {}): GameplayContext {
  return { ...DEFAULT_CATALOG, wave: 4, bodies: [{ ...body }], missions: [authored], observations: [], actors: [], facts: [], commands: [], day: 1, month: 1, ...changes };
}
function active(authored: Mission, stepId = "objective"): MissionState {
  return { ...createMissions(), players: { p: { ...createMissionProgress(), missionId: authored.id, stepId, status: "active", startedTick: 0, stepStartedTick: 0, visits: 1 } } };
}
function parkingWorld(authored: Mission): MissionMechanicsWorld {
  return { parking: {
    vehicles: [{ ...car }], bays: [{ ...bay }],
    targets: [{ missionId: authored.id, stepId: "objective", bayIds: [bay.id] }],
    rules: [{ edge: bay.edge, side: bay.side, kind: "free", days: [], from: null, to: null, hourLimit: null, permitAreas: [] }],
    cleaning: [], clock: { isoWeekday: 1, minute: 600, weekOfMonth: 1, holiday: false },
  } };
}
function harness(authored: Mission, stepId = "objective") {
  let mechanics: MissionMechanicsState | undefined, missions = active(authored, stepId), economy = createEconomy();
  const heat = createHeat(), player = createPlayer(), facts: GameplayFact[] = [];
  function tick(tick: number, pressed: boolean, world: MissionMechanicsWorld | undefined, ctx = context(authored)) {
    const prepared = prepareMissionMechanics(mechanics, missions, { tick, seed: 7, inputs: { p: { ...NEUTRAL_INPUT, actions: pressed ? Action.interact : 0 } }, context: ctx, world });
    mechanics = prepared.mechanics; facts.push(...prepared.facts);
    const enriched = { ...ctx, facts: [...stripMissionMechanicsFacts(ctx.facts), ...prepared.facts] };
    missions = stepMissions(missions, enriched, tick, heat, player);
    economy = stepEconomy(economy, enriched, tick, missions.events, heat);
    return prepared;
  }
  return { tick, get mechanics() { return mechanics!; }, get missions() { return missions; }, get economy() { return economy; }, facts };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.freeze(value); for (const member of Object.values(value)) freeze(member); }
  return value;
}

describe("persisted mission mechanics integration", () => {
  it("pays the authored parking objective once after a fresh interaction and 120 continuous ticks", () => {
    const authored = mission("demo.parkedLegally"), world = parkingWorld(authored), run = harness(authored);
    for (let tick = 0; tick <= 130; tick++) run.tick(tick, true, world);
    expect(run.facts).toEqual([]); // A held key is not a fresh confirmation after settling.
    run.tick(131, false, world);
    const completed = run.tick(132, true, world);
    expect(completed.facts.map(fact => fact.kind)).toEqual(["demo.parkedLegally"]);
    expect(run.missions.players.p!.status).toBe("complete");
    expect(run.economy.players.p!.cashCents).toBe(201000);
    const before = JSON.stringify(run.mechanics);
    expect(run.tick(132, true, world).facts).toEqual([]);
    expect(JSON.stringify(run.mechanics)).toBe(before);
    for (let tick = 133; tick < 160; tick++) run.tick(tick, true, world);
    expect(run.economy.players.p!.cashCents).toBe(201000);
    expect(run.facts).toHaveLength(1);
  });

  it("uses only bound bays and current trusted rules, and resets after movement", () => {
    const authored = mission("demo.parkedLegally"), world = parkingWorld(authored), run = harness(authored);
    world.parking!.bays = [{ ...bay }, { ...bay, id: "unbound", x: 30 }];
    world.parking!.vehicles = [{ ...car, x: 30 }];
    for (let tick = 0; tick <= 120; tick++) run.tick(tick, tick === 120, world, context(authored, { bodies: [{ ...body, x: 30 }] }));
    expect(run.facts).toEqual([]);
    world.parking!.vehicles = [{ ...car }];
    for (let tick = 121; tick < 241; tick++) run.tick(tick, false, world);
    world.parking!.rules = [{ ...world.parking!.rules[0]!, kind: "no-parking-any-time" }];
    expect(run.tick(241, true, world).facts).toEqual([]);
    world.parking!.rules = [{ ...world.parking!.rules[0]!, kind: "free" }];
    for (let tick = 242; tick < 362; tick++) run.tick(tick, false, world);
    world.parking!.vehicles = [{ ...car, speed: 1 }];
    expect(run.tick(362, true, world).facts).toEqual([]);
    expect(run.mechanics.parking.p!.stoppedSince).toBe(-1);
  });

  it.each(["missing", "wrong-step", "ambiguous", "inactive", "future-wave", "wrong-objective", "wrong-actor"])("fails closed on %s world/objective authorization", variant => {
    const authored = mission("demo.parkedLegally"), world = parkingWorld(authored), previous = active(authored);
    if (variant === "missing") world.parking!.targets = [];
    if (variant === "wrong-step") world.parking!.targets = [{ ...world.parking!.targets[0]!, stepId: "other" }];
    if (variant === "ambiguous") world.parking!.targets = [world.parking!.targets[0]!, world.parking!.targets[0]!];
    if (variant === "inactive") previous.players.p!.status = "retry";
    if (variant === "future-wave") authored.wave = 5;
    if (variant === "wrong-objective") (authored.steps[0] as { objective: { kind: string } }).objective.kind = "refill";
    if (variant === "wrong-actor") (authored.steps[0] as { objective: { actor?: string } }).objective.actor = "unbound";
    const result = prepareMissionMechanics(undefined, previous, { tick: 0, seed: 1, inputs: { p: { ...NEUTRAL_INPUT, actions: Action.interact } }, context: context(authored), world });
    expect(result.mechanics.parking).toEqual({});
    expect(result.facts).toEqual([]);
    expect(result.boardingIntents).toEqual([]);
  });

  it("removes fabricated completion facts and producer-cursor poisoning before interpretation", () => {
    const authored = mission("demo.parkedLegally"), run = harness(authored);
    const fake: GameplayFact = { id: "outside:1", source: "world", sequence: 1, tick: 0, playerId: "p", kind: "demo.parkedLegally" };
    const poisoned = { ...fake, id: "mission-mechanics:999", sequence: 999, kind: "other.event" };
    const legitimate = { ...fake, id: "world:1", kind: "weather.changed" };
    expect(stripMissionMechanicsFacts([fake, poisoned, legitimate])).toEqual([legitimate]);
    run.tick(0, true, undefined, context(authored, { facts: [fake, poisoned] }));
    expect(run.missions.players.p!.status).toBe("active");
    expect(run.economy.players.p!.cashCents).toBe(200000);
  });

  it("preserves one seeded duel across Demo Day's authored start/win steps and rewards once", () => {
    const authored = MISSIONS.find(value => value.id === "demo-day")!, run = harness(authored, "corner");
    const target = { missionId: authored.id, opponentId: "associate", x: 0, y: 1, z: 0 };
    const world: MissionMechanicsWorld = { bellDuels: [{ ...target, stepId: "corner" }, { ...target, stepId: "bell" }] };
    run.tick(0, true, world);
    const id = run.mechanics.duels.p!.requestId;
    expect(run.missions.players.p!.stepId).toBe("bell");
    for (let tick = 1; tick < 2500 && run.missions.players.p!.status !== "complete"; tick++) {
      run.tick(tick, run.mechanics.duels.p!.responseTicks.includes(tick), world);
      expect(run.mechanics.duels.p?.requestId ?? id).toBe(id);
    }
    expect(run.missions.players.p!.status).toBe("complete");
    expect(run.facts.filter(fact => fact.kind === "bell.duelStarted")).toHaveLength(1);
    expect(run.facts.filter(fact => fact.kind === "bell.duelWon")).toHaveLength(1);
    expect(run.economy.players.p!.cashCents).toBe(380000);
    for (let tick = run.mechanics.tick + 1, end = tick + 10; tick < end; tick++) run.tick(tick, true, world);
    expect(run.economy.players.p!.cashCents).toBe(380000);
  });

  it("does not restart a duel on held input, and gives a new authored visit a new attempt", () => {
    const authored = MISSIONS.find(value => value.id === "demo-day")!, previous = active(authored, "corner");
    const target = { missionId: authored.id, stepId: "corner", opponentId: "associate", x: 0, y: 1, z: 0 };
    const input = { tick: 0, seed: 7, inputs: { p: { ...NEUTRAL_INPUT, actions: Action.interact } }, context: context(authored), world: { bellDuels: [target] } };
    const first = prepareMissionMechanics(undefined, previous, input);
    const retry = { ...previous, players: { p: { ...previous.players.p!, visits: 10, stepStartedTick: 1 } } };
    const held = prepareMissionMechanics(first.mechanics, retry, { ...input, tick: 1 });
    expect(held.facts).toEqual([]);
    expect(held.mechanics.duels).toEqual({});
    const released = prepareMissionMechanics(held.mechanics, retry, { ...input, tick: 2, inputs: { p: NEUTRAL_INPUT } });
    const restarted = prepareMissionMechanics(released.mechanics, retry, { ...input, tick: 3 });
    expect(restarted.facts.map(fact => fact.kind)).toEqual(["bell.duelStarted"]);
    expect(restarted.mechanics.duels.p!.requestId).not.toBe(first.mechanics.duels.p!.requestId);
  });

  it("requires core acceptance and current board pose before Hill Climb advances", () => {
    const authored = MISSIONS.find(value => value.id === "hill-climb")!, run = harness(authored, "board");
    const vehicle = { id: "cable:1", kind: "cable-car" as const, x: 0, y: 0.5, z: 0, heading: 0, speed: 0, atStop: true, boardingOpen: true, slots: [{ id: "left", lateral: 0, forward: 0, height: 0.5 }] };
    const world: MissionMechanicsWorld = { cableBoarding: { targets: [{ missionId: authored.id, stepId: "board", vehicleId: vehicle.id }], vehicles: [vehicle], accepted: [] } };
    const first = run.tick(0, true, world), intent = first.boardingIntents[0]!;
    expect(first.facts).toEqual([]); expect(first.boardingIntents).toHaveLength(1);
    expect(run.missions.players.p!.stepId).toBe("board");
    const accepted = { intentId: intent.id, playerId: "p", vehicleId: vehicle.id, slotId: "left" };
    world.cableBoarding!.accepted = [{ ...accepted, playerId: "other" }];
    expect(run.tick(1, true, world).facts).toEqual([]);
    world.cableBoarding!.accepted = [accepted];
    expect(run.tick(2, true, world, context(authored, { bodies: [{ ...body, x: 5 }] })).facts).toEqual([]);
    const moved = { ...vehicle, x: 2, speed: 2, atStop: false };
    world.cableBoarding!.vehicles = [moved];
    const completed = run.tick(3, true, world, context(authored, { bodies: [{ ...body, ...boardPosition(moved, moved.slots[0]!) }] }));
    expect(completed.facts.map(fact => fact.kind)).toEqual(["cableCar.runningBoardMounted"]);
    expect(run.missions.players.p!.stepId).toBe("stop");
    expect(run.tick(4, true, world).facts).toEqual([]);
    expect(run.economy.players.p!.cashCents).toBe(200000); // Boarding does not bypass the later cone objective.
  });

  it("is deterministic and preserves frozen inputs and persisted cursors", () => {
    const authored = mission("demo.parkedLegally"), previous = active(authored), world = parkingWorld(authored);
    previous.factCursors["world:mission-mechanics"] = 20;
    const input = freeze(structuredClone({ tick: 0, seed: 7, inputs: { p: NEUTRAL_INPUT }, context: context(authored), world }));
    freeze(previous);
    const first = prepareMissionMechanics(undefined, previous, input);
    expect(first).toEqual(prepareMissionMechanics(undefined, previous, input));
    expect(first.mechanics.nextSequence).toBe(21);
    expect(previous.players.p!.objectiveCount).toBe(0);
    expect(() => prepareMissionMechanics(undefined, previous, { ...input, sequenceFloor: 0 })).toThrow("sequence");
  });

  it("does not confirm an old boarding intent after the authorized vehicle changes", () => {
    const authored = mission("cableCar.runningBoardMounted"), run = harness(authored);
    const vehicle = { id: "cable:1", kind: "cable-car" as const, x: 0, y: 1, z: 0, heading: 0, speed: 0, atStop: true, boardingOpen: true, slots: [{ id: "left", lateral: 0, forward: 0, height: 0 }] };
    const world: MissionMechanicsWorld = { cableBoarding: { targets: [{ missionId: authored.id, stepId: "objective", vehicleId: vehicle.id }], vehicles: [vehicle, { ...vehicle, id: "cable:2" }], accepted: [] } };
    const first = run.tick(0, true, world);
    world.cableBoarding!.accepted = [{ intentId: first.boardingIntents[0]!.id, playerId: "p", vehicleId: vehicle.id, slotId: "left" }];
    world.cableBoarding!.targets = [{ missionId: authored.id, stepId: "objective", vehicleId: "cable:2" }];
    expect(run.tick(1, false, world).facts).toEqual([]);
    expect(run.missions.players.p!.status).toBe("active");
    expect(run.economy.players.p!.cashCents).toBe(200000);
  });

  it("orders players consistently and never uses another player's car or completion", () => {
    const authored = mission("demo.parkedLegally"), missions = active(authored), world = parkingWorld(authored);
    missions.players.q = { ...missions.players.p!, objectiveIds: [], completedIds: [], rewardedIds: [], meters: {} };
    const second = { ...body, id: "q", x: 10 };
    world.parking!.bays = [{ ...bay }, { ...bay, id: "second-bay", x: 10 }];
    world.parking!.targets = [{ missionId: authored.id, stepId: "objective", bayIds: ["second-bay", "bay"] }];
    world.parking!.vehicles = [{ ...car }, { ...car, playerId: "q", x: 10, speed: 1 }];
    let forward: MissionMechanicsState | undefined, reverse: MissionMechanicsState | undefined;
    for (let tick = 0; tick <= 120; tick++) {
      const inputs = { p: { ...NEUTRAL_INPUT, actions: tick === 120 ? Action.interact : 0 }, q: { ...NEUTRAL_INPUT, actions: tick === 120 ? Action.interact : 0 } };
      const a = prepareMissionMechanics(forward, missions, { tick, seed: 7, inputs, context: context(authored, { bodies: [body, second] }), world });
      const b = prepareMissionMechanics(reverse, missions, { tick, seed: 7, inputs, context: context(authored, { bodies: [second, body] }), world });
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      forward = a.mechanics; reverse = b.mechanics;
      if (tick === 120) expect(a.facts.map(fact => fact.playerId)).toEqual(["p"]);
    }
  });

  it("runs the registered pipeline with player-owned persistence and same-tick mission facts", () => {
    const authored = mission("demo.parkedLegally"), world = buildWorld([]), data = parkingWorld(authored).parking!;
    let state = createInitialState(world, 7, ["p"], { x: 0, z: 0, heading: 0 });
    state.ext.missions = active(authored) as unknown as JsonObject;
    const provider: GameplayProvider = simulation => {
      const accepted = simulation.state.players.p!.car;
      return {
        ...defaultGameplayProvider(simulation), wave: 4, missions: [authored],
        mechanicsWorld: { parking: {
          ...data, bays: [{ ...bay, y: 0 }],
          vehicles: [{ ...car, x: accepted.x, y: accepted.y, z: accepted.z, heading: accepted.heading, speed: accepted.speed, lateral: accepted.lateral }],
        } },
      };
    };
    const systems = createPlayerSystems(provider).map(system => ({
      key: system.key,
      step(simulation: Parameters<typeof system.step>[0]) {
        const before = freeze(simulation.state), result = system.step(simulation);
        expect({ ...result, ext: before.ext }).toEqual(before);
        for (const key of new Set([...Object.keys(before.ext), ...Object.keys(result.ext)])) {
          if (key !== system.key) expect(result.ext[key]).toBe(before.ext[key]);
        }
        return result;
      },
    }));
    for (let tick = 1; tick <= 120; tick++) {
      state = step(world, state, { p: NEUTRAL_INPUT }, [], systems);
      expect(gameplaySnapshot({ state }).missions.players.p!.status).toBe("active");
      if (tick === 60) state = JSON.parse(JSON.stringify(state)) as typeof state;
    }
    const beforeConfirmation = freeze(state), pressed = { p: { ...NEUTRAL_INPUT, actions: Action.interact } };
    const completed = step(world, beforeConfirmation, pressed, [], systems);
    expect(step(world, beforeConfirmation, pressed, [], systems)).toEqual(completed);
    const snapshot = gameplaySnapshot({ state: completed });
    expect(snapshot.player.mechanics!.tick).toBe(121);
    expect(snapshot.player.mechanicFacts).toMatchObject([{ tick: 121, kind: "demo.parkedLegally" }]);
    expect(snapshot.missions.players.p!.status).toBe("complete");
    expect(snapshot.missions.events.find(event => event.kind === "mission.cash")?.tick).toBe(121);
    expect(snapshot.economy.players.p!.cashCents).toBe(201000);
    for (const key of ["heat", "missions", "economy", "progression", "activities"] as const) {
      expect(snapshot[key]).not.toHaveProperty("mechanics");
      expect(snapshot[key]).not.toHaveProperty("mechanicFacts");
      expect(snapshot[key]).not.toHaveProperty("boardingIntents");
    }
    const next = gameplaySnapshot({ state: step(world, completed, pressed, [], systems) });
    expect(next.player.mechanicFacts).toEqual([]);
    expect(next.economy.players.p!.cashCents).toBe(201000);
  });

  it("strips forged provider completion through registered and standalone mission systems", () => {
    const authored = mission("demo.parkedLegally"), world = buildWorld([]);
    const provider: GameplayProvider = simulation => ({
      ...defaultGameplayProvider(simulation), wave: 4, missions: [authored],
      facts: [
        { id: "provider:1", source: "world", sequence: 1, tick: simulation.state.tick, playerId: "p", kind: "demo.parkedLegally" },
        { id: "mission-mechanics:999", source: "world", sequence: 999, tick: simulation.state.tick, playerId: "p", kind: "demo.parkedLegally" },
      ],
    });
    for (const systems of [createPlayerSystems(provider), [makeGameplaySystem("missions", provider)]]) {
      const initial = createInitialState(world, 7, ["p"], { x: 0, z: 0, heading: 0 });
      initial.ext.missions = active(authored) as unknown as JsonObject;
      const result = step(world, freeze(initial), { p: { ...NEUTRAL_INPUT, actions: Action.interact } }, [], systems);
      const snapshot = gameplaySnapshot({ state: result });
      expect(snapshot.missions.players.p!.status).toBe("active");
      expect(snapshot.missions.players.p!.objectiveCount).toBe(0);
      expect(snapshot.missions.events).toEqual([]);
      expect(snapshot.missions.factCursors["world:mission-mechanics"]).toBeUndefined();
      expect(snapshot.economy.players.p?.cashCents ?? 200000).toBe(200000);
    }
  });
});
