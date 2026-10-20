// Shared browser-test plumbing: boot a world, collect everything that went wrong on the page,
// wait for tiles and frames, and reach the debug handle (window.__fogcity) whatever subset of
// it this checkout's renderer provides.

import { expect, test, type Browser, type Page } from "@playwright/test";
import type { InputFrame, SimEvent, SimInput, SimState } from "../../src/sim/contract.ts";
import { worldExists } from "../helpers.ts";
import { PREREQUISITES, parseRequire, type Prerequisite } from "./prereq.ts";

/** renderInfo() as the render track defines it (src/debug.ts); every field optional here. */
export interface RenderInfoLike {
  drawCalls: number;
  triangles: number;
  cameraMode: string;
  tilesLoaded?: number;
  tilesPending?: number;
  tilesTotal?: number;
  tilesFailed?: number;
  landmarks?: number;
  night?: boolean;
  fps?: number;
  pixelRatio?: number;
  shadows?: boolean;
}

/**
 * window.__fogcity. The first block is the Phase 0 contract every renderer provides; the
 * optional block is what the render track adds. Tests check for an optional member before
 * relying on it, and skip with a reason when a feature they need is missing.
 */
export interface Handle {
  ready: true;
  world: string;
  state(): SimState;
  hash(): string;
  pause(): void;
  resume(): void;
  stepN(n: number, input?: SimInput): void;
  renderInfo?(): RenderInfoLike;
  setNight?(on: boolean): void;
  setCameraMode?(mode: string): void;
  /** Fly camera at (x, y, z), compass yaw and pitch in degrees (+ = up). */
  flyTo?(x: number, y: number, z: number, yawDeg: number, pitchDeg: number): void;
  tilesSettled?(): boolean;
  /**
   * Requested from the render track (not provided yet): one entry per content/landmarks.json
   * entry, with where it was placed and whether its model is in the scene.
   */
  landmarks?(): Array<{ id: string; x: number; y: number; z: number; loaded: boolean }>;
  /**
   * Requested from the render track (not provided yet): advance one tick per frame, feeding
   * each tick the events whose `tick` equals it, like the netcode will.
   */
  stepFrames?(frames: readonly InputFrame[], events?: readonly SimEvent[]): void;
}

/** For page.evaluate bodies: `(window as unknown as FogWindow).__fogcity!`. */
export interface FogWindow {
  __fogcity?: Handle;
}

/**
 * Optional debug-handle members. renderInfo, setNight, setCameraMode, flyTo and tilesSettled
 * are prerequisite "render-debug"; landmarks and stepFrames are "landmark-ids" and "step-frames".
 */
export type OptionalFeature = "renderInfo" | "setNight" | "setCameraMode" | "flyTo" | "tilesSettled" | "landmarks" | "stepFrames";

// ---- prerequisites: skip when absent, or fail when E2E_REQUIRE names them (prereq.ts) -------

/** Parsed once per test process; an unknown name fails the whole run at load time. */
export const REQUIRED = parseRequire(process.env.E2E_REQUIRE);

export function required(p: Prerequisite): boolean {
  return REQUIRED.has(p);
}

/** For describe-level skips: true when `p` is absent and E2E_REQUIRE does not name it. */
export function optionalAbsent(p: Prerequisite, present: boolean): boolean {
  return !present && !required(p);
}

/**
 * Inside a test or a hook: nothing when the prerequisite is present; otherwise skip with
 * `reason`, or fail when E2E_REQUIRE names it.
 */
export function gate(p: Prerequisite, present: boolean, reason: string): void {
  if (present) return;
  if (required(p)) throw new Error(`E2E_REQUIRE names "${p}" (${PREREQUISITES[p]}), but ${reason}`);
  test.skip(true, reason);
}

/** Gate a test on a committed world: dev must exist; sf and dev-city are prerequisites. */
export function gateWorld(name: string): void {
  const present = worldExists(name);
  const reason = `public/tiles/${name}/manifest.json is absent on this checkout`;
  if (name === "sf" || name === "dev-city") gate(name, present, reason);
  else if (!present) throw new Error(reason);
}

export const THROTTLE: SimInput = Object.freeze({ throttle: 1, steer: 0, brake: 0, actions: 0 });

/**
 * Behaviour tests (input, stepping, on foot, determinism) do not need a full-size picture.
 * Under SwiftShader a 1100x700 frame can take a second, and the game loop only catches up
 * 0.25 s of sim per frame, so a slow frame slows the sim itself. A small viewport plus the
 * renderer's pixel-ratio cap (?pr=, ignored by a renderer without it) keeps frames near 60 Hz.
 * Visual checks (boots and draws, buildings on screen, perf, shots) use the defaults.
 */
