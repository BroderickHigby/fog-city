// Runway Run (src/sim/runway-run): the rules, the inert default, replay, and the invented names.
// The rule tests step the real core (step()) with only the runway system registered, so movement
// and impacts are the real ones and nothing else (traffic, combat) can interfere. Cars are put
// where the test needs them by editing the plain-JSON state.
import { describe, expect, it } from "vitest";
import {
  Action, SIM_VERSION, canonicalJson, createGameSystems, createInitialState, step,
  type InputFrame, type SimEvent, type SimState,
} from "../../src/sim/index.ts";
import {
  RUNWAY_CLEAR_EVENT, RUNWAY_QUIT_EVENT, RUNWAY_RULES, RUNWAY_START_EVENT, STAGES, addHype, addedTicks, checkDollars, createRunwaySystem,
  decayHype, networkAt, parTicks, pickPoint, runwayOf, speedFactor, stageFor, type RunwayRun,
} from "../../src/sim/runway-run/index.ts";
import { RUNWAY_INVESTORS } from "../../src/content/runwayInvestors.ts";
import { lintText } from "../../src/content/lint.ts";
import { worldExists, loadWorld } from "../helpers.ts";
import { gridCity } from "./fixtures.ts";

const world = gridCity();
const SYS = [createRunwaySystem()];
const idle = { throttle: 0, steer: 0, brake: 0, actions: 0 };
const IDLE: InputFrame = { p: idle };
const start = (tick: number): SimEvent => ({ tick, kind: RUNWAY_START_EVENT, playerId: "p" });

function fresh(seed = 7): SimState {
  return createInitialState(world, seed, ["p"], { x: 0, z: 0, heading: 0 });
}
function tick(s: SimState, n = 1, events: (t: number) => SimEvent[] = () => [], w = world): SimState {
  for (let i = 0; i < n; i++) s = step(w, s, IDLE, events(s.tick + 1), SYS);
  return s;
}
function begin(seed = 7): SimState {
  return tick(fresh(seed), 1, (t) => [start(t)]);
}
const run = (s: SimState): RunwayRun => runwayOf(s)!.runs.p!;
/** Edit the player's car (plain JSON, a new state). */
function put(s: SimState, car: Partial<SimState["players"][string]["car"]>): SimState {
  return { ...s, players: { p: { ...s.players.p!, car: { ...s.players.p!.car, ...car } } } };
}
/** Edit the run. */
function edit(s: SimState, patch: Partial<RunwayRun>): SimState {
  return { ...s, ext: { ...s.ext, runway: { version: 1, runs: { p: { ...run(s), ...patch } } } } };
}
/** Park the car on the run's target, stopped, and hold there `n` ticks. */
function stopAt(s: SimState, n: number): SimState {
  const t = run(s).target!;
  return tick(put(s, { x: t.x, z: t.z, speed: 0 }), n);
}
const PICK = RUNWAY_RULES.stopHoldTicks;

describe("Runway Run is inert unless a run was started", () => {
  it("returns the very same state object and adds no ext key", () => {
    const s = fresh();
    const out = createRunwaySystem().step({ world, previous: s, state: s, inputs: IDLE, events: [] });
    expect(out).toBe(s);
    expect("runway" in out.ext).toBe(false);
  });
  it("stays out of the composed game's state across a hundred ticks", () => {
    const systems = createGameSystems({ wave: 2, protectedArea: () => false });
    let s = fresh();
    for (let i = 0; i < 100; i++) s = step(world, s, IDLE, [], systems);
    expect("runway" in s.ext).toBe(false);
    expect(s.version).toBe(SIM_VERSION);
    expect(SIM_VERSION).toBe(26);
  });
  it("ignores a start from a player who is not at the wheel", () => {
    const s = fresh();
    const walker = { ...s, players: { p: { ...s.players.p!, mode: "foot" as const, foot: { x: 0, y: 0, z: 0, heading: 0, speed: 0, sprint: false, vy: 0, grounded: true, dodge: null } } } };
    expect(runwayOf(tick(walker, 1, (t) => [start(t)]))).toBeUndefined();
    const passenger = { ...s, players: { p: { ...s.players.p!, ride: { agentId: 1, x: 0, y: 0, z: 0, heading: 0, speed: 0, goal: null, exitPending: false } } } };
    expect(runwayOf(tick(passenger, 1, (t) => [start(t)]))).toBeUndefined();
  });
  it("starts for a driver of a stolen car (a manual ride)", () => {
    const s = fresh();
    const thief = { ...s, players: { p: { ...s.players.p!, ride: { agentId: 1, manual: true as const, x: 0, y: 0, z: 0, heading: 0, speed: 0, goal: null, exitPending: false } } } };
    expect(runwayOf(tick(thief, 1, (t) => [start(t)]))?.runs.p?.phase).toBe("running");
  });
});

