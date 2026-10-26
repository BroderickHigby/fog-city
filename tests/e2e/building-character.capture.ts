// Reproducible building look-dev and GPU-independent budgets; deliberately outside *.spec.ts.
// Start an owned Vite server, then:
// BUILDING_CAPTURE_URL=http://127.0.0.1:4351 BUILDING_CAPTURE_OUT=/tmp/buildings/before \
//   node tests/e2e/building-character.capture.ts
// Candidate: set BUILDING_CAPTURE_PLAN=/tmp/buildings/before/plan.json and
// BUILDING_CAPTURE_BASELINE=/tmp/buildings/before/report.json to match cameras and compare budgets.
// Optional night subset: BUILDING_CAPTURE_LIGHTS=night
// BUILDING_CAPTURE_VIEWS=north-beach-close,soma-howard-close (use a separate output directory).
// Uses committed SF roads/colliders, one browser, fixed graphics settings, and finite waits.
// SwiftShader FPS is display-only. No world-data or simulation mutation is required.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { chromium, type Page } from "@playwright/test";
import { groundHeight } from "../../src/sim/index.ts";
import { loadWorld } from "../helpers.ts";
import type { DebugHandle, RenderInfo } from "../../src/debug.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const OUT = resolve(process.env.BUILDING_CAPTURE_OUT ?? join(ROOT, "test-results/building-character"));
const URL = process.env.BUILDING_CAPTURE_URL ?? "http://127.0.0.1:4353";
const QUERY = "?world=sf&radius=600&pr=1&gfx=high&quality=1&shadows=0&gpumem=1&tod=noon";
const VIEWPORT = { width: 1280, height: 720 };
const WAIT_MS = 90_000;
type Light = "noon" | "golden" | "night";
const LIGHTS = (process.env.BUILDING_CAPTURE_LIGHTS ?? "noon,golden").split(",") as Light[];
if (!LIGHTS.length || LIGHTS.some(light => !["noon", "golden", "night"].includes(light))) throw new Error("BUILDING_CAPTURE_LIGHTS must contain noon, golden, or night");

