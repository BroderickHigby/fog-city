// Weather in the running game (wave 3, src/sim/fog): the page registers the weather reducer in
// its real step, and Node, stepping the browser's own snapshot with the same inputs, matches it
// exactly. Rain and the King tide follow the seeded calendar (rain only in winter weeks), so the
// rainy/tidal rules themselves are covered by tests/sim/fog.test.ts on the same code.
import { expect, test } from "@playwright/test";
import { activeBody, dailyWeather, fogDensity, gameTime, tractionAt, weatherView, type SimInput } from "../../src/sim/index.ts";
import { e2eGameSystems } from "./game-systems.ts";
import { FAST_QUERY, FAST_VIEWPORT, bootWorld, gateWorld, pause, simState, type FogWindow } from "./fixtures.ts";
import { constructions, matchGame, p1Chunk, withRecordedCommands } from "./replay.ts";

test.use({ viewport: FAST_VIEWPORT });

const DRIVE: SimInput = { throttle: 0.6, steer: 0.05, brake: 0, actions: 0 };

test("sf: the live game runs the weather system tick for tick like Node", async ({ page }) => {
  gateWorld("sf");
  const problems = await bootWorld(page, "sf", FAST_QUERY);
  await pause(page);
  const initial = await simState(page);
  const chunk = p1Chunk(240, DRIVE);
  const final = await page.evaluate((chunk) => {
    const handle = (window as unknown as FogWindow).__fogcity!;
    if (!handle.stepFrames || !handle.commands) throw new Error("The composed game must expose stepping and read-only commands");
    handle.stepFrames(chunk.frames);
    return { state: handle.state(), hash: handle.hash(), commands: handle.commands() };
  }, chunk);
  expect(final.state.ext.fog, "the wave-3 page registers the weather reducer").toMatchObject({ version: 1, windows: [] });
  const matched = matchGame("sf", initial, withRecordedCommands([chunk], initial.tick, final.commands), [final.hash], final.state, e2eGameSystems());
  expect(matched.match, matched.tried.join("\n")).toBeDefined();

  // What the weather says where the player now is, read from the browser's own state.
  const world = constructions("sf").get(0).world;
  const body = activeBody(final.state.players.p1!);
  const view = weatherView(world, final.state, body.x, body.z);
  expect(view.fog).toBe(fogDensity(world, final.state, body.x, body.z));
  expect(view.fog).toBeGreaterThanOrEqual(0);
  expect(view.fog).toBeLessThanOrEqual(1);
  const today = dailyWeather(final.state);
  expect(gameTime(final.state).season).toBe("summer");
  expect(today.rain).toBe(false);
  expect(view.rain).toBe(0);
  if (view.tide === 0) expect(tractionAt(world, final.state, body.x, body.z), "dry summer roads").toBe(1);
  test.info().annotations.push({ type: "weather", description: JSON.stringify({ hour: view.hour.toFixed(2), fog: view.fog, kingTide: today.kingTide, tide: view.tide }) });
  expect(problems).toEqual([]);
});
