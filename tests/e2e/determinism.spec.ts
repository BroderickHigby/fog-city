// CROSS-ENGINE DETERMINISM. The sim is the truth for netcode, replays and saves, so the same
// world, seed, inputs and events must give bit-identical states on every JavaScript engine.
//
// 1. Pure sim (@engines: runs in Chromium, Firefox and WebKit): determinism-scenario.ts runs a
//    multiplayer script (five players, joins and leaves, steering, collisions, on-foot hops,
//    clamped junk input, ambient traffic when the sim has it) in Node and in the browser via
//    sim-lab.html; every 15th tick's hashState must match, and so must the final state.
// 2. The running game (Chromium): the real game loop is paused and stepped through
//    window.__fogcity.stepN(); between segments come render-only pokes (C, V, N keys, night,
//    fly camera, camera mode), each followed by the game's own loop running ~36 ticks with no
//    key held. Node replays the same snapshot with the same inputs (neutral for the loop's
//    runs) and must match every hash and the final state. The world must be built the way its
//    manifest says (with the road graph when it names one, so sim traffic runs in the game).
// 3. The running game, multiplayer (Chromium, through window.__fogcity.stepFrames()): the
//    scenario's session (joins, leaves, five players, junk input, collisions) recorded in Node
//    and fed to the game frame by frame, compared with Node chunk by chunk.

import { existsSync } from "node:fs";
import { chromium, expect, firefox, test, webkit, type Page } from "@playwright/test";
import {
  Action,
  NEUTRAL_INPUT,
  canonicalJson,
  createInitialState,
  sortedIds,
  step,
  type SimInput,
  type SimState,
} from "../../src/sim/index.ts";
import { loadWorldFiles } from "../helpers.ts";
import { dmathDigest, makeWorld, recordSession, runScenario, type ScenarioResult } from "./determinism-scenario.ts";
import {
  FAST_QUERY,
  FAST_VIEWPORT,
  bootWorld,
  features,
  gateWorld,
  optionalAbsent,
  pause,
  pokeName,
  pokeNeeds,
  pokeThenRun,
  required,
  simState,
  stepN,
  type FogWindow,
  type Poke,
} from "./fixtures.ts";
import { firstDifference, matchGame, p1Chunk, type Chunk, type MatchResult } from "./replay.ts";
import type {} from "./sim-lab.ts"; // window.__simlab typing

const SEED = 20261020;
const EVERY = 15;
/** Ticks per world: the whole scenario on dev; shorter where ambient traffic makes ticks costly. */
const RUNS = [
  { world: "dev", ticks: 3600 },
  { world: "dev-city", ticks: 1200 },
  { world: "sf", ticks: 900 },
] as const;

function browserInstalled(name: string): boolean {
  const type = { chromium, firefox, webkit }[name];
  try {
    return type !== undefined && existsSync(type.executablePath());
  } catch {
    return false;
  }
}

function expectSameRun(node: ScenarioResult, browser: ScenarioResult): void {
  const n = node.checkpoints.findIndex((c, i) => c !== browser.checkpoints[i]);
  expect(
    n,
    n < 0 ? "" : `first divergence at checkpoint ${n}: node ${node.checkpoints[n]} vs browser ${browser.checkpoints[n]}`,
  ).toBe(-1);
  expect(browser.checkpoints).toHaveLength(node.checkpoints.length);
  expect(browser.finalHash).toBe(node.finalHash);
  const diff = firstDifference(node.finalJson, browser.finalJson);
  expect(diff, `final states differ at ${diff}`).toBe("identical");
  expect(browser.stats).toEqual(node.stats);
}

async function openSimLab(page: Page): Promise<string> {
  await page.goto("/tests/e2e/sim-lab.html");
  await page.waitForFunction(() => window.__simlab?.ready === true, null, { timeout: 30_000 });
  return page.evaluate(() => window.__simlab!.userAgent);
}