describe("starting a run", () => {
  it("opens with 90 s of runway, hype 1x, and an investor waiting on a street", () => {
    const s = begin();
    expect(run(s)).toMatchObject({ phase: "running", runwayTicks: RUNWAY_RULES.startS * 60, raised: 0, closed: 0, hype: 1, carrying: false });
    expect(run(s).target).not.toBeNull();
    expect(RUNWAY_INVESTORS[run(s).investor]).toBeDefined();
  });
  it("counts down one tick at a time and eases nothing below 1x hype", () => {
    const s = tick(begin(), 10);
    expect(run(s).runwayTicks).toBe(RUNWAY_RULES.startS * 60 - 10);
    expect(run(s).hype).toBe(1);
  });
  it("is started by a recorded event, so the same inputs rebuild the same run", () => {
    const a = tick(begin(), 300), b = tick(begin(), 300);
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(begin(7))).not.toBe(canonicalJson(begin(8)));
  });
  it("quit ends the run and keeps the results; clear removes it and the ext key", () => {
    let s = tick(begin(), 5);
    s = tick(s, 1, (t) => [{ tick: t, kind: RUNWAY_QUIT_EVENT, playerId: "p" }]);
    expect(run(s)).toMatchObject({ phase: "over", target: null, carrying: false });
    const frozen = tick(s, 3);
    expect(runwayOf(frozen)).toEqual(runwayOf(s));
    s = tick(s, 1, (t) => [{ tick: t, kind: RUNWAY_CLEAR_EVENT, playerId: "p" }]);
    expect("runway" in s.ext).toBe(false);
  });
  it("play again: a start after a finished run begins a fresh one", () => {
    let s = tick(begin(), 1, (t) => [{ tick: t, kind: RUNWAY_QUIT_EVENT, playerId: "p" }]);
    s = tick(s, 1, (t) => [start(t)]);
    expect(run(s)).toMatchObject({ phase: "running", raised: 0, closed: 0 });
  });
});

describe("pickup: close, slow, and still for half a second", () => {
  it("takes the investor after 30 ticks inside 8 m under 2 m/s", () => {
    const s = begin();
    expect(run(stopAt(s, PICK - 1)).carrying).toBe(false);
    const got = stopAt(s, PICK);
    expect(run(got)).toMatchObject({ carrying: true, downRounds: 0 });
    expect(run(got).pickedAt).toEqual(run(s).target);
    expect(run(got).notes.at(-1)).toMatchObject({ kind: "pickup" });
  });
  it("needs to be slower than 2 m/s", () => {
    const s = begin(), t = run(s).target!;
    let x = put(s, { x: t.x, z: t.z, speed: 2.5 });
    // (Tick with no throttle: the car sheds speed, so hold the speed each tick.)
    for (let i = 0; i < PICK + 5; i++) x = put(tick(x), { x: t.x, z: t.z, speed: 2.5 });
    expect(run(x).carrying).toBe(false);
  });
  it("needs to be within 8 m", () => {
    const s = begin(), t = run(s).target!;
    const out = tick(put(s, { x: t.x + 9, z: t.z, speed: 0 }), PICK + 5);
    expect(run(out).carrying).toBe(false);
    const inn = tick(put(s, { x: t.x + 7.5, z: t.z, speed: 0 }), PICK);
    expect(run(inn).carrying).toBe(true);
  });
  it("starts counting again after moving off", () => {
    const s = begin(), t = run(s).target!;
    let x = stopAt(s, PICK - 5);
    x = tick(put(x, { x: t.x + 20, z: t.z, speed: 0 }));
    expect(run(x).hold).toBe(0);
    x = tick(put(x, { x: t.x, z: t.z, speed: 0 }), PICK - 1);
    expect(run(x).carrying).toBe(false);
  });
  it("does nothing for a player on foot", () => {
    const s = begin(), t = run(s).target!;
    const walker = put(s, { x: t.x, z: t.z });
    const on = { ...walker, players: { p: { ...walker.players.p!, mode: "foot" as const, foot: { x: t.x, y: 0, z: t.z, heading: 0, speed: 0, sprint: false, vy: 0, grounded: true, dodge: null } } } };
    expect(run(tick(on, PICK + 10)).carrying).toBe(false);
  });
  it("puts the demo 300-1200 m from the pickup", () => {
    const got = stopAt(begin(), PICK), d = run(got);
    const m = Math.hypot(d.target!.x - d.pickedAt!.x, d.target!.z - d.pickedAt!.z);
    // (The 300 m grid is smaller than the ring; the ring widens, so only the lower bound is loose.)
    expect(m).toBeGreaterThan(40);
    expect(m).toBeLessThanOrEqual(1200 * 1.6 ** 3);
  });
});

