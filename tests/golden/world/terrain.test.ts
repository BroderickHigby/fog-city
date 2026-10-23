// World-continuity gate, per PR: suite "terrain" (docs/qa/world-continuity-gate.md). Measured on the
// sf world as the game boots it, judged against tests/golden/world-qa-baseline.json (the ratchet).
import { gameWorld } from "../../helpers/world.ts";
import { measureTerrain } from "../../helpers/world-gate/terrain.ts";
import { gateSuite } from "../../helpers/world-gate/suite.ts";

gateSuite("terrain", "pr", () => measureTerrain(gameWorld()));
