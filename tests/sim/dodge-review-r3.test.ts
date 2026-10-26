// The adversarial review's reproductions (round 3, 2026-10-22), kept as permanent tests. Every way
// the reviewers found to raise the contact count through ordinary play stays closed:
//  - getting out of the car beside a robotaxi (standing, or waiting in grid traffic) or as another
//    car passes: the exit spot keeps clear of every vehicle body a walker meets (robotaxis' drawn
//    ones included) and of where a vehicle can be by the end of the tick, and the player's own
//    parked car is solid to their dives and to the override's leaps (no endless leap loop);
//  - a person overlapping a player on foot never shoves them into a vehicle (vehicle bodies are
//    hard limits for a walker), and nobody lands on a player on foot; the multi-car optimiser's
//    natural hits (two cars head-on in an alley, a stopped car shoved at people) replay clean;
//  - people never appear inside a vehicle: the population refill keeps clear of parked player
//    cars, and a player who joins gets a car placed clear of everyone on foot;
//  - heights: someone on a roof over the street, or under a deck a car drives across, is not in
//    the car's way; the override's leap up a flight of steps stands on the step it reached.
// tests/sim/dodge-review.test.ts holds round 2's, tests/sim/dodge.test.ts the dodge's parts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AGENT_SPEC,
  Action,
  CAR,
  FOOT,
  ROBOTAXI_BODY,
  ROOF_STEP_M,
  SPAWN_VEHICLE_CLEAR_M,
  agentDodgeClass,
  agentsOf,
  boxDistance,
  buildWorld,
  circleBlockedBand,
  createInitialState,
  dodgeExtOf,
  explainAgent,
  keepOffVehicles,
  makeCar,
  makeFoot,
  meshGroundHeight,
  step,
  surfaceHeight,
  type AgentKind,
  type AgentState,
  type AgentsExt,
  type BuildingCollider,
  type InputFrame,
  type SimEvent,
  type SimState,
  type World,
} from "../../src/sim/index.ts";
import { LONG_RUN_MS, gridCity } from "./fixtures.ts";
import { replayMultiHit, type MultiFamily } from "./dodge-optimiser-multi.ts";

/** The multi-car optimiser's recorded hits (its genomes, full precision: the very runs the reviewer had). */
const HITS = JSON.parse(readFileSync(new URL("./dodge-review-r3-hits.json", import.meta.url), "utf8")) as Record<MultiFamily, number[][]>;

function rect(id: string, x0: number, z0: number, x1: number, z1: number, topY = 12, baseY = 0, underY?: number): BuildingCollider {
  const b: BuildingCollider = { id, footprint: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], baseY, topY };
  if (underY !== undefined) b.underY = underY;
  return b;
}

const FLAT = buildWorld([{ tileId: "e", buildings: [], ground: null }]);

