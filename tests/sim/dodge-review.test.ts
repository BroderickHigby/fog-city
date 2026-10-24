// The adversarial review's reproductions (round 2, 2026-10-21), kept as permanent tests: every
// way the reviewer found to put a person inside a vehicle, or to get the override to give up,
// must stay closed. A body on a roof or a deck (the dive and the override walk the roof, and drop
// off its edge); people in an inside corner or against a wall with a car drifting, bouncing or
// still turning after it stopped (a dive never carries anyone into a vehicle's reach, a stopped
// car still turning counts as moving, a dive under way is checked every tick); the optimiser's
// recorded drivers; robotaxis measured by their drawn body, keeping a berth wider than the
// override's clearance, and walkers keeping off it; a short override drawn as a stumble.
// tests/sim/dodge.test.ts covers the dodge's parts, dodge-fuzz.test.ts the seeded fuzz.
import { describe, expect, it } from "vitest";
import {
  AGENT_SPEC,
  CAR,
  DODGE_MIN_SPEED,
  DODGE_PROFILE,
  FOOT,
  LEAP_TICKS,
  OVERRIDE_DRAW_MPS,
  PARKED_SPEED,
  ROBOTAXI_BODY,
  ROBOTAXI_CREEP_MPS,
  ROBOTAXI_SLOW_BERTH_M,
  ROBOTAXI_STOP_BERTH_M,
  STOPPED_CLEAR_M,
  agentDodgeClass,
  agentsOf,
  boxBlocked,
  boxDistance,
  buildWorld,
  carVehicle,
  circleBlocked,
  clearanceFrom,
  createInitialState,
  dodgeExtOf,
  groundFor,
  leapShape,
  makeCar,
  makeFoot,
  makeVehicle,
  meshGroundHeight,
  overrideSpot,
  personIsChild,
  routeReach,
  step,
  surfaceHeight,
  vehicleOfAgent,
  zoneDistance,
  type AgentKind,
  type AgentState,
  type AgentsExt,
  type BuildingCollider,
  type InputFrame,
  type SimState,
  type World,
} from "../../src/sim/index.ts";
import { RECORDED, type RecordedDriver } from "./dodge-review-cases.ts";
import { LONG_RUN_MS, gridCity } from "./fixtures.ts";

function rect(id: string, x0: number, z0: number, x1: number, z1: number, topY = 12): BuildingCollider {
  return { id, footprint: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], baseY: 0, topY };
}

const FLAT = buildWorld([{ tileId: "e", buildings: [], ground: null }]);
const WALL = buildWorld([{ tileId: "w", buildings: [rect("wall", 0, -300, 30, 300)], ground: null }]);
// An inside corner at the origin: buildings east (x >= 0) and north (z <= 0) of it.
const CORNER = buildWorld([{ tileId: "c", buildings: [rect("east", 0, -60, 30, 60), rect("north", -60, -30, 0, 0)], ground: null }]);
// A 0.4 m deck (within the step a car and a walker climb, ROOF_STEP_M): both can get onto it.
const DECK = buildWorld([{ tileId: "d", buildings: [rect("deck", -30, -60, 30, 0, 0.4)], ground: null }]);
// A 3 m roof beside a road (x < 0).
const GARAGE = buildWorld([{ tileId: "g", buildings: [rect("garage", -20, -80, 0, 80, 3)], ground: null }]);

function agent(world: World, id: number, kind: AgentKind, x: number, z: number): AgentState {
  return {
    id,
    kind,
    x,
    y: meshGroundHeight(world, x, z),
    z,
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
    rng: id,
    dodge: null,
  };
}

interface CarSpec {
  id: string;
  x: number;
  z: number;
  heading: number;
  speed: number;
  lateral?: number;
  yawRate?: number;
}

interface WalkerSpec {
  id: string;
  x: number;
  z: number;
  y?: number;
  heading?: number;
  speed?: number;
}

