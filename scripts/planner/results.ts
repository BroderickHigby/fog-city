// Prints the demo's scorecard: every signal plan at every traffic level, averaged over seeds the
// optimizer never saw (2-6), evening and morning peaks.
//   node scripts/planner/results.ts [--json out.json]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCorridor } from "../../src/planner/corridor.ts";
import type { Period } from "../../src/planner/demand.ts";
import { DEMAND_IDS, PLAN_IDS, averageRuns, demandFor, planFor } from "../../src/planner/scenarios.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string): unknown => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const corridor = buildCorridor(read("public/tiles/sf/roads.json") as never, read("public/tiles/sf/signals.json") as never);
const seeds = [2, 3, 4, 5, 6];
const rows: Record<string, unknown>[] = [];
for (const period of ["pm", "am"] as Period[]) {
  for (const did of DEMAND_IDS) {
    const d = demandFor(corridor, did, period);
    console.log(`\n${period.toUpperCase()} · ${d.label}`);
    const base = averageRuns(corridor, d, planFor(corridor, "today", period, d), seeds);
    for (const pid of PLAN_IDS) {
      const m = pid === "today" ? base : averageRuns(corridor, d, planFor(corridor, pid, period, d), seeds);
      const lost = m.delayHoursPerHour.main + m.delayHoursPerHour.cross, baseLost = base.delayHoursPerHour.main + base.delayHoursPerHour.cross;
      const pct = (a: number, b: number): string => `${a <= b ? "" : "+"}${((a / b - 1) * 100).toFixed(0)}%`;
      console.log(`  ${pid.padEnd(10)} WB ${m.travelTimeS[0].toFixed(0).padStart(4)}s  EB ${m.travelTimeS[1].toFixed(0).padStart(4)}s  stops ${m.stopsPerCar.toFixed(1)}  lost ${lost.toFixed(0).padStart(4)} h/h (${pct(lost, baseLost)})  CO2 ${m.co2KgPerHour.total.toFixed(0).padStart(5)} kg/h (${pct(m.co2KgPerHour.total, base.co2KgPerHour.total)})  side-street ${m.delayHoursPerHour.cross.toFixed(0)} h/h  to bridge ${m.exitsPerHour[0].toFixed(0)}/h`);
      rows.push({ period, demand: did, plan: pid, travelTimeS: m.travelTimeS, stopsPerCar: m.stopsPerCar, lostHoursPerHour: lost, crossHoursPerHour: m.delayHoursPerHour.cross, co2KgPerHour: m.co2KgPerHour.total, exitsPerHour: m.exitsPerHour });
    }
  }
}
const at = process.argv.indexOf("--json");
if (at > 0 && process.argv[at + 1]) writeFileSync(process.argv[at + 1]!, JSON.stringify(rows, null, 2) + "\n");
