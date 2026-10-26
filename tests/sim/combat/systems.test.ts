import { describe, expect, it } from "vitest";
import { Action, type SimInput, type SimState } from "../../../src/sim/contract.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import { createInitialState, step } from "../../../src/sim/step.ts";
import { canonicalJson } from "../../../src/sim/serialize.ts";
import type { SimSystem } from "../../../src/sim/system-contract.ts";
import { contextFromState, type CombatAdapterOptions } from "../../../src/sim/combat/adapter.ts";
import { createCombatState } from "../../../src/sim/combat/system.ts";
import { createCombatSystem, systems } from "../../../src/sim/combat/systems.ts";
import type { CombatActor, CombatInputs, RefillSource } from "../../../src/sim/combat/types.ts";

const world = buildWorld([]);
const neutral = { throttle: 0, steer: 0, brake: 0, actions: 0 };

function initial(): SimState {
  const state = createInitialState(world, 17, ["p"], { x: 0, z: 0, heading: 0 });
  state.players.p!.mode = "foot";
  state.players.p!.foot = { x: 0, y: 0, z: 0, heading: 0, speed: 0, sprint: false, vy: 0, grounded: true, dodge: null };
  state.players.p!.car.x = 20;
  return state;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function provider(options: CombatAdapterOptions = {}) {
  return createCombatSystem(system => ({ context: contextFromState(system.world, system.state, options) }));
}

function source(id: string, changes: Partial<RefillSource> = {}): RefillSource {
  return { id, x: 1, y: 0, z: 0, radius: 2, kind: "hydrant", salt: false, ...changes };
}

describe("registered combat system", () => {
  it("requires an explicit provider and preserves unrelated extensions across ticks", () => {
    expect(systems).toEqual([]);
    const previous = initial();
    previous.ext.future = { keep: [1, true] };
    expect(step(world, previous, {}).ext.combat).toBeUndefined();
    freeze(previous);
    const earlier: SimSystem = { key: "robots", step: system => ({
      ...system.state, ext: { ...system.state.ext, futureReady: { ready: true } },
    }) };
    const combat = createCombatSystem(system => {
      expect(system.state.tick).toBe(system.previous.tick + 1);
      expect(system.state.ext.futureReady).toEqual({ ready: true });
      return { context: contextFromState(system.world, system.state) };
    });
    const first = step(world, previous, {}, [], [combat, earlier]);
    const second = step(world, freeze(first), {}, [], [earlier, combat]);
    expect(second.ext.combat?.tick).toBe(2);
    expect(second.ext.future).toEqual({ keep: [1, true] });
    expect(second.ext.futureReady).toEqual({ ready: true });
    expect(previous.ext.combat).toBeUndefined();
    expect(() => canonicalJson(second)).not.toThrow();
  });

  it("uses sanitized recorded controls and current loadout without mutating the input", () => {
    const robot: CombatActor = { id: "bot", kind: "robot", firmware: "bad", model: "footman",
      x: 0, y: 0, z: -4, radius: 0.4, height: 1.8, heading: 0, speed: 0 };
    let seen: SimInput | undefined;
    const combat = createCombatSystem(system => {
      seen = system.inputs.p;
      return { context: contextFromState(system.world, system.state, {
        loadouts: { p: { gadget: "balloon" } }, extraActors: [robot],
      }) };
    });
    const input = freeze({ p: { ...neutral, throttle: NaN, steer: Infinity, brake: -1,
      actions: Action.fire | Action.scan | Action.cone | Action.gadget | Action.altFire,
      aimYaw: 8 * Math.PI, aimPitch: NaN } });
    const result = step(world, freeze(initial()), input, [], [combat]);
    expect(seen).toMatchObject({ throttle: 0, steer: 0, brake: 0, aimYaw: 0 });
    expect(seen).not.toHaveProperty("aimPitch");
    expect(result.ext.combat?.players.p).toMatchObject({ cones: 2, scanTicks: 1, held: ["cone", "gadget"] });
    expect(result.ext.combat?.players.p?.water).toBe(8);
    expect(result.ext.combat?.events.filter(event => event.kind === "weapon.water" || event.kind === "weapon.cone")).toHaveLength(2);
    expect(input.p.throttle).toBeNaN();
    expect(() => canonicalJson(result)).not.toThrow();
  });

  it("does not turn an unequipped gadget action into a device input", () => {
    const result = step(world, initial(), { p: { ...neutral, actions: Action.gadget } }, [], [provider()]);
    expect(result.ext.combat?.players.p?.held).toEqual([]);
  });

  it("lets explicit provider inputs replace recorded defaults, even with an empty map", () => {
    const cases: CombatInputs[] = [{}, { p: { scan: true } }];
    for (const inputs of cases) {
      const combat = createCombatSystem(system => ({
        context: contextFromState(system.world, system.state), inputs,
      }));
      const result = step(world, initial(), { p: { ...neutral, actions: Action.fire | Action.cone } }, [], [combat]);
      expect(result.ext.combat?.players.p).toMatchObject({ water: 8, cones: 3 });
      expect(result.ext.combat?.projectiles).toEqual([]);
    }
  });

  it("selects the nearest valid refill in three dimensions with stable ID ties", () => {
    const options: CombatAdapterOptions = { refills: [
      source("upstairs", { x: 0, y: 20 }),
      source("negative", { x: 0, radius: -2 }),
      source("foreign-trunk", { x: 0, kind: "trunk", ownerId: "other" }),
      source("far", { x: 1.5 }), source("z", { x: -1 }), source("a"),
    ] };
    const previous = initial();
    previous.ext.combat = createCombatState(previous.seed, contextFromState(world, previous, options));
    previous.ext.combat.players.p!.water = 0;
    const result = step(world, freeze(previous), { p: { ...neutral, actions: Action.interact } }, [], [provider(options)]);
    expect(result.ext.combat?.players.p).toMatchObject({ refillId: "a", refillTicks: 1 });
    const reversed = step(world, previous, { p: { ...neutral, actions: Action.interact } }, [], [provider({ refills: [...options.refills!].reverse() })]);
    expect(reversed.ext.combat).toEqual(result.ext.combat);
  });

  it("ignores an empty trunk and does not refill without the interact action", () => {
    const options: CombatAdapterOptions = { loadouts: { p: { trunk: true } },
      refills: [source("empty", { x: 0, kind: "trunk", ownerId: "p" }), source("tap")] };
    const previous = initial();
    previous.ext.combat = createCombatState(previous.seed, contextFromState(world, previous, options));
    previous.ext.combat.players.p!.water = 0;
    previous.ext.combat.players.p!.reserve = 0;
    expect(step(world, previous, { p: neutral }, [], [provider(options)]).ext.combat?.players.p?.refillId).toBe("");
    const result = step(world, previous, { p: { ...neutral, actions: Action.interact } }, [], [provider(options)]);
    expect(result.ext.combat?.players.p?.refillId).toBe("tap");
  });

  it("keeps body identity and pose authoritative over runtime metadata", () => {
    const previous = initial();
    previous.ext.agents = { nextId: 2, list: [{ id: 1, kind: "errandRobot", x: 3, y: 4, z: 5, heading: 0.2, speed: 1,
      pitch: 0, vmax: 2, edge: "", dir: 1, lane: 0, s: 0, next: "", ndir: 1, nlane: 0, conn: null,
      node: "", resume: 0, lat: 0, wait: 0, dwell: 0, ghost: 0, mode: "go", rng: 1, dodge: null }] };
    const unsafe = { id: "forged", playerId: "other", x: 900, y: 900, z: 900, heading: 99, speed: 99,
      firmware: "bad", radius: 0.6 };
    const options = { actorMetadata: { "agent:1": unsafe, "player:p": unsafe } } as unknown as CombatAdapterOptions;
    freeze(previous); freeze(options);
    const ctx = contextFromState(world, previous, options);
    const actor = ctx.actors.find(value => value.id === "agent:1");
    expect(actor).toMatchObject({ id: "agent:1", x: 3, y: 4, z: 5, heading: 0.2, speed: 1, firmware: "bad", radius: 0.6 });
    expect(actor).not.toHaveProperty("playerId");
    expect(ctx.actors.find(value => value.id === "player:p")).toMatchObject({
      id: "player:p", playerId: "p", x: 0, y: 0, z: 0, heading: 0, speed: 0, firmware: "bad", radius: 0.6,
    });
    expect(unsafe.id).toBe("forged");
  });
});
