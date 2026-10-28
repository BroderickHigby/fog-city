// SIM_VERSION 24: brake + steer rotates the player's car with a sliding tail, and the handbrake
// drifts it (src/sim/reference-driving.ts). v19 to v23 kept Slop New York's handling except its
// braking: the yaw limit used the reduced lateral grip, so braking while steering ploughed
// straight. v24 lets the yaw keep the tyres' full grip while braking against travel cuts the
// lateral grip (the original controller's steeringGrip), and the handbrake brakes the rear wheels
// only and kicks the tail out as it engages. Older replays keep v19 handling exactly.
import { describe, expect, it } from "vitest";
import {
  CAR, SIM_VERSION, createInitialState, makeCar, makeFoot, step, stepCar, upgradeState,
  type AgentState, type CarState, type SimInput, type SimState,
} from "../../src/sim/index.ts";
import { BRAKE_DRIFT_VERSION, REFERENCE_DRIVE } from "../../src/sim/reference-driving.ts";
import { vehicleOfCar, zoneDistance } from "../../src/sim/dodge.ts";
import braking from "../golden/reference-braking-819a0ad.json";
import { emptyWorld, loadDevWorldWithRoads } from "./fixtures.ts";

const world = emptyWorld();
const idle: SimInput = { throttle: 0, steer: 0, brake: 0, actions: 0 };
const drive = (c: CarState, input: SimInput, version: number, traction = 1): CarState => stepCar(world, c, input, [], traction, [], CAR, version);
function trace(c: CarState, ticks: number, input: SimInput, version = 24, traction = 1): CarState[] {
  const out: CarState[] = [];
  for (let t = 0; t < ticks; t++) out.push(c = drive(c, input, version, traction));
  return out;
}
const at20 = (): CarState => ({ ...makeCar(0, 0, 0), speed: 20 });
const deg = (rad: number): number => (rad * 180) / Math.PI;
const slipDeg = (c: CarState): number => deg(Math.atan2(c.lateral, Math.abs(c.speed)));
const brakeSteer: SimInput = { ...idle, throttle: -1, steer: 1 };
const handbrake: SimInput = { ...idle, brake: 1, steer: 1 };

