import { expect, test } from "@playwright/test";
import type {} from "../../src/debug.ts";
import { bootWorld, frames } from "./fixtures.ts";

test("high graphics loads characters and renders every lighting preset without shader errors", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 400 });
  const problems = await bootWorld(page, "dev", "&gfx=high&pr=0.5&debug=1");
  await page.waitForFunction(() => {
    const gfx = window.__fogcity?.renderInfo().gfx;
    return gfx?.characters.crowd && gfx.characters.player && gfx.detailSets > 0;
  }, null, { timeout: 60_000 });
  await page.evaluate(() => window.__fogcity!.pause());
  for (const preset of ["noon", "golden", "night"] as const) {
    const result = await page.evaluate((preset) => {
      const game = window.__fogcity!;
      const hash = game.hash();
      game.setTimeOfDay!(preset);
      return { hash, after: game.hash() };
    }, preset);
    expect(result.after).toBe(result.hash);
    await frames(page, 2);
  }
  const info = await page.evaluate(() => window.__fogcity!.renderInfo());
  expect(info.gfx.tier).toBe("high");
  expect(info.gfx.post).toBe(true);
  expect(info.drawCalls).toBeGreaterThan(0);
  expect(problems).toEqual([]);
});