/** A roadless world's state: players driving `cars`, players on foot `walkers` (their cars parked far off), standing agents. */
function scene(world: World, cars: CarSpec[], walkers: WalkerSpec[], agents: AgentState[]): SimState {
  const ids = [...cars.map((c) => c.id), ...walkers.map((w) => w.id)];
  let s = createInitialState(world, 1, ids, { x: 0, z: 9000, heading: 0 });
  const players = { ...s.players };
  for (const c of cars) {
    players[c.id] = { ...players[c.id]!, mode: "vehicle", car: { ...makeCar(c.x, c.z, c.heading, meshGroundHeight(world, c.x, c.z)), speed: c.speed, lateral: c.lateral ?? 0, yawRate: c.yawRate ?? 0 } };
  }
  walkers.forEach((w, i) => {
    const y = w.y ?? meshGroundHeight(world, w.x, w.z);
    players[w.id] = { ...players[w.id]!, mode: "foot", car: makeCar(5000 + 10 * i, 5000, 0), foot: { ...makeFoot(w.x, y, w.z, w.heading ?? 0), speed: w.speed ?? 0 } };
  });
  const list = [...agents].sort((a, b) => a.id - b.id);
  return { ...s, players, ext: { ...s.ext, agents: { nextId: 1_000_000, list } } };
}

/**
 * Independent of the sim's own count: every person, child and player on foot inside any
 * vehicle's body (a player's car other than their own: its box; a robotaxi: its drawn body).
 */
function contactsIn(s: SimState): string[] {
  const out: string[] = [];
  const bodies: Array<{ key: string; x: number; z: number; r: number; own: string | null }> = [];
  for (const id of Object.keys(s.players).sort()) {
    const p = s.players[id]!;
    if (p.mode === "foot" && p.foot) bodies.push({ key: `p:${id}`, x: p.foot.x, z: p.foot.z, r: FOOT.radius, own: id });
  }
  for (const a of agentsOf(s)) {
    const cls = agentDodgeClass(a);
    if (cls === "person" || cls === "care") bodies.push({ key: `a:${a.id}`, x: a.x, z: a.z, r: AGENT_SPEC[a.kind].radius, own: null });
  }
  for (const b of bodies) {
    for (const id of Object.keys(s.players).sort()) {
      if (id === b.own) continue;
      const c = s.players[id]!.car;
      const d = boxDistance(b.x, b.z, c.x, c.z, Math.sin(c.heading), -Math.cos(c.heading), CAR.halfLength, CAR.halfWidth);
      if (d < b.r) out.push(`t${s.tick} ${b.key} inside car ${id} by ${(b.r - d).toFixed(3)} m`);
    }
    for (const T of agentsOf(s)) {
      if (T.kind !== "robotaxi") continue;
      const d = boxDistance(b.x, b.z, T.x, T.z, Math.sin(T.heading), -Math.cos(T.heading), ROBOTAXI_BODY.halfLength, ROBOTAXI_BODY.halfWidth);
      if (d < b.r) out.push(`t${s.tick} ${b.key} inside robotaxi ${T.id} by ${(b.r - d).toFixed(3)} m`);
    }
  }
  return out;
}

/** Run `ticks` ticks with `drive`, collecting every contact (independent count) on the way. */
function run(world: World, s0: SimState, ticks: number, drive: (s: SimState, t: number) => InputFrame): { s: SimState; contacts: string[] } {
  let s = s0;
  const contacts: string[] = [];
  for (let t = 0; t < ticks; t++) {
    s = step(world, s, drive(s, t));
    contacts.push(...contactsIn(s));
  }
  return { s, contacts };
}

/** Zero contacts by every count: here, the sim's own, the cars' personBumps; and the override never gave up. */
function expectNoContact(s: SimState, contacts: string[], what: string): void {
  expect(contacts.slice(0, 5), what).toEqual([]);
  const d = dodgeExtOf(s);
  expect(d.contacts, `${what}: ext.dodge.contacts`).toBe(0);
  expect(d.failures, `${what}: ext.dodge.failures`).toBe(0);
  for (const id of Object.keys(s.players)) expect(s.players[id]!.car.personBumps, `${what}: car ${id} personBumps`).toBe(0);
}

const FULL = { throttle: 1, steer: 0, brake: 0, actions: 0 };

