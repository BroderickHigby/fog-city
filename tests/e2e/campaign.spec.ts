import { expect, test, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { canonicalJson, hashState, type SimState } from "../../src/sim/index.ts";
import { DEFAULT_CATALOG } from "../../src/sim/player/catalog.ts";
import { loadWorld } from "../helpers.ts";
import { CampaignDriver } from "./campaign-driver.ts";
import { bootWorld, frames, simState, type FogWindow } from "./fixtures.ts";
import { p1Chunk, replay, withRecordedCommands } from "./replay.ts";
import { e2eGameSystems } from "./game-systems.ts";
import { captureProgression, restoreProgression } from "../../src/save/progression.ts";

function plan(driver: CampaignDriver, run: () => void): void {
  try { run(); }
  catch (error) {
    writeFileSync("test-results/campaign-driver-repro.json", JSON.stringify({ state: driver.state, previousState: driver.previousState, frames: driver.frames }));
    throw error;
  }
}

/** Keep SwiftShader idle while Node plans; restore the real viewport even on failure. */
async function quietRenderer<T>(page: Page, run: () => T): Promise<T> {
  await page.setViewportSize({ width: 1, height: 1 });
  try { return run(); }
  finally { await page.setViewportSize({ width: 960, height: 540 }); }
}

async function feed(page: Page, driver: CampaignDriver): Promise<void> {
  let actual: SimState | undefined;
  for (let at = 0; at < driver.frames.length; at += 500) {
    actual = await page.evaluate(batch => {
      const handle = (window as unknown as FogWindow).__fogcity!;
      handle.stepFrames!(batch);
      return handle.state();
    }, driver.frames.slice(at, at + 500));
  }
  expect(canonicalJson(actual ?? await simState(page))).toBe(canonicalJson(driver.state));
}

test.use({ viewport: { width: 960, height: 540 } });
test("Hot Desk and the first purchase complete through real controls, then Spill waits for acknowledgement", async ({ page }) => {
  test.setTimeout(2_700_000);
  const problems = await bootWorld(page, "sf", "&radius=300&pr=0.75");
  await page.evaluate(() => {
    const handle = (window as unknown as FogWindow).__fogcity!;
    handle.pause();
    handle.stepN(1);
  });
  const { world } = loadWorld("sf", { roads: true });
  const initial = await simState(page);
  const first = new CampaignDriver(world, initial, "p1", e2eGameSystems());
  await quietRenderer(page, () => plan(first, () => first.hotDeskToSignup()));
  console.info(`Campaign planned through signup: ${first.frames.length} input frames`);
  await feed(page, first);
  console.info("Campaign browser reached signup with exact replay state");
  const signup = page.getByRole("dialog", { name: "Hot Desk", exact: true });
  // The dialog appears on the next rendered UI frame; under CI SwiftShader that can take
  // seconds (docs/testing.md, "Load-proof": every real-time wait allows at least 60 s).
  await expect(signup).toBeVisible({ timeout: 60_000 });
  await signup.getByRole("button", { name: "Something with robots", exact: true }).click();
  await page.waitForFunction(() => {
    const handle = (window as unknown as FogWindow).__fogcity!;
    if (handle.state().ext.missions?.players.p1?.stepId !== "cone") return false;
    handle.pause();
    // Closing the form resumes movement; settle with recorded neutral input before the counter.
    handle.stepN(12);
    return true;
  });
  const signed = await simState(page);
  expect(signed.ext.player?.players.p1?.startupKitId).toBeTruthy();
  const vendor = DEFAULT_CATALOG.sites.find(site => site.id === "fidi-desk" && site.kind === "vendor")!;
  const body = signed.players.p1!.mode === "foot" ? signed.players.p1!.foot! : signed.players.p1!.car;
  expect(Math.hypot(body.x - vendor.x, body.z - vendor.z)).toBeLessThanOrEqual(18);
  expect(Math.abs(body.speed)).toBeLessThan(.3);
  await page.getByRole("button", { name: "Counter", exact: true }).click();
  const tank = page.locator("article").filter({ has: page.getByRole("heading", { name: "Tank I", exact: true }) });
  await expect(tank.getByRole("button", { name: "Buy", exact: true })).toBeEnabled();
  const beforeBuy = await simState(page);
  await tank.getByRole("button", { name: "Buy", exact: true }).click();
  await page.waitForFunction(() => (window as unknown as FogWindow).__fogcity!.state().ext.economy?.players.p1?.ownedItemIds.includes("tank-1"));
  const bought = await simState(page);
  expect(bought.ext.economy!.players.p1!.cashCents).toBe(beforeBuy.ext.economy!.players.p1!.cashCents - 60_000);
  expect(bought.ext.economy!.players.p1!.ownedItemIds.filter(id => id === "tank-1")).toHaveLength(1);
  const purchaseCommands = await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.commands!());
  expect(purchaseCommands.filter(command => (command.payload as {kind?: string}).kind === "buy")).toHaveLength(1);
  const purchaseReplay = withRecordedCommands([p1Chunk(bought.tick - beforeBuy.tick)], beforeBuy.tick, purchaseCommands);
  expect(hashState(replay(world, beforeBuy, purchaseReplay, e2eGameSystems()).final)).toBe(hashState(bought));
  console.info("Campaign first purchase passed financial, inventory and replay checks");
  const restored = restoreProgression(initial, captureProgression(bought, "p1"), "p1");
  expect(restored.ext.economy!.players.p1!.cashCents).toBe(bought.ext.economy!.players.p1!.cashCents);
  expect(restored.ext.economy!.players.p1!.ownedItemIds).toContain("tank-1");
  await expect(tank.getByRole("button", { name: "Owned", exact: true })).toBeDisabled();
  await expect(page.locator(".fc-cluster")).toContainText("/ 12 L");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.pause());
  const beforeCone = await simState(page);
  const second = new CampaignDriver(world, beforeCone, "p1", e2eGameSystems());
  await quietRenderer(page, () => plan(second, () => second.coneHotDeskSpot()));
  console.info(`Campaign completion planned: ${second.frames.length} input frames`);
  await feed(page, second);
  await page.waitForFunction(() => {
    const progress = (window as unknown as FogWindow).__fogcity!.state().ext.missions?.players.p1;
    return progress?.missionId === "spill" && progress.stepId === "posting";
  });
  const call = page.getByRole("dialog", { name: "Spill", exact: true });
  await expect(call).toBeVisible({ timeout: 60_000 });
  const awaitingCall = await simState(page);
  expect(awaitingCall.ext.missions!.players.p1!.completedIds.filter(id => id === "hot-desk")).toHaveLength(1);
  expect(awaitingCall.ext.missions!.players.p1!.rewardedIds).toContain("hot-desk:moved-in");
  expect(awaitingCall.ext.economy!.players.p1!.ownedSiteIds).toContain("fidi-desk");
  expect(awaitingCall.ext.economy!.players.p1!.ownedItemIds).toEqual(expect.arrayContaining(["vendor:fidi-desk", "app:bot-bounty"]));
  expect(awaitingCall.ext.economy!.players.p1!.cashCents).toBeGreaterThanOrEqual(beforeCone.ext.economy!.players.p1!.cashCents + 50_000);
  await call.getByRole("button", { name: "Continue", exact: true }).click();
  await page.waitForFunction(() => {
    const handle = (window as unknown as FogWindow).__fogcity!;
    if (handle.state().ext.missions?.players.p1?.stepId !== "go") return false;
    handle.pause();
    return true;
  });
  const final = await simState(page);
  console.info(`Campaign browser acknowledged Spill at tick ${final.tick}`);
  expect(final.ext.missions!.players.p1!.missionId).toBe("spill");
  expect(final.ext.dodge).toMatchObject({ contacts: 0, failures: 0 });
  const commands = await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.commands!());
  expect(commands.filter(command => (command.payload as {kind?: string}).kind === "startup-define")).toHaveLength(1);
  expect(commands.filter(command => (command.payload as {kind?: string}).kind === "mission-ack")).toHaveLength(1);
  const recorded = withRecordedCommands([
    { frames: first.frames },
    p1Chunk(beforeCone.tick - first.state.tick),
    { frames: second.frames },
    p1Chunk(final.tick - second.state.tick),
  ], initial.tick, commands);
  const expectedHash = hashState(final);
  const replayHash = await quietRenderer(page, () => {
    const actualHash = hashState(replay(world, initial, recorded, e2eGameSystems()).final);
    writeFileSync("test-results/campaign-replay-proof.json", JSON.stringify({
      initialTick: initial.tick, finalTick: final.tick,
      inputFrames: recorded.reduce((count, chunk) => count + chunk.frames.length, 0),
      commands: commands.length, actualHash, expectedHash, matches: actualHash === expectedHash,
    }, null, 2));
    return actualHash;
  });
  expect(replayHash).toBe(expectedHash);
  console.info("Campaign full replay hash matched");
  await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.setCameraMode!("chase"));
  await frames(page, 2);
  await page.screenshot({ path: "test-results/hot-desk-complete-third-person.png" });
  await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.setCameraMode!("first-person"));
  await frames(page, 2);
  await page.screenshot({ path: "test-results/hot-desk-complete-first-person.png" });
  expect(problems).toEqual([]);
});
