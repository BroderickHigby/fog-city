import { describe, expect, it } from "vitest";
import { Action, createGameSystems, createInitialState, step, type InputFrame, type SimEvent, type SimState } from "../../src/sim/index.ts";
import { buildWorld } from "../../src/sim/world.ts";
import { canonicalJson, hashState } from "../../src/sim/serialize.ts";
import { DAY_TICKS, gameTime } from "../../src/sim/clock/calendar.ts";
import { activeWorldTick } from "../../src/sim/pause-timers.ts";
import { createDoomClock } from "../../src/sim/progression/doom-clock.ts";
import type { GameSystemsOptions } from "../../src/sim/game-systems.ts";
import type { RuntimeSpawn } from "../../src/sim/agents/runtime.ts";
import type { CombatEvent } from "../../src/sim/combat-contract.ts";
import { impactsOf } from "../../src/sim/impacts.ts";
import type { PropPlacement } from "../../src/sim/props.ts";

const neutral = { throttle: 0, steer: 0, brake: 1, actions: 0 };
const forward = { throttle: 1, steer: .3, brake: 0, actions: Action.fire | Action.gadget | Action.streak };
const roundtrip = (state: SimState): SimState => JSON.parse(canonicalJson(state)) as SimState;
function fixture(options: { version?: number; bad?: boolean; players?: string[]; combat?: GameSystemsOptions["combat"] } = {}) {
  const props: PropPlacement[] = [{ id: "lamp:fixture", kind: "lamp", x: 60, z: 0 }];
  // Loaded, dry terrain covers both the players and the factory's 200 m aim
  // projection. A missing ground field must continue to reject placement.
  const world = Object.assign(buildWorld([{ tileId: "fixture-flat", buildings: [], ground: {
    x0: -300, z0: -300, cellSizeM: 100, nx: 7, nz: 7, heights: Array(49).fill(0), water: Array(49).fill(0),
  } }]), { props });
  const spawns: RuntimeSpawn[] = [{ id: "fixture:good", numericId: 100, model: "footman", firmware: "good", x: 25, y: 0, z: 20, heading: 0, radius: .4, height: 1.8, posted: true }];
  if (options.bad) spawns.push({ ...spawns[0]!, id: "fixture:bad", numericId: 101, firmware: "bad", x: 45 });
  const systems = createGameSystems({ wave: 4, protectedArea: () => false, agents: () => ({ spawns, services: false }), combat: options.combat, modes: [] });
  let state = createInitialState(world, 7, options.players ?? ["p"], { x: 0, z: 0, heading: 0 });
  state.version = options.version ?? 21;
  state = step(world, state, { p: neutral }, [], systems);
  const advance = (previous: SimState, inputs: InputFrame = { p: neutral }, events: SimEvent[] = []) => step(world, previous, inputs, events, systems);
  return { world, systems, state, advance };
}
function bank(state: SimState, kind = "parrots", count = 1): void {
  const own = state.ext.progression!.players.p!;
  own.xp = 1000; own.streakPoints = 0; own.streaks = [kind]; own.earnedStreaks = [kind]; own.banked = { [kind]: count };
  own.streakSequence = 0; own.streakHeld = false; delete own.pendingStreak;
}