interface Camera { x: number; y: number; z: number; yawDeg: number; pitchDeg: number }
interface View { id: string; title: string; camera: Camera; source: unknown }
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
  const { world, roads } = loadWorld("sf");
  if (!roads) throw new Error("Committed SF roads are required");
  const views: View[] = [];
  // Anchors are local metres chosen from the committed roads, then projected onto that street.
  for (const region of [
    { id: "ferry-clay", title: "Ferry district / Clay Street", street: "Clay St", x: -450, z: 30, direction: 81 },
    { id: "north-beach", title: "North Beach / Columbus Avenue", street: "Columbus Ave", x: -1176, z: -350, direction: 311 },
    { id: "soma-howard", title: "SoMa / Howard Street", street: "Howard St", x: -700, z: 1260, direction: 45 },
  ]) {
    let street: { x: number; z: number; heading: number; distance: number; edge: string } | null = null;
    for (const e of roads.edges) {
      if (e.name !== region.street) continue;
      for (let i = 1; i < e.points.length; i++) {
        const a = e.points[i - 1]!, b = e.points[i]!;
        const dx = b[0] - a[0], dz = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((region.x - a[0]) * dx + (region.z - a[1]) * dz) / (dx * dx + dz * dz || 1)));
        const x = a[0] + t * dx, z = a[1] + t * dz, distance = Math.hypot(x - region.x, z - region.z);
        let heading = Math.atan2(dx, -dz) * 180 / Math.PI;
        if (Math.cos((heading - region.direction) * Math.PI / 180) < 0) heading += 180;
        if (!street || distance < street.distance) street = { x, z, heading, distance, edge: e.id };
      }
    }
    if (!street || street.distance > 80) throw new Error(`No committed street at ${region.id}`);
    const y = groundHeight(world, street.x, street.z) + 3.4;
    const camera = { x: round(street.x), y: round(y), z: round(street.z), yawDeg: round(street.heading + 12), pitchDeg: 4 };
    const nearby = world.tiles.flatMap(t => t.buildings.map(b => ({ tile: t.tileId, building: b })))
      .filter(({ building: b }) => b.footprint.some(([x, z]) => Math.hypot(x - street!.x, z - street!.z) < 120));
    const source = { streetFile: "public/tiles/sf/roads.json", edgeId: street.edge, street: region.street, colliderFiles: [...new Set(nearby.map(b => `public/tiles/sf/${b.tile}.collider.json`))], nearbyBuildings: nearby.length };
    views.push({ id: `${region.id}-street`, title: `${region.title}: neighboring facades`, camera, source });
    const faces = nearby.flatMap(({ building: b }) => b.footprint.map((a, i) => {
      const p = b.footprint[(i + 1) % b.footprint.length]!;
      const length = Math.hypot(p[0] - a[0], p[1] - a[1]);
      const x = (a[0] + p[0]) / 2, z = (a[1] + p[1]) / 2;
      const distance = Math.hypot(x - street!.x, z - street!.z), height = b.topY - b.baseY;
      return { x, z, length, distance, height, b };
    })).filter(f => f.length >= 12 && f.distance >= 9 && f.distance <= 65 && f.height >= 8 && f.height <= 95)
      .sort((a, b) => (a.distance + Math.abs(a.height - 20) * 0.05) - (b.distance + Math.abs(b.height - 20) * 0.05));
    const face = faces[0];
    if (!face) throw new Error(`No facade close-up from ${region.id}`);
    const targetY = face.b.baseY + Math.min(9, face.height * 0.4);
    views.push({
      id: `${region.id}-close`, title: `${region.title}: facade at ${round(face.distance)} m`,
      camera: { ...camera, yawDeg: round(Math.atan2(face.x - street.x, -(face.z - street.z)) * 180 / Math.PI), pitchDeg: round(Math.atan2(targetY - y, face.distance) * 180 / Math.PI) },
      source: { ...source, buildingId: face.b.id, facadeLengthM: round(face.length), buildingHeightM: round(face.height), facadeDistanceM: round(face.distance) },
    });
  }
  return { viewport: VIEWPORT, query: QUERY, views };
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
  const detail = entry.render.buildingDetail;
  if (detail) {
    cap("detailed buildings", detail.buildings, 36);
    cap("building detail triangles", detail.triangles, 90_000);
    cap("building detail draw calls", detail.drawCalls, 1);
    if (detail.pending) out.push("Building detail rebuild is pending");
  }
  if (before) {
    if (!detail || detail.registered <= 0 || detail.buildings <= 0) out.push("Candidate has no registered, visible building detail");
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

const plan: Plan = process.env.BUILDING_CAPTURE_PLAN ? JSON.parse(readFileSync(process.env.BUILDING_CAPTURE_PLAN, "utf8")) as Plan : makePlan();
if (process.env.BUILDING_CAPTURE_VIEWS) {
  const ids = process.env.BUILDING_CAPTURE_VIEWS.split(",");
  if (ids.some(id => !plan.views.some(view => view.id === id))) throw new Error("BUILDING_CAPTURE_VIEWS contains an unknown camera ID");
  plan.views = plan.views.filter(view => ids.includes(view.id));
}
const baseline = process.env.BUILDING_CAPTURE_BASELINE ? JSON.parse(readFileSync(process.env.BUILDING_CAPTURE_BASELINE, "utf8")) as Report : null;
if (baseline && (baseline.query !== plan.query || baseline.viewport.width !== plan.viewport.width || baseline.viewport.height !== plan.viewport.height)) {
  throw new Error("Baseline graphics query and viewport must match the capture plan");
}
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "plan.json"), JSON.stringify(plan, null, 2) + "\n");
const report: Report = { generatedAt: new Date().toISOString(), revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.env.BUILDING_CAPTURE_SOURCE ?? ROOT, encoding: "utf8" }).trim(), url: URL, viewport: plan.viewport, query: plan.query, environment: null, shots: [], problems: [] };
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
  for (const light of LIGHTS) for (const view of plan.views) {
    const start = Date.now(), errorsBefore = report.problems.length;
    await page.evaluate(({ camera: c, light }) => { const h = window.__fogcity!; h.pause(); h.setTimeOfDay?.(light); h.flyTo(c.x, c.y, c.z, c.yawDeg, c.pitchDeg); }, { camera: view.camera, light });
    // Fly-to selects the new tile neighborhood on the following frame. Then wait for the
    // streamer to be idle and draw its completed meshes before reading GPU counters.
    await frames(page, 2);
    const settled = await page.waitForFunction(() => window.__fogcity!.tilesSettled(), null, { timeout: WAIT_MS }).then(() => true, () => false);
    if (baseline) await page.waitForFunction(() => window.__fogcity!.renderInfo().buildingDetail?.pending === false, null, { timeout: WAIT_MS });
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
    console.log(`${id}: ${entry.render.drawCalls} calls / ${entry.render.triangles} triangles / ${entry.render.tilesLoaded} tiles / settled=${settled}${entry.violations.length ? " VIOLATIONS: " + entry.violations.join("; ") : ""}`);
  }
} finally { await browser.close(); }

const escape = (s: string): string => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
writeFileSync(join(OUT, "index.html"), `<!doctype html><meta charset="utf-8"><title>Fog City building character</title><style>body{margin:24px;font:15px system-ui;background:#eee;color:#222}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(440px,1fr));gap:20px}figure{margin:0;background:white;padding:10px}img{width:100%}small{display:block;color:#555}</style><h1>Fog City building character</h1><p>${escape(report.revision)} · 600 m tile radius · fixed camera and graphics · SwiftShader counts; FPS is display-only</p><main>${report.shots.map(s => `<figure><a href="${escape(s.image)}"><img src="${escape(s.image)}"></a><figcaption>${escape(s.title)} · ${s.light}<small>${s.render.drawCalls} calls · ${s.render.triangles.toLocaleString()} triangles · ${s.render.tilesLoaded} tiles · ${s.resources?.textures ?? "?"} textures</small><small>${escape(s.violations.join("; "))}</small></figcaption></figure>`).join("")}</main>`);
console.log(`Report: ${join(OUT, "report.json")}`);
if (report.problems.length || report.shots.some(s => s.violations.length)) process.exitCode = 1;
