// World-continuity gate, per PR: suite "cover" (docs/qa/world-continuity-gate.md). Measured on the
// sf world as the game boots it, judged against tests/golden/world-qa-baseline.json (the ratchet).
import { gameWorld } from "../../helpers/world.ts";
import { measureCover } from "../../helpers/world-gate/cover.ts";
import { gateSuite } from "../../helpers/world-gate/suite.ts";

gateSuite("cover", "pr", () => measureCover(gameWorld()));
