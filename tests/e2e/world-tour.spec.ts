// The world-continuity gate's screenshot tour (docs/qa/world-continuity-gate.md): the fixed views
// of tests/e2e/world-tour.views.json, shot to test-results/tour/*.png with a contact sheet
// (index.html), for the person who reviews each wave. Nightly and on every wave candidate
// (`pnpm world:nightly`), and on demand with `pnpm tour` (TOUR_ONLY=1: pictures and measurements,
// no ratchet assertions).
//
// Each view checks what a person would: tiles settled with none failed, far cells loaded, no
// console error; and its probes: the lakes drawn as water, the beaches as sand, the parks green
// with foliage, the landmarks as their models (window.__fogcityView with ?debug=1, world-probe.ts).

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type Page } from "@playwright/test";
import { toLocal } from "../../src/geo/project.ts";
import { closestOnBoundary, groundHeight, nearbyBuildings, pointInPolygon, type World } from "../../src/sim/index.ts";
import { ROOT, worldExists } from "../helpers.ts";
import { advanceIndex, bearing, followInput, gameWorld } from "../helpers/world.ts";
import { route } from "../helpers/world-gate/play.ts";
import { bootWorld, frames, gateWorld, newSharedPage, renderInfo, settle, type FogWindow } from "./fixtures.ts";
import { Measured, judgeMeasured, onStreet } from "./world-gate.ts";
import { PROBE_QUERY, foliageNear, probeDown } from "./world-probe.ts";

/** TOUR_VIEWS=5,7,lake-merced: shoot only these views (by number or id), pictures only. */
const PICK = (process.env.TOUR_VIEWS ?? "").split(",").filter(Boolean);
const TOUR_ONLY = process.env.TOUR_ONLY === "1" || PICK.length > 0;
const OUT = join(ROOT, "test-results", PICK.length ? "tour-pick" : "tour");
const VIEWPORT = { width: 960, height: 540 };

interface Probe {
  at: [number, number];
  expect: string;
}
interface Extra {
  at: [number, number];
  heading?: number;
  mode: string;
  suffix: string;
}
interface View {
  n: number;
  id: string;
  title: string;
  at: [number, number];
  street?: string;
  toward?: [number, number];
  heading?: number;
  look?: [number, number];
  modes: string[];
  /** Stand on the highest sim ground within this many metres of `at` (summit views, so the hill does not fill the frame). */
  summit?: number;
  night?: boolean;
  radius60?: boolean;
  extra?: Extra[];
  probes?: Probe[];
  defects?: string[];
}

interface Shot {
  file: string;
  view: string;
  title: string;
  mode: string;
  problems: string[];
  /** Wall-clock milliseconds since the previous shot (camera move, streaming, frames, screenshot), for the nightly's time budget. */
  ms: number;
}

const views = (JSON.parse(readFileSync(join(import.meta.dirname, "world-tour.views.json"), "utf8")) as { views: View[] }).views.filter(
  (v) => PICK.length === 0 || PICK.includes(String(v.n)) || PICK.includes(v.id),
);

/** Where the camera goes for a view point, a compass heading (degrees) and a mode. */
function camera(ground: (x: number, z: number) => number, x: number, z: number, headingDeg: number, mode: string): { x: number; y: number; z: number; yaw: number; pitch: number } {
  const h = (headingDeg * Math.PI) / 180;
  const fx = Math.sin(h);
  const fz = -Math.cos(h);
  if (mode === "aerial") {
    const back = 120 / Math.tan((35 * Math.PI) / 180);
    const cx = x - fx * back;
    const cz = z - fz * back;
    return { x: cx, y: Math.max(ground(cx, cz), ground(x, z)) + 120, z: cz, yaw: headingDeg, pitch: -35 };
  }
  if (mode === "chase") return { x, y: ground(x, z) + 5, z, yaw: headingDeg, pitch: -12 };
  return { x, y: ground(x, z) + 1.7, z, yaw: headingDeg, pitch: -2 };
}

/** A summit standpoint keeps this far from every building footprint (a camera inside one shows its walls from within). */
const SUMMIT_CLEARANCE_M = 6;
/** ... and looks this far along its heading without a building taller than the eye in the way. */
const SUMMIT_SIGHT_M = 80;

/**
 * The highest point of the sim's ground within r metres of (x, z), on a 2 m grid, that a person
 * could stand on and see from: not inside a building footprint or within SUMMIT_CLEARANCE_M of
 * one, and with no building taller than the eye within SUMMIT_SIGHT_M along the heading. (Bernal
 * Hill's highest ground is the radio building's: standing there put the camera inside it, under
 * its tower; the next highest looked straight into its wall.)
 */
