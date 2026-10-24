// Player feel through real controls in the running SF game (the owner's playtest notes):
// the horn sounds and nearby people react.

import { expect, test } from "@playwright/test";
import { bootWorld, gateWorld, type FogWindow } from "./fixtures.ts";

test.describe.configure({ timeout: 360_000 });
test.use({ viewport: { width: 640, height: 400 } });

const SF_QUERY = "&gfx=default&radius=300&pr=0.5";

/** Counts horn tones started through Web Audio (the horn is synthesized, no sample file). */
async function countTones(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __tones: number };
    w.__tones = 0;
    const start = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function (this: OscillatorNode, ...args: Parameters<OscillatorNode["start"]>) {
      w.__tones++;
      return start.apply(this, args);
    };
  });
}

test("H sounds the horn and startles the people around the car", async ({ page }) => {
  gateWorld("sf");
  await countTones(page);
  const problems = await bootWorld(page, "sf", SF_QUERY, 150_000);
  // Let the street's people spawn around the car.
  await page.waitForFunction(() => {
    const s = (window as unknown as FogWindow).__fogcity!.state();
    return s.tick > 30 && !!(s.ext as Record<string, unknown>).robots;
  }, null, { timeout: 120_000 });
  const listeners = (): Promise<number> => page.evaluate(() => {
    const s = (window as unknown as FogWindow).__fogcity!.state();
    const car = s.players.p1!.car;
    const actors = Object.values((s.ext as { robots: { actors: Record<string, { model: string; x: number; z: number; retired: boolean }> } }).robots.actors);
    return actors.filter(a => !a.retired && a.model === "person" && Math.hypot(a.x - car.x, a.z - car.z) < 38).length;
  });
  expect(await listeners(), "people within earshot of the spawn").toBeGreaterThan(0);

  await page.keyboard.press("KeyH");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __tones: number }).__tones), { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(() => page.evaluate(() => {
    const s = (window as unknown as FogWindow).__fogcity!.state();
    const actors = Object.values((s.ext as { robots: { actors: Record<string, { model: string; reaction: { mode: string; source: { id: string } | null } }> } }).robots.actors);
    return actors.filter(a => a.model === "person" && a.reaction.mode !== "idle" && a.reaction.source?.id === "p1").length;
  }), { timeout: 60_000 }).toBeGreaterThan(0);
  expect(problems).toEqual([]);
});
