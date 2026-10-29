// The dodge (src/sim/dodge.ts, the owner's Crazy Taxi rule): the prediction of a vehicle's
// swept footprint, which side a body dives to, the dive itself, the clearance override, and
// the dodge inside step() (people are never a car's obstacle; robotaxis and robots; children's
// wider berth). The seeded no-touch fuzz is tests/sim/dodge-fuzz.test.ts; the clearance soak on
// the real city is tests/sim/dodge-soak.test.ts.
import { describe, expect, it } from "vitest";
import {
  CAR_MAX_TURN_ACCEL,
  AGENT_SPEC,
  CAR,
  DODGE_MIN_SPEED,
  DODGE_PROFILE,
  EMERGENCY_BOOST,
  FOOT,
  LANDING_EXTRA_M,
  LANDING_PER_MPS,
  REACT_LAG_S,
  REACT_S,
  SAMPLE_S,
  SLIP_RAD,
  advanceDodge,
  agentDodgeClass,
  agentPath,
  agentsOf,
  bodyDistance,
  boxDistance,
  buildWorld,
  chooseDive,
  createInitialState,
  dodgeExtOf,
  horizonS,
  makeCar,
  makeFoot,
  makeVehicle,
  meshGroundHeight,
  overrideSpot,
  pathPoint,
  personIsChild,
  predictPaths,
  redirectDive,
  rejoinAt,
  segmentBlocked,
  step,
  upgradeState,
  sweepClearance,
  sweepHit,
  vehicleOfAgent,
  zoneDistance,
  vehicleOfCar,
  type AgentState,
  type AgentsExt,
  type BoundaryFile,
  type BuildingCollider,
  type DodgeState,
  type Ground,
  type SimState,
  type Vehicle,
  type World,
  withoutStreetProps,
} from "../../src/sim/index.ts";
import { deepFreeze } from "../helpers.ts";
import { emptyWorld, gridCity, terrainWorld } from "./fixtures.ts";

const flat = emptyWorld();
const ground = (world: World): Ground => ({ world, height: (x, z) => meshGroundHeight(world, x, z) });

function box(id: string, x0: number, z0: number, x1: number, z1: number, topY = 10): BuildingCollider {
  return { id, footprint: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], baseY: 0, topY };
}

/** A player's car at (x, z) facing `heading` at `speed` (sliding `lateral`, yawing `yaw`) as a vehicle. */
function carVehicle(x: number, z: number, heading: number, speed: number, lateral = 0, yaw = 0): Vehicle {
  return vehicleOfCar("p", { ...makeCar(x, z, heading), speed, lateral, yawRate: yaw });
}

