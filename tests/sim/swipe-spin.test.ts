// SIM_VERSION 25: side-swipes and offset hits spin both cars. A car meets another car or a
// robotaxi box to box (src/sim/vehicle-contacts.ts boxContact, ported from Slop New York's
// vehicleContact): the least-penetration face normal and a contact point clipped to the faces
// that touch, so a centred bumper hit has no lever arm and an offset one the middle of the
// overlap. The exchange (car.ts boxHit) is v14's, at that point, with Slop's contact friction.
// A driving player's car that did not meet the hitter in its own stepCar takes its share in
// impacts.ts. Before (v14 to v24) the point sat on the other body's nearest circle: an offset
// rear-end spun the hitter to the 2.5 rad/s cap and barely turned the car it hit, and a car
// rear-ended while driving took no share at all.
import { describe, expect, it } from "vitest";
import {
  CAR, SIM_VERSION, boxHit, buildWorld, createInitialState, impactsOf, makeCar, makeFoot, step, upgradeState,
  type AgentState, type CarState, type ImpactBody, type ImpactEvent, type SimInput, type SimState,
} from "../../src/sim/index.ts";
import { BOX_CONTACT_VERSION, boxContact } from "../../src/sim/vehicle-contacts.ts";
import { CAR_DV } from "../../src/sim/dodge.ts";
import slop from "../golden/vehicle-contact-819a0ad.json";

const world = buildWorld([]);
const idle: SimInput = { throttle: 0, steer: 0, brake: 0, actions: 0 };
const CAR_BOX = { hl: CAR.halfLength, hw: CAR.halfWidth };

/** Player a drives `a` with no input; player b drives `b` (bDrives) or is on foot with `b` parked. */
function pair(a: Partial<CarState>, b: Partial<CarState>, version: number, bDrives = false): SimState {
  const s = createInitialState(world, 1, ["a", "b"], { x: 0, z: 0, heading: 0 });
  const bCar = { ...makeCar(0, 0, 0), ...b };
  return { ...s, version, players: {
    a: { ...s.players.a!, car: { ...makeCar(0, 0, 0), ...a } },
    b: bDrives ? { ...s.players.b!, car: bCar } : { ...s.players.b!, mode: "foot", foot: makeFoot(60, 0, 60, 0), car: bCar },
  } };
}

/** Step until the first hit; the cars before it, right after it, and the most yaw each has in the next 0.5 s. */
function collide(s: SimState): { before: SimState; after: SimState; hit: ImpactEvent; yawA: number; yawB: number } {
  for (let t = 0; t < 240; t++) {
    const before = s;
    s = step(world, s, { a: idle, b: idle }, [], []);
    const hit = impactsOf(s)?.events[0];
    if (!hit) continue;
    const after = s;
    let yawA = Math.abs(s.players.a!.car.yawRate), yawB = Math.abs(s.players.b!.car.yawRate);
    for (let k = 0; k < 30; k++) {
      s = step(world, s, { a: idle, b: idle }, [], []);
      yawA = Math.max(yawA, Math.abs(s.players.a!.car.yawRate));
      yawB = Math.max(yawB, Math.abs(s.players.b!.car.yawRate));
    }
    return { before, after, hit, yawA, yawB };
  }
  throw new Error("no hit");
}

