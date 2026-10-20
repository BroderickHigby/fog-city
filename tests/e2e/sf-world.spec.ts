// M0 acceptance on the real San Francisco world (public/tiles/sf, built by the pipeline).
// Skips cleanly while the SF world is absent from this checkout; activates when it lands.
// The browser tests share one page (booting SF under SwiftShader is the expensive part) and
// run in order: boot, look, landmark, then drive (the only one that moves the car).

import { expect, test, type Page } from "@playwright/test";
import { toLocal } from "../../src/geo/project.ts";
import { nearbyBuildings, pointInPolygon } from "../../src/sim/index.ts";
import { fileExists, loadWorld, loadWorldFiles, readJsonIfExists, worldExists, type RoadGraphFile } from "../helpers.ts";
import {
  THROTTLE,
  bootWorld,
  distanceToPolyline,
  features,
  newSharedPage,
  renderInfo,
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
  test.skip(!SF, ABSENT);

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
  test.skip(!SF, ABSENT);

  let page: Page;
  let problems: string[];

  test.beforeAll(async ({ browser }, info) => {
    if (!SF) return;
    page = await newSharedPage(browser, info.project.use);
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

  test("the Ferry Building landmark is placed", async () => {
    const doc = readJsonIfExists<LandmarksDoc>("content/landmarks.json");
    test.skip(!doc, "content/landmarks.json is absent: the assets track has not placed landmarks on this checkout");
    const ferry = doc!.landmarks.find((l) => /ferry/i.test(l.id));
    expect(ferry, "content/landmarks.json has a Ferry Building entry").toBeDefined();
    const at = toLocal(ferry!.lat, ferry!.lon);
    expect(Math.hypot(at.x, at.z), "Ferry Building landmark distance from the clock tower (origin), m").toBeLessThan(150);
    const model = ferry!.model.replace(/^\/+/, "").replace(/^public\//, "");
    expect(fileExists(`public/${model}`), `model file public/${model}`).toBe(true);

    if (!(await features(page)).renderInfo) {
      test.info().annotations.push({ type: "note", description: "renderInfo() not available: checked the data only" });
      return;
    }
    await page.waitForFunction(() => ((window as unknown as FogWindow).__fogcity!.renderInfo!().landmarks ?? 0) >= 1, null, {
      timeout: 60_000,
    });
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
