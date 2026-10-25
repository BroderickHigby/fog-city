// Captures the Ferry/Market vertical slice (tests/render/visual-slice.views.json) to
// $SLICE_OUT (default test-results/visual-slice/): <id>.png per view, and slice.json with each
// view's camera, lighting, render figures (draw calls, triangles, GPU resources, an estimate of
// texture memory) and frame time over 30 frames. SLICE_VIEWS=id,id picks views. On SwiftShader
// the frame times are software figures; on a GPU machine set SLICE_GPU=1 to drop the
// software-GL flags. The HUD is hidden unless SLICE_HUD=1.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "@playwright/test";
import { groundHeight } from "../../src/sim/index.ts";
import { ROOT, loadWorld } from "../helpers.ts";
import { bootWorld, frames, renderInfo, settle, type FogWindow } from "../e2e/fixtures.ts";

interface View { id: string; title: string; x: number; z: number; up: number; yaw: number; pitch: number; tod: "noon" | "golden" | "twilight" | "night" }
const spec = JSON.parse(readFileSync(join(import.meta.dirname, "visual-slice.views.json"), "utf8")) as { query: string; views: View[] };
const OUT = resolve(ROOT, process.env.SLICE_OUT ?? "test-results/visual-slice");
const pick = process.env.SLICE_VIEWS?.split(",").filter(Boolean);
const views = pick ? spec.views.filter((v) => pick.includes(v.id)) : spec.views;

type SliceHandle = {
  setTimeOfDay?(name: View["tod"]): void;
  renderStats?(): Record<string, unknown>;
};

test("visual slice", async ({ page }) => {
  test.setTimeout(3_600_000);
  mkdirSync(OUT, { recursive: true });
  const { world } = loadWorld("sf");
  const problems = await bootWorld(page, "sf", spec.query, 240_000);
  // The 3D view only: the HUD, mission cards and compass stay out of the picture (SLICE_HUD=1 keeps them).
  if (!process.env.SLICE_HUD) await page.addStyleTag({ content: "body > :not(#game), #game > :not(canvas) { visibility: hidden !important; }" });
  const out: unknown[] = [];
  for (const v of views) {
    await page.evaluate((tod) => {
      const h = (window as unknown as { __fogcity: SliceHandle & { setNight(n: boolean): void } }).__fogcity;
      if (h.setTimeOfDay) h.setTimeOfDay(tod);
      else h.setNight(tod === "night");
    }, v.tod);
    const gy = groundHeight(world, v.x, v.z);
    await page.evaluate(([x, y, z, yaw, pitch]) => (window as unknown as FogWindow).__fogcity!.flyTo!(x!, y!, z!, yaw!, pitch!), [v.x, gy + v.up, v.z, v.yaw, v.pitch]);
    const settled = await settle(page, 600_000);
    await frames(page, 8);
    // Frame time: rAF intervals over 30 frames (median and 90th percentile, ms).
    const ft = await page.evaluate(
      () =>
        new Promise<{ median: number; p90: number }>((done) => {
          const t: number[] = [];
          let last = performance.now();
          const tick = (now: number): void => {
            t.push(now - last);
            last = now;
            if (t.length < 30) requestAnimationFrame(tick);
            else {
              t.sort((a, b) => a - b);
              done({ median: t[15]!, p90: t[27]! });
            }
          };
          requestAnimationFrame(tick);
        }),
    );
    const info = await renderInfo(page);
    const stats = await page.evaluate(() => (window as unknown as { __fogcity: SliceHandle }).__fogcity.renderStats?.() ?? null);
    await page.screenshot({ path: join(OUT, `${v.id}.png`) });
    out.push({ ...v, groundY: gy, settled, frameMs: ft, software: !process.env.SLICE_GPU, render: info, gpu: stats });
  }
  writeFileSync(join(OUT, "slice.json"), JSON.stringify({ query: spec.query, problems, views: out }, null, 1));
});
