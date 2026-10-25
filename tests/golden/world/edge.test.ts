// World-continuity gate, per PR: suite "edge" (docs/qa/world-continuity-gate.md). Measured on the
// sf world as the game boots it, judged against tests/golden/world-qa-baseline.json (the ratchet).
import { gameWorld } from "../../helpers/world.ts";
import { measureEdge } from "../../helpers/world-gate/edge.ts";
import { gateSuite } from "../../helpers/world-gate/suite.ts";

gateSuite("edge", "pr", () => measureEdge(gameWorld()));