export const FAST_VIEWPORT = Object.freeze({ width: 480, height: 320 });
export const FAST_QUERY = "&pr=0.5";

/**
 * A page outside the per-test fixture, for suites that share one booted world across tests
 * (beforeAll). Pass the project's `use` so baseURL and viewport match the config.
 */
export async function newSharedPage(
  browser: Browser,
  use: { baseURL?: string; viewport?: { width: number; height: number } | null },
): Promise<Page> {
  const context = await browser.newContext({ baseURL: use.baseURL, viewport: use.viewport ?? undefined });
  return context.newPage();
}

/**
 * Start collecting console errors, uncaught exceptions, HTTP errors and failed requests.
 * Returns the live list; assert it is empty at the end of a test.
 */
export function watchProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console.error: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`uncaught: ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`);
  });
  page.on("requestfailed", (r) => {
    const why = r.failure()?.errorText ?? "";
    // A tile streamer cancelling a fetch it no longer needs is not a failure.
    if (!why.includes("ERR_ABORTED") && !why.includes("NS_BINDING_ABORTED")) problems.push(`request failed: ${r.url()} ${why}`);
  });
  return problems;
}

/**
 * Open /?world=<world> and wait for window.__fogcity.ready. Fails fast with the HUD text when
 * boot reports "Failed to start". Returns the live problem list (see watchProblems).
 */
export async function bootWorld(page: Page, world: string, query = "", timeout = 75_000): Promise<string[]> {
  const problems = watchProblems(page);
  await page.goto(`/?world=${encodeURIComponent(world)}${query}`);
  await page.waitForFunction(
    () => {
      const h = (window as unknown as FogWindow).__fogcity;
      return h?.ready === true || (document.getElementById("hud")?.textContent ?? "").startsWith("Failed to start");
    },
    null,
    { timeout },
  );
  const failed = await page.evaluate(() => {
    const h = (window as unknown as FogWindow).__fogcity;
    return h?.ready === true ? null : (document.getElementById("hud")?.textContent ?? "boot failed");
  });
  if (failed) throw new Error(`world "${world}" did not boot: ${failed}\n${problems.join("\n")}`);
  return problems;
}

/** Which optional debug-handle members this build provides. */
export async function features(page: Page): Promise<Record<OptionalFeature, boolean>> {
  return page.evaluate(() => {
    const h = (window as unknown as FogWindow).__fogcity as unknown as Record<string, unknown> | undefined;
    const has = (k: string): boolean => typeof h?.[k] === "function";
    return {
      renderInfo: has("renderInfo"),
      setNight: has("setNight"),
      setCameraMode: has("setCameraMode"),
      flyTo: has("flyTo"),
      tilesSettled: has("tilesSettled"),
      landmarks: has("landmarks"),
      stepFrames: has("stepFrames"),
    };
  });
}

/** Wait for `n` animation frames (the render loop runs even while the sim is paused). */
export async function frames(page: Page, n: number): Promise<void> {
  await page.evaluate(
    (count) =>
      new Promise<void>((done) => {
        let k = 0;
        const tick = (): void => {
          if (++k >= count) done();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    n,
  );
}

/**
 * Wait until no tile is queued, loading or building (when the renderer reports it), then a few
 * frames so the last tiles are drawn. Returns false if tiles did not settle within `timeout`.
 */
export async function settle(page: Page, timeout = 60_000): Promise<boolean> {
  let ok = true;
  if ((await features(page)).tilesSettled) {
    ok = await page
      .waitForFunction(() => (window as unknown as FogWindow).__fogcity!.tilesSettled!() === true, null, { timeout })
      .then(() => true)
      .catch(() => false);
  }
  await frames(page, 3);
  return ok;
}

export async function simState(page: Page): Promise<SimState> {
  return page.evaluate(() => (window as unknown as FogWindow).__fogcity!.state());
}

export async function simHash(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as FogWindow).__fogcity!.hash());
}

export async function renderInfo(page: Page): Promise<RenderInfoLike | null> {
  return page.evaluate(() => (window as unknown as FogWindow).__fogcity!.renderInfo?.() ?? null);
}

export async function pause(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.pause());
}

/** stepN(n, input) on the paused game; returns the hash after it. */
export async function stepN(page: Page, n: number, input: SimInput): Promise<string> {
  return page.evaluate(
    ({ n, input }) => {
      const h = (window as unknown as FogWindow).__fogcity!;
      h.stepN(n, input);
      return h.hash();
    },
    { n, input },
  );
}

