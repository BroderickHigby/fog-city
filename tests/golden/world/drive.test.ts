// World-continuity gate, per PR: suite "drive" (docs/qa/world-continuity-gate.md). Measured on the
// sf world as the game boots it, judged against tests/golden/world-qa-baseline.json (the ratchet).
import { gameWorld } from "../../helpers/world.ts";
import { measureDrive } from "../../helpers/world-gate/play.ts";
import { gateSuite } from "../../helpers/world-gate/suite.ts";

gateSuite("drive", "pr", () => measureDrive(gameWorld()));
