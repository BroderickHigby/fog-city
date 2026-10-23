import { expect, test } from "@playwright/test";
import { bootWorld, frames, type FogWindow } from "./fixtures.ts";

test.use({ viewport: { width: 1100, height: 740 } });

test("normal SF play uses the animated human avatar, and cameras never change game state", async ({ page }) => {
  const problems = await bootWorld(page, "sf", "&radius=300&pr=1");
  await page.keyboard.press("KeyF");
  await page.waitForFunction(() => {
    const game = (window as unknown as FogWindow).__fogcity!;
    return game.state().players.p1!.mode === "foot" && game.renderInfo!().walkersFromFile === 1;
  });
  const initial = await page.evaluate(() => {
    const game = (window as unknown as FogWindow).__fogcity!;
    game.pause();
    game.setCameraMode!("chase");
    return { hash: game.hash(), foot: game.state().players.p1!.foot! };
  });
  await frames(page, 3);
  await page.screenshot({ path: "test-results/avatar-human-third-person.png" });
  await page.evaluate(foot => {
    const game = (window as unknown as FogWindow).__fogcity!;
    game.flyTo!(foot.x + Math.sin(foot.heading) * 3.1, foot.y + 1.25,
      foot.z - Math.cos(foot.heading) * 3.1, foot.heading * 180 / Math.PI + 180, -4);
  }, initial.foot);
  await frames(page, 3);
  await page.screenshot({ path: "test-results/avatar-human-front.png" });
  expect(await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.hash())).toBe(initial.hash);
  await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.setCameraMode!("first-person"));
  await frames(page, 3);
  expect(await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.renderInfo!().walkersFromFile)).toBe(0);
  expect(await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.hash())).toBe(initial.hash);
  expect(problems).toEqual([]);
});
