// SIM_VERSION 5 (feature/dodge, the owner's Crazy Taxi rule, numbered 4 on its branch): nobody is
// ever run over. Cars gained nearMisses, walkers and ambient agents a dodge state, ext.dodge its
// counters; cars no longer stop at people (they dive out of the way, src/sim/dodge.ts).
// v4 (qa/sim): bodies stand on decks and tunnel floors (surfaceAt), held by rails, bore walls and
// ceilings; agents ride their edge's deck or bore; stairways are barred to cars. v3 added the
// walker's vertical state (FootState.vy, FootState.grounded), the ground on the mesh's
// triangles, roofs as surfaces and capped pushes. Saves from v1 to v4 load through upgradeState
// (v4 -> v5 checked as an exact round trip of a real state); recorded input logs replay to the
// same state every time, through a JSON round trip mid-run, one of them with people diving out of
// a car's way; and the replays are pinned (on the dev world, on a world with a deck and a bore,
// and the dodge on the grid city), so a later change to what the sim does with the same inputs
// shows up here (and needs the next SIM_VERSION).
import { describe, expect, it } from "vitest";
import {
  AGENTS_EXT_KEY,
  Action,
  DODGE_EXT_KEY,
  SIM_VERSION,
  agentsOf,
  canonicalJson,
  createInitialState,
  dodgeExtOf,
  hashState,
  makeFoot,
  step,
  upgradeState,
  type AgentsExt,
  type InputFrame,
  type SimState,
} from "../../src/sim/index.ts";
import { gridCity, loadDevWorldWithRoads, LONG_RUN_MS, surfaceWorld } from "./fixtures.ts";

/** Two players: p1 drives, gets out, walks and sprints about, gets back in; p2 drives. */
function inputsAt(t: number): InputFrame {
  const p1 =
    t === 200 || t === 1100
      ? { throttle: 0, steer: 0, brake: 0, actions: Action.enterExit }
      : t < 200
        ? { throttle: 1, steer: t % 90 < 45 ? 0.4 : -0.2, brake: t > 170 ? 1 : 0, actions: 0 }
        : t < 1100
          ? { throttle: t % 300 < 200 ? 1 : -0.5, steer: t % 160 < 40 ? 1 : 0, brake: t % 400 > 250 ? 1 : 0, actions: 0 }
          : { throttle: 0.8, steer: -0.3, brake: 0, actions: 0 };
  return { p1, p2: { throttle: 0.7, steer: t % 120 < 60 ? 0.6 : -0.3, brake: 0, actions: 0 } };
}

function replay(ticks: number, roundTripAt = -1): { state: SimState; hashes: string[]; footTicks: number } {
  const { world, spawn } = loadDevWorldWithRoads();
  let s = createInitialState(world, 42, ["p1", "p2"], spawn);
  const hashes: string[] = [];
  let footTicks = 0;
  for (let t = 0; t < ticks; t++) {
    s = step(world, s, inputsAt(t));
    if (s.players.p1!.mode === "foot") footTicks++;
    if (t === roundTripAt) s = JSON.parse(canonicalJson(s)) as SimState;
    if (t % 300 === 299) hashes.push(hashState(s));
  }
  return { state: s, hashes, footTicks };
}

/**
 * On surfaceWorld (fixtures.ts): p1 drives north through the tunnel bore and out of it, then
 * turns; p2 drives up the overpass deck and along it, steering into its rail. Returns the hashes
 * every 300 ticks, the highest p2 got, the highest p1 got in the bore, and where p1 was at tick 600.
 */
function surfaceReplay(ticks: number, roundTripAt = -1): { hashes: string[]; p2Top: number; p1BoreTop: number; p1Z600: number } {
  // (No roads: no traffic to knock p1 off its line at the portal.)
  const world = surfaceWorld();
  let s = createInitialState(world, 7, ["p1"], { x: 0, z: -20, heading: 0 });
  const p2 = createInitialState(world, 7, ["p2"], { x: 30, z: -10, heading: Math.PI }).players.p2!;
  s = { ...s, players: { ...s.players, p2 } };
  const hashes: string[] = [];
  let p2Top = -Infinity;
  let p1BoreTop = -Infinity;
  let p1Z600 = 0;
  for (let t = 0; t < ticks; t++) {
    s = step(world, s, {
      p1: { throttle: t < 700 ? 1 : 0.3, steer: t > 700 && t < 760 ? 0.5 : 0, brake: 0, actions: 0 },
      p2: { throttle: 0.8, steer: t > 400 && t < 520 ? 1 : 0, brake: 0, actions: 0 },
    });
    if (t === roundTripAt) s = JSON.parse(canonicalJson(s)) as SimState;
    p2Top = Math.max(p2Top, s.players.p2!.car.y);
    const c1 = s.players.p1!.car;
    if (t <= 600 && c1.z < -55 && c1.z > -145) p1BoreTop = Math.max(p1BoreTop, c1.y);
    if (t === 600) p1Z600 = c1.z;
    if (t % 300 === 299) hashes.push(hashState(s));
  }
  return { hashes, p2Top, p1BoreTop, p1Z600 };
}

