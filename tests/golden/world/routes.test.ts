// World-continuity gate, per PR: suite "routes" (docs/qa/world-continuity-gate.md). Measured on the
// sf world as the game boots it, judged against tests/golden/world-qa-baseline.json (the ratchet).
import { gameWorld } from "../../helpers/world.ts";
import { measureRoutes } from "../../helpers/world-gate/play.ts";
import { gateSuite } from "../../helpers/world-gate/suite.ts";

gateSuite("routes", "pr", () => measureRoutes(gameWorld()));