describe("money", () => {
  it("a check is about $250k per 300 m of straight-line distance", () => {
    expect(checkDollars(300, 0, 1, 0)).toBe(250_000);
    expect(checkDollars(600, 0, 1, 0)).toBe(500_000);
    expect(checkDollars(1200, 0, 1, 0)).toBe(1_000_000);
  });
  it("beating par raises the check up to 2x and adds up to 15 s more runway", () => {
    const d = 600, par = parTicks(d);
    expect(par).toBe(3000);
    expect(speedFactor(d, par)).toBe(0);
    expect(speedFactor(d, par + 600)).toBe(0);
    expect(speedFactor(d, par * 0.75)).toBeCloseTo(0.5, 6);
    expect(speedFactor(d, par * 0.5)).toBe(1);
    expect(speedFactor(d, 1)).toBe(1);
    expect(checkDollars(d, 0.5, 1, 0)).toBe(750_000);
    expect(checkDollars(d, 1, 1, 0)).toBe(1_000_000);
    // 10 s, plus the trip's par time (600 m at 12 m/s: 50 s), plus up to 15 s for speed.
    expect(addedTicks(d, 0)).toBe(60 * 60);
    expect(addedTicks(d, 1)).toBe(75 * 60);
    expect(addedTicks(300, 0)).toBe(35 * 60);
  });
  it("hype multiplies the check and a down round cuts it 20% each time", () => {
    expect(checkDollars(300, 0, 2, 0)).toBe(500_000);
    expect(checkDollars(300, 0, 1, 1)).toBe(200_000);
    expect(checkDollars(300, 0, 1, 2)).toBe(160_000);
    expect(checkDollars(300, 1, 3, 1)).toBe(1_200_000);
  });
  it("hype is capped at 3x and eases back to 1x, never below", () => {
    expect(addHype(1, 1)).toBeCloseTo(1.1, 9);
    expect(addHype(2.95, 5)).toBe(3);
    let h = 3;
    for (let i = 0; i < 60 * 10; i++) h = decayHype(h);
    expect(h).toBeCloseTo(3 - 0.2, 6);
    for (let i = 0; i < 60 * 200; i++) h = decayHype(h);
    expect(h).toBe(1);
  });
  it("stage titles follow total raised", () => {
    expect(STAGES.map((s) => s.title)).toEqual(["Unicorn", "Series C", "Series B", "Series A", "Seed", "Pre-seed"]);
    const table: Array<[number, string]> = [[0, "Pre-seed"], [999_999, "Pre-seed"], [1_000_000, "Seed"], [4_999_999, "Seed"], [5_000_000, "Series A"],
      [19_999_999, "Series A"], [20_000_000, "Series B"], [99_999_999, "Series B"], [100_000_000, "Series C"], [999_999_999, "Series C"], [1_000_000_000, "Unicorn"]];
    for (const [raised, title] of table) expect(stageFor(raised), String(raised)).toBe(title);
  });
});