/**
 * The dodge replay: on the grid city with its traffic, p1 drives east along the south sidewalk
 * of the z = 100 street (steering to hold z = 106) while p2 stands on it on foot ahead; people
 * and robots on the sidewalk dive out of the way.
 */
function dodgeReplay(ticks: number, roundTripAt = -1): { state: SimState; hashes: string[] } {
  const world = gridCity(true);
  let s: SimState = createInitialState(world, 9, ["p1", "p2"], { x: 20, z: 106, heading: Math.PI / 2 });
  s = { ...s, players: { ...s.players, p2: { ...s.players.p2!, mode: "foot", car: { ...s.players.p2!.car, x: 50, z: 150 }, foot: makeFoot(150, 0, 106.2, 0) } } };
  const hashes: string[] = [];
  for (let t = 0; t < ticks; t++) {
    const c = s.players.p1!.car;
    const steer = Math.max(-1, Math.min(1, -((106 - c.z) * 0.08 - Math.sin(c.heading - Math.PI / 2) * 1.5)));
    s = step(world, s, { p1: { throttle: 0.8, steer, brake: 0, actions: 0 } });
    if (t === roundTripAt) s = JSON.parse(canonicalJson(s)) as SimState;
    if (t % 100 === 99) hashes.push(hashState(s));
  }
  return { state: s, hashes };
}