describe("the predicted footprint", () => {
  it("looks 1 s ahead, 0.05 s more per m/s, at most 2.5 s (v14: people on foot need the time)", () => {
    expect(horizonS(0)).toBe(1);
    expect(horizonS(10)).toBeCloseTo(1.5, 12);
    expect(horizonS(20)).toBeCloseTo(2, 12);
    expect(horizonS(30)).toBe(2.5);
    expect(horizonS(60)).toBe(2.5);
  });

  it("is empty below DODGE_MIN_SPEED", () => {
    expect(carVehicle(0, 0, 0, DODGE_MIN_SPEED - 0.01).paths).toEqual([]);
    expect(carVehicle(0, 0, 0, DODGE_MIN_SPEED + 0.01).paths).toHaveLength(1);
  });

  it("goes straight along the velocity, sampled every SAMPLE_S to the horizon", () => {
    const v = carVehicle(0, 0, 0, 20); // north
    expect(v.paths).toHaveLength(1);
    const p = v.paths[0]!;
    expect(p).toHaveLength(Math.ceil(horizonS(20) / SAMPLE_S) + 1);
    const last = p[p.length - 1]!;
    expect(last.t).toBeCloseTo(horizonS(20), 9);
    expect(last.x).toBeCloseTo(0, 9);
    expect(last.z).toBeCloseTo(-20 * last.t, 9);
  });

  it("follows the velocity, not the nose: a car sliding sideways is predicted sideways", () => {
    // Facing north, sliding east at 15 m/s with no forward speed.
    const v = carVehicle(0, 0, 0, 0, 15);
    const last = v.paths[0]!.at(-1)!;
    expect(last.x).toBeCloseTo(15 * last.t, 6);
    expect(Math.abs(last.z)).toBeLessThan(1e-9);
    // Its body still faces north in every sample.
    expect(last.fz).toBeCloseTo(-1, 9);
  });

  it("sliding (velocity more than SLIP_RAD off the nose), also the path it takes if its tyres bite again, off along its nose", () => {
    // Facing north at 19 m/s, sliding right at 6.7 m/s (a drift being caught).
    const v = carVehicle(0, 0, 0, 19, 6.7);
    expect(v.paths).toHaveLength(2);
    const [slide, nose] = [v.paths[0]!.at(-1)!, v.paths[1]!.at(-1)!];
    const speed = Math.hypot(19, 6.7);
    expect(slide.x).toBeCloseTo(6.7 * slide.t, 6);
    expect(nose.x).toBeCloseTo(0, 9);
    expect(nose.z).toBeCloseTo(-speed * nose.t, 6);
    // Not sliding (under SLIP_RAD off the nose): one path.
    expect(carVehicle(0, 0, 0, 19, 19 * Math.tan(SLIP_RAD * 0.9)).paths).toHaveLength(1);
  });

  it("turning: the arc it is on and the straight line it would slide along, both with the body yawing; for a player's car, the hardest turn its tyres allow too", () => {
    const v = carVehicle(0, 0, 0, 20, 0, 0.5); // north, turning right
    expect(v.paths).toHaveLength(3);
    const [arc, line, hard] = v.paths as [typeof v.paths[0], typeof v.paths[0], typeof v.paths[0]];
    expect(arc.at(-1)!.x).toBeGreaterThan(2); // bends east
    expect(Math.abs(line.at(-1)!.x)).toBeLessThan(1e-9); // straight on
    // The body turns in both, by the yaw rate.
    const turned = Math.atan2(arc.at(-1)!.fx, -arc.at(-1)!.fz);
    expect(turned).toBeCloseTo(0.5 * arc.at(-1)!.t, 6);
    expect(Math.atan2(line.at(-1)!.fx, -line.at(-1)!.fz)).toBeCloseTo(turned, 9);
    // The hardest turn: CAR_MAX_TURN_ACCEL / speed rad/s (the front's grip with full weight
    // transfer, v12 dynamics), bending further east than the arc.
    expect(Math.atan2(hard.at(-1)!.fx, -hard.at(-1)!.fz)).toBeCloseTo((CAR_MAX_TURN_ACCEL / 20) * hard.at(-1)!.t, 6);
    expect(hard.at(-1)!.x).toBeGreaterThan(arc.at(-1)!.x + 1);
    // A robotaxi keeps to its route: no such guess.
    expect(predictPaths({ ...v, spread: 0 })).toHaveLength(2);
  });

  it("counts on braking it is told about (a robotaxi's), after its reaction time, and ends where that stops it", () => {
    const v = predictPaths({ x: 0, z: 0, fx: 0, fz: -1, vx: 0, vz: -10, speed: 10, yawRate: 0, decel: 15, react: 0 });
    const last = v[0]!.at(-1)!;
    expect(-last.z).toBeCloseTo((10 * 10) / (2 * 15), 9);
    expect(last.t).toBeLessThan(horizonS(10));
    // Reacting 0.1 s later adds 1 m at 10 m/s.
    const late = predictPaths({ x: 0, z: 0, fx: 0, fz: -1, vx: 0, vz: -10, speed: 10, yawRate: 0, decel: 15, react: 0.1 });
    expect(-late[0]!.at(-1)!.z).toBeCloseTo((10 * 10) / (2 * 15) + 1, 9);
  });

  it("sweepHit: the first predicted moment the body comes within reach; null beside the path beyond reach", () => {
    const v = carVehicle(0, 0, 0, 20); // north at 20 m/s
    // A person 15 m ahead: the nose (2.2 m) plus reach 1.05 meets them after ~(15 - 3.25) / 20 s.
    const hit = sweepHit(v, 0, -15, 1.05)!;
    expect(hit).not.toBeNull();
    expect(hit.t).toBeGreaterThan((15 - 3.25) / 20 - SAMPLE_S - 1e-9);
    expect(hit.t).toBeLessThanOrEqual((15 - 3.25) / 20 + SAMPLE_S);
    // 3 m to the side: never within 1.05 m of the body (0.95 half width), even with the spread.
    expect(sweepHit(carVehicle(0, 0, 0, 10), 3.2, -5, 1.05)).toBeNull();
    // Beyond the horizon: nothing yet.
    expect(sweepHit(v, 0, -60, 1.05)).toBeNull();
    // A player's car's footprint widens with time; a robotaxi's does not.
    expect(v.spread).toBeGreaterThan(0);
  });

  it("sweepClearance is the least distance to the footprint less its spread; boxDistance is signed", () => {
    expect(boxDistance(0, 0, 0, 0, 0, -1, 2, 1)).toBe(-1);
    expect(boxDistance(3, 0, 0, 0, 0, -1, 2, 1)).toBe(2);
    expect(boxDistance(4, -6, 0, 0, 0, -1, 2, 1)).toBeCloseTo(5, 12);
    // A parked car has no footprint: its reach over a step (its body, and the hair it could
    // creep if it set off), zoneDistance.
    const parked = carVehicle(0, 0, 0, 0);
    expect(sweepClearance(parked, 3, 0)).toBeCloseTo(3 - CAR.halfWidth - parked.inflate, 9);
    expect(parked.inflate).toBeLessThan(0.02);
  });
});