describe("closing a round", () => {
  /** A trip set up to finish: the investor aboard at (0, 0), the demo `d` m east, and a trip that will have taken `trip` ticks when the car has held still long enough. */
  function demo(d: number, trip: number, patch: Partial<RunwayRun> = {}): SimState {
    const s = begin();
    return edit(s, { carrying: true, pickedAt: { x: 0, z: 0 }, target: { x: d, z: 0 }, tripStart: s.tick + PICK - trip, ...patch });
  }
  it("pays the check, adds the runway, and sends a new investor", () => {
    const d = 600, s = demo(d, parTicks(d));
    const before = run(s).runwayTicks;
    const r = run(stopAt(s, PICK));
    // On par: no speed bonus, so $500k and 10 s + 50 s of par time.
    expect(r).toMatchObject({ closed: 1, raised: 500_000, best: 500_000, carrying: false });
    expect(r.runwayTicks).toBe(before - PICK + addedTicks(d, 0));
    expect(r.notes.at(-1)).toMatchObject({ kind: "check", amount: 500_000, seconds: 60 });
    expect(r.target).not.toEqual({ x: d, z: 0 });
  });
  it("a fast trip pays up to double and adds 15 s more", () => {
    const out = stopAt(demo(600, 10), PICK);
    expect(run(out).raised).toBe(1_000_000);
    expect(run(out).notes.at(-1)).toMatchObject({ kind: "check", seconds: 75 });
  });
  it("a trip a quarter faster than par pays 1.5x", () => {
    expect(run(stopAt(demo(600, parTicks(600) * 0.75), PICK)).raised).toBe(750_000);
  });
  it("uses the hype at the drop", () => {
    // (Hype eases 0.02x a second while the car holds still for the half second, so just under 2x.)
    const raised = run(stopAt(demo(600, parTicks(600), { hype: 2 }), PICK)).raised;
    expect(raised).toBe(checkDollars(600, 0, 2 - 0.02 * 0.5, 0));
    expect(raised).toBeGreaterThan(985_000);
    expect(raised).toBeLessThan(1_000_000);
  });
  it("cuts the check 20% for each down round on the trip", () => {
    expect(run(stopAt(demo(300, parTicks(300), { downRounds: 2 }), PICK)).raised).toBe(160_000);
  });
  it("a second check raises the total and keeps the best", () => {
    const r = run(stopAt(demo(300, parTicks(300), { raised: 750_000, closed: 1, best: 750_000 }), PICK));
    expect(r).toMatchObject({ closed: 2, raised: 1_000_000, best: 750_000 });
    expect(stageFor(r.raised)).toBe("Seed");
  });
});

