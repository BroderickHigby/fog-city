// SIM_VERSION 3 (qa/sim): the walker's vertical state (FootState.vy, FootState.grounded), the
// ground on the mesh's triangles, roofs as surfaces and capped pushes. Saves from v1 and v2 load
// through upgradeState; a recorded input log replays to the same state every time, through a
// JSON round trip mid-run; and the v3 replay is pinned, so a later change to what the sim does
// with the same inputs shows up here (and needs the next SIM_VERSION).
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
import { loadDevWorldWithRoads, LONG_RUN_MS } from "./fixtures.ts";

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

describe("SIM_VERSION 3", () => {
  it("is 3", () => {
    expect(SIM_VERSION).toBe(3);
  });

  it("upgradeState lifts a v2 walker to v3: standing (grounded, vy 0) where it was saved", () => {
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
    expect(v3.version).toBe(3);
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
    expect(() => upgradeState({ ...v3, version: 4 })).toThrow();
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
    "the v3 replay is pinned (a change here needs the next SIM_VERSION)",
    () => {
      expect(replay(1500).hashes).toEqual(PINNED_V3);
    },
    LONG_RUN_MS,
  );
});

/** hashState every 300 ticks of the replay above, recorded at SIM_VERSION 3. */
const PINNED_V3: string[] = ["55218e00", "36d2fc7b", "1e44fb27", "c8eb268f", "020ec0c2"];
