// M0 acceptance on the real San Francisco world (public/tiles/sf, built by the pipeline).
// Skips cleanly while the SF world is absent from this checkout; activates when it lands.
// The browser tests share one page (booting SF under SwiftShader is the expensive part) and
// run in order: boot, look, landmark, traffic, then drive (the only one that moves the car).

import { expect, test, type Page } from "@playwright/test";
import { toLocal } from "../../src/geo/project.ts";
import { nearbyBuildings, pointInPolygon } from "../../src/sim/index.ts";
import { fileExists, loadWorld, loadWorldFiles, readJsonIfExists, worldExists, type RoadGraphFile } from "../helpers.ts";
import {
  THROTTLE,
  bootWorld,
  distanceToPolyline,
  features,
  frames,
  gate,
  newSharedPage,
  optionalAbsent,
  renderInfo,
  required,
  settle,
  simState,
  type FogWindow,
} from "./fixtures.ts";
import { decodePng, imageStats, looksDrawn } from "./png.ts";

const SF = worldExists("sf");
const ABSENT = "public/tiles/sf/manifest.json is absent: the pipeline has not produced the SF world on this checkout";
/** Spawn must be this close to the origin (the Ferry Building clock tower), metres. */
const SPAWN_RADIUS_M = 400;

interface LandmarksDoc {
  landmarks: Array<{ id: string; model: string; lat: number; lon: number; headingDeg: number }>;
}

