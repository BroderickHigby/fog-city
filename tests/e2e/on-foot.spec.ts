// M0 acceptance for on-foot play, through real key presses in the running game (dev world):
// F gets out, the walker is drawn and moves while the car stays parked (the HUD shows the
// walking speed), F next to the car gets back in.
// Skips while the sim has no on-foot state (PlayerState.foot arrives with sim v2).

import { expect, test } from "@playwright/test";
import type { PlayerState } from "../../src/sim/contract.ts";
import { FAST_QUERY, FAST_VIEWPORT, bootWorld, features, frames, gate, renderInfo, simState, type FogWindow } from "./fixtures.ts";

/** PlayerState as sim contract v2 has it; this file must also compile against v1. */
type Player = Omit<PlayerState, "foot"> & { foot?: { x: number; z: number; heading: number } | null };
const p1 = (s: { players: Record<string, unknown> }): Player => s.players.p1 as Player;

test.use({ viewport: FAST_VIEWPORT });

test("on foot: F exits, the walker moves, F near the car re-enters", async ({ page }) => {
  const problems = await bootWorld(page, "dev", FAST_QUERY);
  const p0 = p1(await simState(page));
  gate("foot", "foot" in p0, "on-foot play is not in this sim yet: PlayerState has no `foot` (sim contract v2)");
  expect(p0.mode).toBe("vehicle");

  // F gets out of the stopped car.
  await page.keyboard.press("KeyF");
  await page.waitForFunction(() => (window as unknown as FogWindow).__fogcity!.state().players.p1!.mode === "foot", null, {
    timeout: 15_000,
  });
  const out = p1(await simState(page));
  const walker0 = out.foot!;
  const car = out.car;
  const gap0 = Math.hypot(walker0.x - car.x, walker0.z - car.z);
  expect(gap0, "the walker stands beside the car, not in it").toBeGreaterThan(0.5);
  expect(gap0).toBeLessThan(6);

  // The renderer draws the walker (the person builder), and the camera follows it.
  if ((await features(page)).renderInfo) {
    await frames(page, 3);
    expect((await renderInfo(page))?.walkers, "players drawn on foot").toBe(1);
  }

  // W walks, and the HUD shows walking speed (1.6 m/s = 6 km/h), not the parked car's 0.
  await page.keyboard.down("KeyW");
  await page.waitForFunction(() => /\b[3-9] km\/h .*on foot/.test(document.getElementById("hud")?.textContent ?? ""), null, { timeout: 30_000 });
  await page.waitForFunction(
    (w) => {
      const f = ((window as unknown as FogWindow).__fogcity!.state().players.p1 as unknown as { foot?: { x: number; z: number } | null }).foot;
      return !!f && Math.hypot(f.x - w.x, f.z - w.z) > 1.5;
    },
    walker0,
    { timeout: 30_000 },
  );
  await page.keyboard.up("KeyW");
  await frames(page, 2);
  const walked = p1(await simState(page));
  expect(walked.mode).toBe("foot");
  // The car stays parked exactly where it was left.
  expect([walked.car.x, walked.car.z, walked.car.heading]).toEqual([car.x, car.z, car.heading]);

  // S walks back towards the car.
  await page.keyboard.down("KeyS");
  await page.waitForFunction(
    ({ c, gap }) => {
      const f = ((window as unknown as FogWindow).__fogcity!.state().players.p1 as unknown as { foot?: { x: number; z: number } | null }).foot;
      return !!f && Math.hypot(f.x - c.x, f.z - c.z) <= gap + 0.5;
    },
    { c: { x: car.x, z: car.z }, gap: gap0 },
    { timeout: 30_000 },
  );
  await page.keyboard.up("KeyS");

  // F next to the car gets back in, and W drives it again.
  await page.keyboard.press("KeyF");
  await page.waitForFunction(() => (window as unknown as FogWindow).__fogcity!.state().players.p1!.mode === "vehicle", null, {
    timeout: 15_000,
  });
  const back = p1(await simState(page));
  expect(back.foot).toBeNull();
  if ((await features(page)).renderInfo) {
    await frames(page, 3);
    expect((await renderInfo(page))?.walkers, "no walker once back in the car").toBe(0);
  }
  await page.keyboard.down("KeyW");
  await page.waitForFunction(
    (c) => {
      const now = (window as unknown as FogWindow).__fogcity!.state().players.p1!.car;
      return Math.hypot(now.x - c.x, now.z - c.z) > 2;
    },
    { x: back.car.x, z: back.car.z },
    { timeout: 30_000 },
  );
  await page.keyboard.up("KeyW");
  expect(problems).toEqual([]);
});
