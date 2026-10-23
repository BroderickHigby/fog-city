// Browser half of the cross-engine determinism test (tests/e2e/determinism.spec.ts).
// Loaded by sim-lab.html through the Vite dev server, so the browser runs exactly the
// TypeScript in src/sim, fetched over HTTP from the same files Node reads from disk.

import { looseAssets } from "../../src/io/assets.ts";
import { loadWorldFiles } from "../../src/io/world-load.ts";
import { SIM_VERSION } from "../../src/sim/index.ts";
import { dmathDigest, makeWorld, runScenario, type ScenarioOptions, type ScenarioResult } from "./determinism-scenario.ts";

export interface SimLab {
  ready: true;
  simVersion: number;
  userAgent: string;
  /**
   * Load public/tiles/<world>/ over HTTP the way the game does (src/io/world-load.ts: the collider
   * pack when the manifest names one, the road graph, the boundary), build the world, run the scenario.
   */
  run(world: string, opts: Omit<ScenarioOptions, "spawn">): Promise<ScenarioResult & { loadMs: number; runMs: number; colliders: "pack" | "json" }>;
  dmath(n?: number): Record<string, string>;
}

declare global {
  interface Window {
    __simlab?: SimLab;
  }
}

window.__simlab = {
  ready: true,
  simVersion: SIM_VERSION,
  userAgent: navigator.userAgent,
  async run(world, opts) {
    const t0 = performance.now();
    // sim-lab.html lives at /tests/e2e/: the worlds are at the server root.
    const files = await loadWorldFiles(looseAssets("/"), world);
    const w = makeWorld(files.tiles, files.roads, files.boundary, files.gameplay ?? undefined, files.transit ?? undefined);
    const t1 = performance.now();
    const result = runScenario(w, { ...opts, spawn: files.manifest.spawn });
    return { ...result, loadMs: t1 - t0, runMs: performance.now() - t1, colliders: files.colliders };
  },
  dmath: (n) => dmathDigest(n),
};

const status = document.getElementById("status");
if (status) status.textContent = `sim lab ready (sim v${SIM_VERSION})`;
