// The composed-path golden: step() through createGameSystems(), the registry the game, the
// headless drivers and the relay run. The physics goldens (tests/sim/replay.test.ts,
// tests/sim/wave2-interface.test.ts) pass [] and pin core movement only; this pins clock,
// agents runtime, identities, services and the follower, combat, the player reducers, heat and
// missions on top. Re-record with `node scripts/golden/composed.ts --update` only for a
// deliberate behaviour change, and say so in the commit.
import { describe, expect, it } from "vitest";
import { SIM_VERSION } from "../../src/sim/index.ts";
import { COMPOSED_SCENARIOS, runComposedScenario } from "../helpers/composed-golden.ts";
import golden from "./composed-v16.json";

describe("composed-path golden replays", () => {
  it("is pinned for this SIM_VERSION and every scenario", () => {
    expect(golden.simVersion).toBe(SIM_VERSION);
    expect(Object.keys(golden.scenarios).sort()).toEqual(COMPOSED_SCENARIOS.map(s => s.name).sort());
  });
  for (const scenario of COMPOSED_SCENARIOS) {
    it(`replays ${scenario.name} to the pinned hashes`, () => {
      const pinned = (golden.scenarios as Record<string, { hashes: string[]; coverage: Record<string, number> }>)[scenario.name]!;
      const run = runComposedScenario(scenario);
      expect(run.coverage).toEqual(pinned.coverage);
      expect(run.hashes).toEqual(pinned.hashes);
    }, 120_000);
  }
});
