// Chase camera orbit through the real mouse (owner playtest: "you should be able to like click
// and hold and drag around"): click-hold-drag on the view swings the camera round the car, the
// compass follows the view, and the sim never sees it (the hash is unchanged while paused).

import { expect, test } from "@playwright/test";
import { FAST_QUERY, FAST_VIEWPORT, bootWorld, type FogWindow } from "./fixtures.ts";

test.use({ viewport: FAST_VIEWPORT });
test.describe.configure({ timeout: 360_000 });

const bearing = (page: import("@playwright/test").Page): Promise<number> =>
  page.evaluate(() => Number.parseInt(document.querySelector("#compass .label")?.textContent ?? "NaN", 10));

test("click-hold-drag orbits the chase camera without touching the sim", async ({ page }) => {
  const problems = await bootWorld(page, "dev", FAST_QUERY);
  await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.pause());
  const hash = await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.hash());
  await expect.poll(() => bearing(page), { timeout: 60_000 }).not.toBeNaN();
  const start = await bearing(page);
  const box = (await page.locator("#game > canvas").boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  // 0.006 rad per pixel: 150 px is about 52 degrees to the right.
  for (let i = 1; i <= 10; i++) await page.mouse.move(x + i * 15, y);
  await page.mouse.up();
  await expect.poll(async () => ((await bearing(page)) - start + 360) % 360, { timeout: 60_000 }).toBeGreaterThan(35);
  expect(((await bearing(page)) - start + 360) % 360).toBeLessThan(70);
  expect(await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.hash())).toBe(hash);
  expect(problems).toEqual([]);
});