function agent(world: World, id: number, kind: AgentKind, x: number, z: number, heading = 0, speed = 0): AgentState {
  return {
    id,
    kind,
    x,
    y: meshGroundHeight(world, x, z),
    z,
    heading,
    pitch: 0,
    speed,
    vmax: kind === "robotaxi" ? 12 : 1.3,
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

function withAgents(s: SimState, list: AgentState[], nextId = 1000): SimState {
  return { ...s, ext: { ...s.ext, agents: { nextId, list } satisfies AgentsExt } };
}

const fwd = (h: number): [number, number] => [Math.sin(h), -Math.cos(h)];

/**
 * Bodies inside a vehicle's body (an independent count): every player on foot and every person or
 * animal, against every player's car but their own and every robotaxi's drawn body, where their
 * height bands overlap.
 */
function inside(s: SimState): string[] {
  const out: string[] = [];
  const vehicles: Array<{ key: string; owner: string | null; x: number; y: number; z: number; h: number; hl: number; hw: number; top: number }> = [];
  for (const id of Object.keys(s.players).sort()) {
    const c = s.players[id]!.car;
    vehicles.push({ key: `car ${id}`, owner: id, x: c.x, y: c.y, z: c.z, h: c.heading, hl: CAR.halfLength, hw: CAR.halfWidth, top: CAR.bodyHeight });
  }
  for (const a of agentsOf(s)) if (a.kind === "robotaxi") vehicles.push({ key: `robotaxi ${a.id}`, owner: null, x: a.x, y: a.y, z: a.z, h: a.heading, hl: ROBOTAXI_BODY.halfLength, hw: ROBOTAXI_BODY.halfWidth, top: ROBOTAXI_BODY.height });
  const bodies: Array<{ key: string; owner: string | null; x: number; y: number; z: number; r: number }> = [];
  for (const id of Object.keys(s.players).sort()) {
    const p = s.players[id]!;
    if (p.mode === "foot" && p.foot) bodies.push({ key: `walker ${id}`, owner: id, x: p.foot.x, y: p.foot.y - (p.foot.dodge?.hop ?? 0), z: p.foot.z, r: FOOT.radius });
  }
  for (const a of agentsOf(s)) {
    const cls = agentDodgeClass(a);
    if (cls === null || cls === "errandRobot" || cls === "sidewalkBot") continue;
    bodies.push({ key: `${a.kind} ${a.id}`, owner: null, x: a.x, y: a.y - (a.dodge?.hop ?? 0), z: a.z, r: AGENT_SPEC[a.kind].radius });
  }
  for (const b of bodies) {
    for (const v of vehicles) {
      if (v.owner !== null && v.owner === b.owner) continue;
      if (!(b.y < v.y + v.top && v.y < b.y + FOOT.height)) continue;
      const [fx, fz] = fwd(v.h);
      const d = boxDistance(b.x, b.z, v.x, v.z, fx, fz, v.hl, v.hw) - b.r;
      if (d < 0) out.push(`tick ${s.tick}: ${b.key} ${(-d).toFixed(3)} m inside ${v.key}`);
    }
  }
  return out;
}

/** How deep a player on foot is in their own car's body (> 0 inside). */
function ownDepth(s: SimState, id: string): number {
  const p = s.players[id]!;
  if (p.mode !== "foot" || !p.foot) return -Infinity;
  const c = p.car;
  const [fx, fz] = fwd(c.heading);
  return FOOT.radius - boxDistance(p.foot.x, p.foot.z, c.x, c.z, fx, fz, CAR.halfLength, CAR.halfWidth);
}

function bumps(s: SimState): number {
  let n = 0;
  for (const id of Object.keys(s.players)) n += s.players[id]!.car.personBumps;
  return n;
}

const EXIT: InputFrame[string] = { throttle: 0, steer: 0, brake: 0, actions: Action.enterExit };
const IDLE: InputFrame[string] = { throttle: 0, steer: 0, brake: 0, actions: 0 };

describe("getting out of the car", () => {
  it("beside a robotaxi standing 0.2-1.1 m off the driver's side: out on a free side, never inside the robotaxi or their own car, no contact, no override, in control (the review's R1a, exit-loop)", () => {
    for (const gap of [0.2, 0.3, 0.45, 0.6, 0.8, 0.9, 1.1]) {
      let s = createInitialState(FLAT, 1, ["a"], { x: 0, z: 0, heading: 0 });
      s = withAgents(s, [agent(FLAT, 5, "robotaxi", -(CAR.halfWidth + gap + ROBOTAXI_BODY.halfWidth), 0)]);
      let control = 0;
      const seen: string[] = [];
      let deepest = -Infinity;
      for (let k = 0; k < 600; k++) {
        // Out, then walk on (forward for 3 s), then stand.
        s = step(FLAT, s, { a: k === 0 ? EXIT : k < 180 ? { ...IDLE, throttle: 0.6 } : IDLE });
        seen.push(...inside(s));
        deepest = Math.max(deepest, ownDepth(s, "a"));
        const f = s.players.a!.foot;
        if (f && !f.dodge) control++;
      }
      expect(s.players.a!.mode, `gap ${gap}`).toBe("foot");
      expect(seen, `gap ${gap}`).toEqual([]);
      expect(dodgeExtOf(s), `gap ${gap}`).toMatchObject({ contacts: 0, overrides: 0, failures: 0 });
      expect(deepest, `gap ${gap}`).toBeLessThanOrEqual(0);
      expect(control, `gap ${gap}`).toBeGreaterThanOrEqual(598);
    }
  });

  it("as another player's car passes 0.6 m off the driver's side at 10-38 m/s: never inside it, no contact, no personBump; out once it has gone, or on the other side (R1b)", () => {
    for (const speed of [10, 20, 30, 38]) {
      for (const off of [0.3, 0.6, 1.0]) {
        // b drives north along a's left side, its right side `off` m from a's left side, its tail
        // `behind` m behind a's (2.86 m: the review's, passing a's door as a gets out).
        for (const behind of [0.66, 1.3, 2.8]) {
          let s = createInitialState(FLAT, 1, ["a", "b"], { x: 0, z: 0, heading: 0 });
          const bx = -(CAR.halfWidth + off + CAR.halfWidth);
          s = { ...s, players: { a: { ...s.players.a!, car: makeCar(0, 0, 0) }, b: { ...s.players.b!, car: { ...makeCar(bx, behind + CAR.halfLength, 0), speed } } } };
          const seen: string[] = [];
          for (let k = 0; k < 90; k++) {
            s = step(FLAT, s, { a: k === 0 ? EXIT : IDLE, b: { ...IDLE, throttle: 1 } });
            seen.push(...inside(s));
          }
          const label = `${speed} m/s, ${off} m off, ${behind} m behind`;
          expect(seen, label).toEqual([]);
          expect(dodgeExtOf(s).contacts, label).toBe(0);
          expect(bumps(s), label).toBe(0);
          expect(s.players.a!.mode, label).toBe("foot");
        }
      }
    }
  });

  it("in grid traffic beside a robotaxi waiting in its lane, 0.2-1.1 m off its side: no contact, no override, the player keeps control, and the robotaxi drives off (0.4 m or more: a car parked closer is in its way itself, out or not) (exit-grid, R1c)", () => {
    const world = gridCity();
    let base = createInitialState(world, 4, ["a"], { x: 20, z: 106, heading: Math.PI / 2 });
    for (let t = 0; t < 60; t++) base = step(world, base, {});
    // A robotaxi on a straight stretch, well clear of the junctions.
    const T = agentsOf(base).find((a) => a.kind === "robotaxi" && a.speed > 2 && a.conn === null && ((a.x % 100) + 100) % 100 > 30 && ((a.x % 100) + 100) % 100 < 70)!;
    expect(T).toBeDefined();
    const [fx, fz] = fwd(T.heading);
    for (const gap of [0.2, 0.4, 0.6, 0.8, 1.1]) {
      // The player's car stopped alongside it, on its right; the player gets out toward it (the driver's side).
      const off = CAR.halfWidth + gap + ROBOTAXI_BODY.halfWidth;
      const cx = T.x - fz * off;
      const cz = T.z + fx * off;
      const list = agentsOf(base).map((a) => (a.id === T.id ? { ...a, speed: 0 } : a));
      let s: SimState = { ...base, players: { a: { ...base.players.a!, mode: "vehicle", car: makeCar(cx, cz, T.heading, meshGroundHeight(world, cx, cz)) } } };
      s = { ...s, ext: { ...s.ext, agents: { ...(s.ext.agents as AgentsExt), list } } };
      let control = 0;
      let drove = false;
      const seen: string[] = [];
      for (let k = 0; k < 600; k++) {
        s = step(world, s, { a: k === 0 ? EXIT : { ...IDLE, throttle: 1 } });
        seen.push(...inside(s));
        const f = s.players.a!.foot;
        if (f && !f.dodge) control++;
        const t2 = agentsOf(s).find((a) => a.id === T.id);
        if (t2 && Math.hypot(t2.x - T.x, t2.z - T.z) > 1) drove = true;
      }
      expect(seen, `gap ${gap}`).toEqual([]);
      expect(dodgeExtOf(s), `gap ${gap}`).toMatchObject({ contacts: 0, overrides: 0, failures: 0 });
      expect(control, `gap ${gap}`).toBeGreaterThanOrEqual(598);
      if (gap >= 0.4) expect(drove, `gap ${gap}`).toBe(true);
      else {
        // The parked car, not the player on foot, holds it: it waits for the car, out or not.
        expect(explainAgent(world, s, T.id)?.blocker, `gap ${gap}`).toBe("player");
        let still: SimState = { ...base, players: { a: { ...base.players.a!, mode: "vehicle", car: makeCar(cx, cz, T.heading, meshGroundHeight(world, cx, cz)) } } };
        still = { ...still, ext: { ...still.ext, agents: { ...(still.ext.agents as AgentsExt), list } } };
        for (let k = 0; k < 600; k++) still = step(world, still, {});
        const t3 = agentsOf(still).find((a) => a.id === T.id)!;
        expect(Math.hypot(t3.x - T.x, t3.z - T.z), `gap ${gap}`).toBeLessThan(1);
      }
    }
  }, LONG_RUN_MS);

  it("a player landing inside a robotaxi's body beside their own parked car is put outside both, once (never into their own car, no leap loop)", () => {
    for (const gap of [0.3, 0.6]) {
      let s = createInitialState(FLAT, 1, ["a", "b"], { x: 0, z: 0, heading: 0 });
      const tx = -(CAR.halfWidth + gap + ROBOTAXI_BODY.halfWidth);
      // Getting up from a dive that ended there (the walker's own step does not run meanwhile).
      const wx = -CAR.halfWidth - FOOT.radius - 0.05;
      const foot = { ...makeFoot(wx, 0, 0, 0), dodge: { phase: "recover" as const, sx: wx, sz: 0, tx: wx, tz: 0, t: 0, dur: 30, peak: 0, hop: 0, leap: false, vx: 0, vz: 0, vmax: 4.8 } };
      s = { ...s, players: { a: { ...s.players.a!, mode: "foot", car: makeCar(0, 0, 0), foot }, b: { ...s.players.b!, car: makeCar(200, 0, 0) } } };
      s = withAgents(s, [agent(FLAT, 5, "robotaxi", tx, 0)]);
      let deepest = -Infinity;
      for (let k = 0; k < 600; k++) {
        s = step(FLAT, s, { a: k > 60 && k < 200 ? { ...IDLE, throttle: 0.5 } : IDLE });
        deepest = Math.max(deepest, ownDepth(s, "a"));
        expect(inside(s), `gap ${gap}`).toEqual([]);
      }
      // (The one contact is the placement itself.)
      expect(dodgeExtOf(s), `gap ${gap}`).toMatchObject({ contacts: 1, overrides: 1, failures: 0 });
      expect(deepest, `gap ${gap}`).toBeLessThanOrEqual(0);
    }
  });
});

describe("a player on foot is never shoved into a vehicle", () => {
  it("a person overlapping a walker 0.06 m off a parked car, a car creeping at 0.8 m/s and a standing robotaxi (overlaps 0.2-0.5 m): no contact (R5)", () => {
    for (const overlap of [0.2, 0.3, 0.4, 0.5]) {
      const wx = CAR.halfWidth + 0.06 + FOOT.radius;
      const px = wx + FOOT.radius + AGENT_SPEC.person.radius - overlap;
      let s = createInitialState(FLAT, 1, ["a", "b"], { x: 0, z: 0, heading: 0 });
      s = withAgents({ ...s, players: { a: { ...s.players.a!, mode: "foot", car: makeCar(80, 80, 0), foot: makeFoot(wx, 0, 0, 0) }, b: { ...s.players.b!, mode: "foot", car: makeCar(0, 0, 0), foot: makeFoot(300, 0, 300, 0) } } }, [agent(FLAT, 5, "person", px, 0)]);
      const runs: Array<[string, SimState, (k: number) => InputFrame]> = [
        ["parked car", s, () => ({})],
        ["creeping car", { ...s, players: { ...s.players, b: { ...s.players.b!, mode: "vehicle", foot: null, car: { ...makeCar(0, 1, 0), speed: 0.8 } } } }, (k) => ({ b: { ...IDLE, throttle: k % 3 === 0 ? 0.12 : 0.06 } })],
      ];
      const wx3 = ROBOTAXI_BODY.halfWidth + 0.06 + FOOT.radius;
      let s3 = createInitialState(FLAT, 1, ["a"], { x: 0, z: 0, heading: 0 });
      s3 = withAgents({ ...s3, players: { a: { ...s3.players.a!, mode: "foot", car: makeCar(80, 80, 0), foot: makeFoot(wx3, 0, 0, 0) } } }, [agent(FLAT, 4, "robotaxi", 0, 0), agent(FLAT, 5, "person", wx3 + FOOT.radius + AGENT_SPEC.person.radius - overlap, 0)]);
      runs.push(["standing robotaxi", s3, () => ({})]);
      for (const [label, s0, inputs] of runs) {
        let st = s0;
        for (let k = 0; k < 30; k++) {
          st = step(FLAT, st, inputs(k));
          expect(inside(st), `${label}, overlap ${overlap}`).toEqual([]);
        }
        expect(dodgeExtOf(st).contacts, `${label}, overlap ${overlap}`).toBe(0);
        expect(bumps(st), `${label}, overlap ${overlap}`).toBe(0);
      }
    }
  });

  it("keepOffVehicles: a resolved step that ends in a vehicle's box is pushed out of it, or not taken where that would put the walker in a building", () => {
    const box = { x: 0, z: 0, heading: 0, hl: 2.24, hw: 0.99 };
    const band = { bottom: 0.5, top: 1.8 };
    // Pushed 0.2 m into the box's right side: out again, to just outside it.
    const out = keepOffVehicles(FLAT, 1.4, 0, { x: 1.14, z: 0, hit: true }, FOOT.radius, [box], band);
    expect(out.x).toBeGreaterThanOrEqual(0.99 + FOOT.radius - 1e-6);
    // Not in a box: unchanged.
    const free = { x: 3, z: 0, hit: false };
    expect(keepOffVehicles(FLAT, 3, 0, free, FOOT.radius, [box], band)).toBe(free);
    // A building right of the box, 0.5 m off it: no room; the walker stays where it was.
    const w = buildWorld([{ tileId: "b", buildings: [rect("b", 1.49, -10, 10, 10)], ground: null }]);
    const stay = keepOffVehicles(w, 1.2, 3, { x: 1.14, z: 0, hit: true }, FOOT.radius, [box], band);
    expect(stay).toMatchObject({ x: 1.2, z: 3 });
  });

  it("the multi-car optimiser's natural hits replay clean (two cars head-on in a 3.4 m alley with people and players between them; cars round a stopped car near a wall)", () => {
    for (const [family, hits] of Object.entries(HITS) as Array<[MultiFamily, number[][]]>) {
      hits.forEach((genes, i) => {
        const o = replayMultiHit(family, genes);
        expect(o.ticks, `${family} ${i}`).toBeGreaterThan(0);
        expect({ contacts: o.contacts, simContacts: o.simContacts, bumps: o.bumps, failures: o.failures }, `${family} ${i}`).toEqual({ contacts: 0, simContacts: 0, bumps: 0, failures: 0 });
      });
    }
  }, LONG_RUN_MS);
});

describe("nobody appears inside a vehicle", () => {
  it("the population refill around cars parked on the grid's sidewalks (their players far away): no spawn within SPAWN_VEHICLE_CLEAR_M of a car's body, no contact, no personBump (R3, seeds 1 and 7)", () => {
    const world = gridCity();
    const parkers = ["b", "c", "d", "e", "f", "g", "h", "i"];
    for (const seed of [1, 7]) {
      let r = (seed * 2654435761) >>> 0;
      const rnd = (): number => (r = (Math.imul(r, 1664525) + 1013904223) >>> 0) / 4294967296;
      let s = createInitialState(world, seed, ["a", ...parkers], { x: 900, z: 0, heading: -Math.PI / 2 });
      const players = { ...s.players };
      parkers.forEach((id, n) => {
        // On a sidewalk: along a horizontal street (z = j*100 +- 7.5) or a vertical one.
        const horiz = rnd() < 0.5;
        const line = Math.floor(rnd() * 4) * 100 + (rnd() < 0.5 ? -7.5 : 7.5);
        const along = Math.floor(rnd() * 3) * 100 + 15 + rnd() * 70;
        const [x, z, h] = horiz ? [along, line, Math.PI / 2] : [line, along, 0];
        players[id] = { ...players[id]!, mode: "foot", car: makeCar(x, z, h, meshGroundHeight(world, x, z)), foot: makeFoot(5000 + n * 10, 0, 5000, 0) };
      });
      players.a = { ...players.a!, car: { ...makeCar(900, 0, -Math.PI / 2), speed: 25 } };
      s = { ...s, players };
      const known = new Set(agentsOf(s).map((a) => a.id));
      let spawned = 0;
      const near: string[] = [];
      for (let k = 0; k < 2400; k++) {
        const c = s.players.a!.car;
        s = step(world, s, { a: c.x > 330 ? { ...IDLE, throttle: 1 } : { ...IDLE, brake: 1 } });
        for (const a of agentsOf(s)) {
          if (known.has(a.id)) continue;
          known.add(a.id);
          spawned++;
          if (AGENT_SPEC[a.kind].road) continue;
          for (const id of parkers) {
            const pc = s.players[id]!.car;
            const [fx, fz] = fwd(pc.heading);
            const d = boxDistance(a.x, a.z, pc.x, pc.z, fx, fz, CAR.halfLength, CAR.halfWidth) - AGENT_SPEC[a.kind].radius;
            if (d < SPAWN_VEHICLE_CLEAR_M - 1e-9) near.push(`seed ${seed} tick ${s.tick}: ${a.kind} ${a.id} ${d.toFixed(2)} m from ${id}'s car`);
          }
        }
        expect(inside(s), `seed ${seed}`).toEqual([]);
      }
      expect(spawned, `seed ${seed}`).toBeGreaterThan(50);
      expect(near).toEqual([]);
      expect(dodgeExtOf(s).contacts, `seed ${seed}`).toBe(0);
      expect(bumps(s), `seed ${seed}`).toBe(0);
    }
  }, LONG_RUN_MS);

  it("a player who joins on a person, on a player on foot or on a crowd of 20 gets a car placed clear of them all: no contact, no override, no personBump (R2)", () => {
    const join = (s: SimState): SimEvent[] => [{ tick: s.tick + 1, kind: "player.join", playerId: "j", payload: { x: 0, z: 0, heading: 0 } }];
    const cases: Array<[string, SimState]> = [];
    const base = createInitialState(FLAT, 1, ["a"], { x: 200, z: 0, heading: 0 });
    cases.push(["a person", withAgents(base, [agent(FLAT, 5, "person", 0.5, 0.4)])]);
    cases.push(["a player on foot", { ...base, players: { a: { ...base.players.a!, mode: "foot", car: makeCar(200, 0, 0), foot: makeFoot(0.3, 0, -0.5, 0) } } }]);
    const crowd: AgentState[] = [];
    for (let i = 0; i < 20; i++) crowd.push(agent(FLAT, 100 + i, i % 7 === 6 ? "errandRobot" : "person", ((i % 5) - 2) * 1.1, (Math.floor(i / 5) - 1.5) * 1.3));
    cases.push(["a crowd of 20", withAgents(base, crowd)]);
    for (const [label, s0] of cases) {
      let s = step(FLAT, s0, {}, join(s0));
      const c = s.players.j!.car;
      const [fx, fz] = fwd(c.heading);
      for (const a of agentsOf(s)) {
        if (a.kind === "person") expect(boxDistance(a.x, a.z, c.x, c.z, fx, fz, CAR.halfLength, CAR.halfWidth) - AGENT_SPEC.person.radius, label).toBeGreaterThanOrEqual(0.6);
      }
      for (let k = 0; k < 60; k++) {
        s = step(FLAT, s, {});
        expect(inside(s), label).toEqual([]);
      }
      expect(dodgeExtOf(s), label).toMatchObject({ contacts: 0, overrides: 0, failures: 0 });
      expect(bumps(s), label).toBe(0);
    }
  });
});

describe("heights", () => {
  it("a player on foot 0.1-0.6 m in from the edge of a 4 m or 10 m roof as a car passes along the wall below at 30 m/s: no dive, no leap, no contact, still on the roof (R8)", () => {
    for (const roofY of [4, 10]) {
      const world = buildWorld([{ tileId: "r", buildings: [rect("b", 0, -40, 12, 40, roofY)], ground: null }]);
      for (const edge of [0.1, 0.35, 0.6]) {
        let s = createInitialState(world, 1, ["a", "c"], { x: -10, z: 60, heading: 0 });
        s = { ...s, players: { a: { ...s.players.a!, mode: "foot", car: makeCar(-30, 0, 0), foot: makeFoot(edge, roofY, 0, -Math.PI / 2) }, c: { ...s.players.c!, car: { ...makeCar(-CAR.halfWidth - 0.05, 60, 0), speed: 30 } } } };
        for (let k = 0; k < 150; k++) s = step(world, s, { c: { ...IDLE, throttle: 1 } });
        const label = `roof ${roofY} m, ${edge} m in`;
        expect(dodgeExtOf(s), label).toMatchObject({ contacts: 0, overrides: 0, dives: 0 });
        expect(s.players.a!.foot!, label).toMatchObject({ x: edge, y: roofY, z: 0, dodge: null });
      }
    }
  });

  it("a 0.45 m deck beside the street is within a car's climb: someone on it still dives out of the way", () => {
    const world = buildWorld([{ tileId: "r", buildings: [rect("b", 0, -40, 12, 40, 0.45)], ground: null }]);
    let s = createInitialState(world, 1, ["a", "c"], { x: -10, z: 60, heading: 0 });
    s = { ...s, players: { a: { ...s.players.a!, mode: "foot", car: makeCar(-30, 0, 0), foot: makeFoot(0.35, 0.45, 0, -Math.PI / 2) }, c: { ...s.players.c!, car: { ...makeCar(-CAR.halfWidth - 0.05, 60, 0), speed: 30 } } } };
    for (let k = 0; k < 150; k++) s = step(world, s, { c: { ...IDLE, throttle: 1 } });
    expect(dodgeExtOf(s).dives).toBeGreaterThanOrEqual(1);
    expect(dodgeExtOf(s).contacts).toBe(0);
  });

  it("a player on a 4 m roof walks right up to its edge over a car parked below (walkers meet vehicle bodies only at their height)", () => {
    const world = buildWorld([{ tileId: "r", buildings: [rect("b", 0, -40, 12, 40, 4)], ground: null }]);
    let s = createInitialState(world, 1, ["a", "c"], { x: -10, z: 60, heading: 0 });
    s = { ...s, players: { a: { ...s.players.a!, mode: "foot", car: makeCar(-30, 0, 0), foot: makeFoot(0.9, 4, 0, -Math.PI / 2) }, c: { ...s.players.c!, mode: "foot", car: makeCar(-CAR.halfWidth - 0.02, 0, 0), foot: makeFoot(-30, 0, 30, 0) } } };
    let minX = Infinity;
    for (let k = 0; k < 50; k++) {
      s = step(world, s, { a: { ...IDLE, throttle: 0.5 } });
      if (s.players.a!.foot!.y > 3.9) minX = Math.min(minX, s.players.a!.foot!.x);
    }
    expect(minX).toBeLessThan(0.36);
    expect(dodgeExtOf(s)).toMatchObject({ contacts: 0, overrides: 0, dives: 0 });
  });

  it("a person under a 5 m deck as a car drives across it at 12-30 m/s: no dive, no leap, no contact", () => {
    // The deck: a structure from 5 m (its underside) to 6 m over x -30..30, z -6..6.
    const world = buildWorld([{ tileId: "d", buildings: [rect("deck", -40, -6, 40, 6, 6, 0, 5)], ground: null }]);
    for (const speed of [12, 20, 30]) {
      let s = createInitialState(world, 1, ["c"], { x: 0, z: 200, heading: 0 });
      s = withAgents({ ...s, players: { c: { ...s.players.c!, car: { ...makeCar(-30, 0.3, Math.PI / 2, 6), speed } } } }, [agent(world, 5, "person", 5, 0)]);
      for (let k = 0; k < Math.round((45 / speed) * 60); k++) {
        s = step(world, s, { c: { ...IDLE, throttle: 0.3 } });
        expect(s.players.c!.car.y, `${speed} m/s`).toBeCloseTo(6, 3);
      }
      expect(dodgeExtOf(s), `${speed} m/s`).toMatchObject({ contacts: 0, overrides: 0, dives: 0 });
    }
  });

  it("the override's leap up a flight of steps stands on the step it reached, never inside one (stairs)", () => {
    const RISE = 0.18;
    const TREAD = 0.28;
    const buildings = [rect("wall", -30, 2.2, 30, 12, 10)];
    for (let k = 1; k <= 16; k++) buildings.push(rect(`step${k}`, -30, -TREAD * k, 30, -TREAD * (k - 1), RISE * k));
    const world = buildWorld([{ tileId: "t", buildings, ground: null }]);
    let leaps = 0;
    for (const speed of [3, 8, 15, 25]) {
      for (const pz of [0.15, 0.25, 0.35]) {
        let s = createInitialState(world, 1, ["a", "b"], { x: 0, z: 900, heading: 0 });
        s = { ...s, players: { a: { ...s.players.a!, car: { ...makeCar(-1.0, 0.95, Math.PI / 2, 0), speed } }, b: { ...s.players.b!, mode: "foot", car: makeCar(40, 900, 0), foot: makeFoot(0, 0, pz, 0) } } };
        for (let k = 0; k < 120; k++) {
          s = step(world, s, { a: k === 0 ? IDLE : { ...IDLE, brake: 1 } });
          const f = s.players.b!.foot!;
          const feet = f.y - (f.dodge?.hop ?? 0);
          if (f.dodge?.leap && f.dodge.t === 0) {
            leaps++;
            // Standing on the surface there, as a walker with those feet would.
            expect(feet).toBeCloseTo(surfaceHeight(world, f.x, f.z, feet), 9);
          }
          // Never inside a step: no building whose top is more than a step above the feet holds them.
          expect(circleBlockedBand(world, f.x, f.z, 0.001, feet + ROOF_STEP_M, feet + FOOT.height), `${speed} m/s, z ${pz}, tick ${s.tick}`).toBe(false);
        }
      }
    }
    expect(leaps).toBeGreaterThan(5);
  });
});

describe("their own car", () => {
  it("a player on foot beside their parked car dives round it, never into it, when another car passes at 25 m/s (R9)", () => {
    for (const wallGap of [0.2, 0.6]) {
      for (const pass of [0.2, 0.5]) {
        const world = buildWorld([{ tileId: "w", buildings: [rect("wall", 0, -300, 30, 300)], ground: null }]);
        const ox = -(wallGap + CAR.halfWidth);
        const wx = ox - CAR.halfWidth - 0.1 - FOOT.radius;
        const cx = wx - FOOT.radius - pass - CAR.halfWidth;
        let s = createInitialState(world, 1, ["a", "c"], { x: -10, z: 60, heading: 0 });
        s = { ...s, players: { a: { ...s.players.a!, mode: "foot", car: makeCar(ox, 0, 0), foot: makeFoot(wx, 0, 0.5, 0) }, c: { ...s.players.c!, car: { ...makeCar(cx, 60, 0), speed: 25 } } } };
        let deepest = -Infinity;
        for (let k = 0; k < 200; k++) {
          s = step(world, s, { c: { ...IDLE, throttle: 1 } });
          deepest = Math.max(deepest, ownDepth(s, "a"));
          expect(inside(s)).toEqual([]);
        }
        const label = `own car ${wallGap} m off the wall, car passing ${pass} m off`;
        expect(deepest, label).toBeLessThanOrEqual(0);
        expect(dodgeExtOf(s).contacts, label).toBe(0);
      }
    }
  });
});
