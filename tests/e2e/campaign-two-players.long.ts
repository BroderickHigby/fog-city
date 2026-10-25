// Two players in one real-SF page session: the local player (p1) loads a post-Spill save and plays
// Launch Day; a second player (p2) joins through the sim's join event, as a remote player's client
// would, and plays its own first mission, Hot Desk, with its commands arriving as events. Each
// keeps its own actors, guidance and rewards, paid exactly once, including after a reload.
import { expect, test } from "@playwright/test";
import { NEUTRAL_INPUT, type SimEvent } from "../../src/sim/index.ts";
import { captureProgression } from "../../src/save/progression.ts";
import { STARTUP_KITS } from "../../src/content/kits.ts";
import { missionActorBindings } from "../../src/sim/agents/systems.ts";
import { uiProjection } from "../../src/ui/projection.ts";
import { loadWorld } from "../helpers.ts";
import { savedAfterSpill } from "../helpers/drivers/wave3-campaign.ts";
import { bootWorld, simState, type FogWindow } from "./fixtures.ts";
import { e2eGameSystems } from "./game-systems.ts";
import { QUERY, Session, choose, feed, importAndLoad, loadSlot, quietly, saveFile, saveSlot } from "./campaign-browser.ts";

const { world, manifest } = loadWorld("sf", { roads: true });
const systems = e2eGameSystems();
const HOLD = { ...NEUTRAL_INPUT, brake: 1 };

test.use({ viewport: { width: 960, height: 540 } });

test("two players keep their own missions, guidance and once-only rewards", async ({ page }) => {
  test.setTimeout(4 * 60 * 60_000);
  // Each page load keeps its own live problem list; all must stay empty.
  const problems = [await bootWorld(page, "sf", QUERY)];
  await page.evaluate(() => { const h = (window as unknown as FogWindow).__fogcity!; h.pause(); h.stepN(1); });
  await importAndLoad(page, await saveFile(savedAfterSpill(world, systems, manifest.spawn)), 1);
  const initial = await simState(page);
  const session = new Session(world, systems, initial);

  // p2 joins at the Ferry Building plaza, the city's spawn.
  const join: SimEvent = { tick: initial.tick + 1, kind: "player.join", playerId: "p2", payload: { ...manifest.spawn } };
  const frames = [{ p1: HOLD }];
  const joined = await page.evaluate(([batch, events]) => {
    const handle = (window as unknown as FogWindow).__fogcity!;
    handle.stepFrames!(batch, events);
    return handle.state();
  }, [frames, [join]] as const);
  session.note(frames, [join], joined);
  expect(Object.keys(joined.players).sort()).toEqual(["p1", "p2"]);

  // p2: Hot Desk through the watch, the melt and the walk to the desk, while p1 waits braked.
  const hotDesk = await quietly(page, () => session.plan(joined, "two-players-hot-desk", driver => {
    // A remote player's client asks for its first campaign mission, as the page does for its own.
    driver.command({ kind: "mission-start", targetId: "hot-desk" });
    driver.hotDeskToSignup();
    driver.command({ kind: "startup-define", kitId: STARTUP_KITS[0]!.id });
    driver.hold(12);
    driver.coneHotDeskSpot();
  }, { playerId: "p2", companions: { p1: HOLD }, budget: 60_000 }));
  await feed(page, hotDesk);
  const afterHotDesk = await simState(page);
  const p2 = afterHotDesk.ext.missions!.players.p2!;
  expect(p2.completedIds).toContain("hot-desk");
  expect(p2.rewardedIds.filter(id => id === "hot-desk:moved-in")).toHaveLength(1);
  // p1 is untouched by p2's mission: still waiting for Washington Square, with nothing paid.
  expect(afterHotDesk.ext.missions!.players.p1).toMatchObject({ missionId: "launch-day", stepId: "start" });
  expect(afterHotDesk.ext.missions!.players.p1!.rewardedIds).toEqual(initial.ext.missions!.players.p1!.rewardedIds);

  // p1: Launch Day to the false positive, while p2 stands still.
  const opening = await quietly(page, () => session.plan(afterHotDesk, "two-players-launch-day", driver => driver.launchDayToFalsePositive(), { companions: { p2: HOLD } }));
  await feed(page, opening);
  const atEvidence = await simState(page);
  // Identity isolation: the Launch Day actors are bound to p1 only; each player's guidance is its own.
  const p1Actors = missionActorBindings(atEvidence, "launch-day", "p1"), p2Actors = missionActorBindings(atEvidence, "launch-day", "p2");
  expect(p1Actors.suspect).toBeDefined();
  expect(Object.keys(atEvidence.ext.robots?.missionBindings ?? {}).some(key => key.startsWith("p2:launch-day:"))).toBe(false);
  expect(p2Actors.suspect ?? p1Actors.suspect).toBe(p1Actors.suspect);
  const p1View = uiProjection(atEvidence, "p1", null, undefined, 3), p2View = uiProjection(atEvidence, "p2", null, undefined, 3);
  expect(p1View.objective?.title).toBe("Launch Day");
  expect(p1View.interaction?.choices.map(choice => choice.id)).toEqual(["ack"]);
  expect(p2View.objective?.title ?? "").not.toBe("Launch Day");
  expect(p2View.interaction).toBeUndefined();
  await choose(page, "Launch Day", "Continue", "active:compare");
  const compare = await simState(page);
  const melt = await quietly(page, () => session.plan(compare, "two-players-melt", driver => driver.launchDayToPivot(), { companions: { p2: HOLD } }));
  await feed(page, melt);
  await choose(page, "Launch Day", "Something with robots", "complete");
  const done = await session.verify(page, "two-players");
  expect(done.ext.missions!.players.p1!.rewardedIds.filter(id => id === "launch-day:complete")).toHaveLength(1);
  expect(done.ext.missions!.players.p2!.rewardedIds.some(id => id.startsWith("launch-day"))).toBe(false);
  expect(done.ext.missions!.players.p2!.rewardedIds.filter(id => id === "hot-desk:moved-in")).toHaveLength(1);
  const cash = { p1: done.ext.economy!.players.p1!.cashCents, p2: done.ext.economy!.players.p2!.cashCents };
  await saveSlot(page, 2);

  // Reload, each player on their own client: neither reward is paid again.
  const p2Save = await saveFile(captureProgression(done, "p2"));
  // A reload is a fresh navigation to the game.
  problems.push(await bootWorld(page, "sf", QUERY));
  await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.pause());
  await loadSlot(page, 2);
  const p1Again = await simState(page);
  expect(p1Again.ext.missions!.players.p1!.completedIds).toContain("launch-day");
  expect(p1Again.ext.economy!.players.p1!.cashCents).toBe(cash.p1);
  // A reload is a fresh navigation to the game.
  problems.push(await bootWorld(page, "sf", QUERY));
  await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.pause());
  await importAndLoad(page, p2Save, 3);
  const p2Again = await simState(page);
  expect(p2Again.ext.missions!.players.p1!.completedIds).toContain("hot-desk");
  expect(p2Again.ext.missions!.players.p1!.rewardedIds).toContain("hot-desk:moved-in");
  expect(p2Again.ext.economy!.players.p1!.cashCents).toBe(cash.p2);
  expect(problems.flat()).toEqual([]);
});
