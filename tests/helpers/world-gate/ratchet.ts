// The world-continuity gate's ratchet (docs/qa/world-continuity-gate.md, rule 3).
//
// tests/golden/world-qa-baseline.json holds every metric the gate measures: its value at the
// baseline build, its target, which way is better, the defects it tracks, and the suite that
// measures it. tests/golden/world-qa-runs.json holds the per-run outcomes of the drive and walk
// sets (which edge reached its end, which did not), so a fixed street can never quietly break
// again. A gate suite measures its metrics once, then checks each one:
//
//  1. Not worse than its baseline (a regression fails the PR).
//  2. When every defect the metric tracks is marked "fixed" (or it tracks none: a pass check), it
//     is at its target: the defect's acceptance test is a hard assertion from then on.
//  3. Better than its baseline by more than 10% means the baseline is stale: the PR that improved
//     it must lower it too (`pnpm world:baseline`), so the next PR is held to the new value. A
//     smaller improvement only prints a reminder.
//
// Every suite also writes what it measured to test-results/world-gate/<suite>.json, which is
// what `pnpm world:baseline` reads to rewrite the baseline (scripts/golden/world-baseline.ts).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../helpers.ts";

export type Severity = "blocker" | "high" | "medium" | "low";
export type DefectStatus = "open" | "partly" | "fixed";
export type Cadence = "pr" | "nightly" | "e2e" | "e2e-nightly";

export interface DefectSpec {
  severity: Severity;
  status: DefectStatus;
  /** Owning track(s), as in the QA report. */
  owner: string;
  title: string;
  /** The wave whose merge needs it at target (docs/roadmap.md: no wave merges with an open blocker, high or medium). */
  targetWave: number | null;
  /** What the status rests on (a measurement at the baseline build, or the QA report). */
  note?: string;
}

export interface MetricSpec {
  /** The value measured at the baseline build. */
  baseline: number;
  /** The value the defect's acceptance test requires. */
  target: number;
  /** Which direction is an improvement. */
  better: "lower" | "higher";
  unit: string;
  /** The defects (W-xx, L-xx) the metric tracks; empty for a pass check that must stay passing. */
  defects: string[];
  /** Overrides the defects' targetWave. */
  targetWave: number | null;
  /** The gate suite that measures it (tests/golden/world/<suite>.test.ts or .nightly.ts, or an e2e spec). */
  suite: string;
  cadence: Cadence;
  desc: string;
}

export interface Baseline {
  build: string;
  measuredOn: string;
  note: string;
  defects: Record<string, DefectSpec>;
  metrics: Record<string, MetricSpec>;
}

export const BASELINE_FILE = "tests/golden/world-qa-baseline.json";
export const RUNS_FILE = "tests/golden/world-qa-runs.json";
export const RECORD_DIR = "test-results/world-gate";
/** An improvement past this share of the baseline means the baseline is stale. */
export const STALE_SHARE = 0.1;

let cached: Baseline | null = null;

export function loadBaseline(): Baseline {
  if (!cached) cached = JSON.parse(readFileSync(join(ROOT, BASELINE_FILE), "utf8")) as Baseline;
  return cached;
}

/**
 * Runs golden: set name -> the run keys that did NOT reach their end (or pass) at the baseline,
 * sorted. Every other run of the set must pass, so the file stays small however many runs a set
 * has (the nightly street set has 26,800).
 */
export type RunsGolden = Record<string, string[]>;

let cachedRuns: RunsGolden | null = null;

export function loadRuns(): RunsGolden {
  if (!cachedRuns) cachedRuns = JSON.parse(readFileSync(join(ROOT, RUNS_FILE), "utf8")) as RunsGolden;
  return cachedRuns;
}

/** Metric ids of one suite, sorted. */
export function suiteMetrics(suite: string, b: Baseline = loadBaseline()): string[] {
  return Object.keys(b.metrics)
    .filter((id) => b.metrics[id]!.suite === suite)
    .sort();
}

const EPS = 1e-9;

function tolerance(v: number): number {
  return EPS * Math.max(1, Math.abs(v));
}

/** Is `v` worse than `ref` for this metric? */
export function isWorse(spec: Pick<MetricSpec, "better">, v: number, ref: number): boolean {
  return spec.better === "lower" ? v > ref + tolerance(ref) : v < ref - tolerance(ref);
}

/** Has `v` reached `target`? */
export function atTarget(spec: Pick<MetricSpec, "better" | "target">, v: number): boolean {
  return !isWorse(spec, v, spec.target);
}

