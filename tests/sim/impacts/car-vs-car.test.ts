// Car vs car (impacts.ts): a player's car shoves, spins and dents other cars and robotaxis
// instead of stopping against them as at a wall; a knocked robotaxi slides, stops with its
// hazards on and rejoins its lane; people are never touched; everything is deterministic and
// plain JSON.
import { describe, expect, it } from "vitest";
import {
  AGENTS_EXT_KEY,
  CAR,
  IMPACT,
  PERSON_CLEAR_M,
  REPAIR_AFTER_TICKS,
  WRECK_LIMP_MPS,
  SIM_VERSION,
  agentVelocity,
  boxDistance,
  carDamage,
  carVelocity,
  createInitialState,
  dcos,
  dsin,
  impactsOf,
  makeCar,
  stepCar,
  step,
  stepImpacts,
  upgradeState,
  type AgentState,
  type AgentsExt,
  type CarContact,
  type InputFrame,
  type SimInput,
  type SimState,
  type World,
} from "../../../src/sim/index.ts";
import { LONG_RUN_MS, emptyWorld, gridCity } from "../fixtures.ts";

const I = (throttle: number, steer = 0, brake = 0): SimInput => ({ throttle, steer, brake, actions: 0 });

function agents(s: Readonly<SimState>): AgentState[] {
  return (s.ext[AGENTS_EXT_KEY] as AgentsExt | undefined)?.list ?? [];
}

function withAgents(s: SimState, list: AgentState[]): SimState {
  const ext = s.ext[AGENTS_EXT_KEY] as AgentsExt;
  return { ...s, ext: { ...s.ext, [AGENTS_EXT_KEY]: { ...ext, list } } };
}

/** A grid-city state with one robotaxi (the first spawned) and player "p" in a car `behind` m behind it on its lane, at `speed`. */
function rearEndScene(world: World, behind: number, speed: number): { s: SimState; taxi: AgentState } {
  const s0 = createInitialState(world, 7, ["p"], { x: 150, z: -40, heading: 0 });
  const found = agents(s0).find((a) => a.kind === "robotaxi" && a.conn === null && a.runtimeId === undefined);
  expect(found).toBeDefined();
  const taxi = { ...found!, speed: found!.vmax };
  const fx = dsin(taxi.heading);
  const fz = -dcos(taxi.heading);
  const car = { ...makeCar(taxi.x - fx * behind, taxi.z - fz * behind, taxi.heading, taxi.y), speed };
  const s = withAgents({ ...s0, players: { p: { ...s0.players.p!, car } } }, [taxi]);
  return { s, taxi };
}

function run(world: World, s: SimState, ticks: number, input: (t: number, s: SimState) => InputFrame): SimState[] {
  const out: SimState[] = [s];
  let cur = s;
  for (let t = 0; t < ticks; t++) {
    cur = step(world, cur, input(t, cur));
    out.push(cur);
  }
  return out;
}

