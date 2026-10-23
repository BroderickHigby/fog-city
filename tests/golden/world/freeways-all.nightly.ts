// World-continuity gate, nightly: suite "freeways-all" (docs/qa/world-continuity-gate.md). Run with
// `pnpm world:nightly` (one worker); judged against tests/golden/world-qa-baseline.json.
import { gameWorld } from "../../helpers/world.ts";
import { measureFreewaysAll } from "../../helpers/world-gate/nightly.ts";
import { gateSuite } from "../../helpers/world-gate/suite.ts";

gateSuite("freeways-all", "nightly", () => measureFreewaysAll(gameWorld()), 3_600_000);
