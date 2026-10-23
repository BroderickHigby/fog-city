// The world-continuity gate's ratchet, tested on its own (unit project: no world loaded): the
// judging rules on synthetic baselines, and the committed baseline file's shape: every QA defect
// present with a status, every blocker, high and medium defect tracked by at least one metric,
// every metric's suite a real test file, the runs golden's sets owned by a suite.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loosenings, staleness, type Spec } from "../../scripts/golden/world-baseline.ts";
import { chooseSample } from "../../scripts/golden/world-sample.ts";
import { ROOT } from "../helpers.ts";
import type { RoadEdge } from "../helpers/world.ts";
import { checkTintWiring } from "../helpers/world-gate/cover.ts";
import { sampleEdges } from "../helpers/world-gate/play.ts";
import { atTarget, enforced, improvement, isWorse, judge, loadBaseline, loadRuns, runImprovements, runRegressions, type Baseline } from "../helpers/world-gate/ratchet.ts";

function synthetic(status: "open" | "fixed", baseline: number, target: number, better: "lower" | "higher" = "lower"): Baseline {
  return {
    build: "test",
    measuredOn: "test",
    note: "",
    defects: { "W-99": { severity: "high", status, owner: "test", title: "test", targetWave: null } },
    metrics: { m: { baseline, target, better, unit: "u", defects: ["W-99"], targetWave: null, suite: "s", cadence: "pr", desc: "d" } },
  };
}

describe("world gate ratchet rules", () => {
  it("fails a metric that got worse than its baseline, in either direction of better", () => {
    expect(judge("m", 11, synthetic("open", 10, 0)).ok).toBe(false);
    expect(judge("m", 10, synthetic("open", 10, 0)).ok).toBe(true);
    expect(judge("m", 0.4, synthetic("open", 0.5, 0.9, "higher")).ok).toBe(false);
    expect(isWorse({ better: "lower" }, 10 + 1e-12, 10)).toBe(false);
  });
  it("prints a reminder for a small improvement and fails a stale baseline (better by more than 10%)", () => {
    const small = judge("m", 95, synthetic("open", 100, 0));
    expect(small.ok).toBe(true);
    expect(small.reminder).toMatch(/lower the baseline/);
    const stale = judge("m", 80, synthetic("open", 100, 0));
    expect(stale.ok).toBe(false);
    expect(stale.messages.join()).toMatch(/stale/);
    expect(improvement({ better: "higher", baseline: 0 }, 0.5)).toBe(Infinity);
    expect(judge("m", 0.5, synthetic("open", 0, 1, "higher")).ok).toBe(false);
  });
  it("makes the target a hard assertion once every tracked defect is fixed", () => {
    const b = synthetic("fixed", 5, 0);
    expect(enforced(b.metrics.m!, b)).toBe(true);
    expect(judge("m", 5, b).ok).toBe(false);
    expect(judge("m", 0, synthetic("fixed", 0, 0)).ok).toBe(true);
    expect(atTarget({ better: "higher", target: 0.9 }, 0.95)).toBe(true);
    // Open: at its baseline is fine however far from the target.
    expect(judge("m", 5, synthetic("open", 5, 0)).ok).toBe(true);
  });
  it("treats a pass check (no defects) as enforced", () => {
    const b = synthetic("open", 0, 0);
    b.metrics.m!.defects = [];
    expect(enforced(b.metrics.m!, b)).toBe(true);
  });
  it("finds run regressions against the baseline's failing list, and improvements", () => {
    const golden = { "s/x": ["a", "b"] };
    expect(runRegressions("s/x", { a: false, b: true, c: true }, golden)).toEqual([]);
    expect(runRegressions("s/x", { a: false, b: false, c: false }, golden)).toEqual(["c"]);
    expect(runImprovements("s/x", { a: false, b: true, c: true }, golden)).toEqual(["b"]);
  });
});

