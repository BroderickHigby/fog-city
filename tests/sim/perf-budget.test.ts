// The sim's cost per tick on a fixed scenario, guarded against regressions (docs/parallel/status/
// perf-stream.md). SF, seed 1, the game's wave-3 systems, one player driving a gentle weave from
// the spawn: after a warm-up, the time per tick and the bytes allocated per tick must stay within
// a margin of the committed baseline (tests/sim/perf-budget.json).
//
// Robust to machine noise:
//  - Time is never compared in milliseconds. Each measured block of ticks is paired with a block
//    of a fixed synthetic workload (calibrate(): allocation, object spreads, string sorts, Map
//    traffic and float math, like the sim's), run alternately in this process. The test compares
//    the ratio of the best sim block to the best calibration block, so a slower or busier machine
//    slows both. The margin is wide (RATIO_MARGIN): it catches a hotspot coming back (2x), not
//    a few percent.
//  - Allocation is close to machine-independent: the bytes the heap grew by between collections
//    (v8.GCProfiler), summed over the measured ticks.
//
// FOG_PERF_UPDATE=1 rewrites the baseline from this run (do it on purpose, alone, after a change
// that makes the sim legitimately more or less expensive, and say why in the PR).
import { readFileSync, writeFileSync } from "node:fs";
import { GCProfiler } from "node:v8";
import { describe, expect, it } from "vitest";
import { createGameSystems, createInitialState, step, type SimState } from "../../src/sim/index.ts";
import { buildWorldWithRoads, loadWorldFiles, worldExists } from "../helpers.ts";
import { SF_RUN_MS } from "./fixtures.ts";

const SF = worldExists("sf");
const BASELINE = new URL("./perf-budget.json", import.meta.url);
const WARM = 900;
const BLOCKS = 6;
const BLOCK_TICKS = 50;
/** Fail when the time ratio is more than this times the baseline's. */
const RATIO_MARGIN = 1.6;
/** Fail when the bytes allocated per tick are more than this times the baseline's. */
const ALLOC_MARGIN = 1.3;

interface Baseline {
  scenario: string;
  ratio: number;
  bytesPerTick: number;
  recorded: string;
  note: string;
}

/** A fixed, deterministic workload shaped like a sim tick. Returns a checksum so it is not elided. */
function calibrate(): number {
  let sum = 0;
  const ids: string[] = [];
  for (let i = 0; i < 400; i++) ids.push(`agent:${(i * 7919) % 1000}`);
  const map = new Map<string, { x: number; z: number; heading: number; speed: number; tag: string }>();
  for (let round = 0; round < 6; round++) {
    let list = ids.map((id, i) => ({ id, x: i * 1.5, z: i * 0.5, heading: i * 0.01, speed: 1, tag: "walker", a: 0, b: 1, c: 2, d: 3, e: 4, f: 5 }));
    for (let k = 0; k < 4; k++) list = list.map((o) => ({ ...o, x: o.x + Math.sqrt(o.z + k + 1), z: o.z * 0.999 }));
    const sorted = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const o of list) map.set(o.id, o);
    for (const id of sorted) sum += map.get(id)!.x;
    const set = new Set(sorted.map((id) => `${id}:${round}`));
    sum += set.size;
  }
  return sum;
}

function scenario(): { run: (ticks: number) => void; state: () => SimState } {
  const files = loadWorldFiles("sf");
  const world = buildWorldWithRoads(files.tiles, files.roads, files.boundary, files);
  const systems = createGameSystems({ wave: 3 });
  let s = createInitialState(world, 1, ["p1"], files.manifest.spawn);
  return {
    run(ticks) {
      for (let i = 0; i < ticks; i++) {
        const phase = Math.floor(s.tick / 240) % 4;
        s = step(world, s, { p1: { throttle: 0.45, steer: phase === 1 ? 0.25 : phase === 3 ? -0.25 : 0, brake: 0, actions: 0 } }, [], systems);
      }
    },
    state: () => s,
  };
}

function bytesAllocated(stats: ReturnType<GCProfiler["stop"]>, startUsed: number, endUsed: number): number {
  let total = 0;
  let from = startUsed;
  for (const gc of stats?.statistics ?? []) {
    total += Math.max(0, gc.beforeGC.heapStatistics.usedHeapSize - from);
    from = gc.afterGC.heapStatistics.usedHeapSize;
  }
  return total + Math.max(0, endUsed - from);
}

describe.skipIf(!SF)("sim cost per tick on a fixed SF scenario", () => {
  it("stays within the baseline's time ratio and allocation", () => {
    const sim = scenario();
    sim.run(WARM);
    let check = 0;
    for (let i = 0; i < 3; i++) check += calibrate(); // warm the calibration's code too
    const simMs: number[] = [];
    const calMs: number[] = [];
    let bytes = 0;
    for (let b = 0; b < BLOCKS; b++) {
      let t0 = performance.now();
      check += calibrate();
      calMs.push(performance.now() - t0);
      const profiler = new GCProfiler();
      const used0 = process.memoryUsage().heapUsed;
      profiler.start();
      t0 = performance.now();
      sim.run(BLOCK_TICKS);
      simMs.push((performance.now() - t0) / BLOCK_TICKS);
      const stats = profiler.stop();
      bytes += bytesAllocated(stats, used0, process.memoryUsage().heapUsed);
    }
    expect(check).toBeGreaterThan(0);
    expect(sim.state().tick).toBe(WARM + BLOCKS * BLOCK_TICKS);
    const ratio = Math.min(...simMs) / Math.min(...calMs);
    const bytesPerTick = bytes / (BLOCKS * BLOCK_TICKS);
    const measured = `ratio ${ratio.toFixed(3)} (best ${Math.min(...simMs).toFixed(2)} ms/tick vs calibration ${Math.min(...calMs).toFixed(2)} ms), ${(bytesPerTick / 1024).toFixed(0)} KB/tick`;
    if (process.env.FOG_PERF_UPDATE === "1") {
      const next: Baseline = { scenario: `sf seed 1 wave 3, 1 player weave, ticks ${WARM + 1}-${WARM + BLOCKS * BLOCK_TICKS}`, ratio: +ratio.toFixed(3), bytesPerTick: Math.round(bytesPerTick), recorded: new Date().toISOString().slice(0, 10), note: measured };
      writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`);
      return;
    }
    const base = JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline;
    expect(ratio, `${measured}; baseline ratio ${base.ratio}`).toBeLessThanOrEqual(base.ratio * RATIO_MARGIN);
    expect(bytesPerTick, `${measured}; baseline ${(base.bytesPerTick / 1024).toFixed(0)} KB/tick`).toBeLessThanOrEqual(base.bytesPerTick * ALLOC_MARGIN);
  }, SF_RUN_MS);
});
