// v22: on foot, F beside a stopped civilian car steals it (src/sim/steal-car.ts).
import { describe, expect, it } from "vitest";
import { Action, SIM_VERSION, canonicalJson, createGameSystems, createInitialState, dcos, dsin, hashState, makeCar, makeFoot, step, upgradeState, type InputFrame, type SimState } from "../../src/sim/index.ts";
import { isCivilianTraffic } from "../../src/sim/civilian-traffic.ts";
import { RIDE, distanceToTaxi } from "../../src/sim/ride.ts";
import { STEAL_CAR_VERSION, stealableCar } from "../../src/sim/steal-car.ts";
import { gridCity } from "./fixtures.ts";

const world = gridCity(), idle = { throttle: 0, steer: 0, brake: 0, actions: 0 };
const F: InputFrame = { p: { ...idle, actions: Action.enterExit } }, IDLE: InputFrame = { p: idle };
const CIV = 7;

/** A player on foot 1.7 m off the left side of a stopped civilian car (the only agent). */
function besideCivilian(): SimState {
  const s = createInitialState(world, 5, ["p"], { x: 150, z: 0, heading: Math.PI / 2 });
  const car = { ...s.ext.agents!.list.find((a) => a.kind === "robotaxi" && a.id % 8 !== 7)!, id: CIV, speed: 0 };
  expect(isCivilianTraffic(car)).toBe(true);
  s.ext.agents!.list = [car];
  s.players.p!.mode = "foot";
  s.players.p!.foot = makeFoot(car.x - Math.cos(car.heading) * 1.7, 0, car.z - Math.sin(car.heading) * 1.7, car.heading);
  return s;
}
function run(s: SimState, n: number, input = { ...idle, throttle: 1 }): SimState {
  for (let i = 0; i < n; i++) s = step(world, s, { p: input });
  return s;
}

