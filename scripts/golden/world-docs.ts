// Render the world gate's ratchet into the QA documents, between markers (run by
// `pnpm world:baseline` after it writes the baseline, or alone: node scripts/golden/world-docs.ts):
//   docs/qa/world-continuity-gate.md  the table of every metric, its baseline, target and state;
//   docs/qa/world-qa-status.md        each defect's status at the baseline build and its metrics.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");

interface Spec {
  baseline: number;
  target: number;
  better: "lower" | "higher";
  unit: string;
  defects: string[];
  suite: string;
  cadence: string;
  desc: string;
}
interface Defect {
  severity: string;
  status: string;
  title: string;
}

const fmt = (v: number): string => (Number.isInteger(v) ? String(v) : String(Math.round(v * 1e4) / 1e4));

export function renderDocs(): void {
  const b = JSON.parse(readFileSync(join(ROOT, "tests/golden/world-qa-baseline.json"), "utf8")) as { build: string; defects: Record<string, Defect>; metrics: Record<string, Spec> };
  const M = b.metrics;
  const D = b.defects;
  const enforced = (m: Spec): boolean => m.defects.every((x) => D[x]?.status === "fixed");
  const at = (m: Spec): boolean => (m.better === "lower" ? m.baseline <= m.target + 1e-9 : m.baseline >= m.target - 1e-9);
  const order: Record<string, number> = { pr: 0, e2e: 1, nightly: 2, "e2e-nightly": 3 };
  const ids = Object.keys(M).sort((p, q) => (order[M[p]!.cadence]! - order[M[q]!.cadence]!) || (M[p]!.suite < M[q]!.suite ? -1 : M[p]!.suite > M[q]!.suite ? 1 : p < q ? -1 : 1));
  const rows = ids.map((k) => {
    const m = M[k]!;
    const state = enforced(m) ? "enforced" : at(m) ? "at target" : "ratchet";
    return `| \`${k}\` | ${m.suite} (${m.cadence}) | ${m.defects.join(", ") || "pass check"} | ${fmt(m.baseline)} | ${m.better === "lower" ? "<=" : ">="} ${fmt(m.target)} ${m.unit} | ${state} | ${m.desc} |`;
  });
  const block = [
    "<!-- metrics:start (generated from tests/golden/world-qa-baseline.json by scripts/golden/world-docs.ts) -->",
    `### The metrics at ${b.build}`,
    "",
    `${ids.length} metrics. "enforced": every defect it tracks is fixed (or it is a pass check), so its target is a hard assertion; "ratchet": it may not get worse than its baseline; "at target": already there while a defect it tracks is still open.`,
    "",
    `| Metric | Suite (cadence) | Tracks | Baseline at ${b.build} | Target | State | What it measures |`,
    "|---|---|---|---|---|---|---|",
    ...rows,
    "<!-- metrics:end -->",
  ].join("\n");
  put("docs/qa/world-continuity-gate.md", /<!-- metrics:start[\s\S]*?<!-- metrics:end -->/, block);

  const bydef = new Map<string, string[]>();
  for (const [k, m] of Object.entries(M)) for (const x of m.defects) bydef.set(x, [...(bydef.get(x) ?? []), k]);
  const counts: Record<string, Record<string, number>> = {};
  for (const d of Object.values(D)) {
    if (d.severity === "low") continue;
    counts[d.severity] ??= {};
    counts[d.severity]![d.status] = (counts[d.severity]![d.status] ?? 0) + 1;
  }
  const lines = Object.keys(D)
    .sort()
    .filter((x) => D[x]!.severity !== "low" || bydef.has(x))
    .map((x) => {
      const d = D[x]!;
      const ms = (bydef.get(x) ?? []).sort().map((k) => `\`${k}\` ${fmt(M[k]!.baseline)} (${M[k]!.better === "lower" ? "<=" : ">="} ${fmt(M[k]!.target)})`).join("; ");
      return `| ${x} | ${d.severity} | **${d.status}** | ${d.title} | ${ms || "-"} |`;
    });
  const sblock = [
    "<!-- gate-status:start (generated from tests/golden/world-qa-baseline.json by scripts/golden/world-docs.ts) -->",
    `## Status at ${b.build}: the gate's baseline`,
    "",
    `The world-continuity gate (\`world-continuity-gate.md\`) measures every defect on the committed world. Each defect's status is kept in \`tests/golden/world-qa-baseline.json\` (the lane that fixes it flips it there); its metrics give the value at ${b.build} and the target that becomes a hard assertion once it is marked fixed.`,
    "",
    "| Severity | Defects | Fixed | Partly | Open |",
    "|---|---|---|---|---|",
    ...["blocker", "high", "medium"].map((s) => {
      const c = counts[s] ?? {};
      return `| ${s} | ${Object.values(c).reduce((a, n) => a + n, 0)} | ${c.fixed ?? 0} | ${c.partly ?? 0} | ${c.open ?? 0} |`;
    }),
    "",
    `| ID | Sev | Status | Defect | Metrics: baseline (target) |`,
    "|---|---|---|---|---|",
    ...lines,
    "<!-- gate-status:end -->",
  ].join("\n");
  put("docs/qa/world-qa-status.md", /<!-- gate-status:start[\s\S]*?<!-- gate-status:end -->/, sblock);
}

function put(rel: string, re: RegExp, block: string): void {
  const p = join(ROOT, rel);
  const s = readFileSync(p, "utf8");
  writeFileSync(p, re.test(s) ? s.replace(re, block) : s.replace(/\n*$/, "\n\n") + block + "\n");
}

if (import.meta.filename === process.argv[1]) {
  renderDocs();
  console.log("rendered docs/qa/world-continuity-gate.md and docs/qa/world-qa-status.md");
}
