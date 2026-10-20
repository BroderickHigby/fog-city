import { expect, test } from "@playwright/test";
import type {} from "../../src/debug.ts"; // window.__fogcity typing

test("dev world boots, drives forward, and stops at the wall", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?world=dev");
  await page.waitForFunction(() => window.__fogcity?.ready === true, null, { timeout: 60_000 });

  // Real keyboard input reaches the sim.
  const z0 = await page.evaluate(() => window.__fogcity!.state().players.p1!.car.z);
  await page.keyboard.down("KeyW");
  await page.waitForFunction((z) => window.__fogcity!.state().players.p1!.car.z < z - 2, z0, { timeout: 30_000 });
  await page.keyboard.up("KeyW");

  // Deterministic stepping: 10 s of full throttle ends against the wall, not through it.
  const car = await page.evaluate(() => {
    const h = window.__fogcity!;
    h.pause();
    h.stepN(600, { throttle: 1, steer: 0, brake: 0, actions: 0 });
    return h.state().players.p1!.car;
  });
  expect(car.hits).toBeGreaterThan(0);
  expect(car.z).toBeGreaterThan(-60);

  await page.screenshot({ path: "test-results/smoke-dev.png" });
  expect(errors).toEqual([]);
});