describe("v22 stealing a civilian car", () => {
  it("F beside a stopped civilian car takes it: the player drives it, it keeps its look, the own car stays parked", () => {
    const start = besideCivilian(), frozen = canonicalJson(start), own = { ...start.players.p!.car };
    let s = step(world, start, F);
    expect(s.players.p!.mode).toBe("vehicle");
    expect(s.players.p!.foot).toBeNull();
    expect(s.players.p!.ride).toMatchObject({ agentId: CIV, manual: true, exitPending: false });
    const stolen = s.ext.agents!.list.find((a) => a.id === CIV)!;
    expect(stolen.manualCar).toBeTruthy();
    expect(isCivilianTraffic(stolen)).toBe(true);
    const at = { ...s.players.p!.ride! };
    s = run(s, 120);
    expect(Math.hypot(s.players.p!.ride!.x - at.x, s.players.p!.ride!.z - at.z)).toBeGreaterThan(8);
    expect(s.players.p!.ride!.speed).toBeGreaterThan(5);
    const car = s.ext.agents!.list.find((a) => a.id === CIV)!;
    expect(s.players.p!.ride).toMatchObject({ x: car.x, z: car.z, heading: car.heading, speed: car.speed });
    expect(s.players.p!.car.x).toBe(own.x);
    expect(s.players.p!.car.z).toBe(own.z);
    expect(canonicalJson(start)).toBe(frozen);
  });

  it("F beside your own car still gets into your own car, even with a civilian car nearer", () => {
    const s = besideCivilian(), civ = s.ext.agents!.list[0]!;
    const fx = dsin(civ.heading), fz = -dcos(civ.heading), lx = -Math.cos(civ.heading), lz = -Math.sin(civ.heading);
    s.players.p!.car = makeCar(civ.x - fx * 8, civ.z - fz * 8, civ.heading, 0);
    s.players.p!.foot = makeFoot(civ.x - fx * 4 + lx * 1.6, 0, civ.z - fz * 4 + lz * 1.6, civ.heading);
    const foot = s.players.p!.foot;
    expect(distanceToTaxi(civ, foot.x, foot.z)).toBeLessThan(RIDE.boardRange);
    expect(stealableCar(world, s, s.ext.agents!.list, foot.x, foot.z)?.id).toBe(CIV);
    const next = step(world, s, F);
    expect(next.players.p!.mode).toBe("vehicle");
    expect(next.players.p!.ride ?? null).toBeNull();
    expect(next.ext.agents!.list.find((a) => a.id === CIV)!.manualCar).toBeUndefined();
  });

  it("F with nothing in reach does nothing, and a moving civilian car is not taken", () => {
    const far = besideCivilian(), civ = far.ext.agents!.list[0]!;
    far.players.p!.foot = makeFoot(civ.x - Math.cos(civ.heading) * 12, 0, civ.z - Math.sin(civ.heading) * 12, civ.heading);
    for (const s of [far, (() => { const m = besideCivilian(); m.ext.agents!.list[0]!.speed = RIDE.boardSpeed + 1; return m; })()]) {
      const next = step(world, s, F);
      expect(next.players.p!.mode).toBe("foot");
      expect(next.players.p!.ride ?? null).toBeNull();
      expect(next.players.p!.hail ?? null).toBeNull();
      expect(next.ext.agents!.list.find((a) => a.id === CIV)!.manualCar).toBeUndefined();
    }
  });

  it("a v21 replay keeps the old rule: F beside a civilian car does nothing", () => {
    const s = { ...besideCivilian(), version: STEAL_CAR_VERSION - 1 };
    const next = step(world, s, F);
    expect(next.players.p!.mode).toBe("foot");
    expect(next.players.p!.ride ?? null).toBeNull();
  });

  it("a save round-trips mid-drive, F gets out and parks it, and F beside it drives it again", () => {
    const go = (restore: boolean): { state: SimState; hashes: string[] } => {
      let s = run(step(world, besideCivilian(), F), 60);
      const hashes: string[] = [];
      if (restore) s = upgradeState(JSON.parse(canonicalJson(s)) as SimState);
      s = run(s, 60);
      hashes.push(hashState(s));
      s = step(world, s, F);
      for (let i = 0; i < 300 && s.players.p!.ride; i++) s = step(world, s, IDLE);
      hashes.push(hashState(s));
      return { state: s, hashes };
    };
    const direct = go(false), restored = go(true);
    expect(restored.hashes).toEqual(direct.hashes);
    let s = direct.state;
    expect(s.version).toBe(SIM_VERSION);
    expect(s.players.p!.mode).toBe("foot");
    const parked = s.ext.agents!.list.find((a) => a.id === CIV)!;
    expect(parked.manualCar).toBeTruthy();
    expect(parked.speed).toBe(0);
    s = run(s, 30, idle);
    expect(s.ext.agents!.list.find((a) => a.id === CIV)).toMatchObject({ x: parked.x, z: parked.z, heading: parked.heading });
    s = step(world, s, F);
    expect(s.players.p!.ride).toMatchObject({ agentId: CIV, manual: true });
  });

  it("upgrades a v21 save by restamping only", () => {
    const old = { ...besideCivilian(), version: 21 };
    expect(SIM_VERSION).toBe(23);
    expect(upgradeState(old)).toEqual({ ...old, version: 23 });
  });

  it("a driver sprays from a stolen car as far as from their own car (the car they drive is not a wall)", () => {
    const systems = createGameSystems({ wave: 3 });
    const spray = (stolen: boolean): { reach: number; ends: string[] } => {
      let s = step(world, besideCivilian(), IDLE, [], systems);
      const civ = s.ext.agents!.list.find((a) => a.id === CIV)!;
      if (stolen) {
        s = step(world, s, F, [], systems);
        expect(s.players.p!.ride).toMatchObject({ agentId: CIV, manual: true });
      } else {
        s.ext.agents!.list = [];
        s.players.p!.mode = "vehicle"; s.players.p!.foot = null;
        s.players.p!.car = makeCar(civ.x, civ.z, civ.heading, civ.y);
      }
      const at = { x: civ.x, z: civ.z };
      let reach = 0;
      const ends: string[] = [];
      for (let i = 0; i < 90; i++) {
        s = step(world, s, { p: { ...idle, actions: i < 10 ? Action.fire : 0 } }, [], systems);
        for (const q of s.ext.combat?.projectiles ?? []) reach = Math.max(reach, Math.hypot(q.x - at.x, q.z - at.z));
        for (const e of s.ext.combat?.events ?? []) if (e.tick === s.tick && e.kind === "projectile.ended") ends.push(e.detail);
      }
      return { reach, ends };
    };
    const own = spray(false), stolen = spray(true);
    expect(own.reach).toBeGreaterThan(3);
    expect(stolen.reach).toBeCloseTo(own.reach, 1);
    expect(stolen.ends).not.toContain("wall");
    expect(stolen.ends.length).toBe(own.ends.length);
  });

  it("two players pressing F beside the same car on the same tick: the first by id gets it, the other stays on foot", () => {
    const s = besideCivilian(), foot = s.players.p!.foot!, civ = s.ext.agents!.list[0]!;
    s.players.q = { ...s.players.p!, id: "q", car: makeCar(civ.x + 60, civ.z + 60, 0, 0),
      foot: makeFoot(civ.x + Math.cos(civ.heading) * 1.7, 0, civ.z + Math.sin(civ.heading) * 1.7, civ.heading) };
    expect(foot).toBeTruthy();
    const both = { p: F.p!, q: F.p! };
    const next = step(world, s, both);
    expect(next.players.p!.ride).toMatchObject({ agentId: CIV, manual: true });
    expect(next.players.q!.mode).toBe("foot");
    expect(next.players.q!.ride ?? null).toBeNull();
    // Swapped ids give the car to the other walker: the order is by player id, never by input order.
    const swapped = step(world, s, { q: F.p!, p: F.p! });
    expect(hashState(swapped)).toBe(hashState(next));
  });

  it("a robotaxi and a civilian car at the same distance: F boards the robotaxi as a passenger (a car is stolen only when nearer)", () => {
    const s = besideCivilian(), civ = s.ext.agents!.list[0]!;
    const taxi = { ...civ, id: 8, x: civ.x - Math.cos(civ.heading) * 3.4, z: civ.z - Math.sin(civ.heading) * 3.4 };
    s.ext.agents!.list = [civ, taxi];
    const foot = s.players.p!.foot!;
    expect(distanceToTaxi(taxi, foot.x, foot.z)).toBeCloseTo(distanceToTaxi(civ, foot.x, foot.z), 9);
    const next = step(world, s, F);
    expect(next.players.p!.ride).toMatchObject({ agentId: 8 });
    expect(next.players.p!.ride!.manual).toBeUndefined();
    expect(next.ext.agents!.list.find((a) => a.id === CIV)!.manualCar).toBeUndefined();
  });
});