describe("where a body dives", () => {
  const person = (x: number, z: number, id = 1) => ({ x, z, y: 0, r: 0.3, cls: "person" as const, id });

  it("square to the path, to the side it is on, just clear of the footprint plus margin and the landing extra (v14: more from a faster car holding its line)", () => {
    const v = carVehicle(0, 30, 0, 25); // north at 25 m/s, at the person (x 0.4 right of its line)
    const extra = LANDING_EXTRA_M + LANDING_PER_MPS * 25;
    for (const [x, side] of [
      [0.4, 1],
      [-0.4, -1],
    ] as const) {
      const b = person(x, 0);
      const hit = sweepHit(v, b.x, b.z, b.r + 0.75)!;
      const to = chooseDive(ground(flat), b, hit, [v], [])!;
      expect(Math.sign(to.x - b.x)).toBe(side);
      expect(Math.abs(to.z - b.z)).toBeLessThan(1e-9);
      expect(sweepClearance(v, to.x, to.z)).toBeGreaterThanOrEqual(b.r + 0.75 + extra - 1e-9);
      // ... and not much further than that (the nearest clear spot on the line).
      expect(sweepClearance(v, to.x, to.z)).toBeLessThan(b.r + 0.75 + extra + 0.3);
    }
  });

  it("a body square on the line picks a side by its id, the same every time", () => {
    const v = carVehicle(0, 30, 0, 25);
    const sides = new Set<number>();
    for (let id = 1; id <= 12; id++) {
      const b = person(0, 0, id);
      const to = chooseDive(ground(flat), b, sweepHit(v, 0, 0, 1.05)!, [v], [])!;
      expect(chooseDive(ground(flat), b, sweepHit(v, 0, 0, 1.05)!, [v], [])).toEqual(to);
      sides.add(Math.sign(to.x));
    }
    expect([...sides].sort()).toEqual([-1, 1]);
  });

  it("its side blocked by a building: the other side, never into or through the building", () => {
    // A building's face 0.6 m right of the person (east), the car coming north 0.4 m to their left.
    const w = buildWorld([{ tileId: "b", buildings: [box("b", 1.0, -20, 20, 20)], ground: null }]);
    const v = carVehicle(-0.4, 50, 0, 25); // (50 m: about when someone sees it coming, horizonS(25) = 2.25 s; on foot they need the time, v14)
    const b = person(0.1, 0);
    const to = chooseDive(ground(w), b, sweepHit(v, b.x, b.z, 1.05)!, [v], [])!;
    expect(to.x).toBeLessThan(-0.4); // across the car's path, to the west
    expect(segmentBlocked(w, b.x, b.z, to.x, to.z)).toBe(false);
  });

  it("its side behind a wall (the shore, a kerb rail): the other side", () => {
    // Shore along x = 1 (land to the west, the water east of it).
    const boundary: BoundaryFile = { version: 1, seaLevelY: 0, edges: [], shore: [{ closed: false, points: [[1, -200], [1, 200]] }] };
    const w = buildWorld([{ tileId: "f", buildings: [], ground: null }], null, boundary);
    expect(w.walls!.segments.length).toBe(1);
    const v = carVehicle(-0.3, 50, 0, 25); // (50 m: about when someone sees it coming, horizonS(25) = 2.25 s; on foot they need the time, v14)
    const b = person(0.2, 0);
    const to = chooseDive(ground(w), b, sweepHit(v, b.x, b.z, 1.05)!, [v], [])!;
    expect(to.x).toBeLessThan(0);
  });

  it("never lands on another body or another diver's landing spot (when there is room)", () => {
    const v = carVehicle(0, 30, 0, 25);
    const b = person(0.4, 0);
    const first = chooseDive(ground(flat), b, sweepHit(v, b.x, b.z, 1.05)!, [v], [])!;
    const second = chooseDive(ground(flat), b, sweepHit(v, b.x, b.z, 1.05)!, [v], [{ x: first.x, z: first.z, r: 0.3 }])!;
    expect(Math.hypot(second.x - first.x, second.z - first.z)).toBeGreaterThanOrEqual(0.7 - 1e-9);
  });

  it("never into another vehicle's path: with a second car coming down its side, it dives the other way", () => {
    const v = carVehicle(0, 50, 0, 25); // north, on the person's line (50 m: about when someone sees it coming, horizonS(25) = 2.25 s; on foot they need the time, v14)
    const w = carVehicle(2.6, -36, Math.PI, 25); // south, 2.6 m east (the person's side)
    expect(sweepClearance(w, 2.6, 0)).toBeLessThan(0); // its path does cross the person's row
    const b = person(0.3, 0);
    const to = chooseDive(ground(flat), b, sweepHit(v, b.x, b.z, 1.05)!, [v, w], [])!;
    expect(to.x).toBeLessThan(0);
    expect(sweepClearance(w, to.x, to.z)).toBeGreaterThanOrEqual(1.05);
  });

  it("never through a stopped vehicle: with a robotaxi waiting on its side, it dives the other way, not through it", () => {
    const v = carVehicle(0, 50, 0, 25); // north, on the person's line (50 m: about when someone sees it coming, horizonS(25) = 2.25 s; on foot they need the time, v14)
    const base = (scene(flat, [], [{ id: 9, x: 2.4, z: 0, kind: "robotaxi" }]).ext.agents as AgentsExt).list[0]!;
    const parked = vehicleOfAgent({ ...base, speed: 0, heading: 0 }, null, 1 / 60); // waiting 2.4 m east
    expect(parked.paths).toEqual([]);
    const b = person(0.3, 0);
    const to = chooseDive(ground(flat), b, sweepHit(v, b.x, b.z, 1.05)!, [v, parked], [])!;
    for (let f = 0; f <= 1; f += 0.01) {
      const x = b.x + (to.x - b.x) * f;
      const z = b.z + (to.z - b.z) * f;
      // (Against its drawn body, a box: ROBOTAXI_BODY.)
      expect(bodyDistance(parked, x, z)).toBeGreaterThanOrEqual(b.r);
    }
    expect(to.x).toBeLessThan(0);
  });

  it("not along a line the car reaches first: too close for one side, it takes a spot it reaches in time", () => {
    // The car's nose 10 m from the person, at 15 m/s (0.67 s), the person at its left front corner:
    // on foot the far side (across the car's front) is out of reach in time, so it goes left (its
    // own side). (v14: was 1.2 m at 30 m/s, a distance only the old 9 m/s leap covered.)
    const v = carVehicle(0.5, 10 + 2.5, 0, 15);
    const b = person(-0.6, 0);
    const to = chooseDive(ground(flat), b, sweepHit(v, b.x, b.z, 1.05)!, [v], [])!;
    expect(to.x).toBeLessThan(b.x);
  });

  it("the dive itself, on foot: it speeds up at the profile's rate to its top speed, slows to a stop on the spot, never leaves the ground, then recovers and is done", () => {
    const prof = DODGE_PROFILE.person;
    let d: DodgeState = { phase: "dive", sx: 0, sz: 0, tx: 3, tz: 0, t: 0, dur: 60, peak: prof.peak, hop: 0, leap: false, vx: 0, vz: 0, vmax: prof.speed };
    const xs: number[] = [0];
    const vs: number[] = [0];
    let n = advanceDodge(d, prof, 0, 0);
    while (n.dodge && n.dodge.phase === "dive") {
      expect(n.dodge.hop).toBe(0);
      xs.push(n.x);
      vs.push((n.x - xs[xs.length - 2]!) * 60);
      d = n.dodge;
      n = advanceDodge(d, prof, n.x, n.z);
    }
    xs.push(n.x);
    vs.push((n.x - xs[xs.length - 2]!) * 60);
    expect(xs.every((x, i) => i === 0 || x >= xs[i - 1]!)).toBe(true);
    // Never faster than its top speed, never changing speed faster than its acceleration (a hair for rounding).
    expect(Math.max(...vs)).toBeLessThanOrEqual(prof.speed + 1e-9);
    for (let i = 1; i < vs.length; i++) expect(Math.abs(vs[i]! - vs[i - 1]!) * 60).toBeLessThanOrEqual(prof.accel * 1.01);
    // 3 m from a standstill at 7 m/s^2 and back to a stop: about 1.3 s, not 0.33 s at 9 m/s.
    expect(xs.length / 60).toBeGreaterThan(1.1);
    expect(xs.length / 60).toBeLessThan(1.5);
    expect(n.dodge!.phase).toBe("recover");
    expect([n.x, n.z]).toEqual([3, 0]);
    let ticks = 0;
    let r = n;
    while (r.dodge) {
      r = advanceDodge(r.dodge, prof);
      ticks++;
    }
    expect(ticks).toBe(prof.recover);
    expect([r.x, r.z]).toEqual([3, 0]);
  });

  it("does not snap a moving dive onto a newly nearby target and stop abruptly", () => {
    const prof = DODGE_PROFILE.person;
    const d: DodgeState = { phase: "dive", sx: 0, sz: 0, tx: .02, tz: 0, t: 20, dur: 60, peak: 0, hop: 0, leap: false, vx: 1.5, vz: 0, vmax: prof.speed };
    const n = advanceDodge(d, prof, 0, 0);
    expect(n.dodge!.phase).toBe("dive");
    const vx = n.x * 60;
    expect(Math.abs(vx - d.vx) * 60).toBeLessThanOrEqual(prof.accel * 1.01);
    expect(n.dodge!.vx).toBeCloseTo(vx, 12);
  });

  it("a dive turned toward a new landing carries on from where the body is, keeping its velocity: no restart, no jump, no instant turn", () => {
    const prof = DODGE_PROFILE.person;
    let d: DodgeState = { phase: "dive", sx: 0, sz: 0, tx: 3, tz: 0, t: 0, dur: 60, peak: prof.peak, hop: 0, leap: false, vx: 0, vz: 0, vmax: prof.speed };
    let x = 0;
    let z = 0;
    for (let i = 0; i < 20; i++) {
      const m = advanceDodge(d, prof, x, z);
      d = m.dodge!;
      x = m.x;
      z = m.z;
    }
    const v0 = Math.hypot(d.vx, d.vz);
    expect(v0).toBeGreaterThan(1.5); // under way east
    // Turned 90 degrees: north of where it is now.
    const turned = redirectDive(prof, d, x, z, x, z - 3);
    expect([turned.sx, turned.sz, turned.t, turned.vx, turned.vz]).toEqual([x, z, d.t, d.vx, d.vz]);
    const n = advanceDodge(turned, prof, x, z);
    // It carries on east this tick, turning only as fast as it can change its velocity.
    expect(n.x - x).toBeGreaterThan(0);
    expect(Math.hypot(n.dodge!.vx - d.vx, n.dodge!.vz - d.vz)).toBeLessThanOrEqual((prof.accel / 60) * 1.0001);
    // Turned every tick toward the same landing, it still gets there and stops.
    let r: DodgeState = turned;
    let pos: [number, number] = [x, z];
    for (let i = 0; i < 240 && r.phase === "dive"; i++) {
      const m = advanceDodge(r, prof, pos[0], pos[1]);
      pos = [m.x, m.z];
      if (!m.dodge || m.dodge.phase !== "dive") break;
      r = redirectDive(prof, m.dodge, m.x, m.z, x, z - 3);
    }
    expect(pos[0]).toBeCloseTo(x, 9);
    expect(pos[1]).toBeCloseTo(z - 3, 9);
  });
});

