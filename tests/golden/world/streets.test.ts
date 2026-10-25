// World-continuity gate, per PR: suite "streets" (docs/qa/world-continuity-gate.md). Measured on the
// sf world as the game boots it, judged against tests/golden/world-qa-baseline.json (the ratchet).
import { gameWorld } from "../../helpers/world.ts";
import { measureStreets } from "../../helpers/world-gate/streets.ts";
import { gateSuite } from "../../helpers/world-gate/suite.ts";

gateSuite("streets", "pr", () => measureStreets(gameWorld()));
