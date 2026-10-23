// World-continuity gate, per PR: suite "determinism" (docs/qa/world-continuity-gate.md). The suite
// builds its own worlds one at a time (the pack world as the game boots it, then the world from the
// per-tile JSON colliders), judged against tests/golden/world-qa-baseline.json (the ratchet).
import { measureDeterminism } from "../../helpers/world-gate/nightly.ts";
import { gateSuite } from "../../helpers/world-gate/suite.ts";

gateSuite("determinism", "pr", () => measureDeterminism("sf"));