describe("the clearance override", () => {
  const person = (x: number, z: number) => ({ x, z, y: 0, r: 0.3, cls: "person" as const, id: 1 });

  it("puts a body inside a car at the nearest spot outside its reach plus the clearance that is also clear of its path by the body's margin (v14: so it is not needed again a moment later)", () => {
    const v = carVehicle(0, 0, 0, 20);
    const b = person(0.5, -1);
    const to = overrideSpot(ground(flat), b, [v], [], 0.3)!;
    expect(to.tier).toBe(0);
    expect(boxDistance(to.x, to.z, v.x, v.z, v.fx, v.fz, v.hl, v.hw)).toBeGreaterThanOrEqual(0.6);
    // Clear of everywhere the car can be by the next tick, by the clearance.
    expect(zoneDistance(v, to.x, to.z)).toBeGreaterThanOrEqual(0.6);
    // Out of the near side (east), clear of its predicted path by the margin: about
    // 0.95 - 0.5 + 0.3 + 0.75 m away (half its width, less where the body is, its radius and margin).
    expect(to.x).toBeGreaterThan(1.5);
    expect(sweepClearance(v, to.x, to.z, false)).toBeGreaterThanOrEqual(b.r + DODGE_PROFILE.person.margin - 1e-9);
    expect(Math.hypot(to.x - b.x, to.z - b.z)).toBeLessThan(0.95 - 0.5 + b.r + DODGE_PROFILE.person.margin + 0.3);
  });

  it("pinned against a building, it leaps over the car to the other side, never into or through the building", () => {
    const w = buildWorld([{ tileId: "b", buildings: [box("b", 1.3, -20, 20, 20)], ground: null }]);
    const v = carVehicle(0, 0, 0, 20); // east side at 0.95, the building at 1.3
    const b = person(1.0, 0);
    const to = overrideSpot(ground(w), b, [v], [], 0.3)!;
    expect(to.x).toBeLessThan(-0.95 - 0.6 + 1e-9);
    expect(segmentBlocked(w, b.x, b.z, to.x, to.z)).toBe(false);
  });

  it("a parked car only needs to be left, not cleared by the margin", () => {
    const v = carVehicle(0, 0, 0, 0);
    const to = overrideSpot(ground(flat), person(0.5, 0), [v], [], 0.3)!;
    expect(boxDistance(to.x, to.z, v.x, v.z, v.fx, v.fz, v.hl, v.hw)).toBeGreaterThanOrEqual(0.3);
    expect(boxDistance(to.x, to.z, v.x, v.z, v.fx, v.fz, v.hl, v.hw)).toBeLessThan(0.45);
  });
});

