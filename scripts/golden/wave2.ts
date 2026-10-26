// The current core-only replay of the unchanged historical wave-1 input log.
// node scripts/golden/wave2.ts --update
// Preserve old branch pins: v15/v16 filenames were already used before this combined release.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SIM_VERSION, hashState, step, upgradeState, type InputFrame, type SimState } from "../../src/sim/index.ts";
import { loadDevWorldWithRoads } from "../../tests/sim/fixtures.ts";
import baseline from "../../tests/golden/wave1-v2.json" with { type: "json" };

const { world } = loadDevWorldWithRoads();
let state = upgradeState(baseline.initial as unknown as SimState);
const hashes: string[] = [];
for (const segment of baseline.segments) {
  for (let tick = 0; tick < segment.ticks; tick++) state = step(world, state, segment.inputs as InputFrame, [], []);
  hashes.push(hashState(state));
}
const file = join(import.meta.dirname, "../../tests/golden/wave2-v15-civilian-pace.json");
const text = JSON.stringify({ sourceInput: "wave1-v2.json", sourcePhysics: "Combined v15: civilian passing traffic and jog/sprint 3.5/8 m/s; previous release 4cb909caafd357b6f1198aced58ae95aca2719de", simVersion: SIM_VERSION, hashes }, null, 2) + "\n";
if (process.argv.includes("--update")) writeFileSync(file, text);
else if (readFileSync(file, "utf8") !== text) throw new Error("current core replay pins changed");
console.log(file);