describe("SIM24 brake-steer rotation and handbrake drift", () => {
  it("v24 is in the chain, and a v23 save upgrades by restamping only", () => {
    expect(SIM_VERSION).toBeGreaterThanOrEqual(24);
    expect(BRAKE_DRIFT_VERSION).toBe(24);
    const old = { ...createInitialState(world, 3, ["p"], { x: 0, z: 0, heading: 0 }), version: 23 };
    const upgraded = upgradeState(old);
    expect(upgraded).toEqual({ ...old, version: SIM_VERSION });
    expect(upgraded.players).toBe(old.players);
    expect(upgraded.ext).toBe(old.ext);
  });

  it.each(braking.scenarios)("braking against travel matches the original controller's own trajectory: $name", (scenario) => {
    expect(braking.sourceCommit).toBe("819a0adb3345e15a7c5e9558d8d00c9dd05b2ae4");
    let c: CarState = { ...makeCar(0, 0, 0), ...scenario.initial };
    for (let tick = 1; tick <= scenario.ticks; tick++) {
      c = drive(c, scenario.input, 24);
      const pin = scenario.checkpoints.find((p) => p.tick === tick);
      if (pin) for (const field of ["x", "z", "heading", "speed", "lateral", "yawRate", "steer"] as const) {
        expect(Math.abs(c[field] - pin[field]), `${scenario.name} tick ${tick} ${field}`).toBeLessThan(5e-6);
      }
    }
  });

  it("v23 and earlier keep v19 handling: braking while steering ploughs (the reason for v24)", () => {
    const s = braking.scenarios.find((x) => x.name === "brake-steer-right")!;
    const pin = s.checkpoints.find((p) => p.tick === 30)!;
    const v23 = trace({ ...makeCar(0, 0, 0), ...s.initial }, 30, s.input, 23).at(-1)!;
    expect(pin.yawRate).toBeGreaterThan(0.45);
    expect(v23.yawRate).toBeLessThan(0.15);
    for (const v of [19, 20, 21, 22, 23]) expect(trace(at20(), 60, handbrake, v)).toEqual(trace(at20(), 60, handbrake, 19));
  });

  it("full brake (S) and full steer at 20 m/s: the body turns at about 0.5 rad/s and the tail slides out", () => {
    const v24 = trace(at20(), 60, brakeSteer), v23 = trace(at20(), 60, brakeSteer, 23);
    // (Measured: v24 0.494 rad/s at 0.5 s, v23 0.135.)
    expect(v24[29]!.yawRate).toBeGreaterThan(0.45);
    expect(v23[29]!.yawRate).toBeLessThan(0.15);
    expect(deg(v24[59]!.heading)).toBeGreaterThan(20);
    expect(deg(v23[59]!.heading)).toBeLessThan(10);
    // The velocity lags the nose: a slide, not a tighter turn.
    expect(slipDeg(v24[59]!)).toBeLessThan(-20);
    expect(slipDeg(v23[59]!)).toBeGreaterThan(-5);
    // Braking is unchanged: the same speed lost either way.
    expect(Math.abs(Math.hypot(v24[29]!.speed, v24[29]!.lateral) - Math.hypot(v23[29]!.speed, v23[29]!.lateral))).toBeLessThan(0.1);
  });

  it("the handbrake (Space + steer) kicks the tail out as it engages, once, and carries more speed than the foot brake", () => {
    const hb = trace(at20(), 120, handbrake), v23 = trace(at20(), 30, handbrake, 23), foot = trace(at20(), 30, brakeSteer);
    // The kick: on the first tick the yaw rate jumps to the most the tyres allow at that speed.
    expect(hb[0]!.yawRate).toBeGreaterThan(0.4);
    expect(hb[0]!.yawRate).toBeLessThanOrEqual(REFERENCE_DRIVE.handbrakeKick + 0.05);
    expect(v23[0]!.yawRate).toBeLessThan(0.02);
    // Held, it never kicks again (one engagement takes grip below the kick's threshold).
    for (let i = 1; i < hb.length; i++) expect(hb[i]!.yawRate - hb[i - 1]!.yawRate).toBeLessThan(0.05);
    expect(hb[1]!.grip).toBeLessThan(0.95);
    // At 0.5 s: turned more than twice as far as the foot brake, with more speed left (rear wheels only).
    expect(deg(hb[29]!.heading)).toBeGreaterThan(10);
    expect(deg(hb[29]!.heading)).toBeGreaterThan(1.4 * deg(foot[29]!.heading));
    expect(hb[29]!.speed).toBeGreaterThan(foot[29]!.speed + 1.5);
    expect(deg(v23[29]!.heading)).toBeLessThan(2);
    // Released and pulled again once the grip is back: it kicks again.
    const released = trace(hb[29]!, 60, { ...idle, throttle: 1 }).at(-1)!;
    expect(released.grip).toBe(1);
    const again = trace({ ...released, yawRate: 0 }, 1, handbrake)[0]!;
    if (Math.abs(released.speed) > REFERENCE_DRIVE.handbrakeMinSpeed) expect(again.yawRate).toBeGreaterThan(0.3);
  });

  it("a flickering handbrake (pad trigger near half) kicks no harder than a steady pull", () => {
    const steady = trace(at20(), 60, handbrake);
    let c = at20();
    const flicker: CarState[] = [];
    for (let t = 0; t < 60; t++) flicker.push(c = drive(c, t % 2 ? { ...handbrake, brake: 0 } : handbrake, 24));
    const peak = (cs: CarState[]): number => Math.max(...cs.map((x) => Math.abs(x.yawRate)));
    expect(peak(flicker)).toBeLessThanOrEqual(peak(steady) + 1e-9);
    // The kick needs grip fully back: one off tick after a pull is not enough to fire it again.
    let kicks = 0;
    for (let t = 1; t < flicker.length; t++) if (Math.abs(flicker[t]!.yawRate) - Math.abs(flicker[t - 1]!.yawRate) > 0.3) kicks++;
    expect(kicks).toBeLessThanOrEqual(1);
  });

  it("in reverse the kick turns the way the car yaws for that steer", () => {
    const back: CarState = { ...makeCar(0, 0, 0), speed: -10.4 };
    const held = trace(back, 30, { ...idle, brake: 0.4, steer: 1 }, 24).at(-1)!;
    const kicked = drive(back, handbrake, 24);
    expect(Math.sign(kicked.yawRate)).toBe(Math.sign(held.yawRate));
  });

  it("is a controllable slide: release and drive on and the tyres bite; counter-steer swings it back", () => {
    const slid = trace(at20(), 30, handbrake).at(-1)!;
    expect(slipDeg(slid)).toBeLessThan(-8);
    const out = trace(slid, 90, { ...idle, throttle: 1 });
    expect(Math.abs(slipDeg(out[59]!))).toBeLessThan(2);
    expect(out[59]!.grip).toBe(1);
    expect(out[89]!.speed).toBeGreaterThan(slid.speed);
    const counter = trace(slid, 30, { ...idle, throttle: 1, steer: -1 });
    expect(slid.yawRate).toBeGreaterThan(0.4);
    expect(counter[29]!.yawRate).toBeLessThan(-0.3);
  });

  it("a half-pressed brake trigger slides less than full braking (pads are analogue)", () => {
    const half = trace(at20(), 60, { ...idle, brake: 0.45, steer: 1 }).at(-1)!, full = trace(at20(), 60, brakeSteer).at(-1)!;
    expect(slipDeg(half)).toBeGreaterThan(slipDeg(full));
    expect(half.grip).toBe(1);
  });

  it("wet streets: the same inputs rotate it less, and the yaw never exceeds what the tyres allow", () => {
    expect(trace(at20(), 30, handbrake, 24, 0.5)[29]!.yawRate).toBeLessThan(0.6 * trace(at20(), 30, handbrake)[29]!.yawRate);
    for (const speed of [-8, 5, 12, 20, 36]) for (const traction of [1, 0.5]) for (const input of [brakeSteer, handbrake, { ...idle, brake: 0.45, steer: -1 }, { ...idle, throttle: 1, brake: 1, steer: -0.6 }]) {
      for (const c of trace({ ...makeCar(0, 0, 0), speed }, 150, input, 24, traction)) {
        expect(Math.abs(c.yawRate) * Math.max(2, Math.abs(c.speed)), `${speed} m/s, traction ${traction}, ${JSON.stringify(input)}`).toBeLessThanOrEqual(REFERENCE_DRIVE.grip * traction + 0.01);
      }
    }
  });

  it("plain steering, plain throttle and straight braking are exactly v23's", () => {
    for (const input of [{ ...idle, steer: 1 }, { ...idle, throttle: 1, steer: -0.6 }, { ...idle, brake: 1 }, { ...idle, throttle: -1 }, idle]) {
      expect(trace(at20(), 90, input)).toEqual(trace(at20(), 90, input, 23));
    }
  });

  it("stays inside the pedestrian escape reach (dodge.ts) for brake-steer, the handbrake's kick, slip and impact yaw", () => {
    for (const speed of [-10, 0, 5, 9.5, 25, 55]) for (const lateral of [-4, 4]) for (const yawRate of [-2, 0, 2]) for (const grip of [1, 0.5])
      for (const steer of [-1, 1]) for (const throttle of [-1, 0, 1]) for (const brake of [0, 0.45, 1]) {
        const c = { ...makeCar(0, 0, 0), speed, lateral, yawRate, grip }, next = drive(c, { ...idle, steer, throttle, brake }, 24);
        const reach = vehicleOfCar("p", c, null, world), fx = Math.sin(next.heading), fz = -Math.cos(next.heading), rx = -fz, rz = fx;
        for (const fore of [-CAR.halfLength, CAR.halfLength]) for (const side of [-CAR.halfWidth, CAR.halfWidth]) {
          expect(zoneDistance(reach, next.x + fore * fx + side * rx, next.z + fore * fz + side * rz)).toBeLessThanOrEqual(1e-8);
        }
      }
  });

  it("the game step drives the player's car with it; a v23 state keeps the old handling", () => {
    const base = createInitialState(world, 7, ["p"], { x: 0, z: 0, heading: 0 });
    const moving: SimState = { ...base, players: { p: { ...base.players.p!, car: { ...base.players.p!.car, speed: 20 } } } };
    let now = moving, old: SimState = { ...moving, version: 23 };
    for (let t = 0; t < 30; t++) { now = step(world, now, { p: handbrake }, [], []); old = step(world, old, { p: handbrake }, [], []); }
    expect(now.version).toBe(SIM_VERSION);
    expect(old.version).toBe(23);
    expect(deg(now.players.p!.car.heading)).toBeGreaterThan(10);
    expect(deg(old.players.p!.car.heading)).toBeLessThan(2);
  });

  it("a driven (H) taxi is the player's handling too: it rotates under brake + steer at v24 only", () => {
    const base = createInitialState(world, 7, ["p"], { x: 100, z: 100, heading: 0 });
    const car = { ...makeCar(0, 0, 0), speed: 20 };
    const taxi = { id: 1001, kind: "robotaxi", x: 0, y: 0, z: 0, heading: 0, pitch: 0, speed: car.speed, vmax: 12, edge: "", dir: 1, lane: 0, s: 0, next: "", ndir: 1, nlane: 0, conn: null, node: "", resume: 0, lat: 0, wait: 0, dwell: 0, ghost: 0, mode: "go", rng: 7, dodge: null, manualCar: car } as AgentState;
    const start: SimState = { ...base, players: { p: { ...base.players.p!, ride: { agentId: taxi.id, manual: true, x: 0, y: 0, z: 0, heading: 0, speed: car.speed, goal: null, exitPending: false } } }, ext: { ...base.ext, agents: { nextId: 1002, list: [taxi] } } };
    const run = (version: number): number => {
      let s: SimState = { ...start, version };
      for (let t = 0; t < 30; t++) s = step(world, s, { p: handbrake }, [], []);
      return deg(s.ext.agents!.list.find((a) => a.id === taxi.id)!.heading);
    };
    expect(run(24)).toBeGreaterThan(10);
    expect(run(23)).toBeLessThan(2);
  });

  it("ambient traffic drives exactly as before: robotaxis and cars never use the player's handling", () => {
    const { world: dev, spawn } = loadDevWorldWithRoads();
    const base = createInitialState(dev, 5, ["p"], spawn);
    const onFoot: SimState = { ...base, players: { p: { ...base.players.p!, mode: "foot", foot: makeFoot(spawn.x + 6, 0, spawn.z, 0) } } };
    expect(onFoot.ext.agents!.list.length).toBeGreaterThan(0);
    let now = onFoot, old: SimState = { ...onFoot, version: 23 };
    for (let t = 0; t < 120; t++) { now = step(dev, now, { p: idle }, [], []); old = step(dev, old, { p: idle }, [], []); }
    expect(now.ext.agents).toEqual(old.ext.agents);
  }, 60_000);
});
