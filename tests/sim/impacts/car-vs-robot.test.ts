// Car vs robot (impacts.ts): a player's car bowls robots over instead of stopping against them;
// they tumble, lie there and get up; a tumbling robot bowls over the robots it meets and stops
// dead at anyone's clearance; a robot that is seizing, slumping or a heap stays solid; knocking
// over a good robot costs $30 and 3 reputation through the economy, a bad one nothing.
import { describe, expect, it } from "vitest";
import {
  AGENTS_EXT_KEY,
  PERSON_CLEAR_M,
  ROBOT,
  createGameSystems,
  rammedRobotFacts,
  createInitialState,
  dodgeExtOf,
  impactsOf,
  makeCar,
  step,
  type AgentState,
  type AgentsExt,
  type InputFrame,
  type SimInput,
  type SimState,
  type SimSystem,
  type SimSystemContext,
  type World,
} from "../../../src/sim/index.ts";
import { LONG_RUN_MS, gridCity } from "../fixtures.ts";

const I = (throttle: number, steer = 0, brake = 0): SimInput => ({ throttle, steer, brake, actions: 0 });

function agents(s: Readonly<SimState>): AgentState[] {
  return (s.ext[AGENTS_EXT_KEY] as AgentsExt | undefined)?.list ?? [];
}

function withAgents(s: SimState, list: AgentState[]): SimState {
  const ext = s.ext[AGENTS_EXT_KEY] as AgentsExt;
  return { ...s, ext: { ...s.ext, [AGENTS_EXT_KEY]: { ...ext, list } } };
}

/**
 * Grid city, player "p" driving north up street x = 200 at `speed` from z = 250, and the first
 * spawned errand robot (and any `extra` bodies) put on the road ahead of it at z = 220. The rest
 * of the population is cleared so nothing else is in the way.
 */
function scene(world: World, speed: number, extra: (robot: AgentState) => AgentState[] = () => []): { s: SimState; robot: AgentState } {
  const s0 = createInitialState(world, 11, ["p"], { x: 200, z: 250, heading: 0 });
  const found = agents(s0).find((a) => a.kind === "errandRobot")!;
  expect(found).toBeDefined();
  const robot: AgentState = { ...found, x: 200, z: 220, heading: Math.PI / 2, speed: 0, dwell: 3600, mode: "dwell" };
  const car = { ...makeCar(200, 250, 0), speed };
  return { s: withAgents({ ...s0, players: { p: { ...s0.players.p!, car } } }, [robot, ...extra(robot)]), robot };
}

function run(world: World, s: SimState, ticks: number, input: (t: number, s: SimState) => InputFrame, systems?: readonly SimSystem[]): SimState[] {
  const out: SimState[] = [s];
  let cur = s;
  for (let t = 0; t < ticks; t++) {
    cur = systems ? step(world, cur, input(t, cur), [], systems) : step(world, cur, input(t, cur));
    out.push(cur);
  }
  return out;
}

const robotOf = (s: SimState, id: number): AgentState | undefined => agents(s).find((a) => a.id === id);

