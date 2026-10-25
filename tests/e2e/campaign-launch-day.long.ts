// Launch Day in the real SF world, in the browser: played through real controls and the page's own
// dialogs from a post-Spill save, with save/reload mid-mission and after completion, a failed
// attempt retried with fresh actors, an exact Node replay, and no protected-body contact.
import { expect, test } from "@playwright/test";
import { loadWorld } from "../helpers.ts";
import { savedAfterSpill } from "../helpers/drivers/wave3-campaign.ts";
import { bootWorld, simState, type FogWindow } from "./fixtures.ts";
import { e2eGameSystems } from "./game-systems.ts";
import { QUERY, Session, choose, feed, importAndLoad, loadSlot, quietly, saveFile, saveSlot } from "./campaign-browser.ts";

const { world, manifest } = loadWorld("sf", { roads: true });
const systems = e2eGameSystems();
/** Launch Day pays $900 once; melts and bounties on the way may add a little, never a second $900. */
const PAY = 90_000;

test.use({ viewport: { width: 960, height: 540 } });

test("Launch Day completes through real controls, survives reloads, retries fresh and pays once", async ({ page }) => {
  test.setTimeout(4 * 60 * 60_000);
  // Each page load keeps its own live problem list; all must stay empty.
  const problems = [await bootWorld(page, "sf", QUERY)];
  await page.evaluate(() => { const h = (window as unknown as FogWindow).__fogcity!; h.pause(); h.stepN(1); });
  await importAndLoad(page, await saveFile(savedAfterSpill(world, systems, manifest.spawn)), 1);
  const initial = await simState(page);
  expect(initial.ext.missions!.players.p1).toMatchObject({ missionId: "launch-day", status: "active", stepId: "start" });
  const cashBefore = initial.ext.economy!.players.p1!.cashCents;
  const session = new Session(world, systems, initial);

  // Washington Square: drive (walking on past gridlock), watch, scan, then the false positive.
  const opening = await quietly(page, () => session.plan(initial, "launch-day-opening", driver => driver.launchDayToFalsePositive()));
  console.info(`Launch Day opening planned: ${opening.frames.length} frames; ${opening.trace.filter(line => line.startsWith("walking") || line.startsWith("plan")).join("; ")}`);
  await feed(page, opening);
  await choose(page, "Launch Day", "Continue", "active:compare");

  // Mid-mission save: progression only, so a reload restarts Launch Day without its reward.
  await saveSlot(page, 2);
  const compare = await simState(page);
  const middle = await quietly(page, () => session.plan(compare, "launch-day-melt", driver => driver.launchDayToPivot()));
  await feed(page, middle);
  await expect(page.getByRole("dialog", { name: "Launch Day", exact: true })).toBeVisible();
  await choose(page, "Launch Day", "Something with robots", "complete");
  const done = await session.verify(page, "launch-day");
  const progress = done.ext.missions!.players.p1!;
  expect(progress.completedIds.filter(id => id === "launch-day")).toHaveLength(1);
  expect(progress.rewardedIds.filter(id => id === "launch-day:complete")).toHaveLength(1);
  expect(done.ext.progression!.players.p1!.scannerTier).toBe(2);
  expect(done.ext.economy!.players.p1!.cashCents - cashBefore).toBeGreaterThanOrEqual(PAY);
  expect(done.ext.economy!.players.p1!.cashCents - cashBefore).toBeLessThan(2 * PAY);
  expect(done.ext.combat!.targets[opening.bound("courier")]?.rust ?? 0).toBe(0);
  await saveSlot(page, 3);

  // Reload after completion: the reward is not paid again and the campaign moves on.
  problems.push(await bootWorld(page, "sf", QUERY));
  await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.pause());
  await loadSlot(page, 3);
  const after = await simState(page);
  expect(after.ext.missions!.players.p1!.completedIds).toContain("launch-day");
  expect(after.ext.missions!.players.p1!.missionId).toBe("demoed-correctly");
  expect(after.ext.economy!.players.p1!.cashCents).toBe(done.ext.economy!.players.p1!.cashCents);
  expect(after.ext.progression!.players.p1!.scannerTier).toBe(2);

  // Reload mid-mission: Launch Day restarts from its start area, unpaid, and a timed-out attempt
  // retries with fresh actors.
  problems.push(await bootWorld(page, "sf", QUERY));
  await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.pause());
  await loadSlot(page, 2);
  const restarted = await simState(page);
  expect(restarted.ext.missions!.players.p1).toMatchObject({ missionId: "launch-day", status: "active", stepId: "start" });
  expect(restarted.ext.missions!.players.p1!.completedIds).not.toContain("launch-day");
  expect(restarted.ext.economy!.players.p1!.cashCents).toBe(cashBefore);
  const retrySession = new Session(world, systems, restarted);
  const firstTry = await quietly(page, () => retrySession.plan(restarted, "launch-day-timeout", driver => {
    driver.launchDayToFalsePositive();
    driver.waitForRetry();
  }));
  await feed(page, firstTry);
  const firstSuspect = firstTry.bound("suspect");
  await choose(page, "Launch Day", "Try again", "active:watch");
  const retried = await simState(page);
  const retry = await quietly(page, () => retrySession.plan(retried, "launch-day-retry", driver => {
    driver.hold(4);
    if (driver.bound("suspect") === firstSuspect) throw new Error("The retry reused the first attempt's suspect");
    driver.launchDayToFalsePositive();
  }));
  await feed(page, retry);
  await choose(page, "Launch Day", "Continue", "active:compare");
  const compared = await simState(page);
  const finish = await quietly(page, () => retrySession.plan(compared, "launch-day-retry-melt", driver => driver.launchDayToPivot()));
  await feed(page, finish);
  await choose(page, "Launch Day", "Something with robots", "complete");
  const second = await retrySession.verify(page, "launch-day-retry");
  expect(second.ext.missions!.players.p1!.rewardedIds.filter(id => id === "launch-day:complete")).toHaveLength(1);
  expect(second.ext.economy!.players.p1!.cashCents - cashBefore).toBeGreaterThanOrEqual(PAY);
  expect(second.ext.economy!.players.p1!.cashCents - cashBefore).toBeLessThan(2 * PAY);
  expect(problems.flat()).toEqual([]);
});
