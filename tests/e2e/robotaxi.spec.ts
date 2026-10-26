// Robotaxi rides in the running game (owner playtest: "You also should be able to hop in
// Waymos as well"; in the game they are original robotaxis). In SF: walk up to a
// robotaxi (stepped inputs only, like the gameplay driver), F hails it and F beside it hops in, a waypoint set on the
// phone map becomes the ride's goal, the camera follows the taxi, and the real F key gets the
// player out beside it, with no contact.

import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { FAST_VIEWPORT, bootWorld, gateWorld, type FogWindow } from "./fixtures.ts";

test.use({ viewport: FAST_VIEWPORT });
test.describe.configure({ timeout: 360_000 });

type Ride = { agentId: number; x: number; z: number; heading: number; speed: number; manual?: true; goal: { x: number; z: number } | null } | null | undefined;
const ride = (page: import("@playwright/test").Page): Promise<Ride> =>
  page.evaluate(() => ((window as unknown as FogWindow).__fogcity!.state().players.p1 as unknown as { ride?: Ride }).ride);

test("F rides to a map waypoint, H takes control, WASD drives the same taxi and F gets out", async ({ page }) => {
  gateWorld("sf");
  const problems = await bootWorld(page, "sf", "&gfx=default&radius=300&pr=0.5", 150_000);
  await page.waitForFunction(() => {
    const s = (window as unknown as FogWindow).__fogcity!.state();
    return s.tick > 30 && ((s.ext as { agents?: { list: unknown[] } }).agents?.list.length ?? 0) > 0;
  }, null, { timeout: 120_000 });
  await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.pause());
  // Out of the car; walk (inputs only) toward the nearest robotaxi not stuck in traffic; within
  // hailing range F hails it (it pulls up and waits); beside it, F hops in.
  const boarded = await page.evaluate(() => {
    const h = (window as unknown as FogWindow).__fogcity!;
    const idle = { throttle: 0, steer: 0, brake: 0, actions: 0 };
    h.stepFrames!([{ p1: { ...idle, actions: 1 } }]);
    for (let i = 0; i < 60; i++) h.stepFrames!([{ p1: idle }]);
    type Taxi = { id: number; kind: string; x: number; z: number; heading: number; speed: number; wait: number; runtimeId?: string };
    const log: string[] = [];
    for (let tick = 0; tick < 9000; tick++) {
      const s = h.state();
      const me = s.players.p1 as unknown as { ride?: unknown; hail?: { agentId: number } | null; foot: { x: number; z: number; heading: number } | null };
      if (me.ride) return true;
      if (!me.foot) return `not on foot at tick ${tick}: ${log.join(" | ")}`;
      const foot = me.foot;
      const taxis = ((s.ext as { agents?: { list: Taxi[] } }).agents?.list ?? []).filter((a) => a.kind === "robotaxi" && a.runtimeId === undefined && a.id % 8 !== 7);
      // The hailed taxi, else the nearest empty one that is not stuck in traffic.
      let best = me.hail ? taxis.find((t) => t.id === me.hail!.agentId) : undefined;
      if (!best) {
        let bestD = Infinity;
        for (const t of taxis) {
          const d = Math.hypot(t.x - foot.x, t.z - foot.z);
          if (t.wait < 60 && d < bestD) { bestD = d; best = t; }
        }
      }
      if (!best) { h.stepFrames!([{ p1: idle }]); continue; }
      const d = Math.hypot(best.x - foot.x, best.z - foot.z);
      // Hail it once within range (F), then walk to 2 m off its left side and F again to get in.
      const car = (s.players.p1 as unknown as { car: { x: number; z: number } }).car;
      // (Next to your own car F gets back in it: hail from further off.)
      const hail = !me.hail && d < 17 && Math.hypot(car.x - foot.x, car.z - foot.z) > 7 && tick % 15 === 0;
      const board = !!me.hail && d < 4.5 && Math.hypot(car.x - foot.x, car.z - foot.z) > 7 && Math.abs(best.speed) < 1.2 && tick % 10 === 0;
      const gx = best.x - Math.cos(best.heading) * 2.2, gz = best.z - Math.sin(best.heading) * 2.2;
      const dx = gx - foot.x, dz = gz - foot.z, dist = Math.hypot(dx, dz);
      let err = Math.atan2(dx, -dz) - foot.heading;
      while (err > Math.PI) err -= 2 * Math.PI;
      while (err < -Math.PI) err += 2 * Math.PI;
      if (tick % 300 === 0) log.push(`${tick} taxi ${best.id} d ${d.toFixed(1)} v ${best.speed.toFixed(1)} w ${best.wait} hail ${me.hail?.agentId ?? "-"}`);
      h.stepFrames!([{ p1: { throttle: dist > 0.6 && Math.abs(err) < 0.7 ? 1 : 0, steer: Math.max(-1, Math.min(1, err * 4)), brake: dist > 8 ? 1 : 0, actions: hail || board ? 1 : 0 } }]);
    }
    return "timed out " + log.join(" | ");
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
  // The taxi drives off with the player aboard (the camera and HUD follow it).
  await expect.poll(async () => { const r = await ride(page); return r ? Math.hypot(r.x - first!.x, r.z - first!.z) : 0; }, { timeout: 120_000 }).toBeGreaterThan(5);

  // The actual H key switches the existing passenger ride to manual control. The own car is
  // still a parked body, and the taxi keeps its ambient identity and its current position.
  const parked = await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.state().players.p1!.car);
  await page.keyboard.press("KeyH");
  await expect.poll(async () => (await ride(page))?.manual ?? false, { timeout: 60_000 }).toBe(true);
  expect((await ride(page))!.agentId).toBe(first!.agentId);
  await page.keyboard.down("KeyW");
  try {
    await expect.poll(async () => Math.abs((await ride(page))?.speed ?? 0), { timeout: 60_000 }).toBeGreaterThan(4);
  } finally {
    await page.keyboard.up("KeyW");
  }
  await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.pause());
  const controlled = await page.evaluate(() => {
    const h = (window as unknown as FogWindow).__fogcity!;
    const before = h.state().players.p1!.ride!;
    for (let i = 0; i < 60; i++) h.stepFrames!([{ p1: { throttle: 0.65, steer: 0.3, brake: 0, actions: 0 } }]);
    const after = h.state(), rider = after.players.p1!.ride!;
    const taxi = after.ext.agents!.list.find(a => a.id === rider.agentId)!;
    return { before, rider, taxi, own: after.players.p1!.car };
  });
  expect(Math.hypot(controlled.rider.x - controlled.before.x, controlled.rider.z - controlled.before.z)).toBeGreaterThan(1);
  expect(Math.abs(controlled.rider.heading - controlled.before.heading)).toBeGreaterThan(0.025);
  expect(controlled.taxi.manualCar).toBeDefined();
  expect(controlled.taxi.x).toBe(controlled.rider.x);
  expect(controlled.taxi.z).toBe(controlled.rider.z);
  expect(controlled.own.x).toBeCloseTo(parked.x, 4);
  expect(controlled.own.z).toBeCloseTo(parked.z, 4);
  mkdirSync("test-results/robotaxi-takeover", { recursive: true });
  writeFileSync("test-results/robotaxi-takeover/manual-drive.json", JSON.stringify(controlled, null, 2));
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.screenshot({ path: "test-results/robotaxi-takeover/manual-drive.png" });
  await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.resume());
  // While driving, H remains the horn; it does not discard the manual steering state.
  await page.keyboard.press("KeyH");
  await expect.poll(async () => (await ride(page))?.manual ?? false, { timeout: 60_000 }).toBe(true);

  // The real F key: the taxi stops and the player steps out beside it.
  await page.keyboard.press("KeyF");
  await expect.poll(() => page.evaluate(() => (window as unknown as FogWindow).__fogcity!.state().players.p1!.mode), { timeout: 90_000 }).toBe("foot");
  expect(await ride(page) ?? null).toBeNull();
  const contacts = await page.evaluate(() => ((window as unknown as FogWindow).__fogcity!.state().ext as { dodge?: { contacts: number } }).dodge?.contacts ?? 0);
  expect(contacts).toBe(0);
  expect(problems).toEqual([]);
});
