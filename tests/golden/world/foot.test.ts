// World-continuity gate, per PR: suite "foot" (docs/qa/world-continuity-gate.md). Measured on the
// sf world as the game boots it, judged against tests/golden/world-qa-baseline.json (the ratchet).
import { gameWorld } from "../../helpers/world.ts";
import { measureFoot } from "../../helpers/world-gate/play.ts";
import { gateSuite } from "../../helpers/world-gate/suite.ts";

gateSuite("foot", "pr", () => measureFoot(gameWorld()));
