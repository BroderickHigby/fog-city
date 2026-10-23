// M0 acceptance on the real San Francisco world (public/tiles/sf, built by the pipeline).
// Skips cleanly while the SF world is absent from this checkout; activates when it lands.
// The browser tests share one page (booting SF under SwiftShader is the expensive part) and
// run in order: boot, look, landmark, traffic, drive (the first that moves the car), then the
// city limit (which puts the player there).

import { expect, test, type Page } from "@playwright/test";
import { toLocal } from "../../src/geo/project.ts";
import { canonicalJson, createGameSystems, hashState, nearbyBuildings, pointInPolygon } from "../../src/sim/index.ts";
import { DEFAULT_CATALOG } from "../../src/sim/player/catalog.ts";
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
import { GameplayDriver } from "./gameplay-driver.ts";
import { p1Chunk, replay, withRecordedCommands } from "./replay.ts";

const SF = worldExists("sf");
const ABSENT = "public/tiles/sf/manifest.json is absent: the pipeline has not produced the SF world on this checkout";
/** Spawn must be this close to the origin (the Ferry Building clock tower), metres. */
const SPAWN_RADIUS_M = 400;

test.describe("sf world: authored gameplay", () => {
  test.use({ viewport: { width: 960, height: 540 } });
  test("drives to the real FiDi counter and makes the first purchase through the HUD", async ({ page }) => {
    test.setTimeout(900_000);
    gate("sf", SF, ABSENT);
    const problems = await bootWorld(page, "sf", "&radius=300&pr=0.75");
    await page.evaluate(() => {
      const handle = (window as unknown as FogWindow).__fogcity!;
      handle.pause();
      handle.stepN(1); // Consume the recorded boot command before taking the replay snapshot.
    });
    const initial = await simState(page);
    const { world } = loadWorld("sf", { roads: true });
    const vendor = DEFAULT_CATALOG.sites.find(site => site.id === "fidi-desk" && site.kind === "vendor")!;
    const driver = new GameplayDriver(world, initial);
    driver.driveTo(vendor, 18, 9600);
    for (let at = 0; at < driver.frames.length; at += 500) {
      await page.evaluate(frames => (window as unknown as FogWindow).__fogcity!.stepFrames!(frames), driver.frames.slice(at, at + 500));
    }
    const arrived = await simState(page);
    expect(canonicalJson(arrived)).toBe(canonicalJson(driver.state));
    expect(Math.hypot(arrived.players.p1!.car.x - vendor.x, arrived.players.p1!.car.z - vendor.z)).toBeLessThanOrEqual(18);
    expect(Math.abs(arrived.players.p1!.car.speed)).toBeLessThan(.3);

    await page.getByRole("button", { name: "Counter", exact: true }).click();
    const tank = page.locator("article").filter({ has: page.getByRole("heading", { name: "Tank I", exact: true }) });
    await expect(tank.getByRole("button", { name: "Buy", exact: true })).toBeEnabled();
    const before = await simState(page);
    const cash = before.ext.economy!.players.p1!.cashCents;
    await tank.getByRole("button", { name: "Buy", exact: true }).click();
    await page.waitForFunction(() => (window as unknown as FogWindow).__fogcity!.state().ext.economy?.players.p1?.ownedItemIds.includes("tank-1"));
    const bought = await simState(page);
    const commands = await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.commands!());
    expect(bought.ext.economy!.players.p1!.cashCents).toBe(cash - 60_000);
    expect(bought.ext.economy!.players.p1!.ownedItemIds.filter(id => id === "tank-1")).toHaveLength(1);
    const purchase = commands.filter(command => command.kind === "gameplay.command" && (command.payload as { kind?: string }).kind === "buy");
    expect(purchase).toHaveLength(1);
    const chunks = withRecordedCommands([p1Chunk(bought.tick - before.tick)], before.tick, commands);
    expect(hashState(replay(world, before, chunks, createGameSystems()).final)).toBe(hashState(bought));
    await expect(tank.getByRole("button", { name: "Owned", exact: true })).toBeDisabled();
    await expect(page.locator(".fc-cluster")).toContainText("/ 12 L");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.pause());
    await frames(page, 2);
    await page.screenshot({ path: "test-results/first-purchase-third-person.png" });
    await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.setCameraMode!("first-person"));
    await frames(page, 2);
    await page.screenshot({ path: "test-results/first-purchase-first-person.png" });
    expect(problems).toEqual([]);
  });
});

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
  /** Streamer warnings: a tile whose glb failed to load (and was rebuilt from its collider, or failed). */
  const tileWarnings: string[] = [];

  test.beforeAll(async ({ browser }, info) => {
    gate("sf", SF, ABSENT);
    page = await newSharedPage(browser, info.project.use);
    page.on("response", (r) => responses.push({ path: new URL(r.url()).pathname, status: r.status() }));
    page.on("console", (m) => {
      if (m.type() === "warning" && /\[fog-city\] tile .*(glb failed|failed \()/.test(m.text())) tileWarnings.push(m.text());
    });
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

  test("the meshopt-compressed tiles decode in the browser: none falls back to its collider, none fails", async () => {
    // The pipeline's tiles need EXT_meshopt_compression (src/render/gltf-loader.ts); a loader
    // without the decoder fails every one, and the streamer quietly rebuilds them from colliders.
    const glbs = responses.filter((r) => /^\/tiles\/sf\/t-?\d+_-?\d+\.glb$/.test(r.path));
    expect(glbs.length, "tile glbs fetched since boot").toBeGreaterThan(4);
    expect(glbs.filter((r) => r.status !== 200 && r.status !== 304), "tile glbs not served").toEqual([]);
    expect(tileWarnings, "tiles whose glb failed to load").toEqual([]);
    expect(problems).toEqual([]);
    // The streamer's own counts: gated on the debug handle like every renderInfo() check, so
    // a missing handle is reported, never a silently skipped assertion.
    const have = await features(page);
    if (!have.renderInfo) {
      if (required("render-debug")) throw new Error(`E2E_REQUIRE names "render-debug", but window.__fogcity.renderInfo() is missing`);
      test.info().annotations.push({ type: "note", description: "renderInfo() not available: checked the glb responses and streamer warnings only" });
      return;
    }
    const info = await renderInfo(page);
    expect(info, "renderInfo() returned nothing").not.toBeNull();
    expect(typeof info!.tilesFailed, "renderInfo().tilesFailed").toBe("number");
    expect(info!.tilesFailed, "tiles failed").toBe(0);
    expect(info!.tilesLoaded ?? 0, "tiles loaded").toBeGreaterThan(4);
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

  test("boots from the citywide collider pack: not one *.collider.json is fetched", async () => {
    // 583 per-tile collider JSONs (83 MB) were the boot's biggest cost; the sim and the renderer
    // now read world.colliders.bin (13 MB) once (src/io/world-load.ts).
    const { manifest } = loadWorldFiles("sf");
    expect(manifest.worldColliders, "the manifest names a collider pack").toBeTruthy();
    expect(responses.filter((r) => r.path.endsWith(".collider.json")).map((r) => r.path), "collider JSON requests").toEqual([]);
    const pack = responses.filter((r) => r.path === `/tiles/sf/${manifest.worldColliders}`);
    expect(pack.length, `GET /tiles/sf/${manifest.worldColliders}`).toBe(1);
    expect(pack[0]!.status).toBe(200);
    const info = await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.simInfo!());
    expect(info.colliders, "simInfo().colliders").toBe("pack");
    expect(info.walls ?? 0, "edge and shore wall segments in the sim world").toBeGreaterThan(1000);
    expect(info.roads).toBe(true);
    expect(problems).toEqual([]);
  });

  test("the far skyline is drawn beyond the streamed tiles: from Twin Peaks, the current region is loaded and on screen", async () => {
    // 40 tiles stream in around Twin Peaks and every frame draws ~740k triangles: under
    // SwiftShader on a loaded machine that takes minutes of wall time, never a frame-rate claim.
    test.setTimeout(420_000);
    const have = await features(page);
    gate("render-debug", have.renderInfo && have.flyTo, "window.__fogcity.renderInfo() or flyTo() is missing");
    const { manifest } = loadWorldFiles("sf");
    const far = (manifest as { far?: Array<{ bbox?: [number, number, number, number] }> }).far ?? [];
    expect(far.length, "manifest.far cells").toBeGreaterThan(20);
    // Twin Peaks, 50 m over the summit, looking north-east at downtown 6.6 km away.
    await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.flyTo!(-4756, 330, 4562, 46, -6));
    expect(await settle(page, 300_000), "tiles and far cells settled").toBe(true);
    await frames(page, 3);
    const r = (await renderInfo(page))!;
    expect(r.farCellsTotal, "far cells the renderer knows").toBe(far.length);
    if (r.farBudget?.radius !== null && r.farBudget?.radius !== undefined) {
      const radius = r.farBudget.radius;
      const wanted = far.filter(({ bbox: b }) => {
        if (!b) return true;
        const dx = Math.max(Math.min(b[0], b[2]) + 4756, -4756 - Math.max(b[0], b[2]), 0);
        const dz = Math.max(Math.min(b[1], b[3]) - 4562, 4562 - Math.max(b[1], b[3]), 0);
        return Math.hypot(dx, dz) <= radius;
      }).length;
      expect(r.farBudget, "the requested software-renderer region has no outstanding or failed loads").toMatchObject({ queued: 0, loading: 0, failed: 0 });
      expect(r.farCells, "every cell in the bounded current region is loaded").toBeGreaterThanOrEqual(Math.min(24, wanted));
      expect(r.farCells, "the software skyline cache stays inside its cell budget").toBeLessThanOrEqual(24);
    } else {
      expect(r.farCells, "native GPUs retain the full skyline").toBe(far.length);
    }
    expect(r.farCellsDrawn ?? 0, "far cells drawn in the last frame").toBeGreaterThan(3);
    expect(r.farTriangles ?? 0, "far-LOD triangles loaded").toBeGreaterThan(100_000);
    expect(r.cameraFar ?? 0, "camera far plane, m").toBeGreaterThanOrEqual(15_000);
    expect(r.tilesFailed, "tiles failed").toBe(0);
    const stats = imageStats(decodePng(await page.screenshot()), 7);
    expect(looksDrawn(stats), `the frame looks blank: ${JSON.stringify(stats)}`).toBe(true);
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

  test("the city limit has no crack: from the car at the southern land edge, no sea shows between the last tile and the land beyond", async () => {
    // Before the far layer stitched its terrain to the tiles' ground at the city's outer edge, a
    // strip of the sea plane showed here across the whole screen, through the gap between the
    // last tile's ground and the far terrain's edge.
    test.setTimeout(420_000);
    const have = await features(page);
    gate("render-debug", have.renderInfo && have.setCameraMode && have.tilesSettled, "window.__fogcity.renderInfo(), setCameraMode() or tilesSettled() is missing");
    gate("step-frames", have.stepFrames, "window.__fogcity.stepFrames() is missing");
    await page.evaluate(() => {
      const h = (window as unknown as FogWindow).__fogcity!;
      h.pause();
      const tick = h.state().tick + 1;
      // Parked 2.2 m short of the land edge at z = 10000, facing south across it.
      h.stepFrames!(
        [{}],
        [
          { tick, kind: "player.leave", playerId: "p1" },
          { tick, kind: "player.join", playerId: "p1", payload: { x: -430, z: 9997.8, heading: Math.PI } },
        ],
      );
      h.setCameraMode!("chase");
    });
    expect(await settle(page, 300_000), "tiles and far cells settled").toBe(true);
    await frames(page, 3);
    const r = (await renderInfo(page))!;
    expect(r.farSeamEdges ?? 0, "far quads stitched to the tiles' ground at the city's outer edge").toBeGreaterThan(50);
    const img = decodePng(await page.screenshot());
    // Sea-coloured pixels below the horizon, outside the middle third (the car is there).
    let sea = 0;
    for (let y = Math.floor(img.height / 2); y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        if (x > img.width / 3 && x < (2 * img.width) / 3) continue;
        const i = (y * img.width + x) * img.channels;
        const red = img.data[i]!;
        const green = img.data[i + 1]!;
        const blue = img.data[i + 2]!;
        if (blue > red + 35 && blue > green + 15) sea++;
      }
    }
    expect(sea, "sea-coloured pixels below the horizon (the crack was about 11,000)").toBeLessThan(50);
    expect(problems).toEqual([]);
  });
});
