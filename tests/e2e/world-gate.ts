// The world-continuity gate's browser half (docs/qa/world-continuity-gate.md, section G): judge a
// Playwright spec's measurements against tests/golden/world-qa-baseline.json, like the Vitest
// suites do (tests/helpers/world-gate/suite.ts), and record them for `pnpm world:baseline`.

import { expect } from "@playwright/test";
import { toLocal } from "../../src/geo/project.ts";
import { readJson } from "../helpers.ts";
import { Measured, writeSpecs } from "../helpers/world-gate/measured.ts";
import { judge, loadBaseline, record, suiteMetrics } from "../helpers/world-gate/ratchet.ts";

export { Measured };

/** Record, then assert each metric (soft, so one failing metric does not hide the others). */
export function judgeMeasured(m: Measured): void {
  record(m.suite, m.values, m.runs);
  writeSpecs(m.suite, m);
  if (process.env.WORLD_GATE_RECORD === "1") return;
  const b = loadBaseline();
  const ids = suiteMetrics(m.suite, b);
  expect(Object.keys(m.values).sort(), `${m.suite}: measured exactly the baseline's metrics (run \`pnpm world:baseline\` after adding one)`).toEqual(ids);
  for (const id of ids) {
    const v = judge(id, m.values[id]!, b);
    if (v.reminder) console.log(`[world gate] ${v.reminder}`);
    expect.soft(v.messages, `${id}${m.details[id] !== undefined ? ` details: ${JSON.stringify(m.details[id]).slice(0, 800)}` : ""}`).toEqual([]);
  }
}

interface RoadsLite {
  edges: Array<{ id: string; name?: string; pedestrian?: boolean; points: Array<[number, number]> }>;
}

/** The street nearest a lat/lon point: the point on it, its compass heading there (radians) and the edge. */
export function onStreet(lat: number, lon: number, name?: RegExp): { x: number; z: number; heading: number; edge: string } {
  const p = toLocal(lat, lon);
  const roads = readJson<RoadsLite>("public/tiles/sf/roads.json");
  let best = { x: p.x, z: p.z, heading: 0, edge: "", d: Infinity };
  for (const e of roads.edges) {
    if (e.pedestrian || (name && !name.test(e.name ?? ""))) continue;
    for (let i = 1; i < e.points.length; i++) {
      const [ax, az] = e.points[i - 1]!;
      const [bx, bz] = e.points[i]!;
      const ex = bx - ax;
      const ez = bz - az;
      const l2 = ex * ex + ez * ez || 1;
      const t = Math.max(0, Math.min(1, ((p.x - ax) * ex + (p.z - az) * ez) / l2));
      const x = ax + ex * t;
      const z = az + ez * t;
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < best.d) best = { x, z, heading: Math.atan2(ex, -ez), edge: e.id, d };
    }
  }
  return best;
}
