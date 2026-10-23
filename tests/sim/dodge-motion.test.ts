// People get out of a car's way on their feet (SIM_VERSION 10, the dodge stream: "they jump out
// of the way in too weird of a way ... they like fly"). Bounds on how a dodging person or player
// on foot moves, measured tick by tick (tests/sim/dodge-motion.ts): never off the ground, never
// faster than a scramble's pace, speeding up no faster than a lunge outside the safety pull-ups,
// and the override (the hard guarantee) a rare last resort. And the v8 -> v10 save upgrade.
import { describe, expect, it } from "vitest";
import {
  DODGE_PROFILE,
  EMERGENCY_ACCEL,
  EMERGENCY_BOOST,
  SIM_VERSION,
  agentsOf,
  buildWorld,
  canonicalJson,
  hashState,
  step,
  upgradeState,
  type SimState,
} from "../../src/sim/index.ts";
import saved from "../golden/legacy-saves/v8-mid-dodge.json";
import { deepFreeze } from "../helpers.ts";
import { DodgeMotion, HARD_STOP_MPS2, pct, straightAtOne } from "./dodge-motion.ts";
import { makeScene, run } from "./dodge-scenes.ts";

/** The fastest anyone moves getting out of the way: a scramble (a person's or a player's). */
const TOP = Math.max(DODGE_PROFILE.person.speed, DODGE_PROFILE.player.speed) * EMERGENCY_BOOST;
/** The hardest anyone speeds up or slows down on their own: a scrambling lunge. */
const LUNGE = Math.max(DODGE_PROFILE.person.accel, DODGE_PROFILE.player.accel) * EMERGENCY_ACCEL;

describe("how people move getting out of the way (v10)", () => {
  it("human pace: at most 6 m/s, a sprint's top speed; no faster than about 4.8 m/s unhurried", () => {
    expect(TOP).toBeLessThanOrEqual(6 + 1e-9);
    expect(DODGE_PROFILE.person.speed).toBeLessThanOrEqual(5);
    expect(DODGE_PROFILE.care.speed).toBeLessThan(DODGE_PROFILE.person.speed);
    for (const cls of ["person", "care", "player"] as const) {
      expect(DODGE_PROFILE[cls].peak).toBe(0);
      expect(DODGE_PROFILE[cls].leapPeak).toBe(0);
    }
  });

  it("across 60 of the no-touch fuzz's scenes: never off the ground, never faster than a scramble, speeding up no harder than a lunge but for the override's jumps and the safety pull-ups", () => {
    let samples = 0;
    let dives = 0;
    let pullUps = 0;
    let fastest = 0;
    let lift = 0;
    const accels: number[] = [];
    for (let seed = 1; seed <= 60; seed++) {
      const sc = makeScene(seed);
      const m = new DodgeMotion(sc.world);
      run(sc, (a, b) => m.tick(a, b));
      const s = m.summary();
      samples += s.samples;
      dives += s.dives;
      pullUps += s.hardStops;
      fastest = Math.max(fastest, s.peakDiveSpeed);
      lift = Math.max(lift, s.peakLift, s.peakHop);
      accels.push(...m.accelSamples());
    }
    const accel99 = pct(accels, 0.99);
    console.info(`[dodge motion] ${dives} dives, ${samples} body-ticks: fastest ${fastest.toFixed(2)} m/s, lift ${lift.toFixed(4)} m, p99 acceleration ${accel99.toFixed(1)} m/s2, ${pullUps} pull-ups`);
    expect(dives).toBeGreaterThan(100);
    expect(lift).toBeLessThan(1e-6);
    // (Speed per tick from the drawn positions: the top speed plus rounding.)
    expect(fastest).toBeLessThanOrEqual(TOP + 0.05);
    expect(accel99).toBeLessThanOrEqual(LUNGE * 1.01);
    expect(accel99).toBeLessThan(HARD_STOP_MPS2);
    // Pull-ups (stopped short of a vehicle's reach) are rare: well under one a dive.
    expect(pullUps).toBeLessThan(dives * 0.5);
  });

  it("a car driven straight at someone, at 6 to 30 m/s: they step or run aside in time, never leave the ground, never need the override", () => {
    const flat = buildWorld([{ tileId: "flat", buildings: [], ground: null }]);
    for (const speed of [6, 10, 15, 20, 30]) {
      // (dodge-motion-report.ts runs the same drive and records it.)
      const m = new DodgeMotion(flat);
      let s = straightAtOne(flat, speed);
      for (let t = 0; t < Math.round((80 / speed + 3) * 60); t++) {
        const prev = s;
        const c = s.players.car!.car;
        s = step(flat, s, { car: { throttle: c.speed < speed ? 1 : 0, steer: 0, brake: 0, actions: 0 } }, []);
        m.tick(prev, s);
      }
      const r = m.summary();
      expect(r.dives, `${speed} m/s`).toBe(1);
      expect(r.overrides, `${speed} m/s`).toBe(0);
      expect(r.peakLift, `${speed} m/s`).toBeLessThan(1e-6);
      expect(r.peakDiveSpeed, `${speed} m/s`).toBeLessThanOrEqual(DODGE_PROFILE.person.speed + 0.05);
      expect(r.p99Accel, `${speed} m/s`).toBeLessThanOrEqual(DODGE_PROFILE.person.accel * 1.01);
    }
  });
});

