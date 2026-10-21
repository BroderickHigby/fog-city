// World-continuity gate, nightly: suite "far" (docs/qa/world-continuity-gate.md). Run with
// `pnpm world:nightly` (one worker); judged against tests/golden/world-qa-baseline.json.
import { gameWorld } from "../../helpers/world.ts";
import { measureFar } from "../../helpers/world-gate/far.ts";
import { gateSuite } from "../../helpers/world-gate/suite.ts";

gateSuite("far", "nightly", () => measureFar(gameWorld()), 3_600_000);
