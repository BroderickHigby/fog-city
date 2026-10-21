// World-continuity gate, nightly: suite "glb" (docs/qa/world-continuity-gate.md). Run with
// `pnpm world:nightly` (one worker); judged against tests/golden/world-qa-baseline.json.
import { gameWorld } from "../../helpers/world.ts";
import { measureGlb } from "../../helpers/world-gate/glb.ts";
import { gateSuite } from "../../helpers/world-gate/suite.ts";

gateSuite("glb", "nightly", () => measureGlb(gameWorld()), 3_600_000);
