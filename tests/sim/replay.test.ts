// SIM_VERSION 4 (qa/sim): bodies stand on decks and tunnel floors (surfaceAt), held by rails,
// bore walls and ceilings; agents ride their edge's deck or bore; stairways are barred to cars.
// v3 added the walker's vertical state (FootState.vy, FootState.grounded), the ground on the
// mesh's triangles, roofs as surfaces and capped pushes. Saves from v1, v2 and v3 load through
// upgradeState; a recorded input log replays to the same state every time, through a JSON round
// trip mid-run; and the replays are pinned (on the dev world, and on a world with a deck and a
// bore), so a later change to what the sim does with the same inputs shows up here (and needs
// the next SIM_VERSION).
import { describe, expect, it } from "vitest";
import {
  Action,
  SIM_VERSION,
  canonicalJson,
  createInitialState,
  hashState,
  step,
  upgradeState,
  type InputFrame,
  type SimState,
} from "../../src/sim/index.ts";
import { loadDevWorldWithRoads, LONG_RUN_MS, surfaceWorld } from "./fixtures.ts";

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

describe("SIM_VERSION 4", () => {
  it("is 4", () => {
    expect(SIM_VERSION).toBe(4);
  });

  it("upgradeState lifts a v3 state to v4 unchanged but for the version", () => {
    const v3 = { ...createInitialState(loadDevWorldWithRoads().world, 3, ["a"], { x: 0, z: 0, heading: 0 }), version: 3 } as SimState;
    const v4 = upgradeState(v3);
    expect(v4).toEqual({ ...v3, version: 4 });
    expect(upgradeState(v4)).toBe(v4);
    expect(() => upgradeState({ ...v4, version: 5 })).toThrow();
  });

  it("upgradeState lifts a v2 walker to v4: standing (grounded, vy 0) where it was saved", () => {
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
    const v3 = upgradeState(v2);
    expect(v3.version).toBe(4);
    expect(v3.players.a!.foot).toEqual({ x: 3, y: 1.5, z: -4, heading: 0.2, speed: 1.2, sprint: false, vy: 0, grounded: true });
    expect(v3.players.b!.foot).toBeNull();
    expect(v3.players.b!.car).toEqual(v2.players.b!.car);
    expect(v3.ext).toEqual(v2.ext);
    expect(v3.tick).toBe(77);
    expect(upgradeState(v3)).toBe(v3);
    // Plain JSON, and it steps.
    expect(JSON.parse(canonicalJson(v3))).toEqual(v3);
    expect(() => step(loadDevWorldWithRoads().world, v3, {})).not.toThrow();
    // A version from the future is refused.
    expect(() => upgradeState({ ...v3, version: 5 })).toThrow();
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
    "on a world with a deck and a bore: one car rides the deck, the other drives through the bore on its floor; the replay round-trips and is pinned",
    () => {
      const a = surfaceReplay(1200);
      const b = surfaceReplay(1200, 500);
      expect(a.p2Top).toBeGreaterThan(5.9);
      expect(a.p1BoreTop).toBeLessThan(0.1);
      expect(a.p1Z600).toBeLessThan(-160);
      expect(b.hashes).toEqual(a.hashes);
      expect(a.hashes).toEqual(PINNED_SURFACES_V4);
    },
    LONG_RUN_MS,
  );
});

/**
 * hashState every 300 ticks of the dev-world replay above, recorded at SIM_VERSION 4 (it moved
 * from v3's f70c31aa... because each wheel now finds the surface at its own height along the
 * body's tilt, sampleGround).
 */
const PINNED_DEV: string[] = ["f7176a9d", "36cf2ae4", "225e4f16", "c8fc6fb0", "0219f9b5"];

/** hashState every 300 ticks of surfaceReplay, recorded at SIM_VERSION 4. */
const PINNED_SURFACES_V4: string[] = ["aa6364da", "89e19bc6", "50a14b31", "e738b8e3"];
