// Shared browser-test plumbing: boot a world, collect everything that went wrong on the page,
// wait for tiles and frames, and reach the debug handle (window.__fogcity) whatever subset of
// it this checkout's renderer provides.

import type { Browser, Page } from "@playwright/test";
import type { SimInput, SimState } from "../../src/sim/contract.ts";

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
}

/** For page.evaluate bodies: `(window as unknown as FogWindow).__fogcity!`. */
export interface FogWindow {
  __fogcity?: Handle;
}

export type OptionalFeature = "renderInfo" | "setNight" | "setCameraMode" | "flyTo" | "tilesSettled";

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
