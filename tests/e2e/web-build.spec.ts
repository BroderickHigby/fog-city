// The static web build (pnpm build, scripts/build-web.ts) works as the page host will serve it:
// built into a sub-directory and opened from a sub-path (/fog/city/), with only the extensions
// the host accepts, the world read from gzip + base64 packs through assets.index.json and no
// per-tile collider JSON, it boots SF by default, drives, streams tiles and draws the skyline.
// A file too big for one host file (the collider pack, once over 14 MB encoded) is served as
// parts: each is fetched once and the world still boots from them.
//
// The committed world's collider pack fits one file under the real 14 MB margin, so a second
// build with a lowered part size (SPLIT_PART_BYTES) proves the split path in the browser on
// every run: its parts join back to the raw pack, the page boots and drives on them, fetching
// each part once and never the whole file, and a part the host lacks stops the boot with an
// error that names the part by the number in its file's name.
//
// Each build runs once for its describe (about 15 s), into test-results/web-build/, served by a
// loopback server inside the test process that records every request. WEB_BUILD_PUBLIC=<dir>
// builds the world and models from another public/ directory (a pipeline branch's world before
// it merges, docs/testing.md); the default is this checkout's public/.

import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { HOST_LIMITS, PACK_MAX_BYTES, buildWeb, checkHostLimits, partName, type BuildReport, type IndexPart, type WebIndex } from "../../scripts/build-web.ts";
import { ROOT } from "../helpers.ts";
import { FAST_VIEWPORT, THROTTLE, frames, gate, newSharedPage, optionalAbsent, type FogWindow } from "./fixtures.ts";
import { decodePng, imageStats, looksDrawn } from "./png.ts";

const PUBLIC = process.env.WEB_BUILD_PUBLIC ? resolve(ROOT, process.env.WEB_BUILD_PUBLIC) : join(ROOT, "public");
const SF = existsSync(join(PUBLIC, "tiles", "sf", "manifest.json"));
const ABSENT = `${join(PUBLIC, "tiles", "sf", "manifest.json")} is absent: the hosted build ships the SF world`;
const COLLIDERS = "tiles/sf/world.colliders.bin";
const SITE = join(ROOT, "test-results", "web-build", "site");
const SPLIT_SITE = join(ROOT, "test-results", "web-build", "split-site");
const SUB = "/fog/city/";
/**
 * The split build's part size: low enough that the collider pack is cut into parts (the
 * committed one encodes to 12.3 MB, the QA world's to 14.3 MB), high enough that the tile and
 * far packs (at most about 4.2 MB encoded) stay whole.
 */
const SPLIT_PART_BYTES = 5_000_000;
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

interface Hosted {
  server: Server;
  origin: string;
  /** Every request, in order: its path and the status served. */
  requests: Array<{ path: string; status: number }>;
  /** Paths answered 404 as if the host lacked them (a missing part). */
  refused: Set<string>;
}

