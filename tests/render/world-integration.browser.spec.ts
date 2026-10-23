import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toLocal, tileId } from "../../src/geo/project.ts";
import { makeDrawnGroundFn } from "../../src/render/ground.ts";
import type { TileCollider } from "../../src/sim/world.ts";
import { ROOT } from "../helpers.ts";
import { bootWorld, frames, type FogWindow } from "../e2e/fixtures.ts";

const point = (lat: number, lon: number, lift: number) => {
  const p = toLocal(lat, lon);
  const tile = JSON.parse(readFileSync(join(ROOT, "public", "tiles", "sf", `${tileId(Math.floor(p.x / 500), Math.floor(p.z / 500))}.collider.json`), "utf8")) as TileCollider;
  return { ...p, y: makeDrawnGroundFn([tile])(p.x, p.z) + lift };
};

test.use({ viewport: { width: 1280, height: 800 } });
test("new-world houses, Ferry detail and structural materials preserve the running simulation", async ({ page }) => {
  test.setTimeout(600_000);
  const problems = await bootWorld(page, "sf", "&quality=1&shadows=1&tod=golden&radius=400&pr=1&debug=1");
  const initial = await page.evaluate(() => {
    const game = (window as unknown as FogWindow).__fogcity!;
    game.pause(); game.stepN(1); return game.hash();
  });
  await page.waitForFunction(() => (window as unknown as FogWindow).__fogcity!.tilesSettled!(), null, { timeout: 180_000 });
  const info = await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.renderInfo!() as unknown as {
    houseKit: { tiles: number; triangles: number }; showcase: { palms: number; paintQuads: number; trackM: number }; detailSets: number;
    foliage: { near: number; far: number };
  });
  expect(info.houseKit.tiles).toBeGreaterThan(0);
  expect(info.houseKit.triangles).toBeGreaterThan(0);
  expect(info.showcase.palms).toBeGreaterThan(0);
  expect(info.showcase.paintQuads).toBeGreaterThan(0);
  expect(info.showcase.trackM).toBeGreaterThan(100);
  expect(info.detailSets).toBe(4);
  expect(info.foliage.near + info.foliage.far).toBeGreaterThan(0);
  await frames(page, 2);
  await page.screenshot({ path: "test-results/world-integration-ferry.png" });

  for (const view of [
    { name: "alamo-houses", ...point(37.7758, -122.4336, 6), yaw: 80, pitch: -12 },
    { name: "broadway-street", ...point(37.7975, -122.4168, 5), yaw: 85, pitch: -8 },
    { name: "stow-lake", ...point(37.7687, -122.4748, 8), yaw: 325, pitch: -10 },
  ]) {
    await page.evaluate(v => (window as unknown as FogWindow).__fogcity!.flyTo!(v.x, v.y, v.z, v.yaw, v.pitch), view);
    await page.waitForFunction(() => (window as unknown as FogWindow).__fogcity!.tilesSettled!(), null, { timeout: 180_000 });
    await frames(page, 2);
    await page.screenshot({ path: `test-results/world-integration-${view.name}.png` });
  }
  expect(await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.hash())).toBe(initial);
  expect(problems).toEqual([]);
});

test("height-aware camera stays inside the Broadway bore", async ({ page }) => {
  test.setTimeout(180_000);
  const collider = JSON.parse(readFileSync(join(ROOT, "public", "tiles", "sf", "t-5_-1.collider.json"), "utf8")) as {
    tunnels: Array<{ edge: string; path: number[][] }>;
  };
  const bore = collider.tunnels.find(t => t.edge === "c3186101")!;
  expect(bore, "Broadway's committed bore geometry").toBeDefined();
  const [x, floor, z] = bore.path[6]!;
  const problems = await bootWorld(page, "sf", "&quality=1&shadows=1&tod=golden&radius=300&pr=1&debug=1");
  const initial = await page.evaluate(pose => {
    const game = (window as unknown as FogWindow).__fogcity!;
    game.pause(); game.stepN(1);
    game.flyTo!(pose.x, pose.y, pose.z, 81.2, 0);
    return game.hash();
  }, { x: x!, y: floor! + 2, z: z! });
  await page.waitForFunction(() => (window as unknown as FogWindow).__fogcity!.tilesSettled!(), null, { timeout: 120_000 });
  await frames(page, 2);
  const cameraY = await page.evaluate(() => (window as unknown as { __fogcityView: { camera: { position: { y: number } } } }).__fogcityView.camera.position.y);
  expect(cameraY).toBeCloseTo(floor! + 2, 2);
  await page.screenshot({ path: "test-results/world-integration-tunnel-interior.png" });
  expect(await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.hash())).toBe(initial);
  expect(problems).toEqual([]);
});
