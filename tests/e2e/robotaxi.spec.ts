// Robotaxi rides in the running game (owner playtest: "You also should be able to hop in
// Waymos as well"; in the game they are original robotaxis). On the dev world: walk up to a
// robotaxi (stepped inputs only, like the gameplay driver), F hops in, a waypoint set on the
// phone map becomes the ride's goal, the camera follows the taxi, and the real F key gets the
// player out beside it, with no contact.

import { expect, test } from "@playwright/test";
import { FAST_QUERY, FAST_VIEWPORT, bootWorld, type FogWindow } from "./fixtures.ts";

test.use({ viewport: FAST_VIEWPORT });
test.describe.configure({ timeout: 360_000 });

type Ride = { agentId: number; x: number; z: number; speed: number; goal: { x: number; z: number } | null } | null | undefined;
const ride = (page: import("@playwright/test").Page): Promise<Ride> =>
  page.evaluate(() => ((window as unknown as FogWindow).__fogcity!.state().players.p1 as unknown as { ride?: Ride }).ride);

test("walk up to a robotaxi, F hops in, ride to a map waypoint, F gets out", async ({ page }) => {
  const problems = await bootWorld(page, "dev", FAST_QUERY);
  await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.pause());
  // Out of the car, then walk (inputs only) to the left side of the nearest robotaxi and press F
  // once it has stopped for us (robotaxis stop for anyone on foot in their way).
  const boarded = await page.evaluate(() => {
    const h = (window as unknown as FogWindow).__fogcity!;
    const idle = { throttle: 0, steer: 0, brake: 0, actions: 0 };
    h.stepFrames!([{ p1: { ...idle, actions: 1 } }]);
    for (let i = 0; i < 60; i++) h.stepFrames!([{ p1: idle }]);
    for (let tick = 0; tick < 6000; tick++) {
      const s = h.state();
      const me = s.players.p1 as unknown as { ride?: unknown; foot: { x: number; z: number; heading: number } | null };
      if (me.ride) return true;
      if (!me.foot) return false;
      const taxis = ((s.ext as { agents?: { list: Array<{ kind: string; x: number; z: number; heading: number; speed: number; runtimeId?: string }> } }).agents?.list ?? [])
        .filter((a) => a.kind === "robotaxi" && a.runtimeId === undefined);
      let best = taxis[0], bestD = Infinity;
      for (const t of taxis) {
        const d = Math.hypot(t.x - me.foot.x, t.z - me.foot.z);
        if (d < bestD) { bestD = d; best = t; }
      }
      if (!best) return false;
      // Aim for a point 2 m off the taxi's left side.
      const gx = best.x - Math.cos(best.heading) * 2.2, gz = best.z - Math.sin(best.heading) * 2.2;
      const dx = gx - me.foot.x, dz = gz - me.foot.z, dist = Math.hypot(dx, dz);
      const want = Math.atan2(dx, -dz);
      let err = want - me.foot.heading;
      while (err > Math.PI) err -= 2 * Math.PI;
      while (err < -Math.PI) err += 2 * Math.PI;
      const near = bestD < 4.5 && Math.abs(best.speed) < 1.2;
      h.stepFrames!([{ p1: { throttle: dist > 0.6 && Math.abs(err) < 0.7 ? 1 : 0, steer: Math.max(-1, Math.min(1, err * 4)), brake: 0, actions: near && tick % 10 === 0 ? 1 : 0 } }]);
    }
    return false;
  });
  expect(boarded, "hopped into a robotaxi").toBe(true);
  const first = await ride(page);
  expect(first?.agentId).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.state().players.p1!.mode)).toBe("vehicle");
  await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.resume());

  // A waypoint on the phone map becomes the ride's goal.
  await page.getByRole("button", { name: "Open phone" }).click();
  await page.getByRole("button", { name: "Map", exact: true }).click();
  const map = page.locator("canvas.fc-phone-map");
  const box = (await map.boundingBox())!;
  await map.click({ position: { x: box.width * 0.8, y: box.height * 0.5 } });
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await ride(page))?.goal ?? null, { timeout: 60_000 }).not.toBeNull();
  // The taxi drives off with the player aboard.
  await expect.poll(async () => Math.abs((await ride(page))?.speed ?? 0), { timeout: 90_000 }).toBeGreaterThan(1);

  // The real F key: the taxi stops and the player steps out beside it.
  await page.keyboard.press("KeyF");
  await expect.poll(() => page.evaluate(() => (window as unknown as FogWindow).__fogcity!.state().players.p1!.mode), { timeout: 90_000 }).toBe("foot");
  expect(await ride(page) ?? null).toBeNull();
  const contacts = await page.evaluate(() => ((window as unknown as FogWindow).__fogcity!.state().ext as { dodge?: { contacts: number } }).dodge?.contacts ?? 0);
  expect(contacts).toBe(0);
  expect(problems).toEqual([]);
});