describe("boxContact: the clipped box contact", () => {
  it("matches the original's vehicleContact on every recorded pair", () => {
    expect(slop.sourceCommit).toBe("819a0adb3345e15a7c5e9558d8d00c9dd05b2ae4");
    expect(slop.cases.length).toBe(120);
    for (const [i, c] of slop.cases.entries()) {
      const got = boxContact(c.a, c.b);
      if (c.contact === null) { expect(got, `case ${i}`).toBeNull(); continue; }
      expect(got, `case ${i}`).not.toBeNull();
      for (const k of ["depth", "nx", "nz", "x", "z"] as const) expect(Math.abs(got![k] - c.contact[k]), `case ${i} ${k}`).toBeLessThan(1e-8);
    }
  });

  it("puts a centred rear-end on the centreline, an offset one in the middle of the overlap, a side-swipe on the flank", () => {
    const a = { x: 0, z: 0, heading: 0, ...CAR_BOX };
    const centred = boxContact(a, { x: 0, z: -4.3, heading: 0, ...CAR_BOX })!;
    expect(centred.x).toBeCloseTo(0, 9);
    expect(centred.nz).toBeCloseTo(1, 9); // out of b (ahead, at -z) toward a
    expect(boxContact(a, { x: 1, z: -4.3, heading: 0, ...CAR_BOX })!.x).toBeCloseTo(0.5, 9);
    const side = boxContact({ ...a, heading: 0.08 }, { x: 1.85, z: -1.5, heading: 0, ...CAR_BOX })!;
    expect(side.nx).toBeCloseTo(-1, 9);
    // (On b's flank, within the overlap.)
    expect(side.x).toBeGreaterThan(1.85 - CAR.halfWidth);
    expect(side.x).toBeLessThan(1.85 - CAR.halfWidth + side.depth);
    expect(boxContact(a, { x: 3, z: 0, heading: 0, ...CAR_BOX })).toBeNull();
  });
});

describe("boxHit: the exchange at the box contact", () => {
  it("conserves momentum, never adds energy of travel, stays inside the dodge's bound on a hit and the spin cap", () => {
    let seed = 3;
    const r = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
    let checked = 0;
    for (let i = 0; i < 3000; i++) {
      const self = { mass: CAR.mass, k2: CAR.yawK2, x: 0, z: 0, vx: (r() - 0.5) * 60, vz: (r() - 0.5) * 60 };
      const heading = r() * 7;
      const body: ImpactBody = { key: "p:b", mass: r() < 0.5 ? CAR.mass : 1800, x: (r() - 0.5) * 5, z: (r() - 0.5) * 5, vx: (r() - 0.5) * 30, vz: (r() - 0.5) * 30, box: { heading, ...CAR_BOX } };
      const g = boxContact({ x: 0, z: 0, heading: r() * 7, ...CAR_BOX }, { x: body.x, z: body.z, heading, ...CAR_BOX });
      if (!g) continue;
      const h = boxHit(self, body, g, CAR.bodyRestitution, CAR.boxFriction);
      if (!h) continue;
      checked++;
      const jx = (h.vx - self.vx) * self.mass, jz = (h.vz - self.vz) * self.mass;
      const other = { vx: body.vx - jx / body.mass, vz: body.vz - jz / body.mass };
      expect(Math.abs(self.mass * self.vx + body.mass * body.vx - (self.mass * h.vx + body.mass * other.vx))).toBeLessThan(1e-6);
      expect(Math.abs(self.mass * self.vz + body.mass * body.vz - (self.mass * h.vz + body.mass * other.vz))).toBeLessThan(1e-6);
      const before = self.mass * (self.vx * self.vx + self.vz * self.vz) + body.mass * (body.vx * body.vx + body.vz * body.vz);
      const after = self.mass * (h.vx * h.vx + h.vz * h.vz) + body.mass * (other.vx * other.vx + other.vz * other.vz);
      expect(after).toBeLessThanOrEqual(before + 1e-6);
      // dodge.ts vehicleOfCar: a hit changes a car's velocity by at most (1 + bodyRestitution) x (its speed + CAR_DV + the body's).
      expect(Math.hypot(h.vx - self.vx, h.vz - self.vz)).toBeLessThanOrEqual((1 + CAR.bodyRestitution) * (Math.hypot(self.vx, self.vz) + CAR_DV + Math.hypot(body.vx, body.vz)));
      expect(Math.abs(h.kick)).toBeLessThanOrEqual(CAR.maxSpinKick);
    }
    expect(checked).toBeGreaterThan(500);
  });
});

