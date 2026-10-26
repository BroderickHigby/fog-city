// Record or check the current composed-path golden: the checkpoint hashes
// of each scenario in tests/helpers/composed-golden.ts, stepped through createGameSystems().
//
//   node scripts/golden/composed.ts            run every scenario and compare with the pins
//   node scripts/golden/composed.ts --update   re-record the pins (say why in the commit)
//
// A pin should change only with a deliberate behaviour change on the composed path; bump
// SIM_VERSION for deliberate behavior changes too; old saves still need an explicit upgrade.
// Named release pins preserve earlier branches that already wrote overlapping v15/v16 stamps.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recordComposedGolden, type ComposedGolden } from "../../tests/helpers/composed-golden.ts";

const file = join(import.meta.dirname, "../../tests/golden/composed-v17-robot-encounters.json");
const golden = recordComposedGolden();
const text = JSON.stringify(golden, null, 2) + "\n";
if (process.argv.includes("--update")) {
  writeFileSync(file, text);
  console.log(`written: ${file}`);
} else {
  const pinned = JSON.parse(readFileSync(file, "utf8")) as ComposedGolden;
  let same = pinned.simVersion === golden.simVersion;
  for (const name of Object.keys(golden.scenarios).sort()) {
    const now = golden.scenarios[name]!.hashes.join(" "), then = pinned.scenarios[name]?.hashes.join(" ");
    console.log(`${name}: ${now === then ? "matches" : `CHANGED\n  pinned ${then}\n  now    ${now}`}`);
    same &&= now === then;
  }
  process.exit(same ? 0 : 1);
}
