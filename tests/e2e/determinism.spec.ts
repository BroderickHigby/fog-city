// CROSS-ENGINE DETERMINISM. The sim is the truth for netcode, replays and saves, so the same
// world, seed, inputs and events must give bit-identical states on every JavaScript engine.
//
// 1. Pure sim (@engines: runs in Chromium, Firefox and WebKit): determinism-scenario.ts runs a
//    multiplayer script (five players, joins and leaves, steering, collisions, on-foot hops,
//    clamped junk input, ambient traffic when the sim has it) in Node and in the browser via
//    sim-lab.html; every 15th tick's hashState must match, and so must the final state.
// 2. The running game (Chromium): the real game loop is paused, stepped through
//    window.__fogcity.stepN() with render-only pokes in between (camera keys, night, fly), and
//    every hash must match Node stepping the same snapshot with the same inputs.

import { existsSync } from "node:fs";
import { chromium, expect, firefox, test, webkit, type Page } from "@playwright/test";
import {
  Action,
  canonicalJson,
  createInitialState,
  hashState,
  sortedIds,
  step,
  type SimInput,
  type SimState,
  type World,
} from "../../src/sim/index.ts";
import { loadWorldFiles, worldExists } from "../helpers.ts";
import { dmathDigest, makeWorld, runScenario, type ScenarioResult } from "./determinism-scenario.ts";
import { FAST_QUERY, FAST_VIEWPORT, bootWorld, features, frames, simState, type FogWindow } from "./fixtures.ts";
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

