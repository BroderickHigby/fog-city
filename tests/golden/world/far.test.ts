// World-continuity gate, per PR: suite "far" (docs/qa/world-continuity-gate.md, section B): the
// far layer's GLBs decoded and compared with the near world (the ring seam, far coverage, the far
// hulls; about 5 s). Judged against tests/golden/world-qa-baseline.json (the ratchet).
import { gameWorld } from "../../helpers/world.ts";
import { measureFar } from "../../helpers/world-gate/far.ts";
import { gateSuite } from "../../helpers/world-gate/suite.ts";

gateSuite("far", "pr", () => measureFar(gameWorld()), 600_000);
