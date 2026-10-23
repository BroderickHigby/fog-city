// `pnpm world:baseline`: rewrite the world-continuity gate's ratchet from the last measurement.
//
// Reads what the gate suites wrote to test-results/world-gate/ (every suite records its values,
// its metric definitions and its failing runs before it judges them, so a failing run still
// records) and updates:
//   tests/golden/world-qa-baseline.json  each metric's baseline (lowered, never raised) and its
//                                        definition (copied from the code, the source of truth);
//   tests/golden/world-qa-runs.json      each run set's failing runs (shrunk, never grown);
//   the metric and status tables in docs/qa/ (scripts/golden/world-docs.ts).
//
// It refuses, unless told otherwise:
//  - a metric that got worse, or a run that newly fails (--accept-worse <id or set>[,...]);
//  - a definition that loosens the gate: a looser target, a flipped direction, a later target
//    wave, a move from the per-PR tier to the nightly one, or tracked defects that would take an
//    enforced metric's target back off (--accept-looser <id>[,...]);
//  - a record measured on another commit than HEAD, or before the latest change in the working
//    tree: it is skipped and listed, so a stale nightly record from an earlier run never lowers or
//    raises anything (--include-stale uses them anyway).
// Say why in the PR for every --accept-*. A metric the baseline has but no suite measured any more
// is removed only with --prune. Defects' statuses are edited by hand (flip an id to "fixed" in the
// same PR as its fix); this script never changes them.
//
//   node scripts/golden/world-baseline.ts                 # accept improvements and new metrics
//   node scripts/golden/world-baseline.ts --check         # print what would change, write nothing
//   node scripts/golden/world-baseline.ts --accept-worse A.rings.nonSimple,drive/sample

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderDocs } from "./world-docs.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const BASELINE = join(ROOT, "tests/golden/world-qa-baseline.json");
const RUNS = join(ROOT, "tests/golden/world-qa-runs.json");
const RECORDS = join(ROOT, "test-results/world-gate");

