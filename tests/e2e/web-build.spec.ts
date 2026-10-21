// The static web build (pnpm build, scripts/build-web.ts) works as the page host will serve it:
// built into a sub-directory and opened from a sub-path (/fog/city/), with only the extensions
// the host accepts, the world read from gzip + base64 packs through assets.index.json and no
// per-tile collider JSON, it boots SF by default, drives, streams tiles and draws the skyline.
// A file too big for one host file (the collider pack, once over 14 MB encoded) is served as
// parts: each is fetched once and the world still boots from them.
//
// The build runs once for the file (about 15 s), into test-results/web-build/, served by a
// loopback server inside the test process that records every request. WEB_BUILD_PUBLIC=<dir>
// builds the world and models from another public/ directory (a pipeline branch's world before
// it merges, docs/testing.md); the default is this checkout's public/.

import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { HOST_LIMITS, PACK_MAX_BYTES, buildWeb, checkHostLimits, type BuildReport, type WebIndex } from "../../scripts/build-web.ts";
import { ROOT } from "../helpers.ts";
import { FAST_VIEWPORT, THROTTLE, frames, gate, newSharedPage, optionalAbsent, type FogWindow } from "./fixtures.ts";
import { decodePng, imageStats, looksDrawn } from "./png.ts";

const PUBLIC = process.env.WEB_BUILD_PUBLIC ? resolve(ROOT, process.env.WEB_BUILD_PUBLIC) : join(ROOT, "public");
const SF = existsSync(join(PUBLIC, "tiles", "sf", "manifest.json"));
const ABSENT = `${join(PUBLIC, "tiles", "sf", "manifest.json")} is absent: the hosted build ships the SF world`;
const COLLIDERS = "tiles/sf/world.colliders.bin";
const SITE = join(ROOT, "test-results", "web-build", "site");
const SUB = "/fog/city/";
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

test.describe("static web build, served from a sub-path", () => {
  test.skip(optionalAbsent("sf", SF), ABSENT);
  test.describe.configure({ mode: "serial" });

  let server: Server | null = null;
  let origin = "";
  let report: BuildReport;
  let page: Page;
  const requests: Array<{ path: string; status: number }> = [];
  const problems: string[] = [];

  test.beforeAll(async ({ browser }, info) => {
    gate("sf", SF, ABSENT);
    info.setTimeout(600_000);
    report = await buildWeb({ out: join(SITE, ...SUB.split("/").filter(Boolean)), worlds: ["sf"], level: 6, skipVite: false, publicDir: PUBLIC });
    server = createServer((req, res) => {
      const path = decodeURIComponent((req.url ?? "/").split("?")[0]!);
      const file = join(SITE, path.endsWith("/") ? `${path}index.html` : path);
      const ext = file.slice(file.lastIndexOf("."));
      let status = 200;
      try {
        if (!file.startsWith(SITE) || !(HOST_LIMITS.extensions as readonly string[]).includes(ext) || !statSync(file).isFile()) throw new Error("refused");
        res.writeHead(200, { "content-type": TYPES[ext] ?? "application/octet-stream" });
        res.end(readFileSync(file));
      } catch {
        status = 404;
        res.writeHead(404);
        res.end();
      }
      requests.push({ path, status });
    });
    await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
    const addr = server.address();
    origin = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    // A small frame: under SwiftShader a full-size one takes seconds (fixtures.ts, FAST_VIEWPORT).
    page = await newSharedPage(browser, { ...info.project.use, viewport: FAST_VIEWPORT });
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`console.error: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`uncaught: ${e.message}`));
  });
  test.afterAll(async () => {
    await page?.context().close();
    if (server) await new Promise<void>((done) => server!.close(() => done()));
  });

  test("the build fits the host: allowed extensions only, file count, total and per-file size, no loose binaries", async () => {
    const dist = join(SITE, ...SUB.split("/").filter(Boolean));
    const check = checkHostLimits(dist);
    expect(check.problems).toEqual([]);
    expect(check.files).toBeLessThanOrEqual(HOST_LIMITS.maxFiles);
    expect(check.totalBytes).toBeLessThanOrEqual(HOST_LIMITS.maxTotalBytes);
    expect(check.largest.bytes).toBeLessThanOrEqual(HOST_LIMITS.maxFileBytes);
    expect(report.packs, "tile and far-cell packs").toBeGreaterThan(5);
    const index = JSON.parse(readFileSync(join(dist, "assets.index.json"), "utf8")) as WebIndex;
    expect(index.defaultWorld).toBe("sf");
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
    await page.goto(`${origin}${SUB}?pr=0.5`);
    await page.waitForFunction(
      () => (window as unknown as FogWindow).__fogcity?.ready === true || (document.getElementById("hud")?.textContent ?? "").startsWith("Failed to start"),
      null,
      { timeout: 120_000 },
    );
    const info = await page.evaluate(() => {
      const h = (window as unknown as FogWindow).__fogcity;
      return h?.ready ? { world: h.world, sim: h.simInfo!() } : { hud: document.getElementById("hud")?.textContent ?? "" };
    });
    expect(info, "the hosted page booted").toHaveProperty("world", "sf");
    type SimInfo = ReturnType<NonNullable<NonNullable<FogWindow["__fogcity"]>["simInfo"]>>;
    const sim = (info as { sim: SimInfo }).sim;
    expect(sim.assets).toBe("packed");
    expect(sim.colliders).toBe("pack");
    expect(sim.roads).toBe(true);
    expect(sim.walls ?? 0).toBeGreaterThan(1000);
    expect(sim.agents).toBeGreaterThan(50);
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
    // Drive: 10 s of full throttle from the spawn, stepped deterministically.
    const moved = await page.evaluate((input) => {
      const h = (window as unknown as FogWindow).__fogcity!;
      h.pause();
      const a = h.state().players.p1!.car;
      h.stepN(600, input);
      const b = h.state().players.p1!.car;
      return Math.hypot(b.x - a.x, b.z - a.z);
    }, THROTTLE);
    expect(moved, "metres driven in 10 s").toBeGreaterThan(30);
    await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.setCameraMode!("chase"));
    await page.waitForFunction(() => (window as unknown as FogWindow).__fogcity!.tilesSettled!() === true, null, { timeout: 180_000 });
    await frames(page, 3);
    const r = await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.renderInfo!());
    expect(r.tilesLoaded, "tiles loaded from the packs").toBeGreaterThan(10);
    expect(r.tilesFailed).toBe(0);
    expect(r.farCells, "far cells loaded").toBe(r.farCellsTotal);
    expect(r.farCellsTotal).toBeGreaterThan(20);
    expect(r.playerCarsFromFile, "the player car model came from its packed file").toBe(1);
    expect(requests.filter((r) => r.path.includes("/packs/tiles-")).length, "tile packs fetched").toBeGreaterThan(1);
    const png = await page.screenshot({ path: join(ROOT, "test-results", "web-build", "hosted-chase.png") });
    const stats = imageStats(decodePng(png), 7);
    expect(looksDrawn(stats), `the frame looks blank: ${JSON.stringify(stats)}`).toBe(true);
    expect(requests.filter((x) => x.status !== 200).map((x) => `${x.status} ${x.path}`)).toEqual([]);
    expect(problems).toEqual([]);
  });
});
