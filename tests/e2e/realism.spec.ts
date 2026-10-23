import { expect, test } from "@playwright/test";
import { bootWorld, frames, type FogWindow } from "./fixtures.ts";

test.use({ viewport: { width: 1280, height: 800 } });
test("SF high-quality presentation compiles, draws leaf foliage and preserves the simulation", async ({ page }) => {
  test.setTimeout(300_000);
  const problems = await bootWorld(page, "sf", "&quality=1&shadows=1&tod=golden&radius=350&pr=1");
  const initial = await page.evaluate(() => {
    const game = (window as unknown as FogWindow).__fogcity!;
    game.pause();
    // Drain the queued boot mission command before taking the paused reference snapshot.
    game.stepN(1);
    return game.hash();
  });
  await page.waitForFunction(() => ((window as unknown as FogWindow).__fogcity!.renderInfo!().foliage?.near ?? 0) > 0);
  await page.waitForFunction(() => (window as unknown as FogWindow).__fogcity!.renderInfo!().surfaceTextures?.length === 2);
  await frames(page, 3);
  const info = await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.renderInfo!());
  expect(info.presentation).toBe(true);
  expect(info.surfaceTextures).toEqual(["asphalt", "concrete"]);
  expect(info.shadows).toBe(true);
  expect(info.lightingPreset).toBe("golden");
  expect(info.foliage!.draws).toBeGreaterThan(0);
  expect(info.foliage!.draws).toBeLessThanOrEqual(8);
  await page.screenshot({ path: "test-results/realism-golden.png" });
  await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.flyTo!(-130, 8, 110, 53, -2));
  await page.waitForFunction(() => (window as unknown as FogWindow).__fogcity!.tilesSettled!(), null, { timeout: 120_000 });
  await frames(page, 3);
  await page.screenshot({ path: "test-results/realism-ferry-golden.png" });
  await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.setNight!(true));
  await frames(page, 3);
  await page.screenshot({ path: "test-results/realism-night.png" });
  expect(await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.hash())).toBe(initial);
  expect(problems).toEqual([]);
});