// ---------------------------------------------------------------- inside step()

/** A roadless world's state with players `cars` (driving) and person agents standing at `people`. */
function scene(world: World, cars: Array<{ id: string; x: number; z: number; heading: number; speed: number }>, people: Array<{ id: number; x: number; z: number; kind?: AgentState["kind"] }>, walkers: Array<{ id: string; x: number; z: number }> = []): SimState {
  const ids = [...cars.map((c) => c.id), ...walkers.map((w) => w.id)];
  let s = createInitialState(world, 3, ids, { x: 0, z: 1000, heading: 0 });
  const players = { ...s.players };
  for (const c of cars) players[c.id] = { ...players[c.id]!, car: { ...makeCar(c.x, c.z, c.heading, meshGroundHeight(world, c.x, c.z)), speed: c.speed } };
  walkers.forEach((w, i) => {
    players[w.id] = { ...players[w.id]!, mode: "foot", car: makeCar(5000 + i * 10, 5000, 0), foot: makeFoot(w.x, meshGroundHeight(world, w.x, w.z), w.z, 0) };
  });
  const list: AgentState[] = people.map((p) => ({
    id: p.id,
    kind: p.kind ?? "person",
    x: p.x,
    y: meshGroundHeight(world, p.x, p.z),
    z: p.z,
    heading: 0,
    pitch: 0,
    speed: 0,
    vmax: 1.3,
    edge: "",
    dir: 1,
    lane: 1,
    s: 0,
    next: "",
    ndir: 1,
    nlane: 1,
    conn: null,
    node: "",
    resume: 0,
    lat: 0,
    wait: 0,
    dwell: 0,
    ghost: 0,
    mode: "go",
    rng: p.id,
    dodge: null,
  }));
  const ext: AgentsExt = { nextId: 1000, list };
  s = { ...s, players, ext: { ...s.ext, agents: ext } };
  return s;
}

/** The state at v23 (people dodge a player's car only when it is about to reach them). */
const v23 = (s: SimState): SimState => ({ ...s, version: 23 });

function drive(world: World, s: SimState, ticks: number, each?: (s: SimState) => void): SimState {
  for (let t = 0; t < ticks; t++) {
    const frame: Record<string, { throttle: number; steer: number; brake: number; actions: number }> = {};
    for (const id of Object.keys(s.players)) if (s.players[id]!.mode === "vehicle") frame[id] = { throttle: 1, steer: 0, brake: 0, actions: 0 };
    s = step(world, s, frame);
    each?.(s);
  }
  return s;
}