function summitOf(world: World, x: number, z: number, r: number, headingDeg: number): { x: number; z: number } {
  const near = nearbyBuildings(world, x, z, r + SUMMIT_SIGHT_M);
  const fx = Math.sin((headingDeg * Math.PI) / 180);
  const fz = -Math.cos((headingDeg * Math.PI) / 180);
  const standable = (px: number, pz: number): boolean => {
    for (const b of near) {
      if (pointInPolygon(px, pz, b.footprint) || closestOnBoundary(px, pz, b.footprint).d2 < SUMMIT_CLEARANCE_M ** 2) return false;
    }
    const eye = groundHeight(world, px, pz) + 1.7;
    for (let d = SUMMIT_CLEARANCE_M; d <= SUMMIT_SIGHT_M; d += 2) {
      const sx = px + fx * d;
      const sz = pz + fz * d;
      for (const b of near) if (b.topY > eye && pointInPolygon(sx, sz, b.footprint)) return false;
    }
    return true;
  };
  let best = { x, z, y: -Infinity };
  for (let dx = -r; dx <= r; dx += 2) {
    for (let dz = -r; dz <= r; dz += 2) {
      if (dx * dx + dz * dz > r * r) continue;
      const y = groundHeight(world, x + dx, z + dz);
      if (y > best.y && standable(x + dx, z + dz)) best = { x: x + dx, z: z + dz, y };
    }
  }
  return best.y === -Infinity ? { x, z } : { x: best.x, z: best.z };
}

function bearingDeg(x: number, z: number, tx: number, tz: number): number {
  return ((Math.atan2(tx - x, -(tz - z)) * 180) / Math.PI + 360) % 360;
}

/** The view's point and heading: snapped to its street when it names one. */
function placeOf(v: { at: [number, number]; street?: string; toward?: [number, number]; heading?: number; look?: [number, number] }): { x: number; z: number; heading: number } {
  let { x, z } = toLocal(v.at[0], v.at[1]);
  let heading = v.heading ?? 0;
  if (v.street) {
    const s = onStreet(v.at[0], v.at[1], new RegExp(v.street));
    x = s.x;
    z = s.z;
    heading = (s.heading * 180) / Math.PI;
    if (v.toward) {
      const t = toLocal(v.toward[0], v.toward[1]);
      const fx = Math.sin(s.heading);
      const fz = -Math.cos(s.heading);
      if ((t.x - x) * fx + (t.z - z) * fz < 0) heading += 180;
    }
  }
  if (v.look) {
    const t = toLocal(v.look[0], v.look[1]);
    heading = bearingDeg(x, z, t.x, t.z);
  }
  return { x, z, heading: (heading + 360) % 360 };
}

