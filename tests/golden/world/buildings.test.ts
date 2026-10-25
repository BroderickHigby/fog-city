// World-continuity gate, per PR: suite "buildings" (docs/qa/world-continuity-gate.md). Measured on the
// sf world as the game boots it, judged against tests/golden/world-qa-baseline.json (the ratchet).
import { gameWorld } from "../../helpers/world.ts";
import { measureBuildings } from "../../helpers/world-gate/buildings.ts";
import { gateSuite } from "../../helpers/world-gate/suite.ts";

gateSuite("buildings", "pr", () => measureBuildings(gameWorld()));
