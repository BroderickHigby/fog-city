// World-continuity gate, nightly: suite "paths-all" (docs/qa/world-continuity-gate.md). Run with
// `pnpm world:nightly` (one worker); judged against tests/golden/world-qa-baseline.json.
import { gameWorld } from "../../helpers/world.ts";
import { measurePathsAll } from "../../helpers/world-gate/nightly.ts";
import { gateSuite } from "../../helpers/world-gate/suite.ts";

gateSuite("paths-all", "nightly", () => measurePathsAll(gameWorld()), 3_600_000);
