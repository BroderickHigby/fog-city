// Turns a gate suite's measurements into Vitest tests against the ratchet (ratchet.ts).
//
// A suite module measures and returns a Measured: for each metric its definition (target,
// direction, unit, the defects it tracks: the code is the source of truth for these) and its
// value, plus run outcomes for the drive and walk sets and details for failure messages. The
// baseline file mirrors the definitions (the format the gate document gives) and holds the
// ratcheted baseline values and the defects' statuses.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ROOT } from "../../helpers.ts";
import {
  RECORD_DIR,
  judge,
  loadBaseline,
  loadRuns,
  record,
  runImprovements,
  runRegressions,
  suiteMetrics,
  type Cadence,
  type MetricSpec,
  type RunsGolden,
} from "./ratchet.ts";

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
  readonly runs: RunsGolden = {};
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

const RECORD_ONLY = process.env.WORLD_GATE_RECORD === "1";

function short(v: unknown): string {
  const s = JSON.stringify(v);
  return s.length > 1500 ? s.slice(0, 1500) + " ..." : s;
}

/**
 * Register a gate suite: measure once (beforeAll), record, then one test per metric the baseline
 * lists for the suite, one per run set, and a check that the code and the baseline agree on which
 * metrics exist and what they mean. WORLD_GATE_RECORD=1 records without asserting (used by
 * `pnpm world:baseline` to measure a new metric for the first time).
 */
export function gateSuite(suite: string, cadence: Cadence, measure: () => Promise<Measured> | Measured, timeoutMs = 600_000): void {
  const b = loadBaseline();
  const ids = suiteMetrics(suite, b);
  describe(`world gate: ${suite}`, () => {
    let m: Measured;
    beforeAll(async () => {
      m = await measure();
      record(suite, m.values, m.runs);
      writeSpecs(suite, m);
    }, timeoutMs);

    it("measures exactly the metrics the baseline lists for this suite, with the same definitions", () => {
      expect(m.suite).toBe(suite);
      if (RECORD_ONLY) return;
      expect(Object.keys(m.values).sort(), `run \`pnpm world:baseline\` after adding or removing a metric`).toEqual(ids);
      const specs = m.specs();
      for (const id of ids) {
        const { baseline: _b, ...mirror } = b.metrics[id]!;
        expect(mirror, `${id}: the baseline file's definition differs from the code's (pnpm world:baseline rewrites it)`).toEqual(specs[id]);
      }
    });

    for (const id of ids) {
      const spec = b.metrics[id]!;
      const tag = spec.defects.length ? spec.defects.join(" ") : "pass";
      it(`${id} [${tag}]: ${spec.desc}`, () => {
        if (RECORD_ONLY) return;
        const value = m.values[id];
        expect(value, `${id} was not measured`).toBeTypeOf("number");
        const v = judge(id, value!, b);
        if (v.reminder) console.log(`[world gate] ${v.reminder}`);
        expect(v.messages, v.messages.length && m.details[id] !== undefined ? `details: ${short(m.details[id])}` : undefined).toEqual([]);
      });
    }

    const golden = loadRuns();
    for (const set of Object.keys(golden).filter((s) => s.startsWith(`${suite}/`))) {
      it(`runs ${set}: nothing that reached its end at the baseline stops now`, () => {
        if (RECORD_ONLY) return;
        const outcomes = m.runs[set];
        expect(outcomes, `${set} was not measured`).toBeDefined();
        const better = runImprovements(set, outcomes!, golden);
        if (better.length) console.log(`[world gate] ${set}: ${better.length} runs reach their end now that did not at the baseline (${better.slice(0, 10).join(", ")}); refresh the golden with \`pnpm world:baseline\`.`);
        expect(runRegressions(set, outcomes!, golden), `${set}: runs that reached their end at the baseline and no longer do`).toEqual([]);
      });
    }
  });
}

/** The definitions and details beside the values, for `pnpm world:baseline` and for reading a failure. */
function writeSpecs(suite: string, m: Measured): void {
  const dir = join(ROOT, RECORD_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${suite}.specs.json`), JSON.stringify({ suite, timing: m.timing, specs: m.specs(), details: m.details }, null, 1) + "\n");
}