test.describe("world gate: the screenshot tour", () => {
  test.skip(!worldExists("sf"), "public/tiles/sf is absent");

  test("every tour view, shot and checked", async ({ browser }, info) => {
    gateWorld("sf");
    test.setTimeout(7_200_000);
    rmSync(OUT, { recursive: true, force: true });
    mkdirSync(OUT, { recursive: true });
    const gw = gameWorld("sf");
    const world = gw.world;
    const ground = (x: number, z: number): number => groundHeight(world, x, z);
    const shots: Shot[] = [];
    const notes: string[] = [];
    const probeFails: Record<string, string[]> = { water: [], sand: [], green: [], foliage: [], landmark: [] };
    const probeTotals: Record<string, number> = { water: 0, sand: 0, green: 0, foliage: 0, landmark: 0 };
    let viewProblems = 0;
    const started = Date.now();
    let lastShot = started;
    const lap = (): number => {
      const now = Date.now();
      const ms = now - lastShot;
      lastShot = now;
      return ms;
    };

    const open = async (query: string): Promise<{ page: Page; problems: string[] }> => {
      const page = await newSharedPage(browser, { ...info.project.use, viewport: VIEWPORT });
      const problems = await bootWorld(page, "sf", PROBE_QUERY + query, 240_000);
      await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.pause());
      return { page, problems };
    };

    const shoot = async (page: Page, problems: string[], v: View, mode: string, place: { x: number; z: number; heading: number }, suffix = ""): Promise<void> => {
      const cam = camera(ground, place.x, place.z, place.heading, mode);
      await page.evaluate((c) => (window as unknown as FogWindow).__fogcity!.flyTo!(c.x, c.y, c.z, c.yaw, c.pitch), cam);
      const settled = await settle(page, 300_000);
      await frames(page, 3);
      const ri = await renderInfo(page);
      const base = `${String(v.n).padStart(2, "0")}-${v.id}${suffix ? `-${suffix}` : ""}-${mode}`;
      const issues: string[] = [];
      if (!settled) issues.push("tiles did not settle");
      if ((ri?.tilesFailed ?? 0) > 0) issues.push(`${ri?.tilesFailed} tiles failed`);
      if ((ri?.farCells ?? 0) === 0) issues.push("no far cell loaded");
      const errs = problems.splice(0, problems.length);
      if (errs.length) issues.push(...errs.slice(0, 3));
      await page.screenshot({ path: join(OUT, `${base}.png`), timeout: 300_000 });
      shots.push({ file: `${base}.png`, view: v.id, title: v.title, mode, problems: issues, ms: lap() });
      if (v.night) {
        await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.setNight!(true));
        await frames(page, 4);
        await page.screenshot({ path: join(OUT, `${base}-night.png`), timeout: 300_000 });
        shots.push({ file: `${base}-night.png`, view: v.id, title: `${v.title} (night)`, mode, problems: [], ms: lap() });
        await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.setNight!(false));
      }
      if (issues.length) viewProblems++;
    };

    // A probe first brings its point's tile in: the camera 80 m above it, looking down.
    const probe = async (page: Page, p: Probe): Promise<void> => {
      const q = toLocal(p.at[0], p.at[1]);
      await page.evaluate((c) => (window as unknown as FogWindow).__fogcity!.flyTo!(c.x, c.y, c.z, 0, -70), { x: q.x, y: ground(q.x, q.z) + 80, z: q.z + 30 });
      await settle(page, 300_000);
      await frames(page, 2);
      const kind = p.expect.startsWith("landmark:") ? "landmark" : p.expect;
      probeTotals[kind] = (probeTotals[kind] ?? 0) + 1;
      if (kind === "foliage") {
        if ((await foliageNear(page, q.x, q.z, 60)) === 0) probeFails.foliage!.push(`${p.at.join(",")}`);
        return;
      }
      const [hit] = await probeDown(page, [[q.x, q.z]], ["tile:", "landmark:", "far:", "bay"]);
      let ok = false;
      if (kind === "landmark") ok = !!hit?.path.some((n) => n === p.expect);
      else if (kind === "water") ok = !!hit && (hit.colour === "water" || hit.mesh === "bay" || /water/i.test(hit.material));
      else ok = hit?.colour === kind;
      if (!ok) probeFails[kind]!.push(`${p.expect} at ${p.at.join(",")}: ${hit ? `${hit.mesh} (${hit.colour}, ${hit.path.slice(0, 3).join(" < ")})` : "nothing drawn"}`);
    };

    const runViews = async (list: View[], query: string): Promise<void> => {
      if (!list.length) return;
      const { page, problems } = await open(query);
      for (const v of list) {
        let place = placeOf(v);
        if (v.summit) place = { ...place, ...summitOf(world, place.x, place.z, v.summit, place.heading) };
        for (const mode of v.modes) {
          if (mode === "drive") {
            await drive(page, problems, v);
            continue;
          }
          const p = mode === "street-back" ? { ...place, heading: (place.heading + 180) % 360 } : place;
          await shoot(page, problems, v, mode === "street-back" ? "street" : mode, p, mode === "street-back" ? "back" : "");
        }
        for (const e of v.extra ?? []) await shoot(page, problems, v, e.mode, placeOf({ at: e.at, heading: e.heading }), e.suffix);
        for (const p of v.probes ?? []) await probe(page, p);
      }
      await page.context().close();
    };

    // A 30 s drive: a joined player driven along the street's route (the gate's road follower,
    // tests/helpers/world.ts, steering every 10 ticks at up to 20 m/s), one frame every 3 s.
    const drive = async (page: Page, problems: string[], v: View): Promise<void> => {
      // Along the named street when its edges connect the two points, else the shortest way.
      const along = v.street ? new RegExp(v.street) : null;
      let path: ReturnType<typeof route>;
      try {
        if (!along) throw new Error("no street");
        path = route({ ...gw, roads: { ...gw.roads, edges: gw.roads.edges.filter((e) => along.test(e.name ?? "")) } }, [v.at, v.toward ?? v.at]);
      } catch {
        path = route(gw, [v.at, v.toward ?? v.at]);
      }
      const h = bearing(path[3]![0] - path[0]![0], path[3]![1] - path[0]![1]);
      const tick = await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.state().tick);
      await page.evaluate(
        ({ x, z, h, tick }) => (window as unknown as FogWindow).__fogcity!.stepFrames!([{}], [{ tick: tick + 1, kind: "player.join", playerId: "tour", payload: { x, z, heading: h } }]),
        { x: path[0]![0], z: path[0]![1], h, tick },
      );
      let idx = 0;
      for (let k = 0; k < 10; k++) {
        for (let c = 0; c < 18; c++) {
          const car = await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.state().players.tour!.car);
          idx = advanceIndex(path, idx, car.x, car.z).idx;
          const input = followInput(car, path, idx, 20);
          await page.evaluate((input) => (window as unknown as FogWindow).__fogcity!.stepFrames!(Array.from({ length: 10 }, () => ({ tour: input }))), input);
        }
        const car = await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.state().players.tour!.car);
        const back = { x: car.x - Math.sin(car.heading) * 16, z: car.z + Math.cos(car.heading) * 16 };
        await shoot(page, problems, v, "chase", { x: back.x, z: back.z, heading: (car.heading * 180) / Math.PI }, `t${(k + 1) * 3}s`);
      }
      // How far along the route the car got (1 m samples), for the reviewer: traffic can hold it up.
      notes.push(`${v.id}: ${idx} m along the ${path.length} m route in 30 s`);
    };

    await runViews(views.filter((v) => !v.radius60), "");
    await runViews(views.filter((v) => v.radius60), "&radius=60");

    // The contact sheet: every shot with its view and any problem; a previous wave's sheet in
    // test-results/tour-previous/ (copied there by the reviewer) is shown beside it.
    const minutes = Math.round((Date.now() - started) / 6000) / 10;
    writeFileSync(join(OUT, "index.json"), JSON.stringify({ minutes, shots, notes, probeFails, probeTotals }, null, 1) + "\n");
    const rows = shots
      .map((s) => `<figure><img src="${s.file}" loading="lazy"><img class="prev" src="../tour-previous/${s.file}" onerror="this.remove()" loading="lazy"><figcaption><b>${s.file}</b> ${s.title}${s.problems.length ? `<br><span class="bad">${s.problems.join("; ")}</span>` : ""}</figcaption></figure>`)
      .join("\n");
    writeFileSync(
      join(OUT, "index.html"),
      `<!doctype html><meta charset="utf-8"><title>World tour</title><style>body{font:14px system-ui;margin:16px;background:#111;color:#ddd}figure{display:inline-block;margin:6px;vertical-align:top;max-width:100%}img{width:480px;max-width:100%;display:inline-block}figcaption{max-width:960px}.bad{color:#f88}</style><h1>World-continuity tour</h1><p>${shots.length} shots in ${minutes} minutes. Review each against docs/qa/world-continuity-gate.md and record pass or fail per view in the wave's QA note.</p>${notes.map((n) => `<p>${n}</p>`).join("")}\n${rows}\n`,
    );

    const m = new Measured("world-tour", "e2e-nightly");
    m.metric({ id: "G.tour.viewProblems", target: 0, better: "lower", unit: "views", defects: [], desc: "tour views whose tiles did not settle, failed to load, had no far cell, or logged a console error" }, viewProblems, shots.filter((s) => s.problems.length).map((s) => `${s.file}: ${s.problems.join("; ")}`).slice(0, 10));
    m.metric({ id: "G.tour.lakesNotWater", target: 0, better: "lower", unit: "probes", defects: ["W-11"], desc: "tour probes at Stow Lake, Spreckels Lake and Lake Merced whose drawn surface is not water" }, probeFails.water!.length, probeFails.water);
    m.metric({ id: "G.tour.beachesNotSand", target: 0, better: "lower", unit: "probes", defects: ["W-34"], desc: "tour probes on Ocean Beach and Baker Beach whose drawn surface is not sand" }, probeFails.sand!.length, probeFails.sand);
    m.metric({ id: "G.tour.parksNotGreen", target: 0, better: "lower", unit: "probes", defects: ["W-18"], desc: "tour probes in Golden Gate Park, Dolores Park, Buena Vista, Glen Canyon and Mt Davidson whose drawn ground is not green" }, probeFails.green!.length, probeFails.green);
    m.metric({ id: "G.tour.parksWithoutFoliage", target: 0, better: "lower", unit: "probes", defects: ["W-18"], desc: "tour probes in Golden Gate Park, Buena Vista, Mt Davidson and the Presidio with no foliage drawn within 60 m" }, probeFails.foliage!.length, probeFails.foliage);
    m.metric({ id: "G.tour.landmarksMissing", target: 0, better: "lower", unit: "probes", defects: ["W-24", "W-25", "W-27"], desc: "tour probes at Coit Tower, Sutro Tower, the Golden Gate Bridge and the Bay Bridge whose topmost drawn surface is not that landmark's model" }, probeFails.landmark!.length, probeFails.landmark);
    if (TOUR_ONLY) {
      writeFileSync(join(OUT, "measured.json"), JSON.stringify({ values: m.values, details: m.details }, null, 1) + "\n");
      return;
    }
    judgeMeasured(m);
  });
});