describe("a body on a roof or a deck", () => {
  it("a car driven onto a 0.4 m deck where a player stands on foot: they get out of its way along the deck, never pushed along on its bumper, never touched (the review's repro-roof)", () => {
    const s0 = scene(DECK, [{ id: "a", x: 0, z: 40, heading: 0, speed: 15 }], [{ id: "b", x: 0, z: -20, y: 0.4 }], []);
    const { s, contacts } = run(DECK, s0, 220, () => ({ a: FULL }));
    expectNoContact(s, contacts, "deck");
    const f = s.players.b!.foot!;
    // Out of the car's way to the side (it drove on to z -47), not carried along in front of it.
    expect(Math.abs(f.z - -20)).toBeLessThan(2);
    expect(Math.abs(f.x)).toBeGreaterThan(CAR.halfWidth + FOOT.radius);
    expect(f.y).toBeCloseTo(0.4, 6); // still on the deck
    expect(dodgeExtOf(s).dives).toBeGreaterThan(0);
  });

  it("the same at 8, 15 and 25 m/s, the car in line with them or offset either way", () => {
    for (const speed of [8, 15, 25]) {
      for (const off of [-1, 0, 0.7]) {
        const s0 = scene(DECK, [{ id: "a", x: off, z: 40, heading: 0, speed }], [{ id: "b", x: 0, z: -20, y: 0.4 }], []);
        const { s, contacts } = run(DECK, s0, 300, () => ({ a: FULL }));
        expectNoContact(s, contacts, `deck v${speed} off${off}`);
      }
    }
  });

  it("the override on a deck: someone standing in a car's body there is put beside it on the deck (a line it can walk), never left inside", () => {
    const v = makeVehicle("p:a", "a", 0, -20, 0, CAR.halfLength, CAR.halfWidth, 0, -15, 0, 0, { spread: 1 });
    const b = { x: 0.2, z: -20.5, y: 0.4, r: FOOT.radius, cls: "player" as const, id: 1 };
    const to = overrideSpot(groundFor(DECK, true), b, [v], [], DODGE_PROFILE.player.override!);
    expect(to.tier).toBe(0);
    expect(zoneDistance(v, to.x, to.z)).toBeGreaterThanOrEqual(b.r + DODGE_PROFILE.player.override!);
    expect(surfaceHeight(DECK, to.x, to.z, 0.4)).toBeCloseTo(0.4, 9);
    // An agent's ground (every footprint blocks it) cannot stand on the deck: the override still finds it a spot, off the deck.
    const g = overrideSpot(groundFor(DECK, false), { ...b, cls: "person", r: 0.3 }, [v], [], 0.3);
    expect(circleBlocked(DECK, g.x, g.z, 0.3)).toBe(false);
    expect(zoneDistance(v, g.x, g.z)).toBeGreaterThanOrEqual(0.3 + 0.3);
  });

  it("a player sprinting off a 3 m roof into the road as another player's car passes flat out: never inside it", () => {
    for (const speed of [25, 38]) {
      for (let D = 10; D <= 40; D += 1.9) {
        for (const lane of [2.5, 3.5]) {
          const s0 = scene(GARAGE, [{ id: "a", x: lane, z: D, heading: 0, speed }], [{ id: "b", x: -0.5, z: 0, y: 3, heading: Math.PI / 2, speed: 4.8 }], []);
          const { s, contacts } = run(GARAGE, s0, 150, () => ({ a: FULL, b: { throttle: 1, steer: 0, brake: 1, actions: 0 } }));
          expectNoContact(s, contacts, `roof v${speed} D${D.toFixed(1)} lane${lane}`);
        }
      }
    }
  }, LONG_RUN_MS);
});

