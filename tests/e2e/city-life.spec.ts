// City life in the browser on real SF (v10): the player parks mid-lane on Drumm St, walks off,
// and traffic goes round the abandoned car. The input frames are planned in Node from the
// browser's own state (tests/e2e/gameplay-driver.ts), then replayed in the page through
// stepFrames; the page must reach the identical state, with robotaxis passing on the way and
// no contact with anyone.
import { expect, test, type Page } from "@playwright/test";
import { canonicalJson, dodgeExtOf, lanePath, pathPoint, type SimState } from "../../src/sim/index.ts";
import { loadWorld } from "../helpers.ts";
import { GameplayDriver } from "./gameplay-driver.ts";
import { bootWorld, gate, simState, type FogWindow } from "./fixtures.ts";
import { e2eGameSystems } from "./game-systems.ts";

/** Drumm St between Clay and Sacramento: two-way, one lane each way, a few hundred metres from the spawn. */
const STREET = "c4970000";

/** Robotaxis on STREET's a -> b lane going round something, by id. */
function passing(state: SimState): number[] {
  return (state.ext.agents?.list ?? []).filter((a) => a.kind === "robotaxi" && a.edge === STREET && a.pass !== undefined).map((a) => a.id);
}

test.use({ viewport: { width: 960, height: 540 } });
test("traffic goes round a car abandoned mid-lane on Drumm St, identically in the browser", async ({ page }: { page: Page }) => {
  test.setTimeout(1_800_000);
  const problems = await bootWorld(page, "sf", "&radius=300&pr=0.75");
  const hasFrames = await page.evaluate(() => typeof (window as unknown as FogWindow).__fogcity!.stepFrames === "function");
  gate("step-frames", hasFrames, "the page has no stepFrames");
  await page.evaluate(() => {
    const handle = (window as unknown as FogWindow).__fogcity!;
    handle.pause();
    handle.stepN(1);
  });
  const { world } = loadWorld("sf", { roads: true });
  const g = world.roads!;
  const edge = g.edges[g.edgeIndex.get(STREET)!]!;
  const lane = lanePath(edge, 1, 0);
  const mid = pathPoint(lane, lane.len / 2);

  // Plan in Node: drive there, stop in the lane, get out and walk across to the far pavement.
  const driver = new GameplayDriver(world, await simState(page), "p1", e2eGameSystems());
  await page.setViewportSize({ width: 1, height: 1 });
  driver.driveTo(mid, 1.5);
  driver.hold(30);
  const car = driver.state.players.p1!.car;
  expect(Math.hypot(car.x - mid.x, car.z - mid.z)).toBeLessThan(4);
  driver.walkTo({ x: mid.x + mid.tz * 9 - mid.tx * 20, z: mid.z - mid.tx * 9 - mid.tz * 20 }, 2);
  const seen = new Set<number>();
  for (let t = 0; t < 3600 * 2 && seen.size < 2; t++) {
    driver.hold(1);
    for (const id of passing(driver.state)) seen.add(id);
  }
  driver.hold(600);
  await page.setViewportSize({ width: 960, height: 540 });
  expect(seen.size).toBeGreaterThanOrEqual(1);
  console.info(`Planned ${driver.frames.length} frames; robotaxis went round the car: ${[...seen].join(", ")}`);

  // Replay in the page, watching it as it goes.
  const inBrowser = new Set<number>();
  let actual: SimState | undefined;
  for (let at = 0; at < driver.frames.length; at += 120) {
    actual = await page.evaluate((batch) => {
      const handle = (window as unknown as FogWindow).__fogcity!;
      handle.stepFrames!(batch);
      return handle.state();
    }, driver.frames.slice(at, at + 120));
    for (const id of passing(actual)) inBrowser.add(id);
    expect(dodgeExtOf(actual).contacts).toBe(0);
  }
  expect(inBrowser.size).toBeGreaterThanOrEqual(1);
  expect(canonicalJson(actual!)).toBe(canonicalJson(driver.state));
  await page.screenshot({ path: "test-results/city-life-drumm.png" });
  expect(problems).toEqual([]);
});