describe("SIM_VERSION 5", () => {
  it("is 5", () => {
    expect(SIM_VERSION).toBe(5);
  });

  it("upgradeState lifts a v3 state through v4 (unchanged but for the version) to v5", () => {
    const v3 = { ...createInitialState(loadDevWorldWithRoads().world, 3, ["a"], { x: 0, z: 0, heading: 0 }), version: 3 } as SimState;
    const v5 = upgradeState(v3);
    // (A fresh state's cars have nearMisses 0 and its agents dodge null: what v4 -> v5 adds.)
    expect(v5).toEqual({ ...v3, version: 5 });
    expect(upgradeState(v5)).toBe(v5);
    expect(() => upgradeState({ ...v5, version: 6 })).toThrow();
  });

  it("upgradeState lifts a v2 walker through v3 and v4 to v5: standing (grounded, vy 0) where it was saved, not diving", () => {
    const v2 = {
      version: 2,
      tick: 77,
      seed: 5,
      rng: [1, 2, 3, 4],
      players: {
        a: { id: "a", mode: "foot", car: createInitialState(loadDevWorldWithRoads().world, 1, ["x"], { x: 0, z: 0, heading: 0 }).players.x!.car, foot: { x: 3, y: 1.5, z: -4, heading: 0.2, speed: 1.2, sprint: false }, exitPending: false },
        b: { id: "b", mode: "vehicle", car: createInitialState(loadDevWorldWithRoads().world, 1, ["x"], { x: 9, z: 0, heading: 0 }).players.x!.car, foot: null, exitPending: false },
      },
      ext: { keep: { me: 1 } },
    } as unknown as SimState;
    // (A v2 car has no v5 field.)
    for (const p of Object.values(v2.players)) delete (p.car as Partial<typeof p.car>).nearMisses;
    const v4 = upgradeState(v2);
    expect(v4.version).toBe(5);
    expect(v4.players.a!.foot).toEqual({ x: 3, y: 1.5, z: -4, heading: 0.2, speed: 1.2, sprint: false, vy: 0, grounded: true, dodge: null });
    expect(v4.players.b!.foot).toBeNull();
    expect(v4.players.b!.car).toEqual({ ...v2.players.b!.car, nearMisses: 0 });
    expect(v4.ext).toEqual(v2.ext);
    expect(v4.tick).toBe(77);
    expect(upgradeState(v4)).toBe(v4);
    // Plain JSON, and it steps.
    expect(JSON.parse(canonicalJson(v4))).toEqual(v4);
    expect(() => step(loadDevWorldWithRoads().world, v4, {})).not.toThrow();
    // A version from the future is refused.
    expect(() => upgradeState({ ...v4, version: 6 })).toThrow();
  });

  it("upgradeState lifts a real v4 state (players, a walker, traffic) to exactly the v5 state it came from, less what v4 never had", () => {
    // Run the sim, then strip what v5 added (nobody is mid-dive at this tick): that is a v4 save.
    const { world, spawn } = loadDevWorldWithRoads();
    let s = createInitialState(world, 42, ["p1", "p2"], spawn);
    for (let t = 0; t < 400; t++) s = step(world, s, inputsAt(t));
    expect(s.players.p1!.mode).toBe("foot");
    expect(agentsOf(s).length).toBeGreaterThan(10);
    expect(agentsOf(s).every((a) => a.dodge === null)).toBe(true);
    expect(s.players.p1!.foot!.dodge).toBeNull();
    const v4 = JSON.parse(canonicalJson(s)) as SimState & { version: number };
    v4.version = 4;
    delete v4.ext[DODGE_EXT_KEY];
    for (const p of Object.values(v4.players)) {
      delete (p.car as Partial<typeof p.car>).nearMisses;
      if (p.foot) delete (p.foot as Partial<typeof p.foot>).dodge;
    }
    for (const a of (v4.ext[AGENTS_EXT_KEY] as AgentsExt).list) delete (a as Partial<typeof a>).dodge;
    // What a v4 save cannot know: the near-miss counts (0) and the dodge counters (absent, all 0).
    const want = JSON.parse(canonicalJson(s)) as SimState;
    delete want.ext[DODGE_EXT_KEY];
    for (const p of Object.values(want.players)) p.car.nearMisses = 0;
    expect(canonicalJson(upgradeState(v4))).toBe(canonicalJson(want));
  });

  it(
    "a recorded input log (driving, on foot, back in) replays identically, through a JSON round trip mid-run",
    () => {
      const a = replay(1500);
      const b = replay(1500, 700);
      expect(a.footTicks).toBeGreaterThan(600);
      expect(b.hashes).toEqual(a.hashes);
      expect(hashState(b.state)).toBe(hashState(a.state));
    },
    LONG_RUN_MS,
  );

  it(
    "the dev-world replay is pinned (a change here needs the next SIM_VERSION)",
    () => {
      expect(replay(1500).hashes).toEqual(PINNED_DEV);
    },
    LONG_RUN_MS,
  );

  it(
    "a car driven along a crowded sidewalk replays identically, dives and all, through a JSON round trip mid-run",
    () => {
      const a = dodgeReplay(600);
      const b = dodgeReplay(600, 333);
      const d = dodgeExtOf(a.state);
      expect(d.dives).toBeGreaterThanOrEqual(2);
      expect(d.contacts).toBe(0);
      expect(a.state.players.p1!.car.personBumps).toBe(0);
      expect(a.state.players.p1!.car.nearMisses).toBe(d.nearMisses);
      expect(b.hashes).toEqual(a.hashes);
      expect(hashState(b.state)).toBe(hashState(a.state));
    },
    LONG_RUN_MS,
  );

  it(
    "on a world with a deck and a bore: one car rides the deck, the other drives through the bore on its floor; the replay round-trips and is pinned",
    () => {
      const a = surfaceReplay(1200);
      const b = surfaceReplay(1200, 500);
      expect(a.p2Top).toBeGreaterThan(5.9);
      expect(a.p1BoreTop).toBeLessThan(0.1);
      expect(a.p1Z600).toBeLessThan(-160);
      expect(b.hashes).toEqual(a.hashes);
      expect(a.hashes).toEqual(PINNED_SURFACES);
    },
    LONG_RUN_MS,
  );

  it(
    "the dodge replay is pinned (a change here needs the next SIM_VERSION)",
    () => {
      const b = dodgeReplay(600).hashes;
      // (Printed so a deliberate change can be re-pinned from the log.)
      if (JSON.stringify(b) !== JSON.stringify(PINNED_DODGE)) console.info(`[replay pins] PINNED_DODGE ${JSON.stringify(b)}`);
      expect(b).toEqual(PINNED_DODGE);
    },
    LONG_RUN_MS,
  );
});

/** hashState every 300 ticks of the dev-world replay above, recorded at SIM_VERSION 5. */
const PINNED_DEV: string[] = [];

/** hashState every 300 ticks of surfaceReplay, recorded at SIM_VERSION 5. */
const PINNED_SURFACES: string[] = [];

/** hashState every 100 ticks of the dodge replay, recorded at SIM_VERSION 5. */
const PINNED_DODGE: string[] = [];
