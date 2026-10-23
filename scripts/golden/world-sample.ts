// The world gate's pinned street sample (tests/helpers/world-gate/fixtures/drive-sample.json): the
// critic's seeded 300-edge sample of the surface streets, every k-th edge by id (k = ceil(N/300)),
// chosen once from roads.json and committed, so the drive/sample run set is the same on every run
// whatever later happens to roads.json (an edge added, removed or renamed shifts every later index
// of a sample recomputed each run). Refresh it only on purpose, in its own PR, with the drive suite's
// baseline (`pnpm world:baseline --accept-worse drive/sample` if the new sample's failing runs are
// new to the golden, saying why).
//
//   node scripts/golden/world-sample.ts           # print what a fresh sample would change
//   node scripts/golden/world-sample.ts --write   # rewrite the fixture from roads.json

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const FIXTURE = join(ROOT, "tests/helpers/world-gate/fixtures/drive-sample.json");

interface Edge {
  id: string;
  pedestrian?: boolean;
  gradeSeparated?: boolean;
  kind?: string;
}

/** Every k-th surface street edge by id: the rule the sample was chosen by. */
export function chooseSample(edges: readonly Edge[], n = 300): string[] {
  const es = edges.filter((e) => !e.pedestrian && e.gradeSeparated !== true && e.kind !== "freeway" && e.kind !== "ramp").sort((a, b) => (a.id < b.id ? -1 : 1));
  const k = Math.ceil(es.length / n);
  return es.filter((_, i) => i % k === 0).map((e) => e.id);
}

if (import.meta.main) {
  const roads = JSON.parse(readFileSync(join(ROOT, "public/tiles/sf/roads.json"), "utf8")) as { edges: Edge[] };
  const fresh = chooseSample(roads.edges);
  const old = (JSON.parse(readFileSync(FIXTURE, "utf8")) as { edges: string[] }).edges;
  const added = fresh.filter((id) => !old.includes(id));
  const removed = old.filter((id) => !fresh.includes(id));
  console.log(`fresh sample: ${fresh.length} edges; ${added.length} added, ${removed.length} removed against the fixture's ${old.length}`);
  if (process.argv.includes("--write")) {
    const doc = {
      source: "every k-th surface street edge of public/tiles/sf/roads.json by id, k = ceil(N/300) (the QA critic's seeded sample); chosen by scripts/golden/world-sample.ts and pinned, so the gate's drive/sample run set does not move when roads.json changes",
      edges: fresh,
    };
    writeFileSync(FIXTURE, JSON.stringify(doc, null, 1) + "\n");
    console.log(`wrote ${FIXTURE}`);
  }
}
