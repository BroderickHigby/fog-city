// Combat look-dev capture (config: tests/render/combat-lookdev.config.ts). Boots SF at the spawn,
// pauses the sim, draws the robots nearest the camera at one combat stage each
// (previewCombatLook: render-only, the sim never sees it), then frames each of them from 5 m and
// saves <stage>.png to $LOOKDEV_OUT (default test-results/combat-lookdev/), with lookdev.json.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { ROOT } from "../helpers.ts";
import { bootWorld, frames, pause, settle, type FogWindow } from "../e2e/fixtures.ts";

const OUT = resolve(ROOT, process.env.LOOKDEV_OUT ?? "test-results/combat-lookdev");
const STAGES = [
  { id: "1-clean", rust: 0, wet: 0, topple: 0 },
  { id: "2-rusting", rust: 0.25, wet: 1, topple: 0 },
  { id: "3-half-rusted", rust: 0.55, wet: 0.6, topple: 0 },
  { id: "4-seized", rust: 1, wet: 0.4, topple: 0 },
  { id: "5-slumping", rust: 1, wet: 0.2, topple: 0.5, height: 0.65 },
  { id: "6-heap", rust: 1, wet: 0, topple: 1, height: 0.3 },
] as const;

type LookHandle = {
  previewCombatLook?(stages: ReadonlyArray<{ rust: number; wet: number; topple: number; height?: number }> | null): number[];
  state(): { ext: { agents?: { list: Array<{ id: number; x: number; y: number; z: number; heading: number; kind: string }> } } };
};

test("combat look-dev", async ({ page }) => {
  test.setTimeout(3_600_000);
  mkdirSync(OUT, { recursive: true });
  const problems = await bootWorld(page, "sf", "&gfx=high&shadows=1&tod=noon", 240_000);
  await page.addStyleTag({ content: "body > :not(#game), #game > :not(canvas) { visibility: hidden !important; }" });
  await settle(page, 300_000);
  await frames(page, 30);
  await pause(page);
  const ids = await page.evaluate((stages) => (window as unknown as { __fogcity: LookHandle }).__fogcity.previewCombatLook?.(stages) ?? [], STAGES as unknown as Array<{ rust: number; wet: number; topple: number; height?: number }>);
  expect(ids.length, "robots near the spawn to dress").toBe(STAGES.length);
  const agents = await page.evaluate(() => (window as unknown as { __fogcity: LookHandle }).__fogcity.state().ext.agents?.list ?? []);
  const shots: unknown[] = [];
  for (const [i, id] of ids.entries()) {
    const a = agents.find((q) => q.id === id)!;
    // 5 m from the robot, a quarter turn off its heading, 1.6 m up, looking down at it a little.
    const side = a.heading + Math.PI / 2;
    const cx = a.x + Math.sin(side) * 4.6 - Math.sin(a.heading) * 2;
    const cz = a.z - Math.cos(side) * 4.6 + Math.cos(a.heading) * 2;
    const yaw = (Math.atan2(a.x - cx, -(a.z - cz)) * 180) / Math.PI;
    await page.evaluate(([x, y, z, yw]) => (window as unknown as FogWindow).__fogcity!.flyTo!(x!, y!, z!, yw!, -14), [cx, a.y + 1.6, cz, yaw]);
    await settle(page, 120_000);
    await frames(page, 6);
    const stage = STAGES[i]!;
    await page.screenshot({ path: join(OUT, `${stage.id}.png`) });
    shots.push({ stage, agent: a });
  }
  writeFileSync(join(OUT, "lookdev.json"), JSON.stringify({ problems, shots }, null, 1));
});
