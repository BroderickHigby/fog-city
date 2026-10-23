// World-continuity gate, nightly: suite "streets-all" (docs/qa/world-continuity-gate.md). Run with
// `pnpm world:nightly` (one worker); judged against tests/golden/world-qa-baseline.json.
import { gameWorld } from "../../helpers/world.ts";
import { measureStreetsAll } from "../../helpers/world-gate/nightly.ts";
import { gateSuite } from "../../helpers/world-gate/suite.ts";

gateSuite("streets-all", "nightly", () => measureStreetsAll(gameWorld()), 3_600_000);
