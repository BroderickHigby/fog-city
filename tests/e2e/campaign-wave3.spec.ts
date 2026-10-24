// Wave-3 campaign in the real SF world, in the browser: Launch Day played through real controls
// and the page's own dialogs, with save/reload mid-mission and after completion, a failed attempt
// retried with fresh actors, an exact Node replay, and no protected-body contact.
import { expect, test, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { canonicalJson, hashState, type SimEvent, type SimState } from "../../src/sim/index.ts";
import { MemorySaveBackend, SaveStore } from "../../src/save/store.ts";
import { validateSavedProgression } from "../../src/save/progression.ts";
import type { ProgressionDocument } from "../../src/save/store.ts";
import { loadWorld } from "../helpers.ts";
import { Wave3Driver, savedAfterSpill } from "../helpers/drivers/wave3-campaign.ts";
import { bootWorld, simState, type FogWindow } from "./fixtures.ts";
import { p1Chunk, replay, withRecordedCommands, type Chunk } from "./replay.ts";
import { e2eGameSystems } from "./game-systems.ts";

const QUERY = "&radius=300&pr=0.75";
const { world, manifest } = loadWorld("sf", { roads: true });
const systems = e2eGameSystems();

/** A save file exactly as the page's Export button writes it. */
async function saveFile(data: ProgressionDocument): Promise<string> {
  const store = new SaveStore({ backends: [new MemorySaveBackend()], contentHash: "e2e", validate: validateSavedProgression });
  await store.save(0, data);
  return store.export(0);
}

async function openSaves(page: Page) {
  await page.getByRole("button", { name: "Open phone", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  return page.locator(".fc-save-panel");
}
const slot = (page: Page, n: number) => page.locator(".fc-save-panel article").filter({ has: page.getByRole("heading", { name: `Save slot ${n}`, exact: true }) });
async function closeDialog(page: Page): Promise<void> {
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).first().click();
}

/** Import a save file into a slot with the page's Import button, then load it with Load. */
async function importAndLoad(page: Page, text: string, n: number): Promise<void> {
  await openSaves(page);
  const chooser = page.waitForEvent("filechooser");
  await slot(page, n).getByRole("button", { name: "Import save", exact: true }).click();
  await (await chooser).setFiles({ name: `slot-${n}.json`, mimeType: "application/json", buffer: Buffer.from(text) });
  await page.locator(".fc-save-panel").getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(slot(page, n).getByRole("button", { name: "Load progress", exact: true })).toBeEnabled();
  await loadSlot(page, n, false);
}
async function loadSlot(page: Page, n: number, open = true): Promise<void> {
  if (open) await openSaves(page);
  await slot(page, n).getByRole("button", { name: "Load progress", exact: true }).click();
  await page.locator(".fc-save-panel").getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.locator(".fc-save-panel [role=status]")).toHaveText("Done");
  // Hold the clock before the dialog closes, so planning starts from a still frame.
  await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.pause());
  await closeDialog(page);
}
async function saveSlot(page: Page, n: number): Promise<void> {
  await openSaves(page);
  await slot(page, n).getByRole("button", { name: "Save progress", exact: true }).click();
  await expect(page.locator(".fc-save-panel [role=status]")).toHaveText("Progress saved");
  await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.pause());
  await closeDialog(page);
}

