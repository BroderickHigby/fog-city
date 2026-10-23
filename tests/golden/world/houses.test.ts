// World-continuity gate, per PR: suite "houses" (docs/qa/world-continuity-gate.md). Measured on the
// sf world as the game boots it, judged against tests/golden/world-qa-baseline.json (the ratchet).
import { gameWorld } from "../../helpers/world.ts";
import { measureHouses } from "../../helpers/world-gate/houses.ts";
import { gateSuite } from "../../helpers/world-gate/suite.ts";

gateSuite("houses", "pr", () => measureHouses(gameWorld()));
