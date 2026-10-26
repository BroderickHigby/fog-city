// Reproducible grass views and rendering budgets; deliberately outside *.spec.ts.
// Supply a JSON plan: { viewport, query, views:[{ id, title, camera, source, lights? }] }.
// GRASS_CAPTURE_PLAN=/tmp/grass/plan.json GRASS_CAPTURE_URL=http://127.0.0.1:4362 \
// GRASS_CAPTURE_OUT=/tmp/grass/after GRASS_CAPTURE_BASELINE=/tmp/grass/before/report.json \
// GRASS_CAPTURE_REQUIRE=1 node tests/e2e/grass.capture.ts
// Optional GRASS_CAPTURE_LIGHTS=noon,golden,night and GRASS_CAPTURE_VIEWS=id1,id2 subsets.
// One browser, fixed cameras and graphics, finite waits; never asserts SwiftShader FPS.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { chromium, type Page } from "@playwright/test";
import type { DebugHandle, RenderInfo } from "../../src/debug.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const OUT = resolve(process.env.GRASS_CAPTURE_OUT ?? join(ROOT, "test-results/grass"));
const URL = process.env.GRASS_CAPTURE_URL ?? "http://127.0.0.1:4362";
const VIEWPORT = { width: 1280, height: 720 };
const WAIT_MS = 90_000;
type Light = "noon" | "golden" | "night";
const LIGHTS = (process.env.GRASS_CAPTURE_LIGHTS ?? "noon,golden,night").split(",") as Light[];
if (!LIGHTS.length || LIGHTS.some(light => !["noon", "golden", "night"].includes(light))) throw new Error("GRASS_CAPTURE_LIGHTS must contain noon, golden, or night");

interface Camera { x: number; y: number; z: number; yawDeg: number; pitchDeg: number }
interface View { id: string; title: string; camera: Camera; source: unknown; lights?: Light[] }
interface Plan { viewport: typeof VIEWPORT; query: string; views: View[] }
type Resources = ReturnType<NonNullable<DebugHandle["renderStats"]>>;
interface Entry {
  id: string; title: string; light: Light; camera: Camera; image: string;
  settled: boolean; settleMs: number; render: RenderInfo; resources: Resources | null;
  state: { seed: number; tick: number }; problems: string[]; violations: string[];
}
interface Report { generatedAt: string; revision: string; url: string; viewport: typeof VIEWPORT; query: string; environment: unknown; shots: Entry[]; problems: string[] }

const round = (v: number): number => Math.round(v * 100) / 100;
function makePlan(): Plan {
  throw new Error("GRASS_CAPTURE_PLAN must point to a fixed-camera plan");
}

async function frames(page: Page, count: number): Promise<void> {
  await page.evaluate(n => new Promise<void>((done, reject) => {
    const timer = setTimeout(() => reject(new Error("Render-frame wait exceeded 60 s")), 60_000);
    let k = 0;
    const next = (): void => { if (++k >= n) { clearTimeout(timer); done(); } else requestAnimationFrame(next); };
    requestAnimationFrame(next);
  }), count);
}

