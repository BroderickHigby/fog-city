// Render budget guard for the real city (the release-#67 regression: 4,000 far street trees at
// 226 triangles each took the SF frame from 236k to 1.17M triangles under SwiftShader).
//  - After the streamed tiles settle at the spawn, the frame stays under FRAME_TRIANGLES.
//  - After warm-up (every material drawn once, night toggled once), driving and toggling night
//    create no shader program and recreate none: a changing light count, a per-frame material or
//    an unstable customProgramCacheKey would recompile programs during play.
import { expect, test } from "@playwright/test";
import { bootWorld, frames, type FogWindow } from "./fixtures.ts";

const QUERY = "&gfx=default&radius=300&pr=0.75&debug=1";
/** The SF spawn frame was 236k triangles before release #67 and is about 330k with it. */
const FRAME_TRIANGLES = 450_000;

type View = { renderer: { info: { programs: Array<{ id: number; name: string }> | null } } };

test("sf: the frame stays in its triangle budget, and play compiles no shader programs", async ({ page }) => {
  test.slow();
  const problems = await bootWorld(page, "sf", QUERY, 240_000);
  await page.waitForFunction(() => (window as unknown as FogWindow).__fogcity!.tilesSettled?.() ?? true, null, { timeout: 300_000, polling: 1000 });
  await frames(page, 10);
  const info = await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.renderInfo!() as { triangles?: number; drawCalls?: number });
  expect(info.triangles, "spawn frame triangles").toBeLessThanOrEqual(FRAME_TRIANGLES);

  // Warm-up: night on and off once, so the night-only materials have compiled.
  await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.setNight!(true));
  await frames(page, 10);
  await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.setNight!(false));
  await frames(page, 10);
  const programs = () => page.evaluate(() => ((window as unknown as { __fogcityView: View }).__fogcityView.renderer.info.programs ?? []).map((p) => `${p.id}:${p.name}`).sort());
  const warm = await programs();

  await page.keyboard.down("KeyW");
  await frames(page, 60);
  await page.keyboard.up("KeyW");
  await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.setNight!(true));
  await frames(page, 20);
  await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.setNight!(false));
  await frames(page, 20);
  const after = await programs();
  // A crowd character seen for the first time may add its own program; nothing may be recreated.
  const added = after.filter((p) => !warm.includes(p) && !/:crowd_/.test(p));
  const dropped = warm.filter((p) => !after.includes(p));
  expect({ added, dropped }, "shader programs created or released during play").toEqual({ added: [], dropped: [] });
  expect(problems).toEqual([]);
});
