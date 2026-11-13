// Finds the optimized Lombard timing for the evening and morning peaks and writes
// src/planner/plans.json. Deterministic: the same inputs give the same file.
//   node scripts/planner/optimize-lombard.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCorridor } from "../../src/planner/corridor.ts";
import { lombardDemand, type Period } from "../../src/planner/demand.ts";
import { optimizePlan } from "../../src/planner/optimize.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string): unknown => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const corridor = buildCorridor(read("public/tiles/sf/roads.json") as never, read("public/tiles/sf/signals.json") as never);
const out: Record<string, unknown> = {
  $comment: "Written by scripts/planner/optimize-lombard.ts. Optimized fixed-time plans for US-101 on Lombard St (signals east to west).",
};
for (const period of ["pm", "am"] as Period[]) {
  const demand = lombardDemand(corridor, period, 1);
  const t0 = performance.now();
  const r = optimizePlan(corridor, demand, { progress: (n) => console.log(period, n) });
  console.log(period, `done: ${r.evaluations} runs, ${((performance.now() - t0) / 1000).toFixed(0)} s, score ${r.score.toFixed(1)}`);
  out[period] = { cycleS: r.plan.cycleS, mainGreenS: r.plan.mainGreenS, offsetS: r.plan.offsetS, signals: corridor.signals.map((s) => s.street) };
}
writeFileSync(join(ROOT, "src/planner/plans.json"), JSON.stringify(out, null, 2) + "\n");
console.log("wrote src/planner/plans.json");
