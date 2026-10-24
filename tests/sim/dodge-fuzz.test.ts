// The no-touch fuzz (docs/design.md, "Vehicles never hurt people"; the owner's Crazy Taxi rule):
// seeded scenes (tests/sim/dodge-scenes.ts) in which cars at up to 38 m/s are aimed at people,
// who must get out of the way every time: a single person, a group of 20 (with children and
// robots in it), players on foot, people backed against a wall or into a corner, people on
// hills; drivers straight at them, chasing them, weaving, drifting and handbrake turns; in some, a
// player parked among them gets out, or a player joins on top of them, as the car comes. Every
// tick of every scene: zero contacts, and every person, child and player on foot at least
// CLEARANCE_M from every moving car's body except in an episode the clearance override handled
// (counted and reported). Deterministic: a scene replays to the same state.
import { describe, expect, it } from "vitest";
import { CLEARANCE_M, makeScene, run } from "./dodge-scenes.ts";
import { LONG_RUN_MS } from "./fixtures.ts";

const SEEDS = 160;
/**
 * Drivers that steer at people (chase, weave), slide or turn into them (drift, handbrake, bank:
 * a slide or hard turn at them from 8-16 m) or drive at random: no human on foot can always out-turn
 * a car with 18 m/s^2 of grip, so the override (drawn as a stumble or shove, no lift) may take
 * up to PURSUIT_SHARE of each one's dodges. A car driven straight never needs it (v11, the dodge
 * stream; docs/design.md decision log 2026-10-23: the old bound, under 5% of all dodges, held only
 * with a 9 m/s superhuman dive).
 */
const PURSUIT = new Set(["chase", "weave", "drift", "handbrake", "bank", "random"]);
const PURSUIT_SHARE = 0.25;

describe("the no-touch fuzz: cars at up to 38 m/s aimed at people", () => {
  it(
    `${SEEDS} seeded scenes (people alone, in groups of 20 with children and robots, players on foot, against walls, in corners, on hills; straight, chasing, weaving, drifting and handbrake drivers; players getting out and joining among them): zero contacts, clearance >= ${CLEARANCE_M} m except in counted override episodes`,
    () => {
      const unexplained: string[] = [];
      let contacts = 0;
      let overrides = 0;
      let dives = 0;
      let robotHits = 0;
      let minClear = Infinity;
      let minChild = Infinity;
      let exits = 0;
      let joins = 0;
      const kinds = new Set<string>();
      const byDriver = new Map<string, { dives: number; overrides: number }>();
      for (let seed = 1; seed <= SEEDS; seed++) {
        const sc = makeScene(seed);
        kinds.add(sc.name.split(" ").slice(1, 4).join(" "));
        const r = run(sc);
        const driver = sc.driver;
        const k = byDriver.get(driver) ?? { dives: 0, overrides: 0 };
        k.dives += r.dives;
        k.overrides += r.overrides;
        byDriver.set(driver, k);
        unexplained.push(...r.unexplained);
        contacts += r.contacts;
        overrides += r.overrides;
        dives += r.dives;
        robotHits += r.robotHits;
        minClear = Math.min(minClear, r.minClear);
        minChild = Math.min(minChild, r.minChild);
        if (r.exited) exits++;
        if (r.joined) joins++;
      }
      // What the run covered, and how often the override had to act (printed for the report).
      console.info(`[dodge fuzz] ${SEEDS} scenes, ${kinds.size} kinds: ${dives} dives, ${overrides} overrides, ${robotHits} robot bumps, ${exits} players got out among them, ${joins} joined on them, min clearance ${minClear.toFixed(3)} m (children ${minChild.toFixed(3)} m)`);
      expect(contacts).toBe(0);
      expect(exits).toBeGreaterThan(SEEDS / 10);
      expect(joins).toBeGreaterThan(SEEDS / 10);
      expect(unexplained.slice(0, 10)).toEqual([]);
      expect(dives).toBeGreaterThan(SEEDS);
      expect(kinds.size).toBeGreaterThan(40);
      // The override is the backstop, not the way people get clear: never for a car driven
      // straight, at most PURSUIT_SHARE of each pursuing driver's dodges.
      console.info(`[dodge fuzz] by driver: ${[...byDriver].map(([d, k]) => `${d} ${k.overrides}/${k.dives}`).join(", ")}`);
      expect([...byDriver.keys()].sort()).toEqual(["bank", "chase", "drift", "handbrake", "random", "straight", "weave"]);
      for (const [driver, k] of byDriver) {
        expect(k.dives, driver).toBeGreaterThan(10);
        if (PURSUIT.has(driver)) expect(k.overrides, `${driver}: ${k.overrides} overrides in ${k.dives} dodges`).toBeLessThanOrEqual(k.dives * PURSUIT_SHARE);
        else expect(k.overrides, `${driver}: overrides`).toBe(0);
      }
    },
    LONG_RUN_MS,
  );

  it("a scene replays to the same state", () => {
    for (const seed of [3, 17, 42]) {
      expect(run(makeScene(seed)).hash).toBe(run(makeScene(seed)).hash);
    }
  }, LONG_RUN_MS);
});
