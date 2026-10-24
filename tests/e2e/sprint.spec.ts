// Sprinting through real keys (owner playtest: "I'm walking too slowly ... there should be a
// way to run"): W jogs and the first jog after getting out shows how to sprint, Shift+W sprints at about
// 7 m/s, and letting go of Shift drops back to the jog.

import { expect, test } from "@playwright/test";
import { FAST_QUERY, FAST_VIEWPORT, bootWorld, type FogWindow } from "./fixtures.ts";

test.use({ viewport: FAST_VIEWPORT });
test.describe.configure({ timeout: 360_000 });

const foot = (page: import("@playwright/test").Page) =>
  page.evaluate(() => (window as unknown as FogWindow).__fogcity!.state().players.p1!.foot);

test("Shift+W sprints on foot, W alone jogs", async ({ page }) => {
  const problems = await bootWorld(page, "dev", FAST_QUERY);
  await page.keyboard.press("KeyF");
  await page.waitForFunction(() => (window as unknown as FogWindow).__fogcity!.state().players.p1!.mode === "foot", null, { timeout: 60_000 });
  await page.keyboard.down("KeyW");
  // Jogging off for the first time, the hint says how to sprint.
  await expect.poll(() => page.evaluate(() => (window as unknown as FogWindow).__fogcity!.hint?.() ?? ""), { timeout: 60_000 })
    .toBe("Hold Shift to sprint");
  await expect.poll(async () => (await foot(page))?.speed ?? 0, { timeout: 60_000 }).toBeGreaterThan(2.8);
  expect((await foot(page))?.sprint).toBe(false);
  await page.keyboard.down("ShiftLeft");
  await expect.poll(async () => (await foot(page))?.speed ?? 0, { timeout: 60_000 }).toBeGreaterThan(6.5);
  expect((await foot(page))?.sprint).toBe(true);
  await page.keyboard.up("ShiftLeft");
  await expect.poll(async () => (await foot(page))?.speed ?? 99, { timeout: 60_000 }).toBeLessThan(3.1);
  await page.keyboard.up("KeyW");
  expect(problems).toEqual([]);
});