describe("world gate baseline file (tests/golden/world-qa-baseline.json)", () => {
  const b = loadBaseline();
  it("names its build and holds every QA defect W-01..W-52 and L-01..L-15 with a severity and a status", () => {
    expect(b.build).toMatch(/^[0-9a-f]{7}$/);
    for (let i = 1; i <= 52; i++) {
      const id = `W-${String(i).padStart(2, "0")}`;
      expect(b.defects[id], id).toBeDefined();
      expect(["blocker", "high", "medium"], id).toContain(b.defects[id]!.severity);
      expect(["open", "partly", "fixed"], id).toContain(b.defects[id]!.status);
    }
    for (let i = 1; i <= 15; i++) expect(b.defects[`L-${String(i).padStart(2, "0")}`]?.severity).toBe("low");
  });
  it("tracks every blocker, high and medium defect with at least one metric, and names only known defects", () => {
    const tracked = new Set(Object.values(b.metrics).flatMap((m) => m.defects));
    for (const [id, d] of Object.entries(b.defects)) if (d.severity !== "low") expect(tracked.has(id), `${id} (${d.title}) has no metric`).toBe(true);
    for (const [id, m] of Object.entries(b.metrics)) for (const d of m.defects) expect(b.defects[d], `${id} tracks unknown defect ${d}`).toBeDefined();
  });
  it("gives every metric a finite baseline and target, a direction and a suite that exists", () => {
    const files = new Set([...readdirSync(join(ROOT, "tests/golden/world")), ...readdirSync(join(ROOT, "tests/e2e"))]);
    for (const [id, m] of Object.entries(b.metrics)) {
      expect(Number.isFinite(m.baseline) && Number.isFinite(m.target), id).toBe(true);
      expect(["lower", "higher"], id).toContain(m.better);
      const file = m.cadence === "pr" ? `${m.suite}.test.ts` : m.cadence === "nightly" ? `${m.suite}.nightly.ts` : `${m.suite}.spec.ts`;
      expect(files.has(file), `${id}: suite file ${file}`).toBe(true);
      // A metric at or past its target while its defect is still open would be a stale status, unless another defect it tracks is open.
    }
  });
  it("keeps a defect marked fixed at its targets: every metric tracking only fixed defects starts at its target", () => {
    for (const [id, m] of Object.entries(b.metrics)) if (enforced(m, b)) expect(atTarget(m, m.baseline), `${id}: baseline ${m.baseline}, target ${m.target}`).toBe(true);
  });
  it("owns every run set of tests/golden/world-qa-runs.json by a suite", () => {
    const suites = new Set(Object.values(b.metrics).map((m) => m.suite));
    for (const set of Object.keys(loadRuns())) expect(suites.has(set.split("/")[0]!), set).toBe(true);
    expect(existsSync(join(ROOT, "tests/golden/world-qa-runs.json"))).toBe(true);
  });
});