/** A landmark's model path relative to public/, as the renderer resolves it. */
function modelPath(model: string): string {
  return model.trim().replace(/\\/g, "/").replace(/^(\.\/|\/)+/, "").replace(/^public\//, "");
}

/** Nearest road edge to (x, z): distance outside its carriageway (<= 0 = on it) and its direction there. */
function nearestRoad(roads: RoadGraphFile, x: number, z: number) {
  let best = { edge: roads.edges[0]!, outside: Infinity, dirX: 0, dirZ: 0 };
  for (const e of roads.edges) {
    const half = (e.widthM ?? e.lanes * 3.5) / 2;
    for (let i = 1; i < e.points.length; i++) {
      const a = e.points[i - 1]!;
      const b = e.points[i]!;
      const outside = distanceToPolyline(x, z, [a, b]) - half;
      if (outside < best.outside) {
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        best = { edge: e, outside, dirX: (b[0] - a[0]) / len, dirZ: (b[1] - a[1]) / len };
      }
    }
  }
  return best;
}

test.describe("sf world: data", () => {
  test.skip(optionalAbsent("sf", SF), ABSENT);
  test.beforeEach(() => gate("sf", SF, ABSENT));

  test("spawn is on a road, along it, within 400 m of the Ferry Building", () => {
    const { manifest, roads } = loadWorldFiles("sf");
    const { x, z, heading } = manifest.spawn;
    expect(Math.hypot(x, z), "spawn distance from the Ferry Building clock tower (origin)").toBeLessThan(SPAWN_RADIUS_M);
    expect(roads, "the SF manifest names a road graph (schemas/roads.schema.json)").not.toBeNull();
    const near = nearestRoad(roads!, x, z);
    expect(near.outside, `spawn is ${near.outside.toFixed(1)} m outside ${near.edge.name ?? near.edge.id}`).toBeLessThanOrEqual(1);
    // The spawn heading follows the road (either way unless one-way), so "drive ahead" stays on it.
    const fx = Math.sin(heading);
    const fz = -Math.cos(heading);
    const along = fx * near.dirX + fz * near.dirZ;
    const angleDeg = (Math.acos(Math.min(1, near.edge.oneway ? along : Math.abs(along))) * 180) / Math.PI;
    expect(angleDeg, `spawn heading vs ${near.edge.name ?? near.edge.id}`).toBeLessThan(35);
  });

  test("buildings exist around the Ferry Building, with real heights", () => {
    const { tiles } = loadWorldFiles("sf");
    let within300 = 0;
    let tallest = 0;
    for (const t of tiles) {
      for (const b of t.buildings) {
        const d = Math.min(...b.footprint.map(([bx, bz]) => Math.hypot(bx, bz)));
        if (d < 300) within300++;
        if (d < 1000) tallest = Math.max(tallest, b.topY - b.baseY);
      }
    }
    expect(within300, "buildings within 300 m of the Ferry Building").toBeGreaterThanOrEqual(10);
    // Downtown is within 1 km: towers well over 100 m (Salesforce Tower is ~326 m, 0.7 km away).
    expect(tallest, "tallest building within 1 km, metres").toBeGreaterThan(100);
  });
});

test.describe("sf world: in the browser", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(optionalAbsent("sf", SF), ABSENT);

  let page: Page;
  let problems: string[];
  /** Every response since boot, by path: the landmark test checks its model was fetched. */
  const responses: Array<{ path: string; status: number }> = [];

  test.beforeAll(async ({ browser }, info) => {
    gate("sf", SF, ABSENT);
    page = await newSharedPage(browser, info.project.use);
    page.on("response", (r) => responses.push({ path: new URL(r.url()).pathname, status: r.status() }));
    problems = await bootWorld(page, "sf");
  });
  test.afterAll(async () => {
    await page?.context().close();
  });

  test("boots with no console errors, the car at the spawn, and draws", async () => {
    const { manifest } = loadWorldFiles("sf");
    const car = (await simState(page)).players.p1!.car;
    expect(Math.hypot(car.x - manifest.spawn.x, car.z - manifest.spawn.z), "car distance from spawn").toBeLessThan(2);
    await settle(page, 80_000);
    const stats = imageStats(decodePng(await page.screenshot()), 7);
    expect(looksDrawn(stats), `the frame looks blank: ${JSON.stringify(stats)}`).toBe(true);
    expect(problems).toEqual([]);
  });

  test("buildings near the Ferry Building are on screen", async () => {
    const have = await features(page);
    if (required("render-debug") && !(have.flyTo && have.renderInfo)) {
      throw new Error(`E2E_REQUIRE names "render-debug", but window.__fogcity.flyTo() or renderInfo() is missing`);
    }
    if (have.flyTo) {
      // From the Embarcadero, west of the clock tower, looking east at it.
      await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.flyTo!(-150, 14, 75, 63, 3));
    }
    expect(await settle(page, 80_000), "tiles settled").toBe(true);
    const info = await renderInfo(page);
    if (info) {
      expect(info.tilesLoaded ?? 1, "tiles loaded").toBeGreaterThan(0);
      expect(info.tilesFailed ?? 0, "tiles failed").toBe(0);
      expect(info.triangles, "triangles drawn").toBeGreaterThan(10_000);
    } else {
      test.info().annotations.push({ type: "note", description: "renderInfo() not available: checked the screenshot only" });
    }
    const stats = imageStats(decodePng(await page.screenshot()), 7);
    expect(looksDrawn(stats), `the frame looks blank: ${JSON.stringify(stats)}`).toBe(true);
    expect(problems).toEqual([]);
  });

  test("the Ferry Building landmark is placed, with every other landmark that has a model", async () => {
    const doc = readJsonIfExists<LandmarksDoc>("content/landmarks.json");
    gate("landmarks", doc !== null, "content/landmarks.json is absent: the assets track has not placed landmarks on this checkout");
    const ferry = doc!.landmarks.find((l) => /ferry/i.test(l.id));
    expect(ferry, "content/landmarks.json has a Ferry Building entry").toBeDefined();
    const at = toLocal(ferry!.lat, ferry!.lon);
    expect(Math.hypot(at.x, at.z), "Ferry Building landmark distance from the clock tower (origin), m").toBeLessThan(150);
    expect(fileExists(`public/${modelPath(ferry!.model)}`), `model file public/${modelPath(ferry!.model)}`).toBe(true);
    const withModel = doc!.landmarks.filter((l) => fileExists(`public/${modelPath(l.model)}`));

    const have = await features(page);
    if (!have.renderInfo) {
      if (required("render-debug")) throw new Error(`E2E_REQUIRE names "render-debug", but window.__fogcity.renderInfo() is missing`);
      test.info().annotations.push({ type: "note", description: "renderInfo() not available: checked the data only" });
      return;
    }
    // The renderer asked for the Ferry Building's model, and got it.
    const url = `/${modelPath(ferry!.model)}`;
    const got = responses.filter((r) => r.path === url);
    expect(got.length, `responses to GET ${url} since boot`).toBeGreaterThan(0);
    expect(got.every((r) => r.status === 200 || r.status === 304), `GET ${url}: ${got.map((r) => r.status).join(", ")}`).toBe(true);

    // renderInfo().landmarks counts models actually placed in the scene. Every entry with a
    // model file must be there, so one landmark (R-Evolution, say) cannot stand in for another.
    const ids = withModel.map((l) => l.id);
    await page
      .waitForFunction((n) => ((window as unknown as FogWindow).__fogcity!.renderInfo!().landmarks ?? 0) >= n, ids.length, {
        timeout: 60_000,
      })
      .catch(() => undefined);
    const placed = (await renderInfo(page))!.landmarks ?? 0;
    expect(placed, `landmarks in the scene; entries with a model file: ${ids.join(", ")}`).toBeGreaterThanOrEqual(ids.length);

    // Which landmark is which: the renderer reports each placement by id (provided since the
    // wave-1 integration, so its absence is a regression, not a skip).
    expect(have.landmarks, "window.__fogcity.landmarks() is provided").toBe(true);
    {
      const list = await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.landmarks!());
      expect(list.map((l) => l.id).sort(), "one landmarks() entry per landmarks.json entry").toEqual(doc!.landmarks.map((l) => l.id).sort());
      for (const id of ["ferry-building", "r-evolution"]) {
        if (!doc!.landmarks.some((l) => l.id === id)) continue;
        expect(list.find((l) => l.id === id)?.loaded, `${id} is reported loaded`).toBe(true);
      }
      for (const id of ids) {
        const e = list.find((l) => l.id === id);
        expect(e, `window.__fogcity.landmarks() reports ${id}`).toBeDefined();
        expect(e!.loaded, `${id} is in the scene`).toBe(true);
      }
      const f = list.find((l) => l.id === ferry!.id)!;
      expect(Math.hypot(f.x, f.z), `${f.id} placed this far from the clock tower (origin), m`).toBeLessThan(150);
    }
    expect(problems).toEqual([]);
  });

  test("sim traffic runs in the game, and the renderer draws it with the asset models", async () => {
    const have = await features(page);
    gate("render-debug", have.renderInfo, "window.__fogcity.renderInfo() is missing");
    // The chase camera at the spawn, on the Embarcadero, among the traffic.
    await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.setCameraMode!("chase"));
    const run = await page.evaluate(() => {
      const h = (window as unknown as FogWindow).__fogcity!;
      h.pause();
      const list = (s: { ext: Record<string, unknown> }) =>
        ((s.ext.agents as { list?: Array<{ id: number; x: number; z: number; kind: string }> } | undefined)?.list ?? []).map((a) => ({ ...a }));
      const t0 = h.state().tick;
      const before = list(h.state());
      h.stepN(120);
      return { t0, before, after: list(h.state()), tick: h.state().tick, info: h.simInfo?.() ?? null };
    });
    expect(run.tick - run.t0, "ticks stepped").toBe(120);
    expect(run.after.length, "state.ext.agents is non-empty after 120 ticks").toBeGreaterThan(0);
    expect(new Set(run.after.map((a) => a.kind)), "kinds of agent").toEqual(new Set(["robotaxi", "errandRobot", "sidewalkBot", "person"]));
    const moved = run.after.filter((a) => {
      const b = run.before.find((x) => x.id === a.id);
      return b && Math.hypot(a.x - b.x, a.z - b.z) > 1;
    });
    expect(moved.length, "agents that moved more than 1 m in 2 s").toBeGreaterThan(run.after.length / 4);
    if (run.info) {
      expect(run.info.roads, "simInfo().roads").toBe(true);
      expect(run.info.agents).toBe(run.after.length);
      expect(run.info.seed).toBe(1);
    }

    // The renderer draws them: proxies everywhere, full models near the camera, from the files.
    await page
      .waitForFunction(() => ((window as unknown as FogWindow).__fogcity!.renderInfo!().agentModels ?? []).length >= 3, null, { timeout: 60_000 })
      .catch(() => undefined);
    await frames(page, 3);
    const r = (await renderInfo(page))!;
    expect(r.agentsTotal, "agents the renderer was given").toBe(run.after.length);
    expect(r.agents ?? 0, "agents drawn").toBeGreaterThan(0);
    expect(r.agentsNear ?? 0, "agents drawn with their full model near the chase camera").toBeGreaterThan(0);
    expect([...(r.agentModels ?? [])].sort(), "agent kinds drawn from their model files").toEqual(["errandRobot", "robotaxi", "sidewalkBot"]);
    // Instanced: the draw-call cost does not grow with the number of agents.
    expect(r.agentDrawCalls ?? 0, "agent draw calls").toBeLessThanOrEqual(27);
    expect(r.playerCarsFromFile, "the player car is models/player-car.glb").toBe(1);
    for (const m of ["robotaxi", "errand-robot", "sidewalk-bot", "player-car"]) {
      const got = responses.filter((x) => x.path === `/models/${m}.glb`);
      expect(got.length, `GET /models/${m}.glb`).toBeGreaterThan(0);
    }
    expect(problems).toEqual([]);
  });

  test("10 s of full throttle along the spawn heading moves the car", async () => {
    const { world } = loadWorld("sf");
    const path = await page.evaluate((input) => {
      const h = (window as unknown as FogWindow).__fogcity!;
      h.pause();
      const out: Array<{ x: number; z: number; heading: number }> = [];
      const c0 = h.state().players.p1!.car;
      out.push({ x: c0.x, z: c0.z, heading: c0.heading });
      for (let s = 0; s < 10; s++) {
        h.stepN(60, input);
        const c = h.state().players.p1!.car;
        out.push({ x: c.x, z: c.z, heading: c.heading });
      }
      return out;
    }, THROTTLE);
    const start = path[0]!;
    const end = path.at(-1)!;
    const fx = Math.sin(start.heading);
    const fz = -Math.cos(start.heading);
    const ahead = (end.x - start.x) * fx + (end.z - start.z) * fz;
    expect(Math.hypot(end.x - start.x, end.z - start.z), "distance driven in 10 s, m").toBeGreaterThan(30);
    expect(ahead, "progress along the spawn heading, m").toBeGreaterThan(20);
    for (const p of path) {
      for (const b of nearbyBuildings(world, p.x, p.z, 2)) {
        if (b.topY - b.baseY > 2) expect(pointInPolygon(p.x, p.z, b.footprint), `car inside building ${b.id}`).toBe(false);
      }
    }
    expect(problems).toEqual([]);
  });
});