describe("people in a corner or against a wall", () => {
  const corner4 = (): AgentState[] => [[-0.4, 0.4], [-1.1, 0.45], [-0.45, 1.15], [-1.2, 1.2]].map(([x, z], i) => agent(CORNER, 200 + i, "person", x!, z!));

  it("four people in an inside corner, a car coming up beside them at 10 m/s that brakes and steers into them 8 m short (repro-corner, probe-park): never inside it, before or after it hits the wall and stops still turning", () => {
    const s0 = scene(CORNER, [{ id: "c", x: -3.4, z: 40, heading: 0, speed: 10 }], [], corner4());
    let stoppedTurning = 0;
    const { s, contacts } = run(CORNER, s0, 240, (k) => {
      const c = k.players.c!.car;
      if (c.speed === 0 && Math.abs(c.yawRate) > 0.05) stoppedTurning++;
      return { c: c.z - 1 <= 8 ? { throttle: 1, steer: 1, brake: 1, actions: 0 } : FULL };
    });
    expectNoContact(s, contacts, "corner drift");
    // The scene does what the review saw: the car ends against the walls, at a standstill but still turning.
    expect(stoppedTurning).toBeGreaterThan(3);
  });

  it("a car at a standstill that is still turning counts as moving: its reach covers its turn, and the override keeps its full clearance from it", () => {
    // 0.39 rad/s at a standstill (the review's probe-park, tick 127): its corners move at 0.94 m/s.
    const v = makeVehicle("p:c", "c", 0, 0, 0.26, CAR.halfLength, CAR.halfWidth, 0, 0, 0.39, 0, { spread: 1 });
    expect(v.moving).toBe(true);
    expect(v.inflate).toBeGreaterThan(0);
    expect(clearanceFrom(v, DODGE_PROFILE.person)).toBe(DODGE_PROFILE.person.override);
    // Truly still: stopped, and only STOPPED_CLEAR_M is kept from it.
    const still = makeVehicle("p:c", "c", 0, 0, 0.26, CAR.halfLength, CAR.halfWidth, 0, 0, 0, 0, { spread: 1 });
    expect(still.moving).toBe(false);
    expect(clearanceFrom(still, DODGE_PROFILE.person)).toBe(STOPPED_CLEAR_M);
    // Moving over its last step counts too (a car that bounced to a stop this tick).
    expect(makeVehicle("p:c", "c", 0, 0, 0, CAR.halfLength, CAR.halfWidth, 0, 0, 0, 0, { observed: PARKED_SPEED * 2 }).moving).toBe(true);
  });

  it("the driven-corner family: 2-4 people backed into a corner or against a wall, cars at 10-26 m/s coming up 1.6-3.4 m off the wall that drift, counter-drift or steer in 8-16 m short: never inside a car", () => {
    const pockets: Record<string, Array<[number, number]>> = {
      corner4: [[-0.4, 0.4], [-1.1, 0.45], [-0.45, 1.15], [-1.2, 1.2]],
      corner2: [[-0.45, 0.45], [-1.2, 0.9]],
      wall4: [[-0.4, 0], [-0.4, 1.4], [-1.15, 0.7], [-0.4, 2.8]],
    };
    let runs = 0;
    for (const [name, pts] of Object.entries(pockets)) {
      const world = name.startsWith("wall") ? WALL : CORNER;
      for (const lane of [-1.6, -2.4, -3.4]) {
        for (const speed of [10, 18, 26]) {
          for (const drv of ["drift", "drift-r", "steer-in"] as const) {
            for (const at of [8, 16]) {
              runs++;
              const people = pts.map(([x, z], i) => agent(world, 200 + i, "person", x, z));
              const s0 = scene(world, [{ id: "c", x: lane, z: 40, heading: 0, speed }], [], people);
              const { s, contacts } = run(world, s0, 240, (k) => {
                const c = k.players.c!.car;
                if (c.z - 1 > at) return { c: FULL };
                if (drv === "drift") return { c: { throttle: 1, steer: 1, brake: 1, actions: 0 } };
                if (drv === "drift-r") return { c: { throttle: 1, steer: -1, brake: 1, actions: 0 } };
                return { c: { throttle: 1, steer: 0.6, brake: 0, actions: 0 } };
              });
              expectNoContact(s, contacts, `${name} lane ${lane} v${speed} ${drv}@${at}`);
            }
          }
        }
      }
    }
    expect(runs).toBe(162);
  }, LONG_RUN_MS);

  it("the optimiser's recorded drivers (a bounce off a wall at 38 m/s, a sliding corner entry, a flat slide, a wall graze): never inside a car", () => {
    const worlds: Record<RecordedDriver["family"], World> = { wall: WALL, corner: CORNER, flat: FLAT };
    for (const [name, d] of Object.entries(RECORDED)) {
      const world = worlds[d.family];
      const people: AgentState[] = [];
      let id = 9000;
      for (const [x, z] of d.people) {
        if (circleBlocked(world, x, z, 0.32)) continue;
        if (people.some((a) => Math.hypot(a.x - x, a.z - z) < 0.7)) continue;
        people.push(agent(world, id++, "person", x, z));
      }
      const fx = Math.sin(d.bearing);
      const fz = -Math.cos(d.bearing);
      const sx = -fx * d.dist - fz * d.offset;
      const sz = -fz * d.dist + fx * d.offset;
      expect(boxBlocked(world, { x: sx, z: sz, heading: d.bearing, hl: CAR.halfLength, hw: CAR.halfWidth }, 0), name).toBe(false);
      const s0 = scene(world, [{ id: "c", x: sx, z: sz, heading: d.bearing, speed: d.speed, lateral: d.lateral, yawRate: d.yawRate }], [], people);
      const { s, contacts } = run(world, s0, 6 * d.ctl.length, (_, t) => {
        const [steer, brake, throttle] = d.ctl[Math.floor(t / 6)]!;
        return { c: { throttle, steer, brake, actions: 0 } };
      });
      expectNoContact(s, contacts, `${name}: ${d.about}`);
    }
  }, LONG_RUN_MS);
});