describe("a player's car hits a robot", () => {
  const world = gridCity();

  it("bowls it over (it does not dive away), barely slowing; it tumbles, lies there and gets up", () => {
    const { s, robot } = scene(world, 15);
    const states = run(world, s, 900, (t, cur) => ({ p: (impactsOf(cur)?.events.length ?? 0) > 0 ? I(0, 0, 1) : I(0.3) }));
    const hitAt = states.findIndex((x) => (impactsOf(x)?.events.length ?? 0) > 0);
    expect(hitAt).toBeGreaterThan(0);
    // It did not dive out of the way first.
    for (const x of states.slice(0, hitAt)) expect(robotOf(x, robot.id)!.dodge).toBeNull();
    const ev = impactsOf(states[hitAt]!)!.events[0]!;
    expect(ev.kind).toBe("car-robot");
    expect(ev.fell).toBe(true);
    // A 1,400 kg car hardly notices a 90 kg robot.
    const before = states[hitAt - 1]!.players.p!.car.speed;
    const after = states[hitAt]!.players.p!.car.speed;
    expect(after).toBeGreaterThan(before * 0.75);
    // It tumbles off ahead of the car (north), no faster than launchMax, and topples.
    const knocked = robotOf(states[hitAt]!, robot.id)!;
    expect(knocked.knock).toBeDefined();
    const v = Math.hypot(knocked.knock!.vx, knocked.knock!.vz);
    expect(v).toBeLessThanOrEqual(ROBOT.launchMax + 1e-9);
    expect(knocked.knock!.vz).toBeLessThan(-3);
    const phases = states.map((x) => robotOf(x, robot.id)?.knock?.phase ?? "none");
    expect(phases).toContain("down");
    expect(phases).toContain("getup");
    const lying = states[phases.indexOf("down") + 10]!;
    expect(Math.abs(robotOf(lying, robot.id)!.pitch)).toBeCloseTo(ROBOT.fallen, 5);
    // Back on its feet and on its way.
    const end = robotOf(states[states.length - 1]!, robot.id)!;
    expect(end.knock).toBeUndefined();
    expect(end.pitch).toBe(0);
    expect(end.dents).toBeDefined();
  }, LONG_RUN_MS);

  it("a tumbling robot bowls over the robot it meets", () => {
    const { s, robot } = scene(world, 18, (r) => [{ ...r, id: r.id + 1000, x: r.x + 1.4, z: r.z - 2.6 }]);
    const states = run(world, s, 120, (t, cur) => ({ p: (impactsOf(cur)?.events.length ?? 0) > 0 ? I(0, 0, 1) : I(0.3) }));
    const kinds = new Set(states.flatMap((x) => impactsOf(x)?.events.map((e) => e.kind) ?? []));
    expect(kinds.has("car-robot")).toBe(true);
    expect(kinds.has("robot-robot")).toBe(true);
    expect(robotOf(states[states.length - 1]!, robot.id + 1000)!.knock).toBeDefined();
  });

  it("a tumbling robot stops dead at a person's clearance", () => {
    const { s, robot } = scene(world, 20, (r) => [{ ...r, id: r.id + 2000, kind: "person", z: r.z - 4, x: r.x }]);
    let minGap = Infinity;
    const states = run(world, s, 200, (t, cur) => ({ p: (impactsOf(cur)?.events.length ?? 0) > 0 ? I(0, 0, 1) : I(0.3) }));
    for (const x of states) {
      const r = robotOf(x, robot.id)!;
      const p = robotOf(x, robot.id + 2000);
      if (!r.knock || !p) continue;
      minGap = Math.min(minGap, Math.hypot(r.x - p.x, r.z - p.z) - (r.radius ?? 0.45) - 0.3);
    }
    expect(minGap).toBeGreaterThan(PERSON_CLEAR_M - 0.11);
    expect(dodgeExtOf(states[states.length - 1]!).contacts).toBe(0);
  });

  it("a robot that is a heap stays solid: the car stops against it and it is not knocked", () => {
    const { s, robot } = scene(world, 8);
    const combat = { version: 1, tick: 0, rng: s.rng, nextId: 1, players: {}, projectiles: [], gadgets: [], attacks: [], attackSequence: {}, events: [], pauseUntil: 0,
      targets: { [`agent:${robot.id}`]: { rust: 1, phase: "heap", phaseTick: 0, lastWaterTick: 0, heightScale: 0.4, puddle: true, repair: false, penalized: false, wetHits: [], wetUntil: 0, blindUntil: 0, waryUntil: 0, alerted: false, pullOverTick: 0, pullOverSpeed: 0, stoppedUntil: 0, flowersUntil: 0, slowUntil: 0, distractedUntil: 0, sourceId: "", movementScale: 1, windupScale: 1 } } };
    const states = run(world, { ...s, ext: { ...s.ext, combat } } as SimState, 120, () => ({ p: I(0.3) }));
    const end = states[states.length - 1]!;
    expect(robotOf(end, robot.id)!.knock).toBeUndefined();
    expect(impactsOf(end)?.events.length ?? 0).toBe(0);
    expect(end.players.p!.car.z).toBeGreaterThan(220);
  });
});