/** How much better than the baseline, as a share of it (Infinity when the baseline is 0 and v beats it). */
export function improvement(spec: Pick<MetricSpec, "better" | "baseline">, v: number): number {
  const d = spec.better === "lower" ? spec.baseline - v : v - spec.baseline;
  if (d <= tolerance(spec.baseline)) return 0;
  return Math.abs(spec.baseline) < EPS ? Infinity : d / Math.abs(spec.baseline);
}

/** True when the metric's target is a hard assertion: every defect it tracks is fixed, or it tracks none. */
export function enforced(spec: Pick<MetricSpec, "defects">, b: Baseline = loadBaseline()): boolean {
  return spec.defects.every((d) => b.defects[d]?.status === "fixed");
}

export interface Verdict {
  ok: boolean;
  /** Failure or reminder text. */
  messages: string[];
  reminder: string | null;
}

/** Judge one measured value against its baseline entry (the three rules in the header). */
export function judge(id: string, value: number, b: Baseline = loadBaseline()): Verdict {
  const spec = b.metrics[id];
  if (!spec) return { ok: false, messages: [`${id}: not in ${BASELINE_FILE}`], reminder: null };
  const messages: string[] = [];
  const tags = spec.defects.length ? spec.defects.map((d) => `${d} ${b.defects[d]?.status ?? "?"}`).join(", ") : "pass check";
  if (!Number.isFinite(value)) messages.push(`${id} (${tags}): measured ${value}, not a finite number`);
  if (isWorse(spec, value, spec.baseline)) {
    messages.push(`${id} (${tags}) got worse: ${fmt(value)} ${spec.unit} against the baseline ${fmt(spec.baseline)} (${spec.better} is better). ${spec.desc}`);
  }
  if (enforced(spec, b) && !atTarget(spec, value)) {
    messages.push(`${id} (${tags}) must be at its target now that ${spec.defects.length ? spec.defects.join(", ") + " is marked fixed" : "it is a pass check"}: measured ${fmt(value)}, target ${fmt(spec.target)} ${spec.unit}. ${spec.desc}`);
  }
  let reminder: string | null = null;
  const imp = improvement(spec, value);
  if (imp > STALE_SHARE) {
    messages.push(`${id} (${tags}) beat its baseline by ${imp === Infinity ? "all of it" : Math.round(imp * 100) + "%"}: ${fmt(value)} against ${fmt(spec.baseline)} ${spec.unit}. The baseline is stale: lower it in this PR with \`pnpm world:baseline\` (and flip the defect to fixed if its target is reached).`);
  } else if (imp > 0) {
    reminder = `${id} improved: ${fmt(value)} against the baseline ${fmt(spec.baseline)} ${spec.unit}; lower the baseline with \`pnpm world:baseline\`.`;
  }
  return { ok: messages.length === 0, messages, reminder };
}

export function fmt(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 1e4) / 1e4);
}

/** Write what a suite measured, for `pnpm world:baseline`. */
export function record(suite: string, values: Record<string, number>, runs: Record<string, Record<string, boolean>> = {}): void {
  const dir = join(ROOT, RECORD_DIR);
  mkdirSync(dir, { recursive: true });
  const failing: RunsGolden = {};
  for (const [set, o] of Object.entries(runs)) failing[set] = failingKeys(o);
  writeFileSync(join(dir, `${suite}.json`), JSON.stringify({ suite, at: new Date().toISOString(), values, runs: failing, runCounts: Object.fromEntries(Object.entries(runs).map(([k, o]) => [k, Object.keys(o).length])) }, null, 1) + "\n");
}

/** Runs that fail now but passed at the baseline (not in its failing list): regressions. */
export function runRegressions(set: string, outcomes: Record<string, boolean>, golden: RunsGolden = loadRuns()): string[] {
  const allowed = new Set(golden[set] ?? []);
  return Object.keys(outcomes)
    .filter((k) => !outcomes[k] && !allowed.has(k))
    .sort();
}

/** Runs the baseline lists as failing that pass now (fixed since): a reminder to refresh the golden. */
export function runImprovements(set: string, outcomes: Record<string, boolean>, golden: RunsGolden = loadRuns()): string[] {
  return (golden[set] ?? []).filter((k) => outcomes[k] === true).sort();
}

/** The failing keys of a set of outcomes, sorted (what the golden stores). */
export function failingKeys(outcomes: Record<string, boolean>): string[] {
  return Object.keys(outcomes)
    .filter((k) => !outcomes[k])
    .sort();
}