describe("SIM25 side-swipes spin both cars", () => {
  it("is the current version; a v24 save upgrades by restamping only", () => {
    expect(SIM_VERSION).toBe(25);
    expect(BOX_CONTACT_VERSION).toBe(25);
    const old = pair({}, { x: 10 }, 24);
    const up = upgradeState(old);
    expect(up).toEqual({ ...old, version: 25 });
    expect(up.players).toBe(old.players);
    expect(up.ext).toBe(old.ext);
  });

  it("an offset rear-end turns both cars about equally, the same way (v24: the hitter to the cap, the other barely)", () => {
    const now = collide(pair({ speed: 12 }, { x: 1, z: -12 }, 25)), old = collide(pair({ speed: 12 }, { x: 1, z: -12 }, 24));
    // (Measured: v25 2.23 and 2.18 rad/s; v24 2.50 and 0.10.)
    expect(now.hit.x).toBeCloseTo(0.5, 6);
    expect(now.yawB).toBeGreaterThan(1.5);
    expect(Math.abs(now.yawA - now.yawB)).toBeLessThan(0.15 * now.yawA);
    // Pushed back on its right front, the hitter turns right; pushed on at its left rear, so does the other.
    expect(now.after.players.a!.car.yawRate).toBeGreaterThan(0);
    expect(now.after.players.b!.car.yawRate).toBeGreaterThan(0);
    expect(old.yawA).toBeGreaterThan(5 * old.yawB);
  });

  it("a side-swipe at 15 m/s, angled 0.15 rad into a parked car: both spin, the same way", () => {
    const { after, yawA, yawB, hit } = collide(pair({ heading: 0.15, speed: 15 }, { x: 2.3, z: -4 }, 25));
    expect(hit.kind).toBe("car-car");
    expect(yawA).toBeGreaterThan(0.5);
    expect(yawB).toBeGreaterThan(0.5);
    expect(Math.sign(after.players.a!.car.yawRate)).toBe(Math.sign(after.players.b!.car.yawRate));
  });

  it("a car rear-ended while its player drives takes its share: shoved on and spun, momentum kept (v24: nothing)", () => {
    const go = (version: number) => collide(pair({ speed: 16 }, { x: 0.8, z: -8, speed: 8 }, version, true));
    const now = go(25), old = go(24);
    const sum = (s: SimState): number => s.players.a!.car.speed + s.players.b!.car.speed;
    expect(now.after.players.b!.car.speed - now.before.players.b!.car.speed).toBeGreaterThan(3);
    expect(Math.abs(sum(now.after) - sum(now.before))).toBeLessThan(0.2);
    expect(now.yawB).toBeGreaterThan(0.5);
    expect(Math.abs(old.after.players.b!.car.speed - old.before.players.b!.car.speed)).toBeLessThan(0.1);
    expect(sum(old.before) - sum(old.after)).toBeGreaterThan(3);
  });

  it("a side-swipe on a standing robotaxi knocks it spinning", () => {
    const base = createInitialState(world, 1, ["a"], { x: 0, z: 0, heading: 0 });
    const taxi = { id: 1001, kind: "robotaxi", x: 2.3, y: 0, z: -5, heading: 0, pitch: 0, speed: 0, vmax: 12, edge: "", dir: 1, lane: 0, s: 0, next: "", ndir: 1, nlane: 0, conn: null, node: "", resume: 0, lat: 0, wait: 0, dwell: 0, ghost: 0, mode: "go", rng: 7, dodge: null } as AgentState;
    let s: SimState = { ...base, players: { a: { ...base.players.a!, car: { ...makeCar(0, 0, 0.15), speed: 15 } } }, ext: { ...base.ext, agents: { nextId: 1002, list: [taxi] } } };
    let yaw = 0;
    for (let t = 0; t < 60; t++) {
      s = step(world, s, { a: idle }, [], []);
      yaw = Math.max(yaw, Math.abs(s.ext.agents!.list.find((a) => a.id === taxi.id)?.knock?.yaw ?? 0));
    }
    expect(impactsOf(s)!.events[0]!.kind).toBe("car-taxi");
    expect(yaw).toBeGreaterThan(1);
  });

  it("v24 states keep the circle contact exactly", () => {
    const old = collide(pair({ heading: 0.15, speed: 15 }, { x: 2.3, z: -4 }, 24));
    expect(old.hit.x).toBe(1.3503069848841822);
    expect(collide(pair({ heading: 0.15, speed: 15 }, { x: 2.3, z: -4 }, 25)).hit.x).not.toBe(old.hit.x);
  });
});