/** Something render-only done to the game: a key (pressed, or held through the run) or a debug call. */
export type Poke =
  | { key: string; hold?: boolean }
  | { call: "night"; on: boolean }
  | { call: "fly"; at: [x: number, y: number, z: number, yawDeg: number, pitchDeg: number] }
  | { call: "camera"; mode: string };

export function pokeName(p: Poke): string {
  if ("key" in p) return p.hold ? `${p.key} (held)` : p.key;
  return p.call === "night" ? `setNight(${p.on})` : p.call === "fly" ? "flyTo(...)" : `setCameraMode(${p.mode})`;
}

/** The debug-handle member a poke needs, or null for a key. */
export function pokeNeeds(p: Poke): OptionalFeature | null {
  if ("key" in p) return null;
  return p.call === "night" ? "setNight" : p.call === "fly" ? "flyTo" : "setCameraMode";
}

export interface PokeRun {
  /** The paused state just before the poke. */
  before: SimState;
  /** The state after the real game loop ran on its own, then paused again. */
  after: SimState;
  /** window.__fogcity.hash() of `after`, computed in the page. */
  afterHash: string;
  /** Ticks the loop ran: after.tick - before.tick. */
  ran: number;
}

/**
 * Prove a render-only poke never reaches the sim, with the real game loop consuming input.
 *
 * With the game paused: snapshot, poke, let two frames pass (the frame loop takes render-only
 * presses even while paused) and require the paused sim unchanged. Then resume() and let the
 * game's own loop run at least `minTicks` ticks, sampling the keyboard as it does for a player,
 * with no key held (or only the poked key, for `hold`), and pause again. A key that leaks into
 * the sim (an action bit latched on press, or an axis while held) changes `after`; the caller
 * replays `before` with NEUTRAL_INPUT for `ran` ticks in Node (replay.ts) and compares.
 * stepN() would not do: it ignores the keyboard.
 */
export async function pokeThenRun(page: Page, poke: Poke, minTicks = 36): Promise<PokeRun> {
  await pause(page);
  await frames(page, 2);
  const before = await simState(page);
  const h0 = await simHash(page);
  if ("key" in poke) {
    if (poke.hold) await page.keyboard.down(poke.key);
    else await page.keyboard.press(poke.key);
  } else {
    await page.evaluate((p) => {
      const h = (window as unknown as FogWindow).__fogcity!;
      if (p.call === "night") h.setNight!(p.on);
      else if (p.call === "fly") h.flyTo!(...p.at);
      else h.setCameraMode!(p.mode);
    }, poke);
  }
  await frames(page, 2);
  expect(await simHash(page), `${pokeName(poke)} moved the paused sim`).toBe(h0);
  expect((await simState(page)).tick, `${pokeName(poke)}: ticks advanced while paused`).toBe(before.tick);

  await page.evaluate(
    ({ target, ms }) =>
      new Promise<void>((done, fail) => {
        const h = (window as unknown as FogWindow).__fogcity!;
        const t0 = performance.now();
        h.resume();
        const poll = (): void => {
          if (h.state().tick >= target) {
            h.pause();
            done();
          } else if (performance.now() - t0 > ms) {
            h.pause();
            fail(new Error(`the game loop reached tick ${h.state().tick}, not ${target}, within ${ms} ms of resume()`));
          } else requestAnimationFrame(poll);
        };
        requestAnimationFrame(poll);
      }),
    { target: before.tick + minTicks, ms: 45_000 },
  );
  if ("key" in poke && poke.hold) await page.keyboard.up(poke.key);
  await frames(page, 2);
  const after = await simState(page);
  const afterHash = await simHash(page);
  return { before, after, afterHash, ran: after.tick - before.tick };
}

/** Smallest signed difference between two compass headings, radians. */
export function headingDelta(from: number, to: number): number {
  let d = (to - from) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Distance from (x, z) to a polyline of [x, z] points. */
export function distanceToPolyline(x: number, z: number, pts: ReadonlyArray<readonly [number, number]>): number {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const [ax, az] = pts[i - 1]!;
    const [bx, bz] = pts[i]!;
    const ex = bx - ax;
    const ez = bz - az;
    const len2 = ex * ex + ez * ez;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / len2)) : 0;
    const dx = x - (ax + ex * t);
    const dz = z - (az + ez * t);
    best = Math.min(best, Math.hypot(dx, dz));
  }
  return best;
}