describe("SIM21 composed ownership and provider integration", () => {
  it("keeps ordinary nearby robot anchors alive without a Coit viewer", () => {
    const { advance, state } = fixture();
    expect(state.ext.robots!.actors["fixture:good"]!.retired).toBe(false);
    expect(state.ext.robots!.actors["fixture:good"]!.fidelity).toBe("full");
    const next = advance(state);
    expect(next.ext.robots!.actors["fixture:good"]!.retired).toBe(false);
    expect(next.ext.agents!.list.some(actor => actor.runtimeId === "fixture:good")).toBe(true);
    expect(next.ext.combat!.targets["fixture:good"]).toBeDefined();
  });

  it("freezes core car/agent/projectile motion, RNG, prop age and clock before preparers, then resumes normally", () => {
    const { advance, state } = fixture();
    state.players.p!.car.speed = 5;
    state.ext.impacts = { version: 1, nextId: 1, events: [], cars: {}, props: { "lamp:fixture": { kind: "lamp", tick: 0, state: "fallen", dir: 1 } } };
    const combat = state.ext.combat!;
    combat.projectiles = [{ id: 90, kind: "water", ownerId: "p", x: 10, y: 3, z: 0, vx: 0, vy: 0, vz: -13, distance: 0, range: 12, bornTick: state.tick,
      volume: .08, salt: false, vehicle: false, rustRate: .025 }];
    combat.pauseUntil = state.tick + 3;
    const before = canonicalJson(state), tick = state.tick, clock = state.ext.clock!.elapsedTicks, actor = state.ext.robots!.actors["fixture:good"]!;
    let next = state;
    for (let count = 0; count < 3; count++) next = advance(next, { p: forward });
    expect(next.tick).toBe(tick + 3); expect(activeWorldTick(next)).toBe(tick);
    expect(next.players.p!.car).toEqual(state.players.p!.car); expect(next.rng).toEqual(state.rng);
    expect(next.ext.combat!.rng).toEqual(combat.rng); expect(next.ext.activities!.players.p!.directorRng).toEqual(state.ext.activities!.players.p!.directorRng);
    expect(next.ext.clock!.elapsedTicks).toBe(clock);
    expect(next.ext.robots!.actors[actor.id]!.x).toBe(actor.x); expect(next.ext.robots!.actors[actor.id]!.z).toBe(actor.z);
    expect(next.ext.agents!.list).toEqual(state.ext.agents!.list);
    expect(next.ext.combat!.projectiles).toHaveLength(1);
    expect(next.ext.combat!.projectiles[0]).toEqual({ ...combat.projectiles[0]!, bornTick: combat.projectiles[0]!.bornTick + 3 });
    const prop = impactsOf(next)!.props!["lamp:fixture"]!;
    expect(next.tick - prop.tick - (prop.pausedTicks ?? 0)).toBe(state.tick);
    expect(prop.dir).toBe(1); expect(prop.state).toBe("fallen");
    expect(canonicalJson(state)).toBe(before);
    const resumed = advance(next, { p: { ...forward, actions: 0 } });
    expect(resumed.players.p!.car.z).toBeLessThan(next.players.p!.car.z);
    expect(resumed.ext.combat!.projectiles[0]!.z).toBeLessThan(0);
    expect(resumed.ext.clock!.elapsedTicks).toBe(clock + 1);
  });

  it("applies membership changes during pause without moving survivors and initializes only actual joined combat owners", () => {
    const { advance, state } = fixture({ players: ["p", "q"] });
    state.ext.combat!.pauseUntil = state.tick + 2;
    state.ext.combat!.gadgets = [{ id: 90, kind: "speaker", ownerId: "q", x: 20, y: 0, z: 0, untilTick: 1000, targetId: "", radius: 10, progress: 0, boost: "salt" }];
    const next = advance(state, { p: forward, r: forward }, [{ kind: "player.leave", playerId: "q", tick: state.tick + 1 },
      { kind: "player.join", playerId: "r", tick: state.tick + 1, payload: { x: 80, z: 0, heading: 0 } }]);
    expect(Object.keys(next.players).sort()).toEqual(["p", "r"]); expect(next.players.p!.car).toEqual(state.players.p!.car);
    expect(next.players.r!.car.speed).toBe(0); expect(next.ext.combat!.players.q).toBeUndefined(); expect(next.ext.combat!.players.r).toBeDefined();
    expect(next.ext.combat!.targets["player:q"]).toBeUndefined(); expect(next.ext.combat!.gadgets).toEqual([]);
    const held = advance(next), resumed = advance(held);
    expect(resumed.ext.progression!.players.r).toBeDefined(); expect(resumed.ext.progression!.players.q).toBeUndefined();
  });

  it("does not resurrect already expired cooldowns and preserves live/sentinel deadlines through the actual paused pipeline", () => {
    const { advance, state } = fixture();
    const at = state.tick, own = state.ext.activities!.players.p!, combat = state.ext.combat!;
    own.cardCooldowns = { expired: at, live: at + 10, unlimited: Number.MAX_SAFE_INTEGER, unset: 0 };
    combat.players.p!.gearUntil = at; combat.players.p!.nextGadgetTick = at; combat.players.p!.boostUntil = at + 10;
    combat.pauseUntil = at + 3;
    let next = state;
    for (let index = 0; index < 3; index++) next = advance(next);
    expect(next.ext.activities!.players.p!.cardCooldowns).toEqual({ expired: at, live: at + 13, unlimited: Number.MAX_SAFE_INTEGER, unset: 0 });
    expect(next.ext.combat!.players.p!.gearUntil).toBe(at); expect(next.ext.combat!.players.p!.nextGadgetTick).toBe(at);
    expect(next.ext.combat!.players.p!.boostUntil).toBe(at + 13);
    const resumed = advance(next); expect(resumed.ext.combat!.players.p!.gearUntil).toBe(at);
    expect(resumed.ext.activities!.players.p!.cardCooldowns.expired).toBe(at);
  });

  it.each([19, 20])("keeps the historical SIM%s core path moving while the SIM21 pause contract is inactive", version => {
    const { advance, state } = fixture({ version });
    state.ext.combat!.pauseUntil = state.tick + 5;
    const next = advance(state, { p: { ...forward, actions: 0 } });
    expect(next.version).toBe(version); expect(next.players.p!.car.z).toBeLessThan(state.players.p!.car.z);
    expect(next.ext.clock!.elapsedTicks).toBe(state.ext.clock!.elapsedTicks + 1);
    expect(next.ext.pause).toBeUndefined();
  });

  it("does not replay historical AGI reset totals when an ordinary JSON save resumes", () => {
    const { advance, state } = fixture({ bad: true });
    state.ext.progression!.doom = { ...createDoomClock(), resets: 9, lastDay: gameTime(state).dayIndex, lastTick: state.tick };
    state.ext.progression!.events = [];
    delete state.ext.combat!.worldAgiSequence;
    const before = canonicalJson(state), next = advance(roundtrip(state));
    expect(next.ext.progression!.doom!.resets).toBe(9); expect(next.ext.combat!.pauseUntil).toBe(0);
    expect(next.ext.combat!.targets["fixture:bad"]!.rust).toBe(0);
    expect(next.ext.combat!.events.some(event => event.kind === "agi.pause")).toBe(false);
    expect(canonicalJson(state)).toBe(before);
  });

  it("routes a real Doom boundary event into one AGI application and persists its receipt across paused JSON restores", () => {
    const { advance, state } = fixture({ bad: true });
    state.ext.progression!.doom = { ...createDoomClock(), months: 1, lastDay: gameTime(state).dayIndex, lastTick: state.tick };
    state.ext.clock!.elapsedTicks += DAY_TICKS;
    const boundary = advance(state);
    expect(boundary.ext.progression!.events.filter(event => event.kind === "world.agi-achieved")).toHaveLength(1);
    let next = advance(roundtrip(boundary));
    const pauses: CombatEvent[] = next.ext.combat!.events.filter(event => event.kind === "agi.pause");
    expect(pauses).toHaveLength(1); expect(next.ext.combat!.targets["fixture:bad"]!.rust).toBeCloseTo(.6);
    expect(next.ext.combat!.targets["fixture:good"]!.rust).toBe(0);
    const pauseUntil = next.ext.combat!.pauseUntil, receipt = next.ext.combat!.worldAgiSequence;
    while (next.tick <= pauseUntil) {
      next = advance(roundtrip(next)); pauses.push(...next.ext.combat!.events.filter(event => event.kind === "agi.pause"));
    }
    expect(pauses).toHaveLength(1); expect(next.ext.combat!.worldAgiSequence).toBe(receipt);
    expect(next.ext.combat!.pauseUntil).toBe(pauseUntil); expect(next.ext.combat!.targets["fixture:bad"]!.rust).toBeCloseTo(.6);
  });

  it("reserves a banked streak in progression, delivers it once through combat, and spends only the measured acknowledgment", () => {
    const { advance, state } = fixture(); bank(state);
    const requested = advance(state, { p: { ...neutral, actions: Action.streak } });
    expect(requested.ext.progression!.players.p!.pendingStreak).toEqual({ kind: "parrots", sequence: 1 });
    expect(requested.ext.progression!.players.p!.banked.parrots).toBe(1); expect(requested.ext.combat!.gadgets).toEqual([]);
    const delivered = advance(roundtrip(requested), { p: { ...neutral, actions: Action.streak } });
    expect(delivered.ext.combat!.events.filter(event => event.kind === "streak.used")).toHaveLength(1);
    expect(delivered.ext.progression!.events.filter(event => event.kind === "streak.spent")).toHaveLength(1);
    expect(delivered.ext.progression!.players.p!.pendingStreak).toBeUndefined(); expect(delivered.ext.progression!.players.p!.banked.parrots).toBe(0);
    expect(delivered.ext.combat!.gadgets.filter(gadget => gadget.kind === "parrots")).toHaveLength(1);
    const held = advance(delivered, { p: { ...neutral, actions: Action.streak } });
    expect(held.ext.combat!.events.some(event => event.kind === "streak.used")).toBe(false);
    expect(held.ext.progression!.players.p!.banked.parrots).toBe(0); expect(held.ext.combat!.gadgets.filter(gadget => gadget.kind === "parrots")).toHaveLength(1);
  });

  it("retains a pending reservation through core pause, preserves rejected stock, and accepts a fresh UI retry exactly once", () => {
    let permitted = false;
    const { advance, state } = fixture({ combat: () => ({ devicePlacementAllowed: () => permitted }) }); bank(state);
    let next = advance(state, { p: { ...neutral, actions: Action.streak } });
    next.ext.combat!.pauseUntil = next.tick + 3;
    const frozen = canonicalJson(next.ext.progression!.players.p!);
    while (next.tick < next.ext.combat!.pauseUntil) next = advance(roundtrip(next), { p: { ...neutral, actions: Action.streak } });
    expect(canonicalJson(next.ext.progression!.players.p!)).toBe(frozen);
    next = advance(next, { p: { ...neutral, actions: Action.streak } });
    expect(next.ext.combat!.events.filter(event => event.kind === "streak.rejected")).toHaveLength(1);
    expect(next.ext.progression!.events.filter(event => event.kind === "streak.blocked")).toHaveLength(1);
    expect(next.ext.progression!.players.p!.pendingStreak).toBeUndefined(); expect(next.ext.progression!.players.p!.banked.parrots).toBe(1);
    expect(next.ext.combat!.gadgets).toEqual([]);
    permitted = true;
    next = advance(next, { p: { ...neutral, actions: Action.streak } }, [{ tick: next.tick + 1, kind: "gameplay.command", playerId: "p", payload: { kind: "streak-call", sequence: 10, itemId: "parrots" } }]);
    expect(next.ext.progression!.players.p!.pendingStreak).toEqual({ kind: "parrots", sequence: 2 });
    const consumed = advance(roundtrip(next));
    expect(consumed.ext.progression!.players.p!.banked.parrots).toBe(0); expect(consumed.ext.combat!.players.p!.streakSequence.parrots).toBe(2);
    expect(consumed.ext.combat!.gadgets.filter(gadget => gadget.kind === "parrots")).toHaveLength(1);
    expect(hashState(advance(roundtrip(consumed)))).toBe(hashState(advance(consumed)));
  });
});