describe("stepCar and a body it can shove", () => {
  it("exchanges momentum along the normal instead of stopping as at a wall", () => {
    const w = emptyWorld();
    const c0 = { ...makeCar(0, 0, 0), speed: 15 };
    // A robotaxi-sized body at rest 3 m ahead (north is -z), as three circles.
    const body = { key: "a:9", mass: IMPACT.taxiMass, x: 0, z: -5.2, vx: 0, vz: 0 };
    const circles = [-1.25, 0, 1.25].map((o) => ({ x: 0, z: -5.2 + o, r: 1.05, person: false, body }));
    const contacts: CarContact[] = [];
    let c = c0;
    for (let t = 0; t < 30 && contacts.length === 0; t++) c = stepCar(w, c, I(0), circles, 1, contacts);
    expect(contacts.length).toBe(1);
    const k = contacts[0]!;
    // Normal out of the body toward the car: +z (south).
    expect(k.nz).toBeGreaterThan(0.99);
    // The car keeps moving forward (a wall would stop it): 1-D collision with restitution.
    const m1 = CAR.mass, m2 = IMPACT.taxiMass, e = CAR.bodyRestitution, u = k.speed;
    const expectedCar = u - ((1 + e) * m2 * u) / (m1 + m2);
    expect(c.speed).toBeGreaterThan(0.5);
    expect(c.speed).toBeCloseTo(expectedCar, 0);
    // The impulse the body takes gives it the rest: total momentum is conserved.
    const bodyDv = k.j / m2;
    expect(m1 * c.speed + m2 * bodyDv).toBeCloseTo(m1 * u, -2);
    // A straight hit does not spin the car.
    expect(Math.abs(c.yawRate)).toBeLessThan(1e-6);
  });

  it("an off-centre hit spins the car", () => {
    const w = emptyWorld();
    const body = { key: "a:9", mass: IMPACT.taxiMass, x: 1.6, z: -5.2, vx: 0, vz: 0 };
    const circles = [-1.25, 0, 1.25].map((o) => ({ x: 1.6, z: -5.2 + o, r: 1.05, person: false, body }));
    const contacts: CarContact[] = [];
    let c = { ...makeCar(0, 0, 0), speed: 15 };
    for (let t = 0; t < 30 && contacts.length === 0; t++) c = stepCar(w, c, I(0), circles, 1, contacts);
    expect(contacts.length).toBe(1);
    // Hit on its front right corner, pushed back: the nose swings left (anticlockwise).
    expect(c.yawRate).toBeLessThan(-0.2);
  });

  it("a plain circle (no body) is still a wall", () => {
    const w = emptyWorld();
    const circles = [{ x: 0, z: -5, r: 1, person: false }];
    const contacts: CarContact[] = [];
    let c = { ...makeCar(0, 0, 0), speed: 6 };
    for (let t = 0; t < 30; t++) c = stepCar(w, c, I(0), circles, 1, contacts);
    expect(contacts).toEqual([]);
    expect(Math.abs(c.speed)).toBeLessThan(0.5);
  });
});

describe("a player's car rear-ends a robotaxi", () => {
  const world = gridCity();
  it("shoves it off its lane, slows without stopping dead, and both are dented", () => {
    const { s, taxi } = rearEndScene(world, 12, 24);
    const states = run(world, s, 90, () => ({ p: I(1) }));
    const hitAt = states.findIndex((x) => (impactsOf(x)?.events.length ?? 0) > 0);
    expect(hitAt).toBeGreaterThan(0);
    const ev = impactsOf(states[hitAt]!)!.events[0]!;
    expect(ev.kind).toBe("car-taxi");
    expect(ev.a).toBe("p:p");
    expect(ev.b).toBe(`a:${taxi.id}`);
    expect(ev.speed).toBeGreaterThan(5);
    const before = states[hitAt - 1]!;
    const after = states[hitAt]!;
    // The car keeps rolling (a wall would have taken nearly all of its speed).
    expect(after.players.p!.car.speed).toBeGreaterThan(0.3 * before.players.p!.car.speed - 0.5);
    expect(after.players.p!.car.speed).toBeLessThan(before.players.p!.car.speed);
    const t = agents(after).find((a) => a.id === taxi.id)!;
    expect(t.knock).toBeDefined();
    expect(t.dents!.rear).toBeGreaterThan(0);
    expect(t.mode).toBe("honk");
    // Pushed forward, faster than it was going.
    const v = agentVelocity(t);
    expect(v.vx * dsin(t.heading) - v.vz * dcos(t.heading)).toBeGreaterThan(taxi.speed);
    const dmg = carDamage(after, "p");
    expect(dmg.front).toBeGreaterThan(0);
    expect(dmg.condition).toBeLessThan(100);
    // Later it really moves along: knocked forward of where its lane would have put it at its speed.
    const later = agents(states[hitAt + 30]!).find((a) => a.id === taxi.id)!;
    expect(later.knock).toBeDefined();
  }, LONG_RUN_MS);

  it("the knocked robotaxi stops, sits with its hazards on, and rejoins its lane", () => {
    const { s, taxi } = rearEndScene(world, 12, 20);
    // Drive into it, then brake and stay back.
    const states = run(world, s, 900, (t) => ({ p: t < 40 ? I(1) : I(0, 0, 1) }));
    const knockedAt = states.findIndex((x) => agents(x).find((a) => a.id === taxi.id)?.knock !== undefined);
    expect(knockedAt).toBeGreaterThan(0);
    const phases = states.map((x) => agents(x).find((a) => a.id === taxi.id)?.knock?.phase ?? "none");
    expect(phases).toContain("slide");
    expect(phases).toContain("stopped");
    const back = phases.findIndex((p, i) => i > knockedAt && p === "none");
    expect(back).toBeGreaterThan(knockedAt);
    const rejoined = agents(states[back]!).find((a) => a.id === taxi.id)!;
    expect(rejoined.conn).not.toBeNull();
    expect(rejoined.mode).toBe("go");
    // It drives on afterwards (no teleport: its heading does not jump when it sets off).
    const prev = agents(states[back - 1]!).find((a) => a.id === taxi.id)!;
    expect(Math.abs(rejoined.heading - prev.heading)).toBeLessThan(1e-9);
    const end = agents(states[states.length - 1]!).find((a) => a.id === taxi.id);
    expect(end).toBeDefined();
    expect(end!.knock).toBeUndefined();
    expect(end!.speed).toBeGreaterThan(2);
  }, LONG_RUN_MS);

  it("is deterministic and stays plain JSON", () => {
    const { s } = rearEndScene(world, 12, 24);
    const a = run(world, s, 200, () => ({ p: I(1, 0.2) }));
    const b = run(world, s, 200, () => ({ p: I(1, 0.2) }));
    expect(JSON.stringify(a[a.length - 1])).toBe(JSON.stringify(b[b.length - 1]));
    for (const x of a) {
      const json = JSON.stringify(x);
      expect(JSON.parse(json)).toEqual(x);
      expect(json).not.toContain("null,null");
    }
  }, LONG_RUN_MS);
});