describe("hype, down rounds and scandals", () => {
  const carrying = (): SimState => edit(stopAt(begin(), PICK), { hype: 1 });
  it("a near miss while carrying adds 0.1x; one while empty-handed adds nothing", () => {
    const empty = begin();
    expect(run(tick(put(empty, { nearMisses: 5 }))).hype).toBe(1);
    const s = carrying();
    expect(run(tick(put(s, { nearMisses: s.players.p!.car.nearMisses + 3 }))).hype).toBeCloseTo(1.3, 9);
  });
  it("hype stops at 3x", () => {
    const s = carrying();
    expect(run(tick(put(s, { nearMisses: s.players.p!.car.nearMisses + 50 }))).hype).toBe(3);
  });
  const hit = (s: SimState, id: number, dv: number, a = "p:p", b = "a:9", kind = "car-car"): SimState => ({
    ...s, ext: { ...s.ext, impacts: { version: 1, nextId: id + 1, cars: {}, events: [{ id, tick: s.tick, kind, a, b, x: 0, y: 0, z: 0, speed: dv, dv }] } } as SimState["ext"],
  });
  it("a hard crash while carrying is a down round: hype back to 1x, the check cut 20%", () => {
    let s = edit(carrying(), { hype: 2.5 });
    s = tick(hit(s, 1, 6));
    expect(run(s)).toMatchObject({ downRounds: 1, hype: 1 });
    expect(run(s).notes.at(-1)).toMatchObject({ kind: "downRound" });
  });
  it("counts a crash where the player's car is b, not a", () => {
    expect(run(tick(hit(carrying(), 1, 6, "a:9", "p:p"))).downRounds).toBe(1);
  });
  it("ignores gentle bumps, other people's crashes, robots, and crashes with nobody aboard", () => {
    expect(run(tick(hit(carrying(), 1, 3.9))).downRounds).toBe(0);
    expect(run(tick(hit(carrying(), 1, 9, "a:3", "a:4"))).downRounds).toBe(0);
    expect(run(tick(hit(carrying(), 1, 9, "p:p", "a:4", "car-robot"))).downRounds).toBe(0);
    expect(run(tick(hit(begin(), 1, 9))).downRounds).toBe(0);
  });
  it("a hit on the parked car while the player is on foot is not a down round", () => {
    const s = carrying();
    const parked = { ...s, players: { p: { ...s.players.p!, mode: "foot" as const } } } as SimState;
    expect(run(tick(hit(parked, 1, 9, "a:9", "p:p"))).downRounds).toBe(0);
  });
  it("counts one crash once, and a crash 1 s later again", () => {
    let s = tick(hit(carrying(), 1, 6));
    s = tick(s, 5);
    expect(run(s).downRounds).toBe(1);
    s = tick(hit(s, 2, 6));
    expect(run(s).downRounds).toBe(1);
    s = tick(s, 40);
    s = tick(hit(s, 3, 6));
    expect(run(s).downRounds).toBe(2);
  });
  it("hitting a person while carrying: the investor leaves, no check, minus 5 s", () => {
    const s = carrying(), before = run(s).runwayTicks;
    const out = tick(put(s, { personBumps: s.players.p!.car.personBumps + 1 }));
    expect(run(out)).toMatchObject({ carrying: false, raised: 0, closed: 0, pickedAt: null });
    expect(run(out).runwayTicks).toBe(before - 1 - 5 * 60);
    expect(run(out).notes.at(-1)).toMatchObject({ kind: "scandal", seconds: -5 });
    expect(run(out).target).not.toBeNull();
  });
  it("a person hit with nobody aboard costs nothing", () => {
    const s = begin(), before = run(s).runwayTicks;
    expect(run(tick(put(s, { personBumps: 3 }))).runwayTicks).toBe(before - 1);
  });
});

describe("running out of runway", () => {
  it("ends the run: results kept, no target, the company is shut down", () => {
    let s = edit(begin(), { runwayTicks: 3, raised: 6_200_000, closed: 4, best: 2_000_000 });
    s = tick(s, 3);
    expect(run(s)).toMatchObject({ phase: "over", runwayTicks: 0, target: null, carrying: false, raised: 6_200_000, closed: 4, best: 2_000_000 });
    expect(run(s).endTick).toBe(s.tick);
    expect(run(s).notes.at(-1)).toMatchObject({ kind: "over" });
    expect(stageFor(run(s).raised)).toBe("Series A");
  });
  it("is quiet afterwards: the same state comes back each tick", () => {
    const s = tick(edit(begin(), { runwayTicks: 1 }), 1);
    expect(run(s).phase).toBe("over");
    const next = createRunwaySystem().step({ world, previous: s, state: { ...s, tick: s.tick + 1 }, inputs: IDLE, events: [] });
    expect(runwayOf(next)).toBe(runwayOf(s));
  });
  it("a check on the last tick still lands (the countdown does not eat it)", () => {
    const s = edit(begin(), { carrying: true, pickedAt: { x: 0, z: 0 }, target: { x: 300, z: 0 }, tripStart: 1 + PICK - parTicks(300), runwayTicks: PICK + 1 });
    const out = stopAt(s, PICK);
    expect(run(out)).toMatchObject({ phase: "running", raised: 250_000 });
  });
  it("leaving the car does not pause the clock", () => {
    const s = begin();
    const walker = { ...s, players: { p: { ...s.players.p!, mode: "foot" as const, foot: { x: 0, y: 0, z: 0, heading: 0, speed: 0, sprint: false, vy: 0, grounded: true, dodge: null } } } };
    expect(run(tick(walker, 100)).runwayTicks).toBe(RUNWAY_RULES.startS * 60 - 100);
  });
  it("is deterministic across a whole run with the same inputs", () => {
    const go = (): SimState => {
      let s = begin(11);
      for (let i = 0; i < 400; i++) s = step(world, s, { p: { ...idle, throttle: i % 90 < 60 ? 1 : 0, steer: (i % 140) < 20 ? 0.6 : 0, actions: i === 200 ? Action.horn : 0 } }, [], SYS);
      return s;
    };
    expect(canonicalJson(go())).toBe(canonicalJson(go()));
  });
});