describe("world gate baseline script (scripts/golden/world-baseline.ts)", () => {
  const spec: Omit<Spec, "baseline"> = { target: 0, better: "lower", unit: "u", defects: ["W-99"], targetWave: 2, suite: "s", cadence: "pr", desc: "d" };
  const fixed = (d: string): boolean => d === "W-99";
  it("refuses a definition that loosens the gate: target, direction, target wave, tier, enforcement", () => {
    expect(loosenings(spec, spec, fixed)).toEqual([]);
    expect(loosenings(spec, { ...spec, target: 0 - 1 }, fixed)).toEqual([]);
    expect(loosenings(spec, { ...spec, target: 5 }, fixed).join()).toMatch(/target loosened/);
    expect(loosenings({ ...spec, better: "higher", target: 0.9 }, { ...spec, better: "higher", target: 0.8 }, fixed).join()).toMatch(/target loosened/);
    expect(loosenings(spec, { ...spec, better: "higher" }, fixed).join()).toMatch(/direction flipped/);
    expect(loosenings(spec, { ...spec, targetWave: 3 }, fixed).join()).toMatch(/target wave later/);
    expect(loosenings(spec, { ...spec, targetWave: null }, fixed).join()).toMatch(/target wave later/);
    expect(loosenings(spec, { ...spec, cadence: "nightly" }, fixed).join()).toMatch(/per-PR tier/);
    expect(loosenings({ ...spec, cadence: "nightly" }, spec, fixed)).toEqual([]);
    expect(loosenings(spec, { ...spec, defects: ["W-99", "W-98"] }, fixed).join()).toMatch(/no longer enforced/);
    expect(loosenings({ ...spec, defects: ["W-98"] }, { ...spec, defects: ["W-98", "W-97"] }, fixed)).toEqual([]);
  });
  it("skips a record from another commit, from before the latest change, or without a stamp", () => {
    const head = "a".repeat(40);
    const t = Date.parse("2026-10-21T12:00:00Z");
    expect(staleness({ commit: head, at: "2026-10-21T12:00:01Z" }, head, t)).toBeNull();
    expect(staleness({ commit: head, at: "2026-10-21T11:59:59Z" }, head, t)).toMatch(/before the working tree's latest change/);
    expect(staleness({ commit: "b".repeat(40), at: "2026-10-21T12:00:01Z" }, head, t)).toMatch(/not HEAD/);
    expect(staleness({ at: "2026-10-21T12:00:01Z" }, head, t)).toMatch(/no commit stamp/);
    expect(staleness({ commit: head, at: "2026-10-21T12:00:01Z" }, head, 0)).toBeNull();
  });
});

describe("world gate pinned street sample (tests/helpers/world-gate/fixtures/drive-sample.json)", () => {
  const pinned = (JSON.parse(readFileSync(join(ROOT, "tests/helpers/world-gate/fixtures/drive-sample.json"), "utf8")) as { edges: string[] }).edges;
  const edge = (id: string, extra: Partial<RoadEdge> = {}): RoadEdge => ({ id, a: "n0", b: "n1", points: [[0, 0], [20, 0]], ...extra }) as unknown as RoadEdge;
  it("holds 300 distinct edge ids in id order", () => {
    expect(pinned.length).toBe(300);
    expect(new Set(pinned).size).toBe(300);
    expect([...pinned].sort((p, q) => (p < q ? -1 : 1))).toEqual(pinned);
  });
  it("drives the same edges whatever roads.json gains or loses around them", () => {
    // Every pinned edge plus streets added before, between and after them in id order: a sample
    // recomputed as every k-th edge would shift; the pinned one does not.
    const extra = ["c0", "c1", ...pinned.map((id) => `${id}a`), "czz"].map((id) => edge(id));
    const edges = new Map([...pinned.map((id) => edge(id)), ...extra].map((e) => [e.id, e] as const));
    expect(sampleEdges({ edges }).map((s) => s.id)).toEqual(pinned);
    expect(sampleEdges({ edges }).every((s) => s.edge !== null)).toBe(true);
    expect(chooseSample([...edges.values()])).not.toEqual(pinned);
    // A pinned edge gone from roads.json comes back null (the drive counts it as a failed run).
    edges.delete(pinned[7]!);
    const s = sampleEdges({ edges });
    expect(s.map((q) => q.id)).toEqual(pinned);
    expect(s.filter((q) => q.edge === null).map((q) => q.id)).toEqual([pinned[7]]);
  });
});

describe("world gate cover suite's copy of the renderer's ground tint", () => {
  it("matches src/render/scene.ts now, and fails loudly when the wiring changes", () => {
    expect(() => checkTintWiring()).not.toThrow();
    const scene = readFileSync(join(ROOT, "src/render/scene.ts"), "utf8");
    expect(() => checkTintWiring(scene.replace(/tintGround:[^\n]*\n/, "\n"))).toThrow(/tintGround/);
    expect(() => checkTintWiring(scene.replace(/parkShapes\(world\.districts/, "parkShapes(other"))).toThrow(/parkShapes/);
  });
});