export interface Spec {
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

export interface RecordStamp {
  /** git HEAD when the suite measured ("unknown" outside a git checkout). */
  commit?: string;
  /** ISO time the suite measured. */
  at?: string;
}

const EPS = 1e-9;
const worse = (s: Pick<Spec, "better">, v: number, ref: number): boolean => (s.better === "lower" ? v > ref + EPS * Math.max(1, Math.abs(ref)) : v < ref - EPS * Math.max(1, Math.abs(ref)));
const perPr = (cadence: string): boolean => cadence === "pr" || cadence === "e2e";

/**
 * How a new definition (from the code) loosens the old one (in the baseline), if it does: each
 * reason is a refusal unless the metric is named with --accept-looser. `fixed` says which defects
 * are marked fixed (an enforced metric tracks only fixed defects, or none).
 */
export function loosenings(old: Omit<Spec, "baseline">, def: Omit<Spec, "baseline">, fixed: (defect: string) => boolean): string[] {
  const out: string[] = [];
  if (def.better !== old.better) out.push(`direction flipped (${old.better} is better -> ${def.better})`);
  else if (worse(old, def.target, old.target)) out.push(`target loosened (${old.target} -> ${def.target}, ${old.better} is better)`);
  if (old.targetWave !== null && (def.targetWave === null || def.targetWave > old.targetWave)) out.push(`target wave later (${old.targetWave} -> ${def.targetWave})`);
  if (perPr(old.cadence) && !perPr(def.cadence)) out.push(`moved off the per-PR tier (${old.cadence} -> ${def.cadence})`);
  const wasEnforced = old.defects.every(fixed);
  if (wasEnforced && !def.defects.every(fixed)) out.push(`no longer enforced (tracks ${def.defects.filter((d) => !fixed(d)).join(", ")}, not fixed)`);
  return out;
}

/** Why a record is stale against HEAD and the newest change in the working tree, or null when it is current. */
export function staleness(stamp: RecordStamp, head: string, newestChangeMs: number): string | null {
  if (!stamp.commit || !stamp.at) return "it carries no commit stamp (measured before records were stamped)";
  if (stamp.commit !== head && stamp.commit !== "unknown") return `measured on ${stamp.commit.slice(0, 7)}, not HEAD ${head.slice(0, 7)}`;
  const at = Date.parse(stamp.at);
  if (Number.isFinite(newestChangeMs) && at < newestChangeMs) return `measured at ${stamp.at}, before the working tree's latest change (${new Date(newestChangeMs).toISOString()})`;
  return null;
}

/** The gate's own outputs: changing them does not change what the suites measure. */
const OWN_OUTPUTS = [/^tests\/golden\/world-qa-(baseline|runs)\.json$/, /^docs\//, /^test-results\//];

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

/** The newest modification time of a tracked change or untracked file in the working tree (0 when clean). */
function newestChange(): number {
  let newest = 0;
  const entries = git(["status", "--porcelain", "-z", "--untracked-files=all"]).split("\0");
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    // "XY path"; a rename or copy is followed by its original path as the next entry.
    if (entry[0] === "R" || entry[0] === "C") i++;
    const path = entry.slice(3);
    if (OWN_OUTPUTS.some((re) => re.test(path))) continue;
    try {
      newest = Math.max(newest, statSync(join(ROOT, path)).mtimeMs);
    } catch {
      // deleted, or the second half of a rename: nothing to stat
    }
  }
  return newest;
}

function main(): void {
  const args = process.argv.slice(2);
  const flag = (name: string): string | null => {
    const i = args.indexOf(name);
    return i >= 0 ? (args[i + 1] ?? "") : null;
  };
  const check = args.includes("--check");
  const prune = args.includes("--prune");
  const includeStale = args.includes("--include-stale");
  const acceptWorse = new Set((flag("--accept-worse") ?? "").split(",").filter(Boolean));
  const acceptLooser = new Set((flag("--accept-looser") ?? "").split(",").filter(Boolean));

  if (!existsSync(RECORDS)) {
    console.error(`No measurements in ${RECORDS}: run the gate first (pnpm world:pr, pnpm world:nightly, or the e2e gate specs).`);
    process.exit(1);
  }
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as { build: string; measuredOn: string; note: string; defects: Record<string, { status: string; targetWave: number | null }>; metrics: Record<string, Spec> };
  const runs = (existsSync(RUNS) ? JSON.parse(readFileSync(RUNS, "utf8")) : {}) as Record<string, string[]>;
  const fixed = (d: string): boolean => baseline.defects[d]?.status === "fixed";
  const head = git(["rev-parse", "HEAD"]).trim() || "unknown";
  const newest = newestChange();

  const changes: string[] = [];
  const refusals: string[] = [];
  const skipped: string[] = [];
  const measuredSuites = new Set<string>();
  const measuredIds = new Set<string>();
  for (const f of readdirSync(RECORDS).filter((n) => n.endsWith(".json") && !n.endsWith(".specs.json")).sort()) {
    const rec = JSON.parse(readFileSync(join(RECORDS, f), "utf8")) as RecordStamp & { suite: string; values: Record<string, number>; runs: Record<string, string[]> };
    const stale = staleness(rec, head, newest);
    if (stale && !includeStale) {
      skipped.push(`${rec.suite} (${f}): ${stale}; rerun the suite, or pass --include-stale`);
      continue;
    }
    const specFile = join(RECORDS, f.replace(/\.json$/, ".specs.json"));
    const specs = (existsSync(specFile) ? JSON.parse(readFileSync(specFile, "utf8")).specs : {}) as Record<string, Omit<Spec, "baseline">>;
    measuredSuites.add(rec.suite);
    for (const [id, v] of Object.entries(rec.values)) {
      measuredIds.add(id);
      if (typeof v !== "number" || !Number.isFinite(v)) {
        refusals.push(`${id}: measured ${JSON.stringify(v)}, not a finite number (a probe that hit nothing?); fix the measurement first`);
        continue;
      }
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
        const looser = loosenings(old, def, fixed);
        if (looser.length && !acceptLooser.has(id)) {
          refusals.push(`${id}: the code's definition loosens the gate: ${looser.join("; ")}; keep it, or pass --accept-looser ${id} and say why in the PR`);
          continue;
        }
        if (looser.length) changes.push(`! ${id}: LOOSER, accepted: ${looser.join("; ")}`);
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
      const gone = [...before].filter((k) => !failing.includes(k));
      if (!runs[set] || gone.length || fresh.length) changes.push(`${runs[set] ? "-" : "+"} runs ${set}: ${failing.length} failing (${gone.length} fixed, ${fresh.length} newly failing)`);
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

  for (const s of skipped) console.log(`skipped ${s}`);
  for (const c of changes) console.log(c);
  for (const r of refusals) console.error(`REFUSED ${r}`);
  if (check) {
    console.log(`--check: ${changes.length} changes, ${refusals.length} refusals, ${skipped.length} stale records skipped, nothing written`);
    process.exit(refusals.length ? 1 : 0);
  }
  const sorted = <T>(o: Record<string, T>): Record<string, T> => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]!]));
  baseline.metrics = sorted(baseline.metrics);
  writeFileSync(BASELINE, JSON.stringify(baseline, null, 1) + "\n");
  writeFileSync(RUNS, JSON.stringify(sorted(runs), null, 1) + "\n");
  renderDocs();
  console.log(`wrote ${BASELINE} and ${RUNS}: ${changes.length} changes${refusals.length ? `, ${refusals.length} refused (see above)` : ""}${skipped.length ? `, ${skipped.length} stale records skipped` : ""}`);
  process.exit(refusals.length ? 1 : 0);
}

if (import.meta.main) main();
