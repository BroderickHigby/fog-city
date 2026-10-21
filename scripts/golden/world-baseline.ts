// `pnpm world:baseline`: rewrite the world-continuity gate's ratchet from the last measurement.
//
// Reads what the gate suites wrote to test-results/world-gate/ (every suite records its values,
// its metric definitions and its failing runs before it judges them, so a failing run still
// records) and updates:
//   tests/golden/world-qa-baseline.json  each metric's baseline (lowered, never raised) and its
//                                        definition (copied from the code, the source of truth);
//   tests/golden/world-qa-runs.json      each run set's failing runs (shrunk, never grown).
// A metric that got worse, or a run that newly fails, is refused unless named with
// --accept-worse <id or set>[,<id>...] (say why in the PR). A metric the baseline has but no suite
// measured any more is removed only with --prune. Defects' statuses are edited by hand (flip an id
// to "fixed" in the same PR as its fix); this script never changes them.
//
//   node scripts/golden/world-baseline.ts                 # accept improvements and new metrics
//   node scripts/golden/world-baseline.ts --check         # print what would change, write nothing
//   node scripts/golden/world-baseline.ts --accept-worse A.rings.nonSimple,drive/sample

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const BASELINE = join(ROOT, "tests/golden/world-qa-baseline.json");
const RUNS = join(ROOT, "tests/golden/world-qa-runs.json");
const RECORDS = join(ROOT, "test-results/world-gate");

interface Spec {
  baseline: number;
  target: number;
  better: "lower" | "higher";
  unit: string;
  defects: string[];
  targetWave: number | null;
  suite: string;
  cadence: string;
  desc: string;
}

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? "") : null;
};
const check = args.includes("--check");
const prune = args.includes("--prune");
const acceptWorse = new Set((flag("--accept-worse") ?? "").split(",").filter(Boolean));

if (!existsSync(RECORDS)) {
  console.error(`No measurements in ${RECORDS}: run the gate first (pnpm world:pr, pnpm world:nightly, or the e2e gate specs).`);
  process.exit(1);
}
const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as { build: string; measuredOn: string; note: string; defects: Record<string, { targetWave: number | null }>; metrics: Record<string, Spec> };
const runs = (existsSync(RUNS) ? JSON.parse(readFileSync(RUNS, "utf8")) : {}) as Record<string, string[]>;

const EPS = 1e-9;
const worse = (s: Pick<Spec, "better">, v: number, ref: number): boolean => (s.better === "lower" ? v > ref + EPS * Math.max(1, Math.abs(ref)) : v < ref - EPS * Math.max(1, Math.abs(ref)));

const changes: string[] = [];
const refusals: string[] = [];
const measuredSuites = new Set<string>();
const measuredIds = new Set<string>();
for (const f of readdirSync(RECORDS).filter((n) => n.endsWith(".json") && !n.endsWith(".specs.json")).sort()) {
  const rec = JSON.parse(readFileSync(join(RECORDS, f), "utf8")) as { suite: string; values: Record<string, number>; runs: Record<string, string[]> };
  const specFile = join(RECORDS, f.replace(/\.json$/, ".specs.json"));
  const specs = (existsSync(specFile) ? JSON.parse(readFileSync(specFile, "utf8")).specs : {}) as Record<string, Omit<Spec, "baseline">>;
  measuredSuites.add(rec.suite);
  for (const [id, v] of Object.entries(rec.values)) {
    measuredIds.add(id);
    const def = specs[id];
    const old = baseline.metrics[id];
    if (!old) {
      if (!def) {
        refusals.push(`${id}: measured but its definition is missing (${specFile})`);
        continue;
      }
      baseline.metrics[id] = { baseline: v, ...def };
      changes.push(`+ ${id} = ${v} (new metric)`);
      continue;
    }
    if (def) {
      for (const k of Object.keys(def) as Array<keyof typeof def>) {
        if (JSON.stringify(old[k]) !== JSON.stringify(def[k])) {
          changes.push(`~ ${id}.${k}: ${JSON.stringify(old[k])} -> ${JSON.stringify(def[k])}`);
          (old as unknown as Record<string, unknown>)[k] = def[k];
        }
      }
    }
    if (v === old.baseline) continue;
    if (worse(old, v, old.baseline)) {
      if (!acceptWorse.has(id)) {
        refusals.push(`${id}: ${v} is worse than the baseline ${old.baseline} (${old.better} is better); fix it, or pass --accept-worse ${id} and say why in the PR`);
        continue;
      }
      changes.push(`! ${id}: ${old.baseline} -> ${v} (WORSE, accepted)`);
    } else changes.push(`- ${id}: ${old.baseline} -> ${v}`);
    old.baseline = v;
  }
  for (const [set, failing] of Object.entries(rec.runs ?? {})) {
    const before = new Set(runs[set] ?? []);
    const fresh = failing.filter((k) => !before.has(k));
    if (runs[set] && fresh.length && !acceptWorse.has(set)) {
      refusals.push(`${set}: ${fresh.length} runs fail now that passed at the baseline (${fresh.slice(0, 8).join(", ")}); fix them, or pass --accept-worse ${set}`);
      continue;
    }
    const fixed = [...before].filter((k) => !failing.includes(k));
    if (!runs[set] || fixed.length || fresh.length) changes.push(`${runs[set] ? "-" : "+"} runs ${set}: ${failing.length} failing (${fixed.length} fixed, ${fresh.length} newly failing)`);
    runs[set] = [...failing].sort();
  }
}
for (const [id, s] of Object.entries(baseline.metrics)) {
  if (!measuredSuites.has(s.suite) || measuredIds.has(id)) continue;
  if (prune) {
    delete baseline.metrics[id];
    changes.push(`x ${id} (no longer measured by ${s.suite})`);
  } else refusals.push(`${id}: the baseline has it but suite ${s.suite} no longer measures it; pass --prune to drop it`);
}

for (const c of changes) console.log(c);
for (const r of refusals) console.error(`REFUSED ${r}`);
if (check) {
  console.log(`--check: ${changes.length} changes, ${refusals.length} refusals, nothing written`);
  process.exit(refusals.length ? 1 : 0);
}
const sorted = <T>(o: Record<string, T>): Record<string, T> => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]!]));
baseline.metrics = sorted(baseline.metrics);
writeFileSync(BASELINE, JSON.stringify(baseline, null, 1) + "\n");
writeFileSync(RUNS, JSON.stringify(sorted(runs), null, 1) + "\n");
console.log(`wrote ${BASELINE} and ${RUNS}: ${changes.length} changes${refusals.length ? `, ${refusals.length} refused (see above)` : ""}`);
process.exit(refusals.length ? 1 : 0);
