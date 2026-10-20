// Browser half of the cross-engine determinism test (tests/e2e/determinism.spec.ts).
// Loaded by sim-lab.html through the Vite dev server, so the browser runs exactly the
// TypeScript in src/sim, fetched over HTTP from the same files Node reads from disk.

import { SIM_VERSION } from "../../src/sim/index.ts";
import { dmathDigest, makeWorld, runScenario, type ScenarioOptions, type ScenarioResult } from "./determinism-scenario.ts";

export interface SimLab {
  ready: true;
  simVersion: number;
  userAgent: string;
  /** Load public/tiles/<world>/ over HTTP, build the world (with its road graph), run the scenario. */
  run(world: string, opts: Omit<ScenarioOptions, "spawn">): Promise<ScenarioResult & { loadMs: number; runMs: number }>;
  dmath(n?: number): Record<string, string>;
}

declare global {
  interface Window {
    __simlab?: SimLab;
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

interface Manifest {
  spawn: { x: number; z: number; heading: number };
  tiles: Array<{ collider: string }>;
  roads?: string | null;
}

window.__simlab = {
  ready: true,
  simVersion: SIM_VERSION,
  userAgent: navigator.userAgent,
  async run(world, opts) {
    const t0 = performance.now();
    const base = `/tiles/${world}/`;
    const manifest = await fetchJson<Manifest>(`${base}manifest.json`);
    const tiles = await Promise.all(manifest.tiles.map((t) => fetchJson<Parameters<typeof makeWorld>[0][number]>(base + t.collider)));
    const roads = manifest.roads ? await fetchJson<unknown>(base + manifest.roads) : null;
    const w = makeWorld(tiles, roads);
    const t1 = performance.now();
    const result = runScenario(w, { ...opts, spawn: manifest.spawn });
    return { ...result, loadMs: t1 - t0, runMs: performance.now() - t1 };
  },
  dmath: (n) => dmathDigest(n),
};

const status = document.getElementById("status");
if (status) status.textContent = `sim lab ready (sim v${SIM_VERSION})`;
