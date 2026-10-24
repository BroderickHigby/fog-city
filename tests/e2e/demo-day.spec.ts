// Demo Day (wave 4, previewed with ?wave=4) completed in the real SF page. Progress up to the
// mission is loaded through the game's own save panel (Import save, then Load progress); the
// mission itself is played with real inputs planned in Node and replayed frame by frame in the
// page, which must end in the identical state.
import { expect, test, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { canonicalJson, hashState, type SimState } from "../../src/sim/index.ts";
import { MISSIONS } from "../../src/content/catalog.ts";
import { VENDOR } from "../../src/content/vendor.ts";
import { STARTUP_KITS } from "../../src/content/kits.ts";
import { contentHash } from "../../src/content/barks.ts";
import { DEFAULT_CATALOG } from "../../src/sim/player/catalog.ts";
import { createGameSystems } from "../../src/sim/game-systems.ts";
import { createMissionProgress } from "../../src/sim/missions/system.ts";
import { SaveStore, MemorySaveBackend } from "../../src/save/index.ts";
import { captureProgression, validateSavedProgression } from "../../src/save/progression.ts";
import { loadWorld } from "../helpers.ts";
import { DemoDayDriver } from "./demo-day-driver.ts";
import { bootWorld, simState, type FogWindow } from "./fixtures.ts";

const EARLIER = ["hot-desk", "spill", "launch-day", "demoed-correctly"];

async function feed(page: Page, driver: DemoDayDriver): Promise<SimState> {
  let actual: SimState | undefined;
  for (let at = 0; at < driver.frames.length; at += 500) {
    actual = await page.evaluate(batch => {
      const handle = (window as unknown as FogWindow).__fogcity!;
      handle.stepFrames!(batch);
      return handle.state();
    }, driver.frames.slice(at, at + 500));
  }
  return actual ?? await simState(page);
}

test.use({ viewport: { width: 960, height: 540 } });
test("Demo Day completes in SF through real controls, the save panel and the bell duel", async ({ page }) => {
  test.setTimeout(6_600_000);
  const problems = await bootWorld(page, "sf", "&radius=300&pr=0.75&wave=4");
  // A save whose campaign is through Demoed Correctly, exported as the game would.
  const booted = await simState(page);
  const progress = { ...createMissionProgress(), completedIds: EARLIER };
  const atDemoDay: SimState = { ...booted, ext: { ...booted.ext, missions: { ...booted.ext.missions!, players: { p1: progress } } } };
  const store = new SaveStore({ backends: [new MemorySaveBackend()], validate: validateSavedProgression,
    contentHash: contentHash([JSON.stringify(MISSIONS), JSON.stringify(VENDOR), JSON.stringify(STARTUP_KITS), JSON.stringify(DEFAULT_CATALOG.sites), JSON.stringify(DEFAULT_CATALOG.activities)]) });
  await store.save(0, captureProgression(atDemoDay, "p1"));
  const exported = await store.export(0);

  await page.getByRole("button", { name: "Open phone", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import save", exact: true }).first().click();
  await (await chooser).setFiles({ name: "fog-city-slot-1.json", mimeType: "application/json", buffer: Buffer.from(exported) });
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByRole("button", { name: "Load progress", exact: true }).first()).toBeEnabled();
  await page.getByRole("button", { name: "Load progress", exact: true }).first().click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.waitForFunction(() => (window as unknown as FogWindow).__fogcity!.state().ext.missions?.players.p1?.missionId === "demo-day");
  await page.keyboard.press("Escape");
  await page.evaluate(() => { const h = (window as unknown as FogWindow).__fogcity!; h.pause(); h.stepN(1); });
  const initial = await simState(page);
  expect(initial.ext.missions!.players.p1!.completedIds).toEqual(EARLIER);

  const { world } = loadWorld("sf", { roads: true });
  const driver = new DemoDayDriver(world, initial, "p1", createGameSystems({ wave: 4 }));
  await page.setViewportSize({ width: 1, height: 1 });
  try { driver.play(); }
  catch (error) {
    writeFileSync("test-results/demo-day-driver-repro.json", JSON.stringify({ state: driver.state, previousState: driver.previousState, frames: driver.frames.length }));
    throw error;
  } finally { await page.setViewportSize({ width: 960, height: 540 }); }
  console.info(`Demo Day planned: ${driver.frames.length} input frames`);
  const final = await feed(page, driver);
  expect(canonicalJson(final)).toBe(canonicalJson(driver.state));
  const done = final.ext.missions!.players.p1!;
  expect(done.completedIds).toContain("demo-day");
  expect(final.ext.dodge).toMatchObject({ contacts: 0, failures: 0 });
  writeFileSync("test-results/demo-day-proof.json", JSON.stringify({ initialTick: initial.tick, finalTick: final.tick, frames: driver.frames.length, hash: hashState(final),
    cashCents: final.ext.economy!.players.p1!.cashCents, vcQuarters: final.ext.heat!.players.p1!.vcQuarters, next: done.missionId }, null, 2));
  await page.screenshot({ path: "test-results/demo-day-complete.png" });
  expect(problems).toEqual([]);
});