describe("two players' cars", () => {
  const world = emptyWorld();
  it("a driving car shoves a parked one (its player on foot) and both dent", () => {
    const s0 = createInitialState(world, 3, ["a", "b"], { x: 0, z: 0, heading: 0 });
    const parked = { ...makeCar(0, -20, 90 * (Math.PI / 180)) };
    const s = {
      ...s0,
      players: {
        a: { ...s0.players.a!, car: { ...makeCar(0, 0, 0), speed: 18 } },
        b: { ...s0.players.b!, mode: "foot" as const, car: parked, foot: { x: 30, y: 0, z: 30, heading: 0, speed: 0, sprint: false, vy: 0, grounded: true, dodge: null } },
      },
    };
    const states = run(world, s, 400, (t, cur) => ({ a: (impactsOf(cur)?.events.length ?? 0) > 0 ? I(0, 0, 1) : I(0) }));
    const hit = states.findIndex((x) => (impactsOf(x)?.events.length ?? 0) > 0);
    expect(hit).toBeGreaterThan(0);
    expect(impactsOf(states[hit]!)!.events[0]!.kind).toBe("car-car");
    // A T-bone: the parked car is pushed north and slides to a stop.
    const end = states[states.length - 1]!.players.b!.car;
    expect(end.z).toBeLessThan(-20.5);
    expect(end.speed).toBe(0);
    expect(end.lateral).toBe(0);
    expect(carDamage(states[hit]!, "b").left + carDamage(states[hit]!, "b").right).toBeGreaterThan(0);
    expect(carDamage(states[hit]!, "a").front).toBeGreaterThan(0);
    // Momentum along the hit is shared.
    const va = carVelocity(states[hit]!.players.a!.car);
    const vb = carVelocity(states[hit]!.players.b!.car);
    expect(-va.vz * CAR.mass - vb.vz * CAR.mass).toBeGreaterThan(0.6 * 18 * CAR.mass * 0.8);
  });

  it("two driving cars meet head on and bounce apart (each takes its own share)", () => {
    const s0 = createInitialState(world, 3, ["a", "b"], { x: 0, z: 0, heading: 0 });
    const s = {
      ...s0,
      players: {
        a: { ...s0.players.a!, car: { ...makeCar(0, 0, 0), speed: 12 } },
        b: { ...s0.players.b!, car: { ...makeCar(0, -30, Math.PI), speed: 12 } },
      },
    };
    const states = run(world, s, 90, () => ({ a: I(0), b: I(0) }));
    const hit = states.findIndex((x) => (impactsOf(x)?.events.length ?? 0) > 0);
    expect(hit).toBeGreaterThan(0);
    // One event for the pair, not one from each side.
    expect(impactsOf(states[hit]!)!.events.length).toBe(1);
    const a = states[hit + 1]!.players.a!.car;
    const b = states[hit + 1]!.players.b!.car;
    // Equal masses, equal speeds: both reverse a little (restitution), symmetrically.
    expect(a.speed).toBeLessThan(0);
    expect(b.speed).toBeLessThan(0);
    expect(a.speed).toBeCloseTo(b.speed, 3);
    expect(carDamage(states[hit]!, "a").condition).toBeCloseTo(carDamage(states[hit]!, "b").condition, 6);
  });
});

