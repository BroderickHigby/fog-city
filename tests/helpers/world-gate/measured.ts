// A gate suite's measurement: each metric's definition (the code is the source of truth for the
// target, direction, unit and defects) and value, plus run outcomes and details. Shared by the
// Vitest suites (suite.ts) and the Playwright gate specs (tests/e2e/world-gate.ts); no test
// runner imported here.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../helpers.ts";
import { RECORD_DIR, type Cadence, type MetricSpec } from "./ratchet.ts";

export interface MetricDef {
  id: string;
  target: number;
  better: "lower" | "higher";
  unit: string;
  defects: string[];
  desc: string;
  targetWave?: number | null;
}

export class Measured {
  readonly suite: string;
  readonly cadence: Cadence;
  readonly defs: MetricDef[] = [];
  readonly values: Record<string, number> = {};
  readonly runs: Record<string, Record<string, boolean>> = {};
  readonly details: Record<string, unknown> = {};
  /** Milliseconds per section (lap), for keeping the per-PR suite inside its time budget. */
  readonly timing: Record<string, number> = {};
  private t = performance.now();
  constructor(suite: string, cadence: Cadence) {
    this.suite = suite;
    this.cadence = cadence;
  }
  /** Close a timed section. */
  lap(label: string): void {
    const now = performance.now();
    this.timing[label] = Math.round(now - this.t);
    this.t = now;
  }
  /** Record one metric. `detail` (worst cases, lists) is printed when it fails. */
  metric(def: MetricDef, value: number, detail?: unknown): void {
    if (this.values[def.id] !== undefined) throw new Error(`${this.suite}: metric ${def.id} measured twice`);
    this.defs.push(def);
    this.values[def.id] = value;
    if (detail !== undefined) this.details[def.id] = detail;
  }
  /** Record a set of run outcomes (key -> reached/passed). */
  runSet(name: string, outcomes: Record<string, boolean>): void {
    this.runs[name] = outcomes;
  }
  /** The definitions as the baseline file mirrors them. */
  specs(): Record<string, Omit<MetricSpec, "baseline">> {
    const out: Record<string, Omit<MetricSpec, "baseline">> = {};
    for (const d of this.defs) {
      out[d.id] = { target: d.target, better: d.better, unit: d.unit, defects: d.defects, targetWave: d.targetWave ?? null, suite: this.suite, cadence: this.cadence, desc: d.desc };
    }
    return out;
  }
}


/** The definitions and details beside the values, for `pnpm world:baseline` and for reading a failure. */
export function writeSpecs(suite: string, m: Measured): void {
  const dir = join(ROOT, RECORD_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${suite}.specs.json`), JSON.stringify({ suite, timing: m.timing, specs: m.specs(), details: m.details }, null, 1) + "\n");
}
