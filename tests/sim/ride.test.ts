// Robotaxi rides (v12, src/sim/ride.ts): F beside an empty stopped robotaxi hops in; the taxi
// heads for the rider's recorded destination and lets them out on arrival, or on F; the own
// car stays parked; nobody boards a moving or rogue taxi; an occupied taxi is `occupied` to
// combat and lets its rider out when it pulls over. No contacts, deterministic, upgradeable.
import { describe, expect, it } from "vitest";
import {
  Action, SIM_VERSION, activeBody, canonicalJson, createInitialState, dodgeExtOf, hashState, makeFoot, step, upgradeState,
  type AgentState, type InputFrame, type SimEvent, type SimState,
} from "../../src/sim/index.ts";
import { RIDE, RIDE_DESTINATION_EVENT, boardableTaxi, distanceToTaxi } from "../../src/sim/ride.ts";
import { contextFromState } from "../../src/sim/combat/adapter.ts";
import { gridCity } from "./fixtures.ts";

const world = gridCity();
const idle = { throttle: 0, steer: 0, brake: 0, actions: 0 };
const F: InputFrame = { p: { ...idle, actions: Action.enterExit } };
const IDLE: InputFrame = { p: idle };

/** A fresh city with taxi 1 stopped and the player on foot 1.7 m off its left side. */
function besideTaxi(): { s: SimState; taxi: AgentState } {
  const s = createInitialState(world, 5, ["p"], { x: 150, z: 0, heading: Math.PI / 2 });
  const taxi = s.ext.agents!.list.find((a) => a.kind === "robotaxi")!;
  taxi.speed = 0;
  const rx = Math.cos(taxi.heading), rz = Math.sin(taxi.heading);
  s.players.p!.mode = "foot";
  s.players.p!.foot = makeFoot(taxi.x - rx * 1.7, 0, taxi.z - rz * 1.7, taxi.heading);
  return { s, taxi };
}
const destination = (s: SimState, x: number, z: number): SimEvent => ({ tick: s.tick + 1, kind: RIDE_DESTINATION_EVENT, playerId: "p", payload: { x, z } });

