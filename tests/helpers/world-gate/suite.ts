// Turns a gate suite's measurements into Vitest tests against the ratchet (ratchet.ts).
//
// A suite module measures and returns a Measured: for each metric its definition (target,
// direction, unit, the defects it tracks: the code is the source of truth for these) and its
// value, plus run outcomes for the drive and walk sets and details for failure messages. The
// baseline file mirrors the definitions (the format the gate document gives) and holds the
// ratcheted baseline values and the defects' statuses.

import { beforeAll, describe, expect, it } from "vitest";
import { Measured, writeSpecs } from "./measured.ts";
import {
  judge,
  loadBaseline,
  loadRuns,
  record,
  runImprovements,
  runRegressions,
  suiteMetrics,
  type Cadence,
} from "./ratchet.ts";

export { Measured, type MetricDef } from "./measured.ts";

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
      it(`runs ${set}: every run that reached its end at the baseline still does`, () => {
        if (RECORD_ONLY) return;
        const outcomes = m.runs[set];
        expect(outcomes, `${set} was not measured`).toBeDefined();
        const better = runImprovements(set, outcomes!, golden);
        if (better.length) console.log(`[world gate] ${set}: ${better.length} runs reach their end now that did not at the baseline (${better.slice(0, 10).join(", ")}); refresh the golden with \`pnpm world:baseline\`.`);
        const missing = (golden[set] ?? []).filter((k) => outcomes![k] === undefined);
        expect(missing, `${set}: runs the baseline lists that were not measured (an edge renamed or removed? refresh the golden)`).toEqual([]);
        expect(runRegressions(set, outcomes!, golden), `${set}: runs that reached their end at the baseline and no longer do`).toEqual([]);
      });
    }
  });
}