describe("the dodge in step()", () => {
  it("people are not a car's obstacle: a car at full throttle through a person drives exactly as through empty space, and nobody is touched", () => {
    let s = scene(flat, [{ id: "a", x: 0, z: 80, heading: 0, speed: 30 }], [{ id: 1, x: 0, z: 0 }]);
    // The control: the same car with nobody there.
    const cars: Array<ReturnType<typeof makeCar>> = [];
    drive(flat, scene(flat, [{ id: "a", x: 0, z: 80, heading: 0, speed: 30 }], []), 240, (k) => cars.push(k.players.a!.car));
    let t = 0;
    s = drive(flat, s, 240, (k) => {
      const c = k.players.a!.car;
      expect({ ...c, nearMisses: 0 }).toEqual({ ...cars[t]!, nearMisses: 0 });
      expect(c.sinceContact).toBeGreaterThan(0);
      t++;
    });
    const c = s.players.a!.car;
    expect(c.z).toBeLessThan(-20); // well past where the person stood
    expect([c.hits, c.personBumps]).toEqual([0, 0]);
    expect(c.nearMisses).toBe(1);
    const d = dodgeExtOf(s);
    expect(d).toEqual({ contacts: 0, overrides: 0, dives: 1, nearMisses: 1, failures: 0 });
    // The person dived to the side and is standing again.
    const p = agentsOf(s)[0]!;
    expect(Math.abs(p.x)).toBeGreaterThan(CAR.halfWidth + 0.3 + 0.75);
    expect(p.dodge).toBeNull();
    expect(p.mode).toBe("go");
  });

  it("a dodging person stays on the ground (v14: no hop), is in mode dive then recover, runs at no more than a scramble's pace and ignores its path meanwhile", () => {
    let s = scene(flat, [{ id: "a", x: 0, z: 60, heading: 0, speed: 25 }], [{ id: 1, x: 0.2, z: 0 }]);
    const modes = new Set<string>();
    let maxHop = 0;
    let ran = 0;
    drive(flat, s, 200, (k) => {
      const p = agentsOf(k)[0]!;
      modes.add(p.mode);
      maxHop = Math.max(maxHop, Math.abs(p.y - meshGroundHeight(flat, p.x, p.z)));
      if (p.dodge) {
        // (Its speed is along its facing while it runs: what the renderer draws it running at.)
        expect(Math.abs(p.speed)).toBeLessThanOrEqual(DODGE_PROFILE.person.speed * EMERGENCY_BOOST + 1e-9);
        ran = Math.max(ran, Math.abs(p.speed));
      } else if (p.mode === "recover") expect(p.speed).toBe(0);
    });
    expect([...modes].sort()).toEqual(["dive", "go", "recover"]);
    expect(maxHop).toBeLessThan(1e-9);
    expect(ran).toBeGreaterThan(1);
    void s;
  });

  it("a player on foot dives out of another player's car's way, ignoring their controls meanwhile; never out of their own", () => {
    // b on foot in a's path; b's own car parked far away; then the same with b in front of their own car.
    let s = scene(flat, [{ id: "a", x: 0, z: 60, heading: 0, speed: 25 }], [], [{ id: "b", x: 0.3, z: 0 }]);
    let dived = 0;
    for (let t = 0; t < 200; t++) {
      // b holds full throttle the whole time (walking north, into the car).
      s = step(flat, s, { a: { throttle: 1, steer: 0, brake: 0, actions: 0 }, b: { throttle: 1, steer: 0, brake: 0, actions: 0 } });
      const f = s.players.b!.foot!;
      if (f.dodge) {
        dived++;
        // On their feet, at no more than a scramble's pace along their facing.
        expect(f.y).toBeCloseTo(meshGroundHeight(flat, f.x, f.z), 9);
        expect(Math.abs(f.speed)).toBeLessThanOrEqual(DODGE_PROFILE.player.speed * EMERGENCY_BOOST + 1e-9);
        expect(f.sprint).toBe(false);
      }
    }
    expect(dived).toBeGreaterThan(DODGE_PROFILE.player.minTicks);
    expect(s.players.a!.car.nearMisses).toBe(1);
    expect(dodgeExtOf(s).contacts).toBe(0);
    // Their own parked car is no threat (it does not move), and a player's own car is never a threat.
    const own = vehicleOfCar("b", s.players.b!.car);
    expect(own.paths).toEqual([]);
  });

  it("deterministic, and step() never mutates the state it is given", () => {
    const start = deepFreeze(scene(flat, [{ id: "a", x: 0, z: 70, heading: 0, speed: 30 }], [1, 2, 3, 4, 5].map((id) => ({ id, x: (id - 3) * 0.8, z: 0 }))));
    const a = drive(flat, start, 180);
    const b = drive(flat, start, 180);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(dodgeExtOf(a).dives).toBe(5);
    expect(dodgeExtOf(a).contacts).toBe(0);
  });

  it("robots do not dodge a player's car (v12, owner request): it bowls them over; they are never under the override", () => {
    expect(agentDodgeClass({ id: 1, kind: "errandRobot" })).toBe("errandRobot");
    expect(agentDodgeClass({ id: 1, kind: "sidewalkBot" })).toBe("sidewalkBot");
    expect(agentDodgeClass({ id: 1, kind: "robotaxi" })).toBeNull();
    expect(DODGE_PROFILE.errandRobot.override).toBeNull();
    let s = scene(flat, [{ id: "a", x: 0, z: 60, heading: 0, speed: 25 }], [
      { id: 1, x: 0.2, z: 0, kind: "errandRobot" },
      { id: 2, x: -0.2, z: -10, kind: "sidewalkBot" },
    ]);
    let knocked = 0;
    // Allow the v19 launch/tyre response five seconds to finish passing both bodies.
    s = drive(flat, s, 300, (k) => {
      for (const r of agentsOf(k)) if (r.knock && r.knock.t === 0 && r.knock.phase === "slide") knocked++;
    });
    // Nobody dived: both were hit and knocked over (impacts.ts), and the car kept going.
    expect(dodgeExtOf(s).dives).toBe(0);
    expect(knocked).toBeGreaterThanOrEqual(2);
    expect(s.players.a!.car.z).toBeLessThan(-30);
  });

  it("children get the wider berth: they dive further and earlier", () => {
    const child = [...Array(400).keys()].find((id) => id > 0 && personIsChild(id))!;
    const adult = [...Array(400).keys()].find((id) => id > 0 && !personIsChild(id))!;
    expect(agentDodgeClass({ id: child, kind: "person" })).toBe("care");
    expect(agentDodgeClass({ id: adult, kind: "person" })).toBe("person");
    const side = (id: number): { x: number; tick: number } => {
      let s = scene(flat, [{ id: "a", x: 0, z: 60, heading: 0, speed: 25 }], [{ id, x: 0.2, z: 0 }]);
      let tick = -1;
      s = drive(flat, s, 200, (k) => {
        if (tick < 0 && agentsOf(k)[0]!.dodge) tick = k.tick;
      });
      return { x: Math.abs(agentsOf(s)[0]!.x), tick };
    };
    const c = side(child);
    const a = side(adult);
    expect(c.x).toBeGreaterThan(a.x + 0.25);
    expect(c.x).toBeGreaterThan(CAR.halfWidth + 0.3 + DODGE_PROFILE.care.margin);
    expect(c.tick).toBeLessThanOrEqual(a.tick);
  });

  it("v22 and earlier keep the old early dive (replays are bit for bit); a v22 save upgrades to v23 by restamping only", () => {
    // The same car passing 3 m beside a person: at v22 they dive from it, as they always did.
    const at = (version: number): SimState => {
      const s = { ...scene(flat, [{ id: "a", x: 0, z: 60, heading: 0, speed: 25 }], [{ id: 1, x: CAR.halfWidth + 3 + 0.3, z: 0 }]), version };
      return drive(flat, s, 360);
    };
    const old = at(22);
    expect(old.version).toBe(22);
    expect(dodgeExtOf(old).dives).toBe(1);
    expect(dodgeExtOf(at(23)).dives).toBe(0);
    const saved = { ...scene(flat, [], [{ id: 1, x: 0, z: 0 }]), version: 22 };
    expect(upgradeState(saved)).toEqual({ ...saved, version: 32 });
  });

  it("nobody runs from a car that will not hit them (owner, 2026-10-27): one passing 3 m or more beside them, or driving away", () => {
    // (Agents walk, so stand them still: a dodge is the only thing that moves them sideways.)
    for (const speed of [10, 20, 30]) {
      for (const gap of [3, 4]) {
        for (const side of [-1, 1]) {
          // 3 m or more between the car's side and the person's body (r 0.3 m), either side.
          const x = side * (CAR.halfWidth + gap + 0.3);
          let s = v23(scene(flat, [{ id: "a", x: 0, z: 60, heading: 0, speed }], [{ id: 1, x, z: 0 }]));
          s = drive(flat, s, 360, (k) => expect(agentsOf(k)[0]!.dodge).toBeNull());
          expect(s.players.a!.car.z).toBeLessThan(-20); // it did go by
          expect(dodgeExtOf(s)).toEqual({ contacts: 0, overrides: 0, dives: 0, nearMisses: 0, failures: 0 });
          expect(s.players.a!.car.nearMisses).toBe(0);
        }
      }
      // Just past them, on their line, and driving away (its rear bumper 1.5 m from them).
      let s = v23(scene(flat, [{ id: "a", x: 0, z: -(CAR.halfLength + 0.3 + 1.5), heading: 0, speed }], [{ id: 1, x: 0, z: 0 }]));
      s = drive(flat, s, 180, (k) => expect(agentsOf(k)[0]!.dodge).toBeNull());
      expect(dodgeExtOf(s)).toEqual({ contacts: 0, overrides: 0, dives: 0, nearMisses: 0, failures: 0 });
    }
    // A player on foot, too.
    let s = v23(scene(flat, [{ id: "a", x: 0, z: 80, heading: 0, speed: 25 }], [], [{ id: "b", x: CAR.halfWidth + 3 + 0.3, z: 0 }]));
    s = drive(flat, s, 300, (k) => expect(k.players.b!.foot!.dodge).toBeNull());
    expect(dodgeExtOf(s).dives).toBe(0);
  });

  it("a car aimed at someone: they wait until it is about to hit them (REACT_S), then still clear it with no contact", () => {
    for (const speed of [10, 20, 30]) {
      for (const x of [0, 0.2, 1.2]) {
        let s = v23(scene(flat, [{ id: "a", x: 0, z: 80, heading: 0, speed }], [{ id: 1, x, z: 0 }]));
        let started: number | null = null;
        let reached: number | null = null;
        let minClear = Infinity;
        s = drive(flat, s, 300, (k) => {
          const c = k.players.a!.car;
          const p = agentsOf(k)[0]!;
          if (started === null && p.dodge) started = k.tick;
          // When the car's body came within the person's margin of where they stood.
          if (reached === null && boxDistance(x, 0, c.x, c.z, Math.sin(c.heading), -Math.cos(c.heading), CAR.halfLength, CAR.halfWidth) < 0.3 + DODGE_PROFILE.person.margin) reached = k.tick;
          minClear = Math.min(minClear, boxDistance(p.x, p.z, c.x, c.z, Math.sin(c.heading), -Math.cos(c.heading), CAR.halfLength, CAR.halfWidth) - 0.3);
        });
        // It moved only once the car was about to reach where it stood: within REACT_S, or its run
        // clear plus REACT_LAG_S when that is longer (plus what the footprint's spread adds by
        // then, and a tick). Before, from horizonS out: 2 s at 20 m/s, 2.5 s at 30 m/s.
        expect(started).not.toBeNull();
        expect(reached).not.toBeNull();
        expect((reached! - started!) / 60).toBeLessThanOrEqual(REACT_S + REACT_LAG_S + REACT_S / speed + 1 / 60 + 1e-9);
        // Clear of the car by its margin, never touched, never needing the override.
        expect(minClear).toBeGreaterThanOrEqual(0.75);
        expect(dodgeExtOf(s)).toMatchObject({ contacts: 0, overrides: 0, dives: 1, failures: 0 });
        expect(s.players.a!.car.personBumps).toBe(0);
      }
    }
  });

  it("on a hill: a car coming down a 20% slope at a person on it", () => {
    const hill = terrainWorld((_x, z) => -0.2 * z, 300);
    let s = scene(hill, [{ id: "a", x: 0, z: -70, heading: Math.PI, speed: 20 }], [{ id: 1, x: 0.1, z: 0 }]);
    let minClear = Infinity;
    s = drive(hill, s, 240, (k) => {
      const c = k.players.a!.car;
      const p = agentsOf(k)[0]!;
      minClear = Math.min(minClear, boxDistance(p.x, p.z, c.x, c.z, Math.sin(c.heading), -Math.cos(c.heading), CAR.halfLength, CAR.halfWidth) - 0.3);
      // Always on the ground (plus at most a hop).
      expect(p.y - meshGroundHeight(hill, p.x, p.z)).toBeGreaterThanOrEqual(-1e-9);
    });
    expect(minClear).toBeGreaterThanOrEqual(0.75);
    expect(dodgeExtOf(s).contacts).toBe(0);
  });

  it("robotaxis: nobody dives out of the way of one that yields in time, but someone it cannot stop for does", () => {
    // A robotaxi as a vehicle predicts braking for people: 20 m ahead at 10 m/s it stops in time.
    const taxi = (speed: number): AgentState => {
      const base = (scene(flat, [], [{ id: 9, x: 0, z: 0, kind: "robotaxi" }]).ext.agents as AgentsExt).list[0]!;
      return { ...base, speed, heading: 0 };
    };
    const slow = vehicleOfAgent(taxi(10), null, 1 / 60);
    expect(sweepHit(slow, 0, -20, 0.3 + 0.75)).toBeNull();
    // 6 m ahead at 12 m/s it cannot.
    const fast = vehicleOfAgent(taxi(12), null, 1 / 60);
    expect(sweepHit(fast, 0, -6, 0.3 + 0.75)).not.toBeNull();
  });

  it("in traffic on the grid city with a player at full throttle along a crowded sidewalk: dives, and no contact", () => {
    // (No street props: since v13 the sidewalk's mature trees would stop the car, props.ts.)
    const world = withoutStreetProps(gridCity(true));
    let s = createInitialState(world, 9, ["p1"], { x: 20, z: 106, heading: Math.PI / 2 });
    for (let t = 0; t < 600; t++) {
      const c = s.players.p1!.car;
      const steer = Math.max(-1, Math.min(1, -((106 - c.z) * 0.08 - Math.sin(c.heading - Math.PI / 2) * 1.5)));
      s = step(world, s, { p1: { throttle: 1, steer, brake: 0, actions: 0 } });
      expect(dodgeExtOf(s).contacts).toBe(0);
    }
    expect(dodgeExtOf(s).dives).toBeGreaterThan(0);
    expect(s.players.p1!.car.personBumps).toBe(0);
  });

  it("a person standing in a car's body is put outside it at once (the override), and that is counted as a contact", () => {
    // Placed overlapping a moving car: no dive can help, the override must.
    let s = scene(flat, [{ id: "a", x: 0, z: 0, heading: 0, speed: 15 }], [{ id: 1, x: 0.3, z: -1 }]);
    s = drive(flat, s, 1);
    const p = agentsOf(s)[0]!;
    const c = s.players.a!.car;
    expect(boxDistance(p.x, p.z, c.x, c.z, Math.sin(c.heading), -Math.cos(c.heading), CAR.halfLength, CAR.halfWidth)).toBeGreaterThanOrEqual(0.3 + DODGE_PROFILE.person.override! - 1e-9);
    expect(p.dodge!.leap).toBe(true);
    expect(dodgeExtOf(s)).toMatchObject({ contacts: 1, overrides: 1 });
    expect(c.personBumps).toBe(1);
    void FOOT;
    void makeVehicle;
  });
});