describe("robotaxi rides", () => {
  it("F beside an empty stopped robotaxi hops in; the own car stays parked", () => {
    const { s: s0, taxi } = besideTaxi();
    const car = s0.players.p!.car;
    const s1 = step(world, s0, F);
    const p = s1.players.p!;
    expect(p.mode).toBe("vehicle");
    expect(p.foot).toBeNull();
    expect(p.ride).toMatchObject({ agentId: taxi.id, goal: null, exitPending: false });
    expect(activeBody(p)).toMatchObject({ x: p.ride!.x, z: p.ride!.z });
    expect(p.car.x).toBe(car.x);
    expect(p.car.z).toBe(car.z);
    // A rider's throttle and fire do nothing to the parked car.
    let s = s1;
    for (let i = 0; i < 60; i++) s = step(world, s, { p: { throttle: 1, steer: 1, brake: 0, actions: Action.fire } });
    expect(s.players.p!.car.x).toBeCloseTo(car.x, 6);
    expect(s.players.p!.car.z).toBeCloseTo(car.z, 6);
    expect(s.players.p!.ride).not.toBeNull();
  });

  it("rides to the recorded destination and steps out there, with no contact", () => {
    const { s: s0 } = besideTaxi();
    let s = step(world, s0, F);
    s = step(world, s, IDLE, [destination(s, 300, 300)]);
    expect(s.players.p!.ride!.goal).toEqual({ x: 300, z: 300 });
    for (let i = 0; i < 9000 && s.players.p!.ride; i++) s = step(world, s, IDLE);
    const p = s.players.p!;
    expect(p.ride).toBeNull();
    expect(p.mode).toBe("foot");
    expect(Math.hypot(p.foot!.x - 300, p.foot!.z - 300)).toBeLessThan(RIDE.arrive + 4);
    expect(dodgeExtOf(s).contacts).toBe(0);
    expect(dodgeExtOf(s).failures).toBe(0);
  });

  it("F mid-ride stops the taxi and the rider steps out beside it", () => {
    const { s: s0 } = besideTaxi();
    let s = step(world, s0, F);
    s = step(world, s, IDLE, [destination(s, 300, 300)]);
    for (let i = 0; i < 420; i++) s = step(world, s, IDLE);
    expect(s.players.p!.ride!.speed).toBeGreaterThan(2);
    const id = s.players.p!.ride!.agentId;
    s = step(world, s, F);
    expect(s.players.p!.ride!.exitPending).toBe(true);
    for (let i = 0; i < 600 && s.players.p!.ride; i++) s = step(world, s, IDLE);
    const p = s.players.p!;
    expect(p.mode).toBe("foot");
    const taxi = s.ext.agents!.list.find((a) => a.id === id)!;
    expect(Math.abs(taxi.speed)).toBeLessThan(0.5);
    const gap = distanceToTaxi(taxi, p.foot!.x, p.foot!.z);
    expect(gap).toBeGreaterThan(0.3);
    expect(gap).toBeLessThan(2);
    expect(dodgeExtOf(s).contacts).toBe(0);
  });

  it("F with no taxi in reach hails one passing: it pulls up and waits, then the hail lapses", () => {
    const s0 = createInitialState(world, 5, ["p"], { x: 150, z: 0, heading: Math.PI / 2 });
    const taxi = s0.ext.agents!.list.find((a) => a.kind === "robotaxi")!;
    taxi.speed = 8;
    // On foot 12 m away (out of reach to board, within hailing range).
    s0.players.p!.mode = "foot";
    s0.players.p!.foot = makeFoot(taxi.x - Math.cos(taxi.heading) * 12, 0, taxi.z - Math.sin(taxi.heading) * 12, 0);
    let s = step(world, s0, F);
    expect(s.players.p!.ride ?? null).toBeNull();
    expect(s.players.p!.hail).toEqual({ agentId: taxi.id, untilTick: s.tick + RIDE.hailTicks });
    for (let i = 0; i < 120; i++) s = step(world, s, IDLE);
    const stopped = s.ext.agents!.list.find((a) => a.id === taxi.id)!;
    expect(stopped.speed).toBe(0);
    for (let i = 0; i < RIDE.hailTicks; i++) s = step(world, s, IDLE);
    expect(s.players.p!.hail ?? null).toBeNull();
    expect(dodgeExtOf(s).contacts).toBe(0);
  });

  it("nobody boards a moving, distant or rogue robotaxi, or one already ridden", () => {
    const moving = besideTaxi();
    moving.taxi.speed = 5;
    expect(boardableTaxi(world, moving.s, moving.s.players.p!.foot!.x, moving.s.players.p!.foot!.z)).toBeNull();
    const far = besideTaxi();
    far.s.players.p!.foot = makeFoot(far.taxi.x + 30, 0, far.taxi.z, 0);
    expect(step(world, far.s, F).players.p!.ride ?? null).toBeNull();
    const rogue = besideTaxi();
    rogue.s.ext.robots = { version: 1, actors: { r: { legacyId: rogue.taxi.id, firmware: "bad", retired: false } } } as unknown as SimState["ext"]["robots"];
    expect(boardableTaxi(world, rogue.s, rogue.s.players.p!.foot!.x, rogue.s.players.p!.foot!.z)).toBeNull();
    const taken = besideTaxi();
    const boarded = step(world, taken.s, F);
    expect(boardableTaxi(world, boarded, taken.s.players.p!.foot!.x, taken.s.players.p!.foot!.z)?.id).not.toBe(taken.taxi.id);
  });

  it("an occupied taxi is `occupied` to combat, and pulling over lets the rider out", () => {
    const { s: s0, taxi } = besideTaxi();
    let s = step(world, s0, F);
    const actor = contextFromState(world, s).actors.find((a) => a.id === `agent:${taxi.id}`)!;
    expect(actor.occupied).toBe(true);
    const empty = contextFromState(world, s0).actors.find((a) => a.id === `agent:${taxi.id}`)!;
    expect(empty.occupied).toBeUndefined();
    // Water reached it (combat/effects.ts): it is pulling over for 3 s.
    s = { ...s, ext: { ...s.ext, combat: { targets: { [`agent:${taxi.id}`]: { pullOverTick: s.tick + 180 } } } as unknown as SimState["ext"]["combat"] } };
    s = step(world, s, IDLE);
    // (Already stopped: the rider is out on this very tick; else on the way out.)
    expect(s.players.p!.ride?.exitPending ?? true).toBe(true);
    for (let i = 0; i < 300 && s.players.p!.ride; i++) s = step(world, s, IDLE);
    expect(s.players.p!.mode).toBe("foot");
  });

  it("is deterministic through a JSON round trip mid-ride, and v11/v12 saves upgrade unchanged", () => {
    const { s: s0 } = besideTaxi();
    let s = step(world, s0, F);
    s = step(world, s, IDLE, [destination(s, 300, 300)]);
    for (let i = 0; i < 200; i++) s = step(world, s, IDLE);
    let a = s, b = JSON.parse(JSON.stringify(s)) as SimState;
    for (let i = 0; i < 300; i++) {
      a = step(world, a, IDLE);
      b = step(world, b, IDLE);
    }
    expect(hashState(b)).toBe(hashState(a));
    // A v12 save mid-ride keeps the active taxi, destination, parked car and every ext field.
    const riding = { ...s, version: 12 };
    expect(riding.players.p!.ride).toBeTruthy();
    const ridingBefore = canonicalJson(riding);
    expect(upgradeState(riding)).toEqual({ ...riding, version: 13 });
    expect(canonicalJson(riding)).toBe(ridingBefore);
    expect(SIM_VERSION).toBe(13);
    const old = { ...createInitialState(world, 5, ["p"], { x: 150, z: 0, heading: 0 }), version: 11 };
    const before = canonicalJson(old);
    expect(upgradeState(old)).toEqual({ ...old, version: 13 });
    expect(canonicalJson(old)).toBe(before);
  });
});
