// Vehicle dynamics in the browser, through real controls (car.ts, SIM_VERSION 15): on the dev
// world the player holds W from rest, then S to brake. The car pulls like a modern EV off the line
// (about 6 m/s^2 average, the old arcade car pulled 9.5) and brakes at about 1 g (ABS at the
// tyres' grip; the old car stopped at over 2 g). Rates are measured against the sim's ticks, so
// the frame rate of the software renderer does not matter. Only key presses reach the game.

import { expect, test, type Page } from "@playwright/test";
import { FAST_QUERY, FAST_VIEWPORT, bootWorld, simState } from "./fixtures.ts";
import type { SimState } from "../../src/sim/index.ts";

async function waitFor(page: Page, pred: (s: SimState) => boolean, timeout = 90_000): Promise<SimState> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const s = await simState(page);
    if (pred(s)) return s;
    if (Date.now() > deadline) throw new Error(`timed out at tick ${s.tick}`);
    await page.waitForTimeout(40);
  }
}

test.describe("vehicle dynamics through real controls", () => {
  test.use({ viewport: FAST_VIEWPORT });

  test("W pulls away at an EV's rate, S brakes at about 1 g", async ({ page }) => {
    const problems = await bootWorld(page, "dev", FAST_QUERY);
    const me = (await page.evaluate(() => (window as unknown as { __fogcity: { simInfo(): { playerIds: string[] } } }).__fogcity.simInfo().playerIds[0]))!;
    const car = (s: SimState) => s.players[me]!.car;

    // From rest: hold W until the car is past 12 m/s (about 2 s), and measure the average pull.
    const s0 = await simState(page);
    expect(car(s0).speed).toBe(0);
    await page.keyboard.down("KeyW");
    const moving = await waitFor(page, (s) => car(s).speed > 0);
    const fast = await waitFor(page, (s) => car(s).speed >= 12);
    await page.keyboard.up("KeyW");
    // (The first tick it moved had already pulled one tick's worth.)
    const ticks = fast.tick - moving.tick + 1;
    const pull = car(fast).speed / (ticks / 60);
    expect(pull, `0 to ${car(fast).speed.toFixed(1)} m/s in ${ticks} ticks`).toBeGreaterThan(5);
    expect(pull).toBeLessThan(7);

    // Brake with S (reverse throttle brakes first) until it stops: about 1 g.
    const v0 = car(await simState(page)).speed;
    await page.keyboard.down("KeyS");
    const braking = await waitFor(page, (s) => car(s).speed < v0 - 0.5);
    const stopped = await waitFor(page, (s) => car(s).speed <= 0);
    await page.keyboard.up("KeyS");
    const decel = car(braking).speed / ((stopped.tick - braking.tick) / 60);
    expect(decel, `from ${car(braking).speed.toFixed(1)} m/s to a stop in ${stopped.tick - braking.tick} ticks`).toBeGreaterThan(7.5);
    expect(decel).toBeLessThan(12.5);

    // Nothing was in the way: the run measured the car alone.
    expect((stopped.ext.impacts as { events?: unknown[] } | undefined)?.events ?? []).toEqual([]);
    expect(car(stopped).hits).toBe(0);
    expect(problems).toEqual([]);
  });
});
