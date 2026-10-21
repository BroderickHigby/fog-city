// The no-touch fuzz (docs/design.md, "Vehicles never hurt people"; the owner's Crazy Taxi rule):
// seeded scenes (tests/sim/dodge-scenes.ts) in which cars at up to 38 m/s are aimed at people,
// who must get out of the way every time: a single person, a group of 20 (with children and
// robots in it), players on foot, people backed against a wall or into a corner, people on
// hills; drivers straight at them, chasing them, weaving, drifting and handbrake turns. Every
// tick of every scene: zero contacts, and every person, child and player on foot at least
// CLEARANCE_M from every moving car's body except in an episode the clearance override handled
// (counted and reported). Deterministic: a scene replays to the same state.
import { describe, expect, it } from "vitest";
import { CLEARANCE_M, makeScene, run } from "./dodge-scenes.ts";
import { LONG_RUN_MS } from "./fixtures.ts";

const SEEDS = 160;

describe("the no-touch fuzz: cars at up to 38 m/s aimed at people", () => {
  it(
    `${SEEDS} seeded scenes (people alone, in groups of 20 with children and robots, players on foot, against walls, in corners, on hills; straight, chasing, weaving, drifting and handbrake drivers): zero contacts, clearance >= ${CLEARANCE_M} m except in counted override episodes`,
    () => {
      const unexplained: string[] = [];
      let contacts = 0;
      let overrides = 0;
      let dives = 0;
      let robotHits = 0;
      let minClear = Infinity;
      let minChild = Infinity;
      const kinds = new Set<string>();
      for (let seed = 1; seed <= SEEDS; seed++) {
        const sc = makeScene(seed);
        kinds.add(sc.name.split(" ").slice(1, 4).join(" "));
        const r = run(sc);
        unexplained.push(...r.unexplained);
        contacts += r.contacts;
        overrides += r.overrides;
        dives += r.dives;
        robotHits += r.robotHits;
        minClear = Math.min(minClear, r.minClear);
        minChild = Math.min(minChild, r.minChild);
      }
      // What the run covered, and how often the override had to act (printed for the report).
      console.info(`[dodge fuzz] ${SEEDS} scenes, ${kinds.size} kinds: ${dives} dives, ${overrides} overrides, ${robotHits} robot bumps, min clearance ${minClear.toFixed(3)} m (children ${minChild.toFixed(3)} m)`);
      expect(contacts).toBe(0);
      expect(unexplained.slice(0, 10)).toEqual([]);
      expect(dives).toBeGreaterThan(SEEDS);
      expect(kinds.size).toBeGreaterThan(40);
      // The override is the backstop, not the way people get clear.
      expect(overrides).toBeLessThan(dives * 0.05);
    },
    LONG_RUN_MS,
  );

  it("a scene replays to the same state", () => {
    for (const seed of [3, 17, 42]) {
      expect(run(makeScene(seed)).hash).toBe(run(makeScene(seed)).hash);
    }
  }, LONG_RUN_MS);
});