describe("the invented investors", () => {
  it("has about twenty, all different", () => {
    expect(RUNWAY_INVESTORS.length).toBeGreaterThanOrEqual(20);
    expect(new Set(RUNWAY_INVESTORS.map((i) => i.name)).size).toBe(RUNWAY_INVESTORS.length);
    expect(new Set(RUNWAY_INVESTORS.map((i) => i.firm)).size).toBe(RUNWAY_INVESTORS.length);
  });
  it("passes the content lint (real firms, real people, accelerator names) and says no 'YC'", () => {
    for (const i of RUNWAY_INVESTORS) {
      for (const text of [i.name, i.firm, `${i.name} from ${i.firm} is in`]) expect(lintText(text), text).toEqual([]);
      expect(`${i.name} ${i.firm}`).not.toMatch(/\bYC\b|combinator/i);
    }
  });
});

const sf = worldExists("sf");
describe.skipIf(!sf)("targets on the real SF street grid", () => {
  const { world: sfWorld } = sf ? loadWorld("sf", { roads: true }) : { world: world };
  it("places investors 150-500 m away and demos 300-1200 m from the pickup, on one connected network", () => {
    const graph = sfWorld.roads!;
    let rng: [number, number, number, number] = [1, 2, 3, 4];
    // Origins on real streets all over the city: every 400th usable edge's middle.
    const origins = graph.edges.filter((e) => e.drivable && e.center.len > 40).filter((_, i) => i % 400 === 0)
      .map((e) => ({ x: e.center.xs[Math.floor(e.center.xs.length / 2)]!, z: e.center.zs[Math.floor(e.center.zs.length / 2)]! }));
    expect(origins.length).toBeGreaterThan(10);
    for (const from of origins) {
      const net = networkAt(graph, from.x, from.z);
      expect(net).toBeGreaterThanOrEqual(0);
      for (let i = 0; i < 4; i++) {
        const a = pickPoint(graph, from, RUNWAY_RULES.pickupMinM, RUNWAY_RULES.pickupMaxM, net, rng)!;
        const m = Math.hypot(a.point.x - from.x, a.point.z - from.z);
        expect(m, `pickup ${i} from ${from.x},${from.z}`).toBeGreaterThanOrEqual(RUNWAY_RULES.pickupMinM);
        expect(m).toBeLessThanOrEqual(RUNWAY_RULES.pickupMaxM);
        const b = pickPoint(graph, a.point, RUNWAY_RULES.dropMinM, RUNWAY_RULES.dropMaxM, net, a.rng)!;
        const n = Math.hypot(b.point.x - a.point.x, b.point.z - a.point.z);
        expect(n).toBeGreaterThanOrEqual(RUNWAY_RULES.dropMinM);
        expect(n).toBeLessThanOrEqual(RUNWAY_RULES.dropMaxM);
        expect(networkAt(graph, b.point.x, b.point.z)).toBe(net);
        rng = b.rng;
      }
    }
  }, 120_000);
  it("starts a full run through step() on SF", () => {
    const spawn = { x: 0, z: 0, heading: 0 };
    let s = createInitialState(sfWorld, 3, ["p"], spawn);
    s = step(sfWorld, s, IDLE, [start(1)], SYS);
    const r = run(s);
    expect(r.phase).toBe("running");
    expect(Math.hypot(r.target!.x - s.players.p!.car.x, r.target!.z - s.players.p!.car.z)).toBeGreaterThanOrEqual(RUNWAY_RULES.pickupMinM);
  }, 120_000);
});