function violations(entry: Entry, before?: Entry): string[] {
  const out: string[] = [];
  const cap = (name: string, value: number, limit: number): void => { if (value > limit) out.push(`${name}: ${value} > ${round(limit)}`); };
  if (!entry.settled) out.push("Tile streamer did not settle within 90 s");
  cap("draw calls", entry.render.drawCalls, 1500);
  cap("visible triangles", entry.render.triangles, 3_000_000);
  cap("far-LOD triangles", entry.render.farTriangles, 600_000);
  if (entry.render.tilesFailed > 0) out.push(`${entry.render.tilesFailed} tiles failed`);
  const grass = (entry.render as RenderInfo & { grass?: Record<string, number | boolean> }).grass;
  if (process.env.GRASS_CAPTURE_REQUIRE === "1" && !grass) out.push("Candidate has no grass stats");
  if (grass) {
    if (typeof grass.drawCalls === "number") cap("grass draw calls", grass.drawCalls, 2);
    if (typeof grass.surfaceTriangles === "number") cap("grass surface triangles", grass.surfaceTriangles, 60_000);
    if (typeof grass.bladeTriangles === "number") cap("grass blade triangles", grass.bladeTriangles, 18_000);
    if (typeof grass.blades === "number") cap("grass blades", grass.blades, 18_000);
    if (typeof grass.patches === "number") cap("grass patches", grass.patches, 96);
    if (process.env.GRASS_CAPTURE_REQUIRE === "1" && (grass.loaded !== true || !(typeof grass.patches === "number" && grass.patches > 0))) out.push("Grass layer is not loaded or has no visible patches");
    if (grass.pending === true) out.push("Grass rebuild is pending");
  }
  if (before) {
    cap("draw-call regression", entry.render.drawCalls, before.render.drawCalls * 1.15 + 25);
    cap("triangle regression", entry.render.triangles, before.render.triangles * 1.25 + 100_000);
    if (entry.resources && before.resources) {
      cap("texture regression", entry.resources.textures, before.resources.textures + 8);
      cap("geometry regression", entry.resources.geometries, before.resources.geometries + 64);
      if (entry.resources.gpu && before.resources.gpu) cap("GPU texture-byte regression", entry.resources.gpu.textureBytes, before.resources.gpu.textureBytes * 1.1 + 16 * 1024 * 1024);
    }
  }
  return out;
}

