// M0 acceptance on the hand-made dev world (public/tiles/dev): it boots cleanly and draws,
// real keys reach the sim, deterministic stepping stops at the wall and never passes through
// it, and the camera key changes the view but never the sim.

import { expect, test } from "@playwright/test";
import { pointInPolygon, type TileCollider } from "../../src/sim/index.ts";
import { readJson } from "../helpers.ts";
import {
  FAST_QUERY,
  FAST_VIEWPORT,
  THROTTLE,
  bootWorld,
  features,
  frames,
  headingDelta,
  renderInfo,
  settle,
  simHash,
  simState,
  type FogWindow,
} from "./fixtures.ts";
import { decodePng, imageStats, looksDrawn } from "./png.ts";

const collider = readJson<TileCollider>("public/tiles/dev/dev.collider.json");
const wall = collider.buildings.find((b) => b.id === "dev-wall")!;

test.describe("dev world: boot", () => {
  test("boots with no console errors and draws a frame", async ({ page }) => {
    const problems = await bootWorld(page, "dev");
    expect(await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.world)).toBe("dev");
    // The loop is alive: ticks advance on their own.
    const t0 = (await simState(page)).tick;
    await page.waitForFunction((t) => (window as unknown as FogWindow).__fogcity!.state().tick > t + 10, t0, { timeout: 20_000 });
    await settle(page);
    await frames(page, 10);

    const stats = imageStats(decodePng(await page.screenshot()), 7);
    expect(looksDrawn(stats), `the frame looks blank: ${JSON.stringify(stats)}`).toBe(true);
    expect(problems).toEqual([]);
  });
});

test.describe("dev world: behaviour", () => {
  test.use({ viewport: FAST_VIEWPORT });

  test("keyboard reaches the sim: W drives forward, D steers right", async ({ page }) => {
    const problems = await bootWorld(page, "dev", FAST_QUERY);
    const start = (await simState(page)).players.p1!.car;

    await page.keyboard.down("KeyW");
    // Heading 0 is north (-z): forward means z decreases.
    await page.waitForFunction((z) => (window as unknown as FogWindow).__fogcity!.state().players.p1!.car.z < z - 2, start.z, {
      timeout: 30_000,
    });
    const moving = (await simState(page)).players.p1!.car;
    await page.keyboard.down("KeyD");
    await page.waitForFunction(
      (h0) => {
        const c = (window as unknown as FogWindow).__fogcity!.state().players.p1!.car;
        let d = (c.heading - h0) % (2 * Math.PI);
        if (d > Math.PI) d -= 2 * Math.PI;
        if (d < -Math.PI) d += 2 * Math.PI;
        return d > 0.05; // compass bearings grow clockwise: right
      },
      moving.heading,
      { timeout: 30_000 },
    );
    await page.keyboard.up("KeyD");
    await page.keyboard.up("KeyW");
    const end = (await simState(page)).players.p1!.car;
    expect(Math.abs(end.x - start.x) + Math.abs(end.z - start.z)).toBeGreaterThan(2);
    expect(headingDelta(moving.heading, end.heading)).toBeGreaterThan(0.05);
    expect(problems).toEqual([]);
  });

  test("deterministic stepping: full throttle stops at the wall, never passes through", async ({ page }) => {
    const problems = await bootWorld(page, "dev", FAST_QUERY);
    const track = await page.evaluate((input) => {
      const h = (window as unknown as FogWindow).__fogcity!;
      h.pause();
      const out: Array<{ x: number; z: number; hits: number; speed: number; tick: number }> = [];
      for (let i = 0; i < 600; i++) {
        h.stepN(1, input);
        const s = h.state();
        const c = s.players.p1!.car;
        out.push({ x: c.x, z: c.z, hits: c.hits, speed: c.speed, tick: s.tick });
      }
      return out;
    }, THROTTLE);

    // One tick per stepN(1): no frame-loop ticks leak in while paused.
    for (let i = 1; i < track.length; i++) expect(track[i]!.tick).toBe(track[i - 1]!.tick + 1);
    const inside = track.filter((p) => pointInPolygon(p.x, p.z, wall.footprint));
    expect(inside, "car centre inside the wall").toEqual([]);
    const southFace = Math.max(...wall.footprint.map(([, z]) => z));
    const deepest = Math.min(...track.map((p) => p.z));
    expect(deepest, "car centre crossed the wall's south face").toBeGreaterThan(southFace);
    const last = track.at(-1)!;
    expect(last.hits).toBeGreaterThan(0);
    // Against the wall after 10 s, not somewhere short of it.
    expect(last.z).toBeLessThan(southFace + 8);
    expect(problems).toEqual([]);
  });

  test("KeyC never changes the sim hash", async ({ page }) => {
    const problems = await bootWorld(page, "dev", FAST_QUERY);
    await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.pause());
    await frames(page, 2);
    const h0 = await simHash(page);
    const tick0 = (await simState(page)).tick;
    await page.waitForTimeout(500);
    await frames(page, 2);
    expect(await simHash(page), "paused sim moved on its own").toBe(h0);
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("KeyC");
      await frames(page, 2);
      expect(await simHash(page)).toBe(h0);
    }
    expect((await simState(page)).tick).toBe(tick0);
    // And resume() really resumes.
    await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.resume());
    await page.waitForFunction((t) => (window as unknown as FogWindow).__fogcity!.state().tick > t + 5, tick0, { timeout: 20_000 });
    expect(problems).toEqual([]);
  });

  test("KeyC changes renderInfo().cameraMode", async ({ page }) => {
    const problems = await bootWorld(page, "dev", FAST_QUERY);
    test.skip(!(await features(page)).renderInfo, "window.__fogcity.renderInfo() is not provided by this renderer yet");
    await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.pause());
    await frames(page, 2);
    const h0 = await simHash(page);
    const modes = [(await renderInfo(page))!.cameraMode];
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("KeyC");
      await page.waitForFunction(
        (prev) => (window as unknown as FogWindow).__fogcity!.renderInfo!().cameraMode !== prev,
        modes.at(-1)!,
        { timeout: 10_000 },
      );
      modes.push((await renderInfo(page))!.cameraMode);
    }
    // C toggles between at least two views and comes back.
    expect(new Set(modes).size).toBeGreaterThanOrEqual(2);
    expect(modes[2]).toBe(modes[0]);
    expect(await simHash(page)).toBe(h0);
    expect(problems).toEqual([]);
  });
});
