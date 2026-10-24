// SIM_VERSION 4 (feature/dodge, the owner's Crazy Taxi rule): nobody is ever run over. Cars
// gained nearMisses, walkers and ambient agents a dodge state, ext.dodge its counters; cars no
// longer stop at people (they dive out of the way, src/sim/dodge.ts). Saves from v1, v2 and v3
// load through upgradeState (v3 -> v4 checked as an exact round trip of a real state); recorded
// input logs replay to the same state every time, through a JSON round trip mid-run, one of
// them with people diving out of a car's way; and both v4 replays are pinned, so a later change
// to what the sim does with the same inputs shows up here (and needs the next SIM_VERSION).
// (v3, qa/sim, added the walker's vertical state, the ground on the mesh's triangles, roofs as
// surfaces and capped pushes: the v2 -> v3 lift is still checked below.)
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
import { gridCity, loadDevWorldWithRoads, LONG_RUN_MS } from "./fixtures.ts";

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
    s = step(world, s, inputsAt(t), [], []);
    if (s.players.p1!.mode === "foot") footTicks++;
    if (t === roundTripAt) s = JSON.parse(canonicalJson(s)) as SimState;
    if (t % 300 === 299) hashes.push(hashState({ ...s, version: 4 }));
  }
  return { state: s, hashes, footTicks };
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
    s = step(world, s, { p1: { throttle: 0.8, steer, brake: 0, actions: 0 } }, [], []);
    if (t === roundTripAt) s = JSON.parse(canonicalJson(s)) as SimState;
    if (t % 100 === 99) hashes.push(hashState({ ...s, version: 4 }));
  }
  return { state: s, hashes };
}

describe("legacy SIM_VERSION 4 replays", () => {
  it("runs on the deliberately versioned current contract", () => {
    expect(SIM_VERSION).toBe(12);
  });

  it("upgradeState lifts a v2 walker through v3 to v4: standing (grounded, vy 0) where it was saved, not diving", () => {
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
    // (A v2 car has no v4 field.)
    for (const p of Object.values(v2.players)) delete (p.car as Partial<typeof p.car>).nearMisses;
    const v4 = upgradeState(v2);
    expect(v4.version).toBe(SIM_VERSION);
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
    expect(() => upgradeState({ ...v4, version: SIM_VERSION + 1 })).toThrow();
  });

  it("upgradeState lifts a real v3 state (players, a walker, traffic) to exactly the v4 state it came from, less what v3 never had", () => {
    // Run the sim, then strip what v4 added (nobody is mid-dive at this tick): that is a v3 save.
    const { world, spawn } = loadDevWorldWithRoads();
    let s = createInitialState(world, 42, ["p1", "p2"], spawn);
    for (let t = 0; t < 400; t++) s = step(world, s, inputsAt(t), [], []);
    expect(s.players.p1!.mode).toBe("foot");
    expect(agentsOf(s).length).toBeGreaterThan(10);
    expect(agentsOf(s).every((a) => a.dodge === null)).toBe(true);
    expect(s.players.p1!.foot!.dodge).toBeNull();
    const v3 = JSON.parse(canonicalJson(s)) as SimState & { version: number };
    v3.version = 3;
    delete v3.ext[DODGE_EXT_KEY];
    for (const p of Object.values(v3.players)) {
      delete (p.car as Partial<typeof p.car>).nearMisses;
      if (p.foot) delete (p.foot as Partial<typeof p.foot>).dodge;
    }
    for (const a of (v3.ext[AGENTS_EXT_KEY] as AgentsExt).list) delete (a as Partial<typeof a>).dodge;
    // What a v3 save cannot know: the near-miss counts (0) and the dodge counters (absent, all 0).
    const want = JSON.parse(canonicalJson(s)) as SimState;
    delete want.ext[DODGE_EXT_KEY];
    for (const p of Object.values(want.players)) p.car.nearMisses = 0;
    expect(canonicalJson(upgradeState(v3))).toBe(canonicalJson(want));
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
    "the v4 replays are pinned (a change here needs the next SIM_VERSION)",
    () => {
      const a = replay(1500).hashes;
      const b = dodgeReplay(600).hashes;
      // (Printed so a deliberate change can be re-pinned from the log.)
      if (JSON.stringify(a) !== JSON.stringify(PINNED_V4) || JSON.stringify(b) !== JSON.stringify(PINNED_V4_DODGE)) console.info(`[replay pins] PINNED_V4 ${JSON.stringify(a)} PINNED_V4_DODGE ${JSON.stringify(b)}`);
      expect(a).toEqual(PINNED_V4);
      expect(b).toEqual(PINNED_V4_DODGE);
    },
    LONG_RUN_MS,
  );
});

/**
 * hashState every 300 ticks of the first replay above, recorded at SIM_VERSION 4; re-pinned at
 * v12 (car.ts vehicle dynamics: the same inputs now drive the more realistic car).
 */
const PINNED_V4: string[] = ["31527baa", "721042f9", "45eec0a7", "e7a70216", "70ba036e"];
/** hashState every 100 ticks of the dodge replay, recorded at SIM_VERSION 4; re-pinned at v12 (as above). */
const PINNED_V4_DODGE: string[] = ["64bae003", "d6038e50", "08d9fede", "3e4079e0", "d6f3b93d", "4fa95eeb"];
