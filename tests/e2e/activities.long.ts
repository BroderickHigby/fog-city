// Side activities in the real SF world, in the browser: started from the HUD's activity panel and
// finished through real controls, with an exact Node replay and no protected-body contact.
import { expect, test, type Page } from "@playwright/test";
import { Action } from "../../src/sim/index.ts";
import { DEFAULT_CATALOG } from "../../src/sim/player/catalog.ts";
import { loadWorld } from "../helpers.ts";
import { savedAfterSpill } from "../helpers/drivers/wave3-campaign.ts";
import { bootWorld, simState, type FogWindow } from "./fixtures.ts";
import { e2eGameSystems } from "./game-systems.ts";
import { QUERY, Session, applyQueued, feed, importAndLoad, quietly, saveFile } from "./campaign-browser.ts";

const { world, manifest } = loadWorld("sf", { roads: true });
const systems = e2eGameSystems();

/** Press the panel's Start, step the tick that applies its queued command, and check the activity runs. */
async function start(page: Page, id: string, title: string): Promise<void> {
  const panel = page.locator(".fc-activity");
  await expect(panel.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Start", exact: true }).click();
  await applyQueued(page, "activity-start");
  expect((await simState(page)).ext.activities?.players.p1?.activeActivityId).toBe(id);
}

test.use({ viewport: { width: 960, height: 540 } });

test("hill delivery starts from the activity panel and finishes on foot through real controls", async ({ page }) => {
  test.setTimeout(4 * 60 * 60_000);
  const problems = await bootWorld(page, "sf", QUERY);
  await page.evaluate(() => { const h = (window as unknown as FogWindow).__fogcity!; h.pause(); h.stepN(1); });
  await importAndLoad(page, await saveFile(savedAfterSpill(world, systems, manifest.spawn)), 1);
  const initial = await simState(page);
  const session = new Session(world, systems, initial);
  const activity = DEFAULT_CATALOG.activities.find(value => value.id === "hill-delivery")!;
  const [pickup, drop] = activity.checkpoints!;
  const walk = await quietly(page, () => session.plan(initial, "hill-delivery-walk", driver => driver.walkRoute(pickup!, pickup!.radius - 3), { budget: 90_000 }));
  await feed(page, walk);
  await start(page, "hill-delivery", "Hill delivery shift");
  await expect(page.locator(".fc-activity")).toContainText("Lombard at Leavenworth (2 of 2)");
  const started = await simState(page);
  const cash = started.ext.economy!.players.p1!.cashCents;
  const deliver = await quietly(page, () => session.plan(started, "hill-delivery-drop", driver => {
    driver.walkRoute(drop!, drop!.radius - 3);
    // The groceries change hands once the route has run its first minute.
    while (driver.state.tick - started.tick < 61) driver.hold(1);
    driver.hold(1, Action.interact);
    driver.hold(2);
  }));
  await feed(page, deliver);
  const done = await session.verify(page, "hill-delivery");
  const own = done.ext.activities!.players.p1!;
  expect(own.activeActivityId).toBe("");
  expect(own.completedIds).toEqual(["hill-delivery"]);
  expect(done.ext.economy!.players.p1!.cashCents - cash).toBe(activity.rewardCents);
  await expect(page.locator(".fc-activity")).toBeHidden();
  expect(problems).toEqual([]);
});