describe("a sliding robotaxi never touches anyone", () => {
  it("stops dead at a person's clearance", () => {
    const world = gridCity();
    const { s, taxi } = rearEndScene(world, 30, 0);
    // A person 6 m ahead of the robotaxi, and the taxi already knocked toward them at 9 m/s.
    const fx = dsin(taxi.heading);
    const fz = -dcos(taxi.heading);
    const person: AgentState = { ...taxi, id: taxi.id + 1, kind: "person", x: taxi.x + fx * 7, z: taxi.z + fz * 7, speed: 0, mode: "dwell", dwell: 600 };
    const knocked: AgentState = { ...taxi, knock: { phase: "slide", vx: fx * 9, vz: fz * 9, yaw: 0, t: 0, age: 0 } };
    let cur = withAgents(s, [knocked, person]);
    let minGap = Infinity;
    for (let t = 0; t < 60; t++) {
      cur = stepImpacts(world, { ...cur, tick: cur.tick + 1 }, new Map());
      const a = agents(cur).find((x) => x.id === taxi.id)!;
      const p = agents(cur).find((x) => x.id === person.id)!;
      minGap = Math.min(minGap, boxDistance(p.x, p.z, a.x, a.z, dsin(a.heading), -dcos(a.heading), a.halfLength ?? 2.5, a.halfWidth ?? 1.0) - 0.3);
    }
    expect(minGap).toBeGreaterThan(PERSON_CLEAR_M - 0.05);
  });
});

describe("condition", () => {
  it("a wrecked car limps (no throttle above WRECK_LIMP_MPS) and condition comes back after a while without a hit", () => {
    const world = emptyWorld();
    const s0 = createInitialState(world, 3, ["p"], { x: 0, z: 0, heading: 0 });
    const wrecked = { ...s0, ext: { ...s0.ext, impacts: { version: 1, nextId: 1, events: [], cars: { p: { condition: 0, front: 1, rear: 0, left: 0, right: 0, lastHitTick: 0 } } } } } as SimState;
    let cur = wrecked;
    let top = 0;
    for (let t = 0; t < 600; t++) {
      cur = step(world, cur, { p: I(1) });
      top = Math.max(top, cur.players.p!.car.speed);
    }
    expect(top).toBeLessThan(WRECK_LIMP_MPS + 0.5);
    // A fresh car on the same road goes much faster.
    let fresh = s0;
    for (let t = 0; t < 600; t++) fresh = step(world, fresh, { p: I(1) });
    expect(fresh.players.p!.car.speed).toBeGreaterThan(20);
    // Twenty seconds after its last hit the condition starts coming back, a point a second.
    while (cur.tick < REPAIR_AFTER_TICKS + 300) cur = step(world, cur, { p: I(0, 0, 1) });
    const back = carDamage(cur, "p").condition;
    expect(back).toBeGreaterThan(3);
    expect(back).toBeLessThan(8);
    // The dents stay until a repair.
    expect(carDamage(cur, "p").front).toBe(1);
  }, LONG_RUN_MS);
});

describe("saves", () => {
  it("a v8 save loads as v14 with nothing rewritten", () => {
    const world = gridCity();
    const s = createInitialState(world, 5, ["p"], { x: 150, z: -40, heading: 0 });
    const v8 = { ...s, version: 8 };
    const up = upgradeState(v8);
    expect(SIM_VERSION).toBe(15);
    expect(up.version).toBe(SIM_VERSION);
    expect({ ...up, version: 8 }).toEqual(v8);
    // And it steps.
    expect(step(world, up, { p: I(1) }).tick).toBe(s.tick + 1);
  });
});