describe("robotaxis, measured by their drawn body", () => {
  it("a person overlapping the corner of a robotaxi's drawn body (outside the two circles traffic moves it by) is a contact, and the override puts them outside its body", () => {
    // Waiting, facing north at the origin; a person at its front-right corner.
    const taxi = { ...agent(FLAT, 9, "robotaxi", 0, 0), heading: 0 };
    const x = ROBOTAXI_BODY.halfWidth + 0.15;
    const z = -ROBOTAXI_BODY.halfLength - 0.1;
    // Outside the circles (r 1.05 at 1.25 m along), inside the box plus a person's radius.
    const o = AGENT_SPEC.robotaxi.halfLength - AGENT_SPEC.robotaxi.radius;
    expect(Math.hypot(x, z + o) - AGENT_SPEC.robotaxi.radius).toBeGreaterThan(0.3);
    expect(boxDistance(x, z, 0, 0, 0, -1, ROBOTAXI_BODY.halfLength, ROBOTAXI_BODY.halfWidth)).toBeLessThan(0.3);
    let s = scene(FLAT, [{ id: "p", x: 500, z: 500, heading: 0, speed: 0 }], [], [taxi, agent(FLAT, 10, "person", x, z)]);
    s = step(FLAT, s, { p: { throttle: 0, steer: 0, brake: 0, actions: 0 } });
    expect(dodgeExtOf(s)).toMatchObject({ contacts: 1, overrides: 1, failures: 0 });
    const p = agentsOf(s).find((a) => a.id === 10)!;
    expect(boxDistance(p.x, p.z, 0, 0, 0, -1, ROBOTAXI_BODY.halfLength, ROBOTAXI_BODY.halfWidth)).toBeGreaterThanOrEqual(0.3);
    // A short hop aside: drawn as a stumble, not the big flip.
    expect(p.dodge!.leap).toBe(true);
    expect(p.dodge!.peak).toBeLessThan(0.5);
    const v = vehicleOfAgent(taxi, null, 1 / 60);
    expect(v.hl).toBe(ROBOTAXI_BODY.halfLength);
    expect(v.hw).toBe(ROBOTAXI_BODY.halfWidth);
  });

  it("in traffic on the grid city: no walker ever overlaps a robotaxi's drawn body, nobody is inside any vehicle, and no robotaxi ever sets off the override", () => {
    const world = gridCity(true);
    let s = createInitialState(world, 21, ["p1"], { x: 150, z: 150, heading: 0 });
    const bad: string[] = [];
    let robots = 0;
    for (let t = 0; t < 2400; t++) {
      const before = dodgeExtOf(s).overrides;
      s = step(world, s, { p1: { throttle: 0, steer: 0, brake: 1, actions: 0 } });
      bad.push(...contactsIn(s));
      if (dodgeExtOf(s).overrides !== before) bad.push(`t${s.tick} override (the player's car is parked: a robotaxi set it off)`);
      for (const A of agentsOf(s)) {
        if (AGENT_SPEC[A.kind].road) continue;
        for (const T of agentsOf(s)) {
          if (T.kind !== "robotaxi") continue;
          const d = boxDistance(A.x, A.z, T.x, T.z, Math.sin(T.heading), -Math.cos(T.heading), ROBOTAXI_BODY.halfLength, ROBOTAXI_BODY.halfWidth);
          if (d < AGENT_SPEC[A.kind].radius) {
            robots++;
            bad.push(`t${s.tick} ${A.kind} #${A.id} overlaps robotaxi #${T.id} by ${(AGENT_SPEC[A.kind].radius - d).toFixed(3)} m`);
          }
        }
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
    expect(robots).toBe(0);
    expect(dodgeExtOf(s).failures).toBe(0);
  }, LONG_RUN_MS);

  it("a robotaxi with someone standing within its berth waits (within its stop berth) or creeps (slower than the dodge's threat speed, never closer to them), so nobody dives or is leapt; with nobody there it pulls away", () => {
    const world = gridCity(true);
    let s = createInitialState(world, 21, ["p1"], { x: 150, z: 150, heading: 0 });
    const park = { p1: { throttle: 0, steer: 0, brake: 1, actions: 0 } };
    for (let t = 0; t < 120; t++) s = step(world, s, park);
    // A robotaxi on a straight lane, brought to a stop there (as if it had stopped for someone).
    const moving = agentsOf(s).find((a) => a.kind === "robotaxi" && !a.conn && a.speed > 3 && a.mode === "go")!;
    expect(moving, "a robotaxi under way on a lane").toBeDefined();
    const taxi: AgentState = { ...moving, speed: 0, mode: "wait" };
    // Someone pausing 0.25 m off its side (inside its stop berth: it must not set off) or 0.6 m
    // off it (inside its slow berth): beside the middle of its body, or beside its back end (it
    // moves away from them).
    const walker = agentsOf(s).find((a) => a.kind === "person" && !a.dodge && !personIsChild(a.id) && Math.hypot(a.x - taxi.x, a.z - taxi.z) > 30)!;
    const rx = Math.cos(taxi.heading);
    const rz = Math.sin(taxi.heading);
    const fx = Math.sin(taxi.heading);
    const fz = -Math.cos(taxi.heading);
    let stand: AgentState = walker;
    const at = (along: number, gap: number): AgentState => {
      const off = ROBOTAXI_BODY.halfWidth + gap + AGENT_SPEC.person.radius;
      return { ...walker, x: taxi.x + rx * off + fx * along, z: taxi.z + rz * off + fz * along, speed: 0, dwell: 100_000, mode: "dwell", conn: null };
    };
    const go = (withPerson: boolean): { moved: number; fastest: number; fastestNear: number; closest: number; dives: number; overrides: number; contacts: number } => {
      const ext = s.ext.agents as AgentsExt;
      let k: SimState = { ...s, ext: { ...s.ext, agents: { ...ext, list: ext.list.map((a) => (a.id === taxi.id ? taxi : withPerson && a.id === walker.id ? stand : a)) } } };
      const d0 = dodgeExtOf(k);
      let fastest = 0;
      let fastestNear = 0;
      let closest = Infinity;
      for (let t = 0; t < 300; t++) {
        k = step(world, k, park);
        const T = agentsOf(k).find((a) => a.id === taxi.id);
        if (!T) break;
        fastest = Math.max(fastest, T.speed);
        const P = agentsOf(k).find((a) => a.id === walker.id)!;
        const clear = boxDistance(P.x, P.z, T.x, T.z, Math.sin(T.heading), -Math.cos(T.heading), ROBOTAXI_BODY.halfLength, ROBOTAXI_BODY.halfWidth) - AGENT_SPEC.person.radius;
        if (withPerson) {
          closest = Math.min(closest, clear);
          if (clear < ROBOTAXI_SLOW_BERTH_M) fastestNear = Math.max(fastestNear, T.speed);
        }
      }
      const T = agentsOf(k).find((a) => a.id === taxi.id);
      const d = dodgeExtOf(k);
      return { moved: T ? Math.hypot(T.x - taxi.x, T.z - taxi.z) : Infinity, fastest, fastestNear, closest, dives: d.dives - d0.dives, overrides: d.overrides - d0.overrides, contacts: d.contacts };
    };
    for (const gap of [0.25, 0.6]) {
      for (const along of [0, -1.6]) {
        stand = at(along, gap);
        const past = go(true);
        const what = `someone ${gap} m off its side, ${along} m along`;
        expect(past.fastestNear, `${what}: its speed while within its berth of them`).toBeLessThanOrEqual(ROBOTAXI_CREEP_MPS + 1e-9);
        expect(past.fastestNear).toBeLessThan(DODGE_MIN_SPEED);
        expect(past.closest, `${what}: never closer than it started`).toBeGreaterThanOrEqual(gap - 1e-6);
        expect(past.dives, what).toBe(0);
        expect(past.overrides, what).toBe(0);
        expect(past.contacts, what).toBe(0);
        // Within the stop berth it waits; beside its back end, outside that, it creeps away from them and goes.
        if (gap < ROBOTAXI_STOP_BERTH_M) expect(past.moved, `${what}: it waits`).toBeLessThan(0.01);
        else if (along < 0) expect(past.moved, `${what}: it moves on`).toBeGreaterThan(1);
      }
    }
    // Nobody there: it pulls away at speed.
    const free = go(false);
    expect(free.moved).toBeGreaterThan(2);
    expect(free.fastest).toBeGreaterThan(ROBOTAXI_CREEP_MPS + 1);
  }, LONG_RUN_MS);
});

describe("a vehicle's reach over its next step (what the override keeps people out of)", () => {
  /** Points every 0.1 m round the outline of a box (its corners included). */
  const outline = (x: number, z: number, heading: number, hl: number, hw: number): Array<[number, number]> => {
    const fx = Math.sin(heading);
    const fz = -Math.cos(heading);
    const out: Array<[number, number]> = [];
    const nl = Math.ceil((2 * hl) / 0.1);
    const nw = Math.ceil((2 * hw) / 0.1);
    for (let i = 0; i <= nl; i++) {
      const a = -hl + (2 * hl * i) / nl;
      for (const s of [-1, 1]) out.push([x + fx * a - fz * s * hw, z + fz * a + fx * s * hw]);
    }
    for (let i = 0; i <= nw; i++) {
      const b = -hw + (2 * hw * i) / nw;
      for (const s of [-1, 1]) out.push([x + fx * s * hl - fz * b, z + fz * s * hl + fx * b]);
    }
    return out;
  };

  it("a player's car is always inside its reach after its step: random drivers into walls, corners, a deck and each other, starting inside a building", () => {
    // (The review's corner and wall drivers. A car touching anything turns its nose toward its
    // slide beyond its yaw rate, CAR.wallAlign; one placed in a building is eased out of it, one
    // overlapping another car is shoved out: all within its reach.)
    let worst = -Infinity;
    let where = "";
    let pushedOut = 0;
    let checked = 0;
    for (let seed = 1; seed <= 48; seed++) {
      let rs = seed * 7919;
      const rnd = (): number => {
        rs = (Math.imul(rs, 1664525) + 1013904223) >>> 0;
        return rs / 4294967296;
      };
      const world = [CORNER, WALL, DECK, FLAT][seed % 4]!;
      const car = (id: string): CarSpec => ({ id, x: -30 + rnd() * 10, z: -10 + rnd() * 20, heading: Math.PI * (0.25 + rnd() * 0.5), speed: 5 + rnd() * 33, lateral: (rnd() - 0.5) * 10, yawRate: (rnd() - 0.5) * 2 });
      // Two cars, the second set off at the first.
      const a = car("a");
      const b = { ...car("b"), x: a.x + 12, z: a.z + (rnd() - 0.5) * 4, heading: a.heading + Math.PI };
      let s = scene(world, [a, b], [], []);
      const ctl: Record<string, InputFrame[string]> = {};
      let older = s;
      for (let t = 0; t < 300; t++) {
        if (t % 6 === 0) for (const id of ["a", "b"]) ctl[id] = { throttle: rnd() > 0.15 ? 1 : -1, steer: rnd() * 2 - 1, brake: rnd() > 0.75 ? 1 : 0, actions: 0 };
        // Its reach as the dodge sees it at the end of the last tick.
        const reach = { a: carVehicle(world, older, s, "a"), b: carVehicle(world, older, s, "b") };
        const box0 = s.players.a!.car;
        if (t === 0 && boxBlocked(world, { x: box0.x, z: box0.z, heading: box0.heading, hl: CAR.halfLength, hw: CAR.halfWidth }, box0.y + 0.4, [], box0.y + CAR.bodyHeight)) pushedOut++;
        older = s;
        s = step(world, s, ctl);
        for (const id of ["a", "b"] as const) {
          const c = s.players[id]!.car;
          checked++;
          for (const [x, z] of outline(c.x, c.z, c.heading, CAR.halfLength, CAR.halfWidth)) {
            const beyond = zoneDistance(reach[id], x, z);
            if (beyond > worst) {
              worst = beyond;
              where = `seed ${seed} t${t} car ${id}`;
            }
          }
        }
      }
    }
    expect(checked).toBe(48 * 300 * 2);
    // (Some start inside a building.)
    expect(pushedOut).toBeGreaterThan(0);
    expect(worst, where).toBeLessThanOrEqual(1e-6);
  }, LONG_RUN_MS);

  it("a robotaxi's reach from its route holds where it goes, a connector's vertex turns included (grid city traffic)", () => {
    const world = gridCity(true);
    let s = createInitialState(world, 11, ["p1"], { x: 100, z: 200, heading: 0 });
    let checked = 0;
    let worst = -Infinity;
    for (let t = 0; t < 900; t++) {
      const before = agentsOf(s).filter((a) => a.kind === "robotaxi" && Math.hypot(a.x - 100, a.z - 200) < 150);
      const reach = new Map(
        before.map((a) => {
          const v = vehicleOfAgent(a, null, 1 / 60, world, false);
          routeReach(v, a, 1 / 60, world);
          return [a.id, v] as const;
        }),
      );
      s = step(world, s, { p1: { throttle: 0, steer: 0, brake: 1, actions: 0 } });
      for (const a of agentsOf(s)) {
        const v = reach.get(a.id);
        if (!v || a.ghost > 0) continue;
        checked++;
        expect(v.zone).not.toBeNull();
        for (const [x, z] of outline(a.x, a.z, a.heading, ROBOTAXI_BODY.halfLength, ROBOTAXI_BODY.halfWidth)) worst = Math.max(worst, zoneDistance(v, x, z));
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(worst).toBeLessThanOrEqual(1e-6);
  }, LONG_RUN_MS);

  it("a car reversing slowly at someone (the review's Spofford Alley pass, at 1-2 m/s): they get out of its way, never within 0.75 m of it while it moves", () => {
    // Facing north, its back toward a person 4 m behind it, reversing from 1 m/s.
    const s0 = scene(FLAT, [{ id: "c", x: 0, z: 0, heading: 0, speed: -1 }], [], [agent(FLAT, 50, "person", 0.3, CAR.halfLength + 4)]);
    let minClear = Infinity;
    const { s, contacts } = run(FLAT, s0, 180, (k) => {
      const c = k.players.c!.car;
      const p = agentsOf(k)[0]!;
      if (Math.hypot(c.speed, c.lateral) > 1) minClear = Math.min(minClear, boxDistance(p.x, p.z, c.x, c.z, Math.sin(c.heading), -Math.cos(c.heading), CAR.halfLength, CAR.halfWidth) - 0.3);
      return { c: { throttle: -0.4, steer: 0, brake: 0, actions: 0 } };
    });
    expectNoContact(s, contacts, "reversing");
    expect(dodgeExtOf(s).dives).toBeGreaterThan(0);
    expect(minClear).toBeGreaterThanOrEqual(0.75);
  });
});

describe("how the override's leap is drawn", () => {
  it("a short one (a robotaxi edging up, a car brushing past) is a quick stumble; a long one a shove aside, never a hop, never drawn faster than OVERRIDE_DRAW_MPS (v11)", () => {
    const short = leapShape(DODGE_PROFILE.person, 0.2);
    expect(short.peak).toBe(0);
    expect(short.dur).toBeLessThan(16);
    const long = leapShape(DODGE_PROFILE.person, 4);
    expect(long.peak).toBe(DODGE_PROFILE.person.leapPeak);
    expect(long.peak).toBe(0);
    expect(long.dur).toBe(LEAP_TICKS);
    // Eased (smoothstep, steepest 1.5 times the mean) over its ticks: no faster than OVERRIDE_DRAW_MPS.
    for (let d = 0.1; d <= 4 + 1e-9; d += 0.1) expect((1.5 * d) / (leapShape(DODGE_PROFILE.person, d).dur / 60)).toBeLessThanOrEqual(OVERRIDE_DRAW_MPS + 1e-9);
    // Never higher or longer for a shorter leap.
    let last = leapShape(DODGE_PROFILE.person, 0);
    for (let d = 0.1; d <= 6; d += 0.1) {
      const k = leapShape(DODGE_PROFILE.person, d);
      expect(k.peak).toBeGreaterThanOrEqual(last.peak);
      expect(k.dur).toBeGreaterThanOrEqual(last.dur);
      last = k;
    }
  });
});
