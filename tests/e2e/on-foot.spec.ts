// M0 acceptance for on-foot play, through real key presses in the running game (dev world):
// F gets out, the walker is drawn and moves while the car stays parked (the HUD shows the
// walking speed), F next to the car gets back in. Boxed in by four other players' cars, F
// does nothing and the HUD says "No room to get out"; once they leave, F gets out, no hint.
// Skips while the sim has no on-foot state (PlayerState.foot arrives with sim v2).

import { expect, test } from "@playwright/test";
import type { PlayerState } from "../../src/sim/contract.ts";
import { FAST_QUERY, FAST_VIEWPORT, bootWorld, features, frames, gate, renderInfo, simState, type FogWindow } from "./fixtures.ts";

/** PlayerState as sim contract v2 has it; this file must also compile against v1. */
type Player = Omit<PlayerState, "foot"> & { foot?: { x: number; z: number; heading: number } | null };
const p1 = (s: { players: Record<string, unknown> }): Player => s.players.p1 as Player;

test.use({ viewport: FAST_VIEWPORT });
// Real keys through the game's own loop, so these waits are wall time: under SwiftShader on a
// loaded 4-core machine the game can run at ~1 frame a second (each frame then catches up only
// 0.25 s of sim). Every wait allows 60 s, and each test several of them.
test.describe.configure({ timeout: 360_000 });

test("on foot: F exits, the walker moves, F near the car re-enters", async ({ page }) => {
  const problems = await bootWorld(page, "dev", FAST_QUERY);
  const p0 = p1(await simState(page));
  gate("foot", "foot" in p0, "on-foot play is not in this sim yet: PlayerState has no `foot` (sim contract v2)");
  expect(p0.mode).toBe("vehicle");

  // F gets out of the stopped car.
  await page.keyboard.press("KeyF");
  await page.waitForFunction(() => (window as unknown as FogWindow).__fogcity!.state().players.p1!.mode === "foot", null, {
    timeout: 60_000,
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
  await page.waitForFunction(() => /\b[3-9] km\/h .*on foot/.test(document.getElementById("hud")?.textContent ?? ""), null, { timeout: 60_000 });
  await page.waitForFunction(
    (w) => {
      const f = ((window as unknown as FogWindow).__fogcity!.state().players.p1 as unknown as { foot?: { x: number; z: number } | null }).foot;
      return !!f && Math.hypot(f.x - w.x, f.z - w.z) > 1.5;
    },
    walker0,
    { timeout: 60_000 },
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
    { timeout: 60_000 },
  );
  await page.keyboard.up("KeyS");

  // F next to the car gets back in, and W drives it again.
  await page.keyboard.press("KeyF");
  await page.waitForFunction(() => (window as unknown as FogWindow).__fogcity!.state().players.p1!.mode === "vehicle", null, {
    timeout: 60_000,
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
    { timeout: 60_000 },
  );
  await page.keyboard.up("KeyW");
  expect(problems).toEqual([]);
});

test("on foot: boxed in by four cars, F says 'No room to get out' and leaves the player in the car", async ({ page }) => {
  const problems = await bootWorld(page, "dev", FAST_QUERY);
  const p0 = p1(await simState(page));
  gate("foot", "foot" in p0, "on-foot play is not in this sim yet: PlayerState has no `foot` (sim contract v2)");
  const have = await page.evaluate(() => {
    const h = (window as unknown as FogWindow).__fogcity!;
    return { stepFrames: typeof h.stepFrames === "function", hint: typeof h.hint === "function" };
  });
  expect(have, "the debug handle has stepFrames() and hint()").toEqual({ stepFrames: true, hint: true });

  // Four players join in cars touching p1's: left and right 2 m off its centre, front and back 5.2 m.
  const boxIn = await page.evaluate(() => {
    const h = (window as unknown as FogWindow).__fogcity!;
    h.pause();
    const s = h.state();
    const c = s.players.p1!.car;
    const fx = Math.sin(c.heading);
    const fz = -Math.cos(c.heading);
    const spots: Array<[string, number, number]> = [
      ["p2", 2, 0],
      ["p3", -2, 0],
      ["p4", 0, 5.2],
      ["p5", 0, -5.2],
    ];
    const tick = s.tick + 1;
    const events = spots.map(([id, right, ahead]) => ({
      tick,
      kind: "player.join",
      playerId: id,
      payload: { x: c.x + right * -fz + ahead * fx, z: c.z + right * fx + ahead * fz, heading: c.heading },
    }));
    h.stepFrames!([{}], events);
    h.resume();
    return { ids: Object.keys(h.state().players).sort(), tick };
  });
  expect(boxIn.ids, "players after the joins").toEqual(["p1", "p2", "p3", "p4", "p5"]);

  // F with the game's own loop running: nowhere to stand, so the player stays in, and the HUD says why.
  await page.keyboard.press("KeyF");
  await page.waitForFunction(() => (window as unknown as FogWindow).__fogcity!.hint!() === "No room to get out", null, { timeout: 60_000 });
  const stuck = p1(await simState(page));
  expect(stuck.mode, "still in the car").toBe("vehicle");
  expect(await page.locator("#hint").isVisible(), "the hint is on screen").toBe(true);

  // The other cars leave; once the hint has gone, F gets out, and no hint shows.
  await page.evaluate(() => {
    const h = (window as unknown as FogWindow).__fogcity!;
    h.pause();
    const tick = h.state().tick + 1;
    h.stepFrames!(
      [{}],
      ["p2", "p3", "p4", "p5"].map((id) => ({ tick, kind: "player.leave", playerId: id })),
    );
    h.resume();
  });
  await page.waitForFunction(() => (window as unknown as FogWindow).__fogcity!.hint!() === "", null, { timeout: 60_000 });
  await page.keyboard.press("KeyF");
  await page.waitForFunction(() => (window as unknown as FogWindow).__fogcity!.state().players.p1!.mode === "foot", null, {
    timeout: 60_000,
  });
  expect(await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.hint!()), "no hint when F works").toBe("");
  expect(problems).toEqual([]);
});