describe("consequences in the composed game", () => {
  const world = gridCity();
  it("knocking over a good robot costs $30 and 3 reputation", () => {
    const systems = createGameSystems({ wave: 2, protectedArea: () => false });
    // (A first tick lets the systems initialise their state.)
    const { s, robot } = scene(world, 0);
    let cur = step(world, s, { p: I(0) }, [], systems);
    cur = { ...cur, players: { p: { ...cur.players.p!, car: { ...cur.players.p!.car, speed: 14 } } } };
    const wallet0 = (cur.ext.economy as { players: Record<string, { cashCents: number; reputation: number }> }).players.p!;
    // Steer at it as a player would (it walks its errand).
    const states = run(world, cur, 240, (t, x) => {
      if ((impactsOf(x)?.events.length ?? 0) > 0) return { p: I(0, 0, 1) };
      const c = x.players.p!.car;
      const r = robotOf(x, robot.id)!;
      let off = Math.atan2(r.x - c.x, -(r.z - c.z)) - c.heading;
      while (off > Math.PI) off -= 2 * Math.PI;
      while (off < -Math.PI) off += 2 * Math.PI;
      return { p: I(0.3, Math.max(-1, Math.min(1, off * 4))) };
    }, systems);
    const hit = impactsOf(states[states.length - 1]!)!.events.find((e) => e.b === `a:${robot.id}`)!;
    expect(hit.fell).toBe(true);
    const wallet = (states[states.length - 1]!.ext.economy as { players: Record<string, { cashCents: number; reputation: number }> }).players.p!;
    expect(wallet0.cashCents - wallet.cashCents).toBe(3000);
    expect(wallet0.reputation - wallet.reputation).toBe(3);
  }, LONG_RUN_MS);
});

describe("rammedRobotFacts", () => {
  const base = (fell: boolean, firmware: "good" | "bad", kind: "car-robot" | "taxi-robot" = "car-robot") => {
    const state = { tick: 9, ext: { agents: { nextId: 8, list: [{ id: 7 }] }, impacts: { version: 1, nextId: 2, cars: {}, events: [{ id: 1, tick: 9, kind, a: kind === "car-robot" ? "p:p" : "a:3", b: "a:7", x: 0, y: 0, z: 0, speed: 9, dv: 8, fell }] } } } as unknown as SimState;
    return rammedRobotFacts({ state } as unknown as SimSystemContext, () => [{ id: "agent:7", kind: "robot", firmware, x: 0, y: 0, z: 0, radius: 0.45, height: 1.8, heading: 0, speed: 0 }]);
  };
  it("a good robot knocked over by a player's car is a penalty; a bad one, a nudge or a robotaxi's knock are not", () => {
    expect(base(true, "good")).toEqual([{ id: "world:ram-1", source: "world", sequence: 1, tick: 9, kind: "economy.penalty", playerId: "p", actorId: "agent:7", amount: 30, detail: "reputation:-3 rammed" }]);
    expect(base(true, "bad")).toEqual([]);
    expect(base(false, "good")).toEqual([]);
    expect(base(true, "good", "taxi-robot")).toEqual([]);
  });
});

it("robots fall the way they are pushed", () => {
  const world = gridCity();
  const { s, robot } = scene(world, 12);
  // Facing east (heading pi/2), pushed north: sideways. Then turn it to face north: pushed from behind, it falls forward.
  const facing = withAgents(s, [{ ...robot, heading: 0 }]);
  const states = run(world, facing, 240, () => ({ p: I(0.3) }));
  const k = states.map((x) => robotOf(x, robot.id)!.knock).find((x) => x !== undefined)!;
  expect(k.fall).toBe(-ROBOT.fallen);
});
