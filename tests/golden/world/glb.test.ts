// World-continuity gate, per PR: suite "glb" (docs/qa/world-continuity-gate.md, sections A and C):
// every tile GLB decoded and compared with the colliders and the sim (all 583 tiles, about 30 s and
// under 1 GB: rule 5's "changed tiles only" is not needed). Judged against
// tests/golden/world-qa-baseline.json (the ratchet).
import { gameWorld } from "../../helpers/world.ts";
import { measureGlb } from "../../helpers/world-gate/glb.ts";
import { gateSuite } from "../../helpers/world-gate/suite.ts";

gateSuite("glb", "pr", () => measureGlb(gameWorld()), 600_000);
