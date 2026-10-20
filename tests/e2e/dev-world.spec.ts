// M0 acceptance on the hand-made dev world (public/tiles/dev): it boots cleanly and draws
// (and refuses to boot without the road graph its manifest names), real keys reach the sim, deterministic stepping stops at the wall and never passes through
// it, and the camera key changes the view but never the sim. "Never the sim" is checked with
// the game's own loop consuming input after each press (pokeThenRun), replayed in Node.

import { expect, test } from "@playwright/test";
import { hashState, pointInPolygon, type SimInput, type TileCollider } from "../../src/sim/index.ts";
import { readJson } from "../helpers.ts";
import {
  FAST_QUERY,
  FAST_VIEWPORT,
  THROTTLE,
  bootWorld,
  features,
  frames,
  gate,
  headingDelta,
  pause,
  pokeName,
  pokeThenRun,
  renderInfo,
  settle,
  simState,
  stepN,
  type FogWindow,
  type PokeRun,
} from "./fixtures.ts";
import { decodePng, imageStats, looksDrawn } from "./png.ts";
import { matchGame, p1Chunk } from "./replay.ts";

const collider = readJson<TileCollider>("public/tiles/dev/dev.collider.json");
const wall = collider.buildings.find((b) => b.id === "dev-wall")!;
const MOVING: SimInput = Object.freeze({ throttle: 1, steer: 0.4, brake: 0, actions: 0 });

/**
 * The game's own loop ran `run.ran` ticks after a render-only poke with no key held: Node, from
 * the same snapshot with NEUTRAL_INPUT for as many ticks, must reach exactly the same state.
 * Returns which sim-world construction matched (the KeyC tests do not care which; the
 * determinism spec does).
 */
function expectNeutralRun(world: string, run: PokeRun, what: string): string {
  expect(run.ran, `${what}: the game loop ran`).toBeGreaterThan(0);
  const m = matchGame(world, run.before, [p1Chunk(run.ran)], [hashState(run.after)], run.after);
  expect(
    m.match,
    `after ${what}, the game's own loop ran ${run.ran} ticks with no driving key held and reached a state Node ` +
      `does not reach with neutral input, so the key leaked into the sim input:\n${m.tried.join("\n")}`,
  ).toBeDefined();
  return `${what}: ${run.ran} ticks = ${m.match!.label}`;
}

test.describe("dev world: boot", () => {
  test("refuses to start a roadless world when the road graph its manifest names cannot be loaded", async ({ page }) => {
    // The road graph drives the ambient agents: a client without it would run a different
    // world from its peers, so boot must fail loudly instead.
    await page.route("**/tiles/dev/roads.json", (route) => route.fulfill({ status: 404, body: "not here" }));
    await page.goto(`/?world=dev${FAST_QUERY}`);
    await page.waitForFunction(() => (document.getElementById("hud")?.textContent ?? "").startsWith("Failed to start"), null, {
      timeout: 30_000,
    });
    expect(await page.locator("#hud").textContent()).toMatch(/^Failed to start: road graph roads\.json: .*HTTP 404/);
    expect(await page.evaluate(() => (window as unknown as FogWindow).__fogcity?.ready ?? false), "no game handle").toBe(false);
  });

  test("boots with no console errors and draws a frame", async ({ page }) => {
    const problems = await bootWorld(page, "dev");
    expect(await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.world)).toBe("dev");
    // The loop is alive: ticks advance on their own.
    const t0 = (await simState(page)).tick;
    await page.waitForFunction((t) => (window as unknown as FogWindow).__fogcity!.state().tick > t + 10, t0, { timeout: 20_000 });
    await settle(page);
    await frames(page, 10);

    const stats = imageStats(decodePng(await page.screenshot()), 7);
    expect(looksDrawn(stats), `the frame looks blank: ${JSON.stringify(stats)}`).toBe(true);
    expect(problems).toEqual([]);
  });
});