/** Serve `site` on loopback as the page host would: its allowed extensions only, nothing outside it. */
async function host(site: string): Promise<Hosted> {
  const requests: Hosted["requests"] = [];
  const refused = new Set<string>();
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]!);
    const file = join(site, path.endsWith("/") ? `${path}index.html` : path);
    const ext = file.slice(file.lastIndexOf("."));
    let status = 200;
    try {
      if (refused.has(path) || !file.startsWith(site + sep) || !(HOST_LIMITS.extensions as readonly string[]).includes(ext) || !statSync(file).isFile()) throw new Error("refused");
      res.writeHead(200, { "content-type": TYPES[ext] ?? "application/octet-stream" });
      res.end(readFileSync(file));
    } catch {
      status = 404;
      res.writeHead(404);
      res.end();
    }
    requests.push({ path, status });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const addr = server.address();
  return { server, origin: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`, requests, refused };
}

/** Open the hosted page and wait until it is ready or has failed to start. */
async function boot(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(
    () => (window as unknown as FogWindow).__fogcity?.ready === true || (document.getElementById("hud")?.textContent ?? "").startsWith("Failed to start"),
    null,
    { timeout: 120_000 },
  );
}

type SimInfo = ReturnType<NonNullable<NonNullable<FogWindow["__fogcity"]>["simInfo"]>>;

/** The booted page's world and sim, or the HUD's text when it did not start. */
async function booted(page: Page): Promise<{ world: string; sim: SimInfo } | { hud: string }> {
  return page.evaluate(() => {
    const h = (window as unknown as FogWindow).__fogcity;
    return h?.ready ? { world: h.world, sim: h.simInfo!() } : { hud: document.getElementById("hud")?.textContent ?? "" };
  });
}

/** Metres the player's car covers in 10 s of full throttle from where it stands, stepped deterministically. */
async function drive(page: Page): Promise<number> {
  return page.evaluate((input) => {
    const h = (window as unknown as FogWindow).__fogcity!;
    h.pause();
    const a = h.state().players.p1!.car;
    h.stepN(600, input);
    const b = h.state().players.p1!.car;
    return Math.hypot(b.x - a.x, b.z - a.z);
  }, THROTTLE);
}

/** A page with a small frame (under SwiftShader a full-size one takes seconds; fixtures.ts, FAST_VIEWPORT) that records its errors. */
async function hostedPage(browser: Browser, use: Parameters<typeof newSharedPage>[1], problems: string[]): Promise<Page> {
  const page = await newSharedPage(browser, { ...use, viewport: FAST_VIEWPORT });
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console.error: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`uncaught: ${e.message}`));
  return page;
}

test.describe("static web build, served from a sub-path", () => {
  test.skip(optionalAbsent("sf", SF), ABSENT);
  test.describe.configure({ mode: "serial" });

  let site: Hosted | null = null;
  let report: BuildReport;
  let page: Page;
  const problems: string[] = [];

  test.beforeAll(async ({ browser }, info) => {
    gate("sf", SF, ABSENT);
    info.setTimeout(600_000);
    report = await buildWeb({ out: join(SITE, ...SUB.split("/").filter(Boolean)), worlds: ["sf"], level: 6, skipVite: false, publicDir: PUBLIC });
    site = await host(SITE);
    page = await hostedPage(browser, info.project.use, problems);
  });
  test.afterAll(async () => {
    await page?.context().close();
    if (site) await new Promise<void>((done) => site!.server.close(() => done()));
  });

  test("the build fits the host: allowed extensions only, file count, total and per-file size, no loose binaries", async () => {
    const dist = join(SITE, ...SUB.split("/").filter(Boolean));
    const check = checkHostLimits(dist);
    expect(check.problems).toEqual([]);
    expect(readFileSync(join(dist, "third-party-notices.txt"), "utf8")).toContain("Copyright (c) 2020 Microsoft");
    expect(check.files).toBeLessThanOrEqual(HOST_LIMITS.maxFiles);
    expect(check.totalBytes).toBeLessThanOrEqual(HOST_LIMITS.maxTotalBytes);
    expect(check.largest.bytes).toBeLessThanOrEqual(HOST_LIMITS.maxFileBytes);
    expect(report.packs, "tile and far-cell packs").toBeGreaterThan(5);
    const index = JSON.parse(readFileSync(join(dist, "assets.index.json"), "utf8")) as WebIndex;
    expect(index.defaultWorld).toBe("sf");
    expect(index.files["models/generic-player.glb"], "generic human is shipped").toBeDefined();
    expect(index.files["models/player.glb"], "retired likeness is excluded").toBeUndefined();
    expect(index.files["textures/surfaces/asphalt_albedo.webp"]).toBeDefined();
    expect(index.files["textures/surfaces/concrete_normal.webp"]).toBeDefined();
    expect(Object.keys(index.files).some((f) => f.endsWith(".collider.json")), "per-tile colliders in the index").toBe(false);
    expect(index.files[COLLIDERS]?.src).toMatch(/\.gz\.b64\.txt$/);
    // Files in parts: the index lists each part at its size on disk, every one under the build's
    // margin; the report names the same; a split index says version 2, an unsplit one 1.
    const parts = index.parts ?? {};
    expect(report.split).toEqual(Object.entries(parts).map(([src, list]) => ({ src, parts: list.map((p) => p.bytes) })));
    expect(index.version).toBe(report.split.length > 0 ? 2 : 1);
    for (const list of Object.values(parts)) {
      expect(list.length).toBeGreaterThan(1);
      for (const p of list) {
        expect(statSync(join(dist, p.src)).size, p.src).toBe(p.bytes);
        expect(p.bytes, p.src).toBeLessThanOrEqual(PACK_MAX_BYTES);
      }
    }
    const mb = (n: number): string => (n / 1e6).toFixed(2);
    test.info().annotations.push({
      type: "build",
      description:
        `${PUBLIC}: ${check.files} files, ${mb(check.totalBytes)} MB, largest ${check.largest.path} ${mb(check.largest.bytes)} MB; ` +
        `binaries ${mb(report.rawBinaryBytes)} MB raw -> ${mb(report.encodedBinaryBytes)} MB encoded; ${report.packs} packs; ` +
        `in parts: ${report.split.map((x) => `${x.src} ${x.parts.map(mb).join(" + ")} MB`).join(", ") || "none"}`,
    });
  });

  test("boots SF by default from /fog/city/: every request under the sub-path, the world from packs, no collider JSON", async () => {
    const { origin, requests } = site!;
    await boot(page, `${origin}${SUB}?pr=0.5`);
    const info = await booted(page);
    expect(info, "the hosted page booted").toHaveProperty("world", "sf");
    const sim = (info as { sim: SimInfo }).sim;
    expect(sim.assets).toBe("packed");
    expect(sim.colliders).toBe("pack");
    expect(sim.roads).toBe(true);
    expect(sim.walls ?? 0).toBeGreaterThan(1000);
    expect(sim.agents).toBeGreaterThan(50);
    // The actual skinned avatar must load through the packed asset provider too.
    await page.keyboard.press("KeyF");
    await page.waitForFunction(() => {
      const game = (window as unknown as FogWindow).__fogcity!;
      return game.state().players.p1!.mode === "foot" && game.renderInfo!().walkersFromFile === 1;
    });
    await page.keyboard.press("KeyF");
    await page.waitForFunction(() => (window as unknown as FogWindow).__fogcity!.state().players.p1!.mode === "vehicle");
    await page.waitForFunction(() => (window as unknown as FogWindow).__fogcity!.renderInfo!().surfaceTextures?.length === 2);
    // Relative URLs only: nothing asked for outside the sub-path, nothing the host would refuse.
    expect(requests.filter((r) => !r.path.startsWith(SUB)).map((r) => r.path), "requests outside the sub-path").toEqual([]);
    expect(requests.filter((r) => r.status !== 200).map((r) => `${r.status} ${r.path}`), "failed requests").toEqual([]);
    expect(requests.filter((r) => /\.(glb|bin)$|\.collider\.json$/.test(r.path)).map((r) => r.path), "raw binaries or collider JSON").toEqual([]);
    expect(requests.some((r) => r.path.endsWith("assets.index.json"))).toBe(true);
    // The collider pack, whole or in parts: each of its files fetched exactly once, and nothing else of it.
    const index = JSON.parse(readFileSync(join(SITE, ...SUB.split("/").filter(Boolean), "assets.index.json"), "utf8")) as WebIndex;
    const src = index.files[COLLIDERS]!.src;
    const files = (index.parts?.[src]?.map((p) => p.src) ?? [src]).map((f) => SUB + f);
    expect(requests.filter((r) => r.path.includes("world.colliders.bin")).map((r) => r.path).sort(), "collider pack requests").toEqual([...files].sort());
    test.info().annotations.push({ type: "colliders", description: files.join(", ") });
    expect(problems).toEqual([]);
  });

  test("streams tiles from the packs, draws the far skyline, drives, and draws a frame", async () => {
    const { requests } = site!;
    // Drive: 10 s of full throttle from the spawn, stepped deterministically.
    expect(await drive(page), "metres driven in 10 s").toBeGreaterThan(30);
    await page.evaluate(() => {
      const h = (window as unknown as FogWindow).__fogcity!;
      h.setCameraMode!("first-person");
      h.setCameraMode!("chase");
    });
    await page.waitForFunction(() => (window as unknown as FogWindow).__fogcity!.tilesSettled!() === true, null, { timeout: 180_000 });
    await frames(page, 3);
    const r = await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.renderInfo!());
    expect(r.tilesLoaded, "tiles loaded from the packs").toBeGreaterThan(10);
    expect(r.tilesFailed).toBe(0);
    expect(r.farCellsTotal).toBeGreaterThan(20);
    if (r.farBudget?.radius !== null && r.farBudget?.radius !== undefined) {
      const car = await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.state().players.p1!.car);
      const far = (JSON.parse(readFileSync(join(PUBLIC, "tiles/sf/manifest.json"), "utf8")) as {
        far: Array<{ bbox?: [number, number, number, number] }>;
      }).far;
      expect(r.farCellsTotal).toBe(far.length);
      // The reset chase camera is at most 10.9 m from the car. Every cell in
      // this inner region must therefore be loaded for the actual camera.
      const radius = r.farBudget.radius - 11;
      expect(radius).toBeGreaterThan(0);
      const wanted = far.filter(({ bbox: b }) => {
        if (!b) return true;
        const dx = Math.max(Math.min(b[0], b[2]) - car.x, car.x - Math.max(b[0], b[2]), 0);
        const dz = Math.max(Math.min(b[1], b[3]) - car.z, car.z - Math.max(b[1], b[3]), 0);
        return Math.hypot(dx, dz) <= radius;
      }).length;
      expect(wanted, "cells required around the settled chase camera").toBeGreaterThan(0);
      expect(r.farBudget, "the current region has no outstanding or failed loads").toMatchObject({ queued: 0, loading: 0, failed: 0 });
      expect(r.farCells, "every cell in the required camera region is loaded").toBeGreaterThanOrEqual(Math.min(24, wanted));
      expect(r.farCells, "the software skyline cache stays inside its cell budget").toBeLessThanOrEqual(24);
    } else {
      expect(r.farCells, "native GPUs retain the full skyline").toBe(r.farCellsTotal);
    }
    expect(r.farCellsDrawn ?? 0, "far skyline cells are actually drawn").toBeGreaterThan(0);
    expect(r.playerCarsFromFile, "the player car model came from its packed file").toBe(1);
    expect(requests.filter((r) => r.path.includes("/packs/tiles-")).length, "tile packs fetched").toBeGreaterThan(1);
    const png = await page.screenshot({ path: join(ROOT, "test-results", "web-build", "hosted-chase.png") });
    const stats = imageStats(decodePng(png), 7);
    expect(looksDrawn(stats), `the frame looks blank: ${JSON.stringify(stats)}`).toBe(true);
    expect(requests.filter((x) => x.status !== 200).map((x) => `${x.status} ${x.path}`)).toEqual([]);
    expect(problems).toEqual([]);
  });
});

test.describe("static web build with the collider pack in parts, served from a sub-path", () => {
  test.skip(optionalAbsent("sf", SF), ABSENT);
  test.describe.configure({ mode: "serial" });

  const dist = join(SPLIT_SITE, ...SUB.split("/").filter(Boolean));
  let site: Hosted | null = null;
  let report: BuildReport;
  let page: Page;
  let parts: IndexPart[] = [];
  const problems: string[] = [];

  test.beforeAll(async ({ browser }, info) => {
    gate("sf", SF, ABSENT);
    info.setTimeout(600_000);
    report = await buildWeb({ out: dist, worlds: ["sf"], level: 6, skipVite: false, publicDir: PUBLIC, partMaxBytes: SPLIT_PART_BYTES });
    site = await host(SPLIT_SITE);
    page = await hostedPage(browser, info.project.use, problems);
  });
  test.afterAll(async () => {
    await page?.context().close();
    if (site) await new Promise<void>((done) => site!.server.close(() => done()));
  });

  test("the collider pack is written in parts under the lowered size, and they join back to the raw pack", async () => {
    const check = checkHostLimits(dist);
    expect(check.problems).toEqual([]);
    const index = JSON.parse(readFileSync(join(dist, "assets.index.json"), "utf8")) as WebIndex;
    expect(index.version, "an index with parts").toBe(2);
    const src = index.files[COLLIDERS]!.src;
    parts = index.parts?.[src] ?? [];
    expect(parts.length, `${src} in parts of at most ${SPLIT_PART_BYTES} bytes`).toBeGreaterThan(1);
    expect(parts.map((p) => p.src)).toEqual(parts.map((_, n) => partName(src, n)));
    expect(report.split.find((x) => x.src === src)?.parts).toEqual(parts.map((p) => p.bytes));
    for (const p of parts) {
      expect(statSync(join(dist, p.src)).size, p.src).toBe(p.bytes);
      expect(p.bytes, p.src).toBeLessThanOrEqual(SPLIT_PART_BYTES);
    }
    // The parts, joined in index order and decoded, are the raw pack byte for byte.
    const joined = parts.map((p) => readFileSync(join(dist, p.src), "utf8")).join("");
    const raw = readFileSync(join(PUBLIC, "tiles", "sf", "world.colliders.bin"));
    expect(gunzipSync(Buffer.from(joined, "base64")).equals(raw), "joined parts decode to world.colliders.bin").toBe(true);
    expect(existsSync(join(dist, src)), "no whole file beside the parts").toBe(false);
    test.info().annotations.push({ type: "parts", description: parts.map((p) => `${p.src} ${p.bytes}`).join(", ") });
  });

  test("boots SF from the parts and drives on them: each part fetched once, the whole file never", async () => {
    const { origin, requests } = site!;
    await boot(page, `${origin}${SUB}?pr=0.5`);
    const info = await booted(page);
    expect(info, "the hosted page booted from the collider pack's parts").toHaveProperty("world", "sf");
    const sim = (info as { sim: SimInfo }).sim;
    expect(sim.assets).toBe("packed");
    expect(sim.colliders).toBe("pack");
    expect(sim.roads).toBe(true);
    expect(sim.walls ?? 0).toBeGreaterThan(1000);
    const colliderRequests = requests.filter((r) => r.path.includes("world.colliders.bin")).map((r) => r.path).sort();
    expect(colliderRequests, "collider pack requests: every part once, nothing else").toEqual(parts.map((p) => SUB + p.src).sort());
    expect(requests.filter((r) => r.status !== 200).map((r) => `${r.status} ${r.path}`), "failed requests").toEqual([]);
    expect(await drive(page), "metres driven in 10 s on the joined pack").toBeGreaterThan(30);
    expect(problems).toEqual([]);
  });

  test("a part the host lacks stops the boot, naming that part by the number in its file's name", async () => {
    const { origin, requests, refused } = site!;
    const missing = parts[1]!;
    refused.add(SUB + missing.src);
    requests.length = 0;
    problems.length = 0;
    await boot(page, `${origin}${SUB}?pr=0.5`);
    const info = await booted(page);
    expect(info, "the page did not start").toHaveProperty("hud");
    expect((info as { hud: string }).hud).toContain(`${COLLIDERS}: part 1 of parts 0..${parts.length - 1} (${missing.src}): HTTP 404`);
    expect(requests.filter((r) => r.status !== 200).map((r) => r.path), "the only failed request").toEqual([SUB + missing.src]);
  });
});
