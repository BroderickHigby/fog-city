// Memory soak: the camera visits FiDi, the Embarcadero, the Marina and SoMa in turn, SOAK_LAPS
// times (default 3, at least 3), letting the tiles stream in at each stop. After each stop it
// records the renderer's live geometries, textures and programs, the geometries the scene holds,
// the tiles in the scene and the JS heap (after a forced collection).
//
// The first lap is the warm-up: the crowd and the traffic near the camera fill in as the game
// clock runs (on 86dfb90 FiDi goes from 133 live geometries to 174, then stays there). From the
// second lap on the city is in a steady state, and every later lap must come back to the second
// lap's figures at the same stop: streaming out a district has to free what streaming it in
// allocated, so a leak grows lap on lap. Writes soak.json to SOAK_OUT.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { bootWorld, frames, type FogWindow } from "../e2e/fixtures.ts";

const LAPS = Math.max(3, Number(process.env.SOAK_LAPS ?? 3));
const OUT = process.env.SOAK_OUT ?? "test-results/soak";
/** Local metres (src/geo/project.ts toLocal): street-level stops in four districts. */
const STOPS = [
  { name: "fidi", x: -599, z: 100 },
  { name: "embarcadero", x: -643, z: -943 },
  { name: "marina", x: -3814, z: -832 },
  { name: "soma", x: -643, z: 1887 },
] as const;
/** Growth allowed from the steady-state lap to any later lap at the same stop. */
const GROWTH = { objects: 1.05, objectsSlack: 8, heapMB: 32 };

interface Sample { lap: number; stop: string; geometries: number; sceneGeometries: number; textures: number; programs: number; tiles: number; heapMB: number; settledS: number }
interface ViewLike {
  renderer: { info: { memory: { geometries: number; textures: number }; programs: unknown[] | null } };
  scene: { traverse(fn: (o: { geometry?: unknown }) => void): void };
}

test("GPU objects and the JS heap hold steady lap after lap", async ({ page }) => {
  const problems = await bootWorld(page, "sf", process.env.SOAK_QUERY ?? "&quality=1&shadows=1&pr=1&debug=1", 240_000);
  const samples: Sample[] = [];
  for (let lap = 0; lap < LAPS; lap++) {
    for (const stop of STOPS) {
      const t0 = Date.now();
      await page.evaluate((s) => (window as unknown as FogWindow).__fogcity!.flyTo!(s.x, 40, s.z, 45, -10), stop);
      await frames(page, 3);
      await page.waitForFunction(() => {
        const i = (window as unknown as FogWindow).__fogcity!.renderInfo!();
        return (i.tilesPending ?? 0) === 0;
      }, null, { timeout: 300_000, polling: 1000 });
      await frames(page, 5);
      const m = await page.evaluate(() => {
        (globalThis as unknown as { gc?: () => void }).gc?.();
        const v = (window as unknown as { __fogcityView: ViewLike }).__fogcityView;
        const info = (window as unknown as FogWindow).__fogcity!.renderInfo!();
        const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
        const held = new Set<unknown>();
        v.scene.traverse((o) => { if (o.geometry) held.add(o.geometry); });
        const geometries = v.renderer.info.memory.geometries;
        return { geometries, sceneGeometries: held.size, textures: v.renderer.info.memory.textures, programs: v.renderer.info.programs?.length ?? 0, tiles: info.tilesLoaded ?? 0, heapMB: heap / 2 ** 20 };
      });
      samples.push({ lap, stop: stop.name, ...m, settledS: (Date.now() - t0) / 1000 });
      console.log(JSON.stringify(samples.at(-1)));
    }
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "soak.json"), JSON.stringify({ laps: LAPS, samples }, null, 1));
  expect(problems).toEqual([]);
  for (const stop of STOPS) {
    const first = samples.find((s) => s.lap === 1 && s.stop === stop.name)!;
    for (const later of samples.filter((s) => s.lap > 1 && s.stop === stop.name)) {
      expect(later.geometries, `${stop.name} lap ${later.lap} geometries`).toBeLessThanOrEqual(first.geometries * GROWTH.objects + GROWTH.objectsSlack);
      expect(later.textures, `${stop.name} lap ${later.lap} textures`).toBeLessThanOrEqual(first.textures * GROWTH.objects + GROWTH.objectsSlack);
      expect(later.programs, `${stop.name} lap ${later.lap} programs`).toBeLessThanOrEqual(first.programs + GROWTH.objectsSlack);
      expect(later.heapMB, `${stop.name} lap ${later.lap} JS heap`).toBeLessThanOrEqual(first.heapMB + GROWTH.heapMB);
    }
  }
});
