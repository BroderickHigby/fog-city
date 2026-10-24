import { expect, test } from "@playwright/test";
import type { SceneRenderer } from "../../src/render/scene.ts";
import { bootWorld, type FogWindow } from "./fixtures.ts";

test.use({ viewport: { width: 600, height: 400 } });

test("automatic graphics recovery reduces a small drawing buffer during sustained render overload", async ({ page }) => {
  const problems = await bootWorld(page, "dev", "&debug=1&radius=250");
  await page.waitForFunction(() => (window as unknown as { __fogcityView: SceneRenderer }).__fogcityView.tilesSettled(), null, { timeout: 60_000 });
  const result = await page.evaluate(() => {
    const game = (window as unknown as FogWindow).__fogcity!;
    game.pause();
    const view = (window as unknown as { __fogcityView: SceneRenderer }).__fogcityView;
    const pixels = (): number => view.renderer.domElement.width * view.renderer.domElement.height;
    const beforePixels = pixels(), beforeHash = game.hash();
    // Exercise the real frame call with the tick-backlog hint that follows a GPU stall.
    // The governor should still count the render time after subtracting simulation time.
    for (let frame = 0; frame < 80; frame++) {
      view.frame(0.1, null, { forward: 0, right: 0, up: 0, yaw: 0, pitch: 0, boost: false }, 480, 2, 0.01, true);
    }
    return { beforePixels, afterPixels: pixels(), beforeHash, afterHash: game.hash(), gfx: view.info().gfx };
  });
  expect(result.afterHash).toBe(result.beforeHash);
  expect(result.gfx?.steps).toEqual(["pixels", "pixels"]);
  expect(result.afterPixels).toBeLessThan(result.beforePixels);
  expect(result.afterPixels).toBeGreaterThanOrEqual(600 * 400 * 0.5 ** 2);
  expect(problems).toEqual([]);
});