/** Keep SwiftShader idle while Node plans; restore the real viewport even on failure. */
async function quietly<T>(page: Page, run: () => T): Promise<T> {
  await page.setViewportSize({ width: 1, height: 1 });
  try { return run(); }
  finally { await page.setViewportSize({ width: 960, height: 540 }); }
}
function plan(driver: Wave3Driver, name: string, run: () => void): void {
  try { run(); }
  catch (error) {
    writeFileSync(`test-results/${name}-repro.json`, JSON.stringify({ state: driver.state, previousState: driver.previousState, trace: driver.trace }));
    throw new Error(`${(error as Error).message}\n${driver.trace.slice(-12).join("\n")}`);
  }
}
/** Feed planned inputs to the page in batches; the page must reach exactly the planned state. */
async function feed(page: Page, driver: Wave3Driver): Promise<void> {
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
/** Click a dialog choice, then hold the clock once the sim has applied it. */
async function choose(page: Page, dialog: string, label: string, applied: string): Promise<void> {
  await page.getByRole("dialog", { name: dialog, exact: true }).getByRole("button", { name: label, exact: true }).click();
  await page.waitForFunction(check => {
    const handle = (window as unknown as FogWindow).__fogcity!;
    const progress = handle.state().ext.missions?.players.p1;
    if (`${progress?.status}:${progress?.stepId}` !== check && progress?.status !== check) return false;
    handle.pause();
    return true;
  }, applied);
}

/** Records every planned chunk and the idle ticks between them, for one exact replay at the end. */
class Session {
  readonly chunks: Chunk[] = [];
  readonly initial: SimState;
  last: SimState;
  constructor(initial: SimState) { this.initial = initial; this.last = initial; }
  plan(state: SimState, name: string, run: (driver: Wave3Driver) => void): Wave3Driver {
    if (state.tick > this.last.tick) this.chunks.push(p1Chunk(state.tick - this.last.tick));
    const driver = new Wave3Driver(world, state, "p1", systems);
    plan(driver, name, () => run(driver));
    this.chunks.push({ frames: driver.frames });
    this.last = driver.state;
    return driver;
  }
  async verify(page: Page, label: string): Promise<SimState> {
    const final = await simState(page);
    if (final.tick > this.last.tick) this.chunks.push(p1Chunk(final.tick - this.last.tick));
    this.last = final;
    const commands = await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.commands!());
    const recorded = withRecordedCommands(this.chunks, this.initial.tick, commands.filter(command => command.tick > this.initial.tick) as SimEvent[]);
    const actual = await quietly(page, () => hashState(replay(world, this.initial, recorded, systems).final));
    const expected = hashState(final);
    writeFileSync(`test-results/${label}-replay-proof.json`, JSON.stringify({
      initialTick: this.initial.tick, finalTick: final.tick, inputFrames: recorded.reduce((n, c) => n + c.frames.length, 0),
      commands: commands.length, actualHash: actual, expectedHash: expected, matches: actual === expected,
    }, null, 2));
    expect(actual, `${label}: Node replay of the browser session`).toBe(expected);
    expect(final.ext.dodge).toMatchObject({ contacts: 0, failures: 0 });
    return final;
  }
}

test.use({ viewport: { width: 960, height: 540 } });

test("Launch Day completes through real controls, survives reloads, and pays once", async ({ page }) => {
  test.setTimeout(3_600_000);
  const problems = await bootWorld(page, "sf", QUERY);
  await page.evaluate(() => { const h = (window as unknown as FogWindow).__fogcity!; h.pause(); h.stepN(1); });
  await importAndLoad(page, await saveFile(savedAfterSpill(world, systems, manifest.spawn)), 1);
  const initial = await simState(page);
  expect(initial.ext.missions!.players.p1).toMatchObject({ missionId: "launch-day", status: "active", stepId: "start" });
  const cashBefore = initial.ext.economy!.players.p1!.cashCents;
  const session = new Session(initial);

  // Washington Square: drive (walking past gridlock if it must), watch, scan, then the false positive.
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
  // The mission pays $900 once; melts and bounties may add a little more, never a second $900.
  expect(done.ext.economy!.players.p1!.cashCents - cashBefore).toBeGreaterThanOrEqual(90_000);
  expect(done.ext.economy!.players.p1!.cashCents - cashBefore).toBeLessThan(180_000);
  expect(done.ext.combat!.targets[opening.bound("courier")]?.rust ?? 0).toBe(0);
  await saveSlot(page, 3);

  // Reload after completion: the reward is not paid again and the campaign moves on.
  await page.reload();
  await bootWorld(page, "sf", QUERY);
  await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.pause());
  await loadSlot(page, 3);
  const after = await simState(page);
  expect(after.ext.missions!.players.p1!.completedIds).toContain("launch-day");
  expect(after.ext.missions!.players.p1!.missionId).toBe("demoed-correctly");
  expect(after.ext.economy!.players.p1!.cashCents).toBe(done.ext.economy!.players.p1!.cashCents);
  expect(after.ext.progression!.players.p1!.scannerTier).toBe(2);

  // Reload mid-mission: Launch Day restarts from its start area, unpaid, and a timed-out attempt
  // retries with fresh actors.
  await page.reload();
  await bootWorld(page, "sf", QUERY);
  await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.pause());
  await loadSlot(page, 2);
  const restarted = await simState(page);
  expect(restarted.ext.missions!.players.p1).toMatchObject({ missionId: "launch-day", status: "active", stepId: "start" });
  expect(restarted.ext.missions!.players.p1!.completedIds).not.toContain("launch-day");
  expect(restarted.ext.economy!.players.p1!.cashCents).toBe(cashBefore);
  const retrySession = new Session(restarted);
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
  expect(second.ext.economy!.players.p1!.cashCents - cashBefore).toBeGreaterThanOrEqual(90_000);
  expect(second.ext.economy!.players.p1!.cashCents - cashBefore).toBeLessThan(180_000);
  expect(problems).toEqual([]);
});