test.describe("cross-engine determinism: pure sim", { tag: "@engines" }, () => {
  // Chromium is always required. With E2E_REQUIRE=engines a missing Firefox or WebKit runs
  // anyway, and fails at launch saying the executable is missing.
  test.skip(
    ({ browserName }) => optionalAbsent("engines", browserInstalled(browserName)),
    "this browser is not installed here (pnpm exec playwright install --with-deps firefox webkit)",
  );

  test("dmath and hashState are bit-identical in Node and this browser", async ({ page }) => {
    await openSimLab(page);
    const browser = await page.evaluate(() => window.__simlab!.dmath(20000));
    expect(browser).toEqual(dmathDigest(20000));
  });

  for (const { world, ticks } of RUNS) {
    test(`${world}: a ${ticks}-tick multiplayer run hashes identically in Node and this browser`, async ({ page, browserName }) => {
      gateWorld(world);
      const files = loadWorldFiles(world);
      const t0 = performance.now();
      const node = runScenario(makeWorld(files.tiles, files.roads, files.boundary), {
        ticks,
        checkpointEvery: EVERY,
        seed: SEED,
        spawn: files.manifest.spawn,
      });
      const nodeMs = performance.now() - t0;

      const ua = await openSimLab(page);
      const browser = await page.evaluate(([w, o]) => window.__simlab!.run(w, o), [world, { ticks, checkpointEvery: EVERY, seed: SEED }] as const);
      // The browser read the world as the game does: from the collider pack when the manifest names one.
      expect(browser.colliders, "the browser read the world's colliders like the game").toBe(files.colliders);
      expectSameRun(node, browser);

      // The run must actually exercise the sim, or equality proves little.
      expect(node.stats.playersSeen.length).toBeGreaterThanOrEqual(4);
      expect(node.stats.turned).toBeGreaterThan(1);
      if (world === "dev") expect(node.stats.hits, "p1 rams the dev wall").toBeGreaterThan(0);

      test.info().annotations.push({
        type: "determinism",
        description:
          `${browserName} (${ua}): ${node.checkpoints.length} checkpoints equal; ` +
          `players ${node.stats.playersSeen.join(",")}, hits ${node.stats.hits}, foot ticks ${node.stats.footTicks}, ` +
          `agents ${node.stats.agents}; node ${nodeMs.toFixed(0)} ms, browser ${browser.runMs.toFixed(0)} ms`,
      });
    });
  }
});

// ---- the running game ----------------------------------------------------------------------

type PlanStep = { n: number; input: SimInput } | { poke: Poke };

const I = (throttle: number, steer = 0, brake = 0, actions = 0): SimInput => ({ throttle, steer, brake, actions });

/**
 * p1's inputs, with render-only pokes between them. On dev the fourth segment hits the wall.
 * Each poke is followed by the game's own loop running with no key held (pokeThenRun), so a
 * key that leaks into the sim shows up as a difference from Node's neutral replay. A leak on
 * a press that switches to the fly camera cannot show (the fly camera feeds the player neutral
 * input by design), so V is checked on the press that leaves it.
 */
const PLAN: PlanStep[] = [
  { n: 90, input: I(1) },
  { poke: { key: "KeyC" } },
  { n: 60, input: I(1, 0.5) },
  { poke: { call: "night", on: true } },
  { n: 60, input: I(1, -0.5) },
  { n: 240, input: I(1) },
  { poke: { key: "KeyV" } },
  { n: 60, input: I(-1, -1) },
  { poke: { key: "KeyV" } },
  { poke: { call: "fly", at: [40, 60, 80, 330, -20] } },
  { n: 120, input: I(0.5, 0.25) },
  { poke: { key: "KeyN" } },
  { n: 40, input: I(0, 0, 1) },
  { poke: { call: "camera", mode: "chase" } },
  { n: 1, input: I(0, 0, 0, Action.enterExit) },
  { n: 90, input: I(1, 0.25) },
  { poke: { key: "KeyC", hold: true } },
  { n: 1, input: I(0, 0, 0, Action.enterExit) },
  { n: 120, input: I(1, -0.5) },
  { poke: { key: "KeyN", hold: true } },
  { poke: { key: "KeyC" } },
  { n: 30, input: I(0.5) },
];

/**
 * The game must build its sim world the way its manifest describes it: with the road graph
 * and the boundary when the manifest names them, or sim traffic never runs in the game and
 * its cars drive off the world. (The road graph was a known gap until src/main.ts passed the
 * roads to buildWorld(); it is now an ordinary assertion.)
 */
function expectManifestConstruction(world: string, m: MatchResult): void {
  const got = m.match!.label;
  const why =
    `the game built its sim world from "${got}", but public/tiles/${world}/manifest.json describes "${m.expected}", ` +
    `so Node's world does not match it: src/main.ts must pass the roads and the boundary to buildWorld()`;
  expect(got, why).toBe(m.expected);
}