/** Where two long strings first differ, with a little context, for failure messages. */
function firstDifference(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === a.length && i === b.length) return "identical";
  const from = Math.max(0, i - 120);
  return `offset ${i}:\n  node:    …${a.slice(from, i + 80)}\n  browser: …${b.slice(from, i + 80)}`;
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
  test.skip(
    ({ browserName }) => !browserInstalled(browserName),
    "this browser is not installed here (pnpm exec playwright install --with-deps firefox webkit)",
  );

  test("dmath and hashState are bit-identical in Node and this browser", async ({ page }) => {
    await openSimLab(page);
    const browser = await page.evaluate(() => window.__simlab!.dmath(20000));
    expect(browser).toEqual(dmathDigest(20000));
  });

  for (const { world, ticks } of RUNS) {
    test(`${world}: a ${ticks}-tick multiplayer run hashes identically in Node and this browser`, async ({ page, browserName }) => {
      test.skip(!worldExists(world), `public/tiles/${world}/manifest.json is absent on this checkout`);
      const files = loadWorldFiles(world);
      const t0 = performance.now();
      const node = runScenario(makeWorld(files.tiles, files.roads), {
        ticks,
        checkpointEvery: EVERY,
        seed: SEED,
        spawn: files.manifest.spawn,
      });
      const nodeMs = performance.now() - t0;

      const ua = await openSimLab(page);
      const browser = await page.evaluate(([w, o]) => window.__simlab!.run(w, o), [world, { ticks, checkpointEvery: EVERY, seed: SEED }] as const);
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

type Poke = "KeyC" | "KeyV" | "KeyN" | "night" | "fly" | "chase";
type PlanStep = { n: number; input: SimInput } | { poke: Poke };

const I = (throttle: number, steer = 0, brake = 0, actions = 0): SimInput => ({ throttle, steer, brake, actions });

/** p1's inputs, with render-only pokes between them. On dev the third segment hits the wall. */
const PLAN: PlanStep[] = [
  { n: 90, input: I(1) },
  { poke: "KeyC" },
  { n: 60, input: I(1, 0.5) },
  { poke: "night" },
  { n: 60, input: I(1, -0.5) },
  { n: 240, input: I(1) },
  { poke: "KeyV" },
  { n: 60, input: I(-1, -1) },
  { poke: "KeyV" },
  { poke: "fly" },
  { n: 120, input: I(0.5, 0.25) },
  { poke: "KeyN" },
  { n: 40, input: I(0, 0, 1) },
  { poke: "chase" },
  { n: 1, input: I(0, 0, 0, Action.enterExit) },
  { n: 90, input: I(1, 0.25) },
  { poke: "KeyC" },
  { n: 1, input: I(0, 0, 0, Action.enterExit) },
  { n: 120, input: I(1, -0.5) },
];

function nodeHashes(world: World, s0: SimState): { hashes: string[]; final: SimState } {
  let s = s0;
  const hashes: string[] = [];
  for (const p of PLAN) {
    if (!("n" in p)) continue;
    for (let i = 0; i < p.n; i++) s = step(world, s, { p1: p.input });
    hashes.push(hashState(s));
  }
  return { hashes, final: s };
}

test.describe("cross-engine determinism: the running game", () => {
  test.use({ viewport: FAST_VIEWPORT });
  for (const world of ["dev", "sf"] as const) {
    test(`${world}: the running game steps exactly like Node, and render toggles never touch the sim`, async ({ page }) => {
      test.skip(!worldExists(world), `public/tiles/${world}/manifest.json is absent on this checkout`);
      const problems = await bootWorld(page, world, FAST_QUERY);
      await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.pause());
      const s0 = await simState(page);
      expect(Object.keys(s0.players)).toContain("p1");
      const have = await features(page);

      const browserHashes: string[] = [];
      const skippedPokes: string[] = [];
      for (const p of PLAN) {
        if ("n" in p) {
          browserHashes.push(
            await page.evaluate(({ n, input }) => {
              const h = (window as unknown as FogWindow).__fogcity!;
              h.stepN(n, input);
              return h.hash();
            }, p),
          );
          continue;
        }
        const before = browserHashes.at(-1) ?? null;
        if (p.poke.startsWith("Key")) {
          await page.keyboard.press(p.poke);
        } else if (p.poke === "night" && have.setNight) {
          await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.setNight!(true));
        } else if (p.poke === "fly" && have.flyTo) {
          await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.flyTo!(40, 60, 80, 330, -20));
        } else if (p.poke === "chase" && have.setCameraMode) {
          await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.setCameraMode!("chase"));
        } else {
          skippedPokes.push(p.poke);
          continue;
        }
        await frames(page, 2);
        // Paused: a render poke must leave the sim exactly where it was.
        const after = await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.hash());
        if (before) expect(after, `poke ${p.poke} changed the sim hash`).toBe(before);
      }
      const browserFinal = await simState(page);

      // Node steps the same snapshot. The game decides whether its sim world includes the road
      // graph (sim v2 traffic); try both constructions and require one to match every hash.
      const files = loadWorldFiles(world);
      const candidates: Array<{ label: string; world: World }> = [{ label: "colliders only", world: makeWorld(files.tiles, null) }];
      if (files.roads) candidates.push({ label: "colliders + road graph", world: makeWorld(files.tiles, files.roads) });
      const tried = candidates.map((c) => ({ ...c, ...nodeHashes(c.world, s0) }));
      const match = tried.find((c) => c.hashes.every((h, i) => h === browserHashes[i]));
      expect(
        match,
        tried
          .map((c) => {
            const i = c.hashes.findIndex((h, k) => h !== browserHashes[k]);
            return `${c.label}: first divergence after segment ${i} (node ${c.hashes[i]} vs game ${browserHashes[i]})`;
          })
          .join("\n"),
      ).toBeDefined();
      expect(canonicalJson(browserFinal)).toBe(canonicalJson(match!.final));

      if (world === "dev") {
        // The plan drives p1 into the dev wall: the comparison covered collisions.
        expect(browserFinal.players.p1!.car.hits).toBeGreaterThan(s0.players.p1!.car.hits);
      }

      // Informational: can a fresh client rebuild the game's boot state from (world, seed, players, spawn)?
      let boot = createInitialState(match!.world, s0.seed, sortedIds(s0.players), files.manifest.spawn);
      while (boot.tick < s0.tick) boot = step(match!.world, boot, {}, []);
      const reproducible = canonicalJson(boot) === canonicalJson(s0);
      test.info().annotations.push({
        type: "determinism",
        description:
          `${browserHashes.length} segments equal with the game's world built from ${match!.label}; ` +
          `boot state ${reproducible ? "is" : "is NOT"} reproducible from (seed ${s0.seed}, players, spawn) after ${s0.tick} neutral ticks` +
          (skippedPokes.length ? `; pokes not available: ${skippedPokes.join(", ")}` : ""),
      });
      expect(problems).toEqual([]);
    });
  }
});