const plan: Plan = process.env.GRASS_CAPTURE_PLAN ? JSON.parse(readFileSync(process.env.GRASS_CAPTURE_PLAN, "utf8")) as Plan : makePlan();
if (process.env.GRASS_CAPTURE_VIEWS) {
  const ids = process.env.GRASS_CAPTURE_VIEWS.split(",");
  if (ids.some(id => !plan.views.some(view => view.id === id))) throw new Error("GRASS_CAPTURE_VIEWS contains an unknown camera ID");
  plan.views = plan.views.filter(view => ids.includes(view.id));
}
const baseline = process.env.GRASS_CAPTURE_BASELINE ? JSON.parse(readFileSync(process.env.GRASS_CAPTURE_BASELINE, "utf8")) as Report : null;
if (baseline && (baseline.query !== plan.query || baseline.viewport.width !== plan.viewport.width || baseline.viewport.height !== plan.viewport.height)) {
  throw new Error("Baseline graphics query and viewport must match the capture plan");
}
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "plan.json"), JSON.stringify(plan, null, 2) + "\n");
const report: Report = { generatedAt: new Date().toISOString(), revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.env.GRASS_CAPTURE_SOURCE ?? ROOT, encoding: "utf8" }).trim(), url: URL, viewport: plan.viewport, query: plan.query, environment: null, shots: [], problems: [] };
const browser = await chromium.launch({ headless: true, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
try {
  const page = await browser.newPage({ viewport: plan.viewport, deviceScaleFactor: 1 });
  page.setDefaultTimeout(WAIT_MS);
  page.on("console", m => { if (m.type() === "error" || /shader error|VALIDATE_STATUS|WebGL.*(error|warning)/i.test(m.text())) report.problems.push(`console.${m.type()}: ${m.text()}`); });
  page.on("pageerror", e => report.problems.push(`pageerror: ${e.message}`));
  page.on("response", r => { if (r.status() >= 400) report.problems.push(`HTTP ${r.status()}: ${r.url()}`); });
  page.on("requestfailed", r => { const error = r.failure()?.errorText ?? ""; if (!/ABORTED/.test(error)) report.problems.push(`request failed: ${r.url()} ${error}`); });
  await page.goto(URL + plan.query, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForFunction(() => window.__fogcity?.ready, null, { timeout: 150_000 });
  await page.evaluate(() => window.__fogcity!.pause());
  report.environment = await page.evaluate(() => {
    const canvas = document.querySelector("canvas"), gl = canvas?.getContext("webgl2");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    return { browser: navigator.userAgent, gl: gl ? { renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), version: gl.getParameter(gl.VERSION) } : null, sim: window.__fogcity!.simInfo(), note: "FPS is display-only under SwiftShader; rendering counts and resources have budgets." };
  });
  for (const view of plan.views) for (const light of (view.lights ?? LIGHTS).filter(light => LIGHTS.includes(light))) {
    const start = Date.now(), errorsBefore = report.problems.length;
    await page.evaluate(({ camera: c, light }) => { const h = window.__fogcity!; h.pause(); h.setTimeOfDay?.(light); h.flyTo(c.x, c.y, c.z, c.yawDeg, c.pitchDeg); }, { camera: view.camera, light });
    // Fly-to selects the new tile neighborhood on the following frame. Then wait for the
    // streamer to be idle and draw its completed meshes before reading GPU counters.
    await frames(page, 2);
    const settled = await page.waitForFunction(() => window.__fogcity!.tilesSettled(), null, { timeout: WAIT_MS }).then(() => true, () => false);

    if (process.env.GRASS_CAPTURE_REQUIRE === "1") await page.waitForFunction(() => {
      const grass = (window.__fogcity!.renderInfo() as RenderInfo & { grass?: { loaded: boolean; pending: boolean } }).grass;
      return grass?.loaded === true && grass.pending === false;
    }, null, { timeout: WAIT_MS });
    await frames(page, 4);
    const stats = await page.evaluate(() => { const h = window.__fogcity!, state = h.state(); return { render: h.renderInfo(), resources: h.renderStats?.() ?? null, state: { seed: state.seed, tick: state.tick } }; });
    const id = `${view.id}-${light}`, image = `${id}.png`;
    await page.screenshot({ path: join(OUT, image), timeout: 60_000 });
    const entry: Entry = { id, title: view.title, light, camera: view.camera, image, settled, settleMs: Date.now() - start, ...stats, problems: report.problems.slice(errorsBefore), violations: [] };
    const before = baseline?.shots.find(b => b.id === id);
    if (baseline && !before) throw new Error(`Baseline report has no matched shot for ${id}`);
    entry.violations = violations(entry, before);
    report.shots.push(entry);
    writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2) + "\n");
    if (report.problems.length || entry.violations.length) throw new Error(`${id}: capture failed; inspect saved report and image`);
    console.log(`${id}: ${entry.render.drawCalls} calls / ${entry.render.triangles} triangles / ${entry.render.tilesLoaded} tiles / settled=${settled}${entry.violations.length ? " VIOLATIONS: " + entry.violations.join("; ") : ""}`);
  }
} finally { await browser.close(); }

const escape = (s: string): string => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
writeFileSync(join(OUT, "index.html"), `<!doctype html><meta charset="utf-8"><title>Fog City grass</title><style>body{margin:24px;font:15px system-ui;background:#eee;color:#222}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(440px,1fr));gap:20px}figure{margin:0;background:white;padding:10px}img{width:100%}small{display:block;color:#555}</style><h1>Fog City grass</h1><p>${escape(report.revision)} · 600 m tile radius · fixed camera and graphics · SwiftShader counts; FPS is display-only</p><main>${report.shots.map(s => `<figure><a href="${escape(s.image)}"><img src="${escape(s.image)}"></a><figcaption>${escape(s.title)} · ${s.light}<small>${s.render.drawCalls} calls · ${s.render.triangles.toLocaleString()} triangles · ${s.render.tilesLoaded} tiles · ${s.resources?.textures ?? "?"} textures</small><small>${escape(s.violations.join("; "))}</small></figcaption></figure>`).join("")}</main>`);
console.log(`Report: ${join(OUT, "report.json")}`);
if (report.problems.length || report.shots.some(s => s.violations.length)) process.exitCode = 1;