test.describe("cross-engine determinism: the running game", () => {
  test.use({ viewport: FAST_VIEWPORT });
  for (const world of ["dev", "sf"] as const) {
    test(`${world}: the running game steps exactly like Node, and render pokes never touch the sim`, async ({ page }) => {
      gateWorld(world);
      // ~50 s on SF at load 5 (SwiftShader frames, traffic replay in Node): triple the timeout.
      test.slow(world === "sf", "SF boots and replays slowly under SwiftShader");
      const problems = await bootWorld(page, world, FAST_QUERY);
      await pause(page);
      const s0 = await simState(page);
      expect(Object.keys(s0.players)).toContain("p1");
      const have = await features(page);

      const chunks: Chunk[] = [];
      const gameHashes: string[] = [];
      const runs: string[] = [];
      const skippedPokes: string[] = [];
      for (const p of PLAN) {
        if ("n" in p) {
          gameHashes.push(await stepN(page, p.n, p.input));
          chunks.push(p1Chunk(p.n, p.input));
          continue;
        }
        const need = pokeNeeds(p.poke);
        if (need && !have[need]) {
          if (required("render-debug")) throw new Error(`E2E_REQUIRE names "render-debug", but window.__fogcity.${need}() is missing`);
          skippedPokes.push(pokeName(p.poke));
          continue;
        }
        // The paused sim must not move, then the game's own loop runs with no key held.
        const run = await pokeThenRun(page, p.poke);
        gameHashes.push(run.afterHash);
        chunks.push(p1Chunk(run.ran, NEUTRAL_INPUT));
        runs.push(`${pokeName(p.poke)}+${run.ran}`);
      }
      const gameFinal = await simState(page);

      // Node steps the same snapshot with the same inputs: the manifest's construction first.
      const m = matchGame(world, s0, chunks, gameHashes, gameFinal);
      expect(
        m.match,
        `the game and Node parted (chunks: ${chunks.length}; loop runs after pokes: ${runs.join(", ")}):\n${m.tried.join("\n")}`,
      ).toBeDefined();
      expect(canonicalJson(gameFinal)).toBe(canonicalJson(m.match!.final));

      if (world === "dev") {
        // The plan drives p1 into the dev wall: the comparison covered collisions.
        expect(gameFinal.players.p1!.car.hits).toBeGreaterThan(s0.players.p1!.car.hits);
      }

      // Informational: can a fresh client rebuild the game's boot state from (world, seed, players, spawn)?
      const files = loadWorldFiles(world);
      let boot = createInitialState(m.match!.world, s0.seed, sortedIds(s0.players), files.manifest.spawn);
      while (boot.tick < s0.tick) boot = step(m.match!.world, boot, {}, []);
      const bootJson = canonicalJson(boot);
      const s0Json = canonicalJson(s0);
      test.info().annotations.push({
        type: "determinism",
        description:
          `${gameHashes.length} chunks equal with the game's world built from ${m.match!.label} ` +
          `(manifest: ${m.expected}); loop runs after pokes: ${runs.join(", ")}; ` +
          `boot state ${bootJson === s0Json ? "is" : `is NOT (${firstDifference(bootJson, s0Json, "node", "game")})`} ` +
          `reproducible from (seed ${s0.seed}, players, spawn) after ${s0.tick} neutral ticks` +
          (skippedPokes.length ? `; pokes not available: ${skippedPokes.join(", ")}` : ""),
      });
      expect(problems).toEqual([]);
      expectManifestConstruction(world, m);
    });
  }

  const SESSION = [
    { world: "dev", ticks: 1800 },
    { world: "sf", ticks: 600 },
  ] as const;
  for (const { world, ticks } of SESSION) {
    test(`${world}: a ${ticks}-tick multiplayer session steps identically through the game's stepFrames()`, async ({ page }) => {
      gateWorld(world);
      test.slow(world === "sf", "SF boots and replays slowly under SwiftShader");
      const problems = await bootWorld(page, world, FAST_QUERY);
      // The game's debug handle provides stepFrames() since the wave-1 integration: its absence is a regression.
      expect((await features(page)).stepFrames, "window.__fogcity.stepFrames(frames, events) is provided").toBe(true);
      await pause(page);
      const s0 = await simState(page);
      const { manifest } = loadWorldFiles(world);
      const chunks = recordSession(sortedIds(s0.players), s0.tick, { ticks, seed: SEED, spawn: manifest.spawn }, 60);

      const gameHashes: string[] = [];
      for (const c of chunks) {
        gameHashes.push(
          await page.evaluate((chunk) => {
            const h = (window as unknown as FogWindow).__fogcity!;
            h.stepFrames!(chunk.frames, chunk.events);
            return h.hash();
          }, c),
        );
      }
      const gameFinal = await simState(page);
      expect(gameFinal.tick, "stepFrames() advanced one tick per frame").toBe(s0.tick + ticks);

      const m = matchGame(world, s0, chunks, gameHashes, gameFinal);
      expect(m.match, `the game and Node parted:\n${m.tried.join("\n")}`).toBeDefined();

      // The session must exercise the sim, or equality proves little.
      const joined = new Set(chunks.flatMap((c) => c.events.filter((e) => e.kind === "player.join").map((e) => e.playerId)));
      expect(joined.size, "players joined during the session").toBeGreaterThanOrEqual(3);
      expect(Object.keys(gameFinal.players).length, "players at the end").toBeGreaterThanOrEqual(3);
      if (world === "dev") expect(gameFinal.players.p1!.car.hits, "p1 rams the dev wall").toBeGreaterThan(s0.players.p1!.car.hits);
      test.info().annotations.push({
        type: "determinism",
        description: `${gameHashes.length} chunks of 60 ticks equal (world built from ${m.match!.label}); players at the end: ${sortedIds(gameFinal.players).join(",")}`,
      });
      expect(problems).toEqual([]);
      expectManifestConstruction(world, m);
    });
  }
});