describe("the v8 -> v10 save upgrade (dodges in flight)", () => {
  it("a real v8 save mid-dodge: people and players lose their hop (y back on the ground), robots keep theirs, every dodge gains a standstill velocity and its profile's top speed; nothing else changes", () => {
    expect(saved.simVersion).toBe(8);
    const old = deepFreeze(saved.state as unknown as SimState);
    expect(hashState(old)).toBe(saved.hash);
    const before = canonicalJson(old);
    const up = upgradeState(old);
    expect(SIM_VERSION).toBe(10);
    expect(up.version).toBe(10);
    expect(canonicalJson(old)).toBe(before);
    const ob = old.players.b!.foot!;
    const ub = up.players.b!.foot!;
    expect(ob.dodge!.hop).toBeGreaterThan(0.1);
    expect(ub.y).toBeCloseTo(ob.y - ob.dodge!.hop, 12);
    expect(ub.dodge).toEqual({ ...ob.dodge!, hop: 0, peak: 0, vx: 0, vz: 0, vmax: DODGE_PROFILE.player.speed });
    const olds = agentsOf(old);
    const ups = agentsOf(up);
    let people = 0;
    let robots = 0;
    olds.forEach((a, i) => {
      const u = ups[i]!;
      if (!a.dodge) {
        expect(u).toEqual(a);
        return;
      }
      if (a.kind === "person") {
        people++;
        expect(u.y).toBeCloseTo(a.y - a.dodge.hop, 12);
        expect(u.dodge).toEqual({ ...a.dodge, hop: 0, peak: 0, vx: 0, vz: 0, vmax: u.dodge!.vmax });
        expect([DODGE_PROFILE.person.speed, DODGE_PROFILE.care.speed]).toContain(u.dodge!.vmax);
      } else {
        robots++;
        expect(u.y).toBe(a.y);
        expect(u.dodge).toEqual({ ...a.dodge, vx: 0, vz: 0, vmax: DODGE_PROFILE.errandRobot.speed });
      }
    });
    expect(people).toBeGreaterThan(0);
    expect(robots).toBeGreaterThan(0);
    expect({ ...up, players: {}, ext: {} }).toEqual({ ...old, version: 10, players: {}, ext: {} });
    expect(upgradeState(up)).toBe(up);
    // A v9 stamp (the structural world's) takes the same step.
    expect(upgradeState({ ...old, version: 9 })).toEqual(up);
    // It steps on from there, deterministically, everyone on the ground.
    const world = buildWorld([{ tileId: "flat", buildings: [], ground: null }]);
    let a = up;
    let b = upgradeState(JSON.parse(before) as SimState);
    for (let t = 0; t < 120; t++) {
      a = step(world, a, { a: { throttle: 1, steer: 0, brake: 0, actions: 0 } });
      b = step(world, b, { a: { throttle: 1, steer: 0, brake: 0, actions: 0 } });
      for (const g of agentsOf(a)) if (g.kind === "person") expect(g.y).toBeCloseTo(0, 9);
    }
    expect(hashState(a)).toBe(hashState(b));
  });
});