test.describe("dev world: behaviour", () => {
  test.use({ viewport: FAST_VIEWPORT });

  test("keyboard reaches the sim: W drives forward, D steers right", async ({ page }) => {
    const problems = await bootWorld(page, "dev", FAST_QUERY);
    const start = (await simState(page)).players.p1!.car;

    await page.keyboard.down("KeyW");
    // Heading 0 is north (-z): forward means z decreases.
    await page.waitForFunction((z) => (window as unknown as FogWindow).__fogcity!.state().players.p1!.car.z < z - 2, start.z, {
      timeout: 30_000,
    });
    const moving = (await simState(page)).players.p1!.car;
    await page.keyboard.down("KeyD");
    await page.waitForFunction(
      (h0) => {
        const c = (window as unknown as FogWindow).__fogcity!.state().players.p1!.car;
        let d = (c.heading - h0) % (2 * Math.PI);
        if (d > Math.PI) d -= 2 * Math.PI;
        if (d < -Math.PI) d += 2 * Math.PI;
        return d > 0.05; // compass bearings grow clockwise: right
      },
      moving.heading,
      { timeout: 30_000 },
    );
    await page.keyboard.up("KeyD");
    await page.keyboard.up("KeyW");
    const end = (await simState(page)).players.p1!.car;
    expect(Math.abs(end.x - start.x) + Math.abs(end.z - start.z)).toBeGreaterThan(2);
    expect(headingDelta(moving.heading, end.heading)).toBeGreaterThan(0.05);
    expect(problems).toEqual([]);
  });

  test("deterministic stepping: full throttle stops at the wall, never passes through", async ({ page }) => {
    const problems = await bootWorld(page, "dev", FAST_QUERY);
    const track = await page.evaluate((input) => {
      const h = (window as unknown as FogWindow).__fogcity!;
      h.pause();
      const out: Array<{ x: number; z: number; hits: number; speed: number; tick: number }> = [];
      for (let i = 0; i < 600; i++) {
        h.stepN(1, input);
        const s = h.state();
        const c = s.players.p1!.car;
        out.push({ x: c.x, z: c.z, hits: c.hits, speed: c.speed, tick: s.tick });
      }
      return out;
    }, THROTTLE);

    // One tick per stepN(1): no frame-loop ticks leak in while paused.
    for (let i = 1; i < track.length; i++) expect(track[i]!.tick).toBe(track[i - 1]!.tick + 1);
    const inside = track.filter((p) => pointInPolygon(p.x, p.z, wall.footprint));
    expect(inside, "car centre inside the wall").toEqual([]);
    const southFace = Math.max(...wall.footprint.map(([, z]) => z));
    const deepest = Math.min(...track.map((p) => p.z));
    expect(deepest, "car centre crossed the wall's south face").toBeGreaterThan(southFace);
    const last = track.at(-1)!;
    expect(last.hits).toBeGreaterThan(0);
    // Against the wall after 10 s, not somewhere short of it.
    expect(last.z).toBeLessThan(southFace + 8);
    expect(problems).toEqual([]);
  });

  test("KeyC never changes the sim: paused, or with the game loop running", async ({ page }) => {
    const problems = await bootWorld(page, "dev", FAST_QUERY);
    await pause(page);
    const notes: string[] = [];
    for (const poke of [{ key: "KeyC" }, { key: "KeyC" }, { key: "KeyC", hold: true }]) {
      // Moving and turning first, so a leaked throttle, steer, brake or action bit would show.
      await stepN(page, 20, MOVING);
      const run = await pokeThenRun(page, poke);
      notes.push(expectNeutralRun("dev", run, pokeName(poke)));
    }
    test.info().annotations.push({ type: "replay", description: notes.join("; ") });
    expect(problems).toEqual([]);
  });

  test("KeyC changes renderInfo().cameraMode, and still never the sim", async ({ page }) => {
    const problems = await bootWorld(page, "dev", FAST_QUERY);
    gate("render-debug", (await features(page)).renderInfo, "window.__fogcity.renderInfo() is not provided by this renderer yet");
    await pause(page);
    const modes = [(await renderInfo(page))!.cameraMode];
    for (let i = 0; i < 3; i++) {
      await stepN(page, 20, MOVING);
      const run = await pokeThenRun(page, { key: "KeyC" });
      modes.push((await renderInfo(page))!.cameraMode);
      expect(modes.at(-1), `KeyC press ${i + 1} did not change the camera mode (${modes.join(" -> ")})`).not.toBe(modes.at(-2));
      expectNeutralRun("dev", run, `KeyC press ${i + 1}`);
    }
    // C toggles between at least two views and comes back.
    expect(new Set(modes).size).toBeGreaterThanOrEqual(2);
    expect(modes[2]).toBe(modes[0]);
    expect(problems).toEqual([]);
  });
});
