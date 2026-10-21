// World-continuity gate, per PR: suite "determinism" (docs/qa/world-continuity-gate.md). Measured on the
// sf world as the game boots it, judged against tests/golden/world-qa-baseline.json (the ratchet).
import { gameWorld } from "../../helpers/world.ts";
import { measureDeterminism } from "../../helpers/world-gate/nightly.ts";
import { gateSuite } from "../../helpers/world-gate/suite.ts";

gateSuite("determinism", "pr", () => measureDeterminism(gameWorld()));
