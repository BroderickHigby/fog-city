// WebGL context loss in the real game (src/render/context-guard.ts): drawing pauses while the sim
// and UI carry on, and resumes when the context comes back; a second loss in a short while saves,
// reloads, and comes back in safe mode (the low tier).
import { expect, test } from "@playwright/test";
import { bootWorld, frames, type FogWindow } from "../e2e/fixtures.ts";

/** The debug handle's context-loss hooks (src/debug.ts), not in the shared fixtures' Handle type. */
type GpuHooks = { __fogcity: { loseContext(): void; restoreContext(): void } };


test("a lost context pauses drawing, the sim runs on, and drawing resumes on restore", async ({ page }) => {
  const problems = await bootWorld(page, "sf", "&radius=300&pr=1", 240_000);
  await frames(page, 3);
  const before = await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.state().tick);
  await page.evaluate(() => (window as unknown as GpuHooks).__fogcity.loseContext());
  await expect(page.locator(".fc-gfx-notice")).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction((t) => (window as unknown as FogWindow).__fogcity!.state().tick > t + 30, before, { timeout: 120_000 });
  await page.evaluate(() => (window as unknown as GpuHooks).__fogcity.restoreContext());
  await expect(page.locator(".fc-gfx-notice")).toBeHidden({ timeout: 60_000 });
  await frames(page, 3);
  expect(await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.renderInfo!().drawCalls)).toBeGreaterThan(10);
  // Context loss reports itself as a console warning in some Chromium builds; nothing else may.
  expect(problems.filter((p) => !/context lost|CONTEXT_LOST/i.test(p))).toEqual([]);
});

test("a second loss within the repeat window saves, reloads and resumes in safe mode", async ({ page }) => {
  await bootWorld(page, "sf", "&radius=300", 240_000);
  await frames(page, 3);
  await page.evaluate(() => (window as unknown as GpuHooks).__fogcity.loseContext());
  await expect(page.locator(".fc-gfx-notice")).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => (window as unknown as GpuHooks).__fogcity.restoreContext());
  await expect(page.locator(".fc-gfx-notice")).toBeHidden({ timeout: 60_000 });
  const reloaded = page.waitForEvent("load", { timeout: 120_000 });
  await page.evaluate(() => (window as unknown as GpuHooks).__fogcity.loseContext());
  await reloaded;
  await page.waitForFunction(() => (window as unknown as FogWindow).__fogcity?.ready === true, null, { timeout: 240_000 });
  const info = await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.renderInfo!() as unknown as { gfx?: { tier: string } });
  expect(info.gfx?.tier).toBe("low");
  expect(await page.evaluate(() => sessionStorage.getItem("fogcity.gfx.safe"))).toBe("1");
  expect(await page.evaluate(() => sessionStorage.getItem("fogcity.resume"))).toBeNull();
});