describe("back on the path after a dodge (agents.ts rejoinAt)", () => {
  it("on its path it carries on from there; beside it or past its end, a connector from where it stands walks it back onto its sidewalk ahead, never a jump", () => {
    const world = gridCity(true);
    let s = createInitialState(world, 9, ["p1"], { x: 20, z: 106, heading: Math.PI / 2 });
    const ext = s.ext.agents as AgentsExt;
    const w = ext.list.find((a) => !AGENT_SPEC[a.kind].road && a.conn === null && a.mode === "go")!;
    expect(w, "a walker on its sidewalk").toBeDefined();
    const path = agentPath(world, w)!;
    // On it, half-way along: carries on from there, facing along it.
    const mid = pathPoint(path, path.len / 2);
    const on = rejoinAt(world, w, mid.x, mid.z)!;
    expect(on.conn).toBeNull();
    expect(on.s).toBeCloseTo(path.len / 2, 6);
    expect(on.lat).toBe(0);
    expect(on.heading).toBeCloseTo(Math.atan2(mid.tx, -mid.tz), 9);
    // Beside it, 3 m to the right: a connector from there onto the sidewalk 3 m on.
    const b = rejoinAt(world, w, mid.x - mid.tz * 3, mid.z + mid.tx * 3)!;
    expect([b.conn![0], b.conn![1], b.s, b.lat]).toEqual([mid.x - mid.tz * 3, mid.z + mid.tx * 3, 0, 0]);
    expect(b.resume).toBeCloseTo(Math.min(path.len, path.len / 2 + 3), 6);
    // Past the end: 2.5 m on and 1 m to the side, where no s and lat reach.
    const end = pathPoint(path, path.len);
    const px = end.x + end.tx * 2.5 - end.tz;
    const pz = end.z + end.tz * 2.5 + end.tx;
    const r = rejoinAt(world, w, px, pz)!;
    expect(r.conn).not.toBeNull();
    expect([r.conn![0], r.conn![1], r.s, r.lat]).toEqual([px, pz, 0, 0]);
    // Walking on from there it takes a step, it does not jump back to the end of its sidewalk.
    const placed: AgentState = { ...w, ...r, x: px, z: pz, speed: 0, mode: "go", wait: 0, dwell: 0, dodge: null };
    s = { ...s, ext: { ...s.ext, agents: { ...ext, list: ext.list.map((a) => (a.id === w.id ? placed : a)) } } };
    for (let t = 0; t < 30; t++) {
      const prev = agentsOf(s).find((a) => a.id === w.id)!;
      s = step(world, s, { p1: { throttle: 0, steer: 0, brake: 1, actions: 0 } });
      const now = agentsOf(s).find((a) => a.id === w.id)!;
      expect(Math.hypot(now.x - prev.x, now.z - prev.z)).toBeLessThan(0.1);
    }
  });
});
