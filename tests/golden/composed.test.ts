// The composed-path golden: step() through createGameSystems(), the registry the game, the
// headless drivers and the relay run. The physics goldens (tests/sim/replay.test.ts,
// tests/sim/wave2-interface.test.ts) pass [] and pin core movement only; this pins clock,
// agents runtime, identities, services and the follower, combat, the player reducers, heat and
// missions on top. Re-record with `node scripts/golden/composed.ts --update` only for a
// deliberate behaviour change, and say so in the commit.
import { describe, expect, it } from "vitest";
import { SIM_VERSION } from "../../src/sim/index.ts";
import { COMPOSED_SCENARIOS, runComposedScenario } from "../helpers/composed-golden.ts";
import golden from "./composed-v25-swipe-spin.json";
import v24 from "./composed-v24-brake-drift.json";
import v23 from "./composed-v23-late-dodge.json";
import v22 from "./composed-v22-steal-car.json";
import v21 from "./composed-v21-amber-commit.json";
import v20 from "./composed-v20-traffic-signals.json";
import v19 from "./composed-v19-reference-driving.json";
import v18 from "./composed-v18-solid-vehicles.json";
import v17 from "./composed-v17-robot-encounters.json";
import v16 from "./composed-v16-robotaxi-takeover.json";

describe("composed-path golden replays", () => {
  it("is pinned for this SIM_VERSION and every scenario", () => {
    expect(golden.simVersion).toBe(SIM_VERSION);
    expect(Object.keys(golden.scenarios).sort()).toEqual(COMPOSED_SCENARIOS.map(s => s.name).sort());
  });
  for (const scenario of COMPOSED_SCENARIOS) {
    for (const previous of [v16, v17, v18, v19, v20, v21, v22, v23, v24]) {
      it(`preserves the recorded v${previous.simVersion} ${scenario.name} replay`, () => {
        const pinned = (previous.scenarios as Record<string, { hashes: string[]; coverage: Record<string, number> }>)[scenario.name]!;
        const run = runComposedScenario(scenario, previous.simVersion);
        expect(run.coverage).toEqual(pinned.coverage);
        expect(run.hashes).toEqual(pinned.hashes);
      }, 120_000);
    }
    it(`replays ${scenario.name} to the pinned hashes`, () => {
      const pinned = (golden.scenarios as Record<string, { hashes: string[]; coverage: Record<string, number> }>)[scenario.name]!;
      const run = runComposedScenario(scenario);
      expect(run.coverage).toEqual(pinned.coverage);
      expect(run.hashes).toEqual(pinned.hashes);
    }, 120_000);
  }
});
