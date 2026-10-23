// Perf probe: frame times, draw calls and triangles for each world, written to
// test-results/perf.json. It REPORTS and never asserts on the numbers: the suite renders with
// SwiftShader (software WebGL), so absolute times say little about a GPU. Compare runs on the
// same machine to spot a change in direction (draw calls doubling, a sim tick getting slower).
// It fails only if the probe itself breaks on the dev world, which every checkout has.

import { mkdirSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";
import { test, type Page } from "@playwright/test";
import { ROOT, worldExists } from "../helpers.ts";
import { THROTTLE, bootWorld, features, renderInfo, settle, type FogWindow, type RenderInfoLike } from "./fixtures.ts";

const OUT = join(ROOT, "test-results", "perf.json");

/** Views to measure besides the spawn (chase camera): x, y, z, compass yaw, pitch (degrees). */
const VIEWS: Record<string, Record<string, [number, number, number, number, number]>> = {
  dev: { overview: [70, 55, 110, 327, -23] },
  "dev-city": { overview: [95, 160, 550, 330, -25] },
  sf: {
    "embarcadero-ferry-building": [-150, 14, 75, 63, 3],
    "downtown-aerial": [900, 450, -700, 229, -17],
  },
};

interface FrameStats {
  frames: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  meanMs: number;
  /** Counted by wrapping WebGL draw calls (works with any renderer), median per frame. */
  glDrawCalls: number;
  glTriangles: number;
}

interface FrameSample {
  ms: number;
  calls: number;
  tris: number;
}

/**
 * Count every WebGL draw call and the triangles it submits, renderer-independently. Installed
 * before the page's own scripts; read as window.__glCount.
 */
function installGlCounter(): void {
  const counter = { calls: 0, tris: 0 };
  (window as unknown as { __glCount: typeof counter }).__glCount = counter;
  const tris = (mode: number, count: number): number => (mode === 4 ? count / 3 : mode === 5 || mode === 6 ? Math.max(0, count - 2) : 0);
  const wrap = (proto: object, name: string, countArg: number, instArg: number): void => {
    const p = proto as Record<string, unknown>;
    const orig = p[name];
    if (typeof orig !== "function") return;
    p[name] = function (this: unknown, ...args: number[]) {
      counter.calls++;
      counter.tris += tris(args[0]!, args[countArg]!) * (instArg >= 0 ? (args[instArg] ?? 1) : 1);
      return (orig as (...a: unknown[]) => unknown).apply(this, args);
    };
  };
  for (const ctx of [globalThis.WebGLRenderingContext, globalThis.WebGL2RenderingContext]) {
    if (!ctx) continue;
    wrap(ctx.prototype, "drawArrays", 2, -1);
    wrap(ctx.prototype, "drawElements", 1, -1);
    wrap(ctx.prototype, "drawArraysInstanced", 2, 3);
    wrap(ctx.prototype, "drawElementsInstanced", 1, 4);
    wrap(ctx.prototype, "drawRangeElements", 3, -1);
  }
}

interface ViewReport extends FrameStats {
  settleMs: number;
  settled: boolean;
  render: RenderInfoLike | null;
}

interface WorldReport {
  bootMs: number;
  /** Mean wall time of one sim tick (p1 at full throttle, stepped while paused). */
  simMsPerTick: number;
  jsHeapMB: number | null;
  views: Record<string, ViewReport>;
}

function quantile(values: number[], f: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(f * s.length))] ?? 0;
}

function summarise(samples: FrameSample[]): FrameStats {
  const ms = samples.map((s) => s.ms);
  const round = (v: number): number => Math.round(v * 10) / 10;
  return {
    frames: ms.length,
    medianMs: round(quantile(ms, 0.5)),
    p95Ms: round(quantile(ms, 0.95)),
    maxMs: round(Math.max(0, ...ms)),
    meanMs: round(ms.reduce((a, b) => a + b, 0) / Math.max(1, ms.length)),
    glDrawCalls: quantile(samples.map((s) => s.calls), 0.5),
    glTriangles: Math.round(quantile(samples.map((s) => s.tris), 0.5)),
  };
}

/** Per-frame wall time and GL work over up to `maxFrames` frames or `maxMs` of wall time. */
async function sampleFrames(page: Page, maxFrames = 60, maxMs = 4000): Promise<FrameSample[]> {
  return page.evaluate(
    ({ maxFrames, maxMs }) =>
      new Promise<FrameSample[]>((done) => {
        const gl = (window as unknown as { __glCount?: { calls: number; tris: number } }).__glCount ?? { calls: 0, tris: 0 };
        const out: FrameSample[] = [];
        let last = -1;
        let calls = gl.calls;
        let tris = gl.tris;
        const t0 = performance.now();
        const tick = (now: number): void => {
          if (last >= 0) out.push({ ms: now - last, calls: gl.calls - calls, tris: gl.tris - tris });
          last = now;
          calls = gl.calls;
          tris = gl.tris;
          if (out.length >= maxFrames || now - t0 >= maxMs) done(out);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    { maxFrames, maxMs },
  );
}

async function measureView(page: Page): Promise<ViewReport> {
  const t0 = Date.now();
  const settled = await settle(page, 60_000);
  const settleMs = Date.now() - t0;
  // Let shader compiles and uploads from the move finish before sampling.
  await sampleFrames(page, 5, 2000);
  const stats = summarise(await sampleFrames(page));
  return { ...stats, settleMs, settled, render: await renderInfo(page) };
}

async function measureWorld(page: Page, world: string): Promise<WorldReport> {
  const t0 = Date.now();
  await bootWorld(page, world);
  const bootMs = Date.now() - t0;
  const views: Record<string, ViewReport> = { spawn: await measureView(page) };
  if ((await features(page)).flyTo) {
    for (const [name, v] of Object.entries(VIEWS[world] ?? {})) {
      await page.evaluate((a) => (window as unknown as FogWindow).__fogcity!.flyTo!(a[0], a[1], a[2], a[3], a[4]), v);
      views[name] = await measureView(page);
    }
  }
  const simMsPerTick = await page.evaluate((input) => {
    const h = (window as unknown as FogWindow).__fogcity!;
    h.pause();
    const t = performance.now();
    h.stepN(600, input);
    return (performance.now() - t) / 600;
  }, THROTTLE);
  const jsHeapMB = await page.evaluate(() => {
    const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return m ? Math.round(m.usedJSHeapSize / 1e5) / 10 : null;
  });
  return { bootMs, simMsPerTick: Math.round(simMsPerTick * 1000) / 1000, jsHeapMB, views };
}

test("perf probe: frame times, draw calls and triangles per world (report only)", async ({ page, browserName }) => {
  test.setTimeout(420_000);
  await page.addInitScript(installGlCounter);
  const report = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    note: "SwiftShader software WebGL: compare runs on the same machine; never a pass/fail gate.",
    environment: {
      browser: browserName,
      userAgent: "",
      gl: null as { vendor: string; renderer: string } | null,
      viewport: page.viewportSize(),
      cpus: cpus().length,
      cpuModel: cpus()[0]?.model ?? "unknown",
      node: process.version,
      ci: Boolean(process.env.CI),
    },
    worlds: {} as Record<string, WorldReport>,
    skipped: {} as Record<string, string>,
    errors: {} as Record<string, string>,
  };
  const write = (): void => {
    mkdirSync(join(ROOT, "test-results"), { recursive: true });
    writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
  };

  for (const world of ["dev", "dev-city", "sf"]) {
    if (!worldExists(world)) {
      report.skipped[world] = `public/tiles/${world}/manifest.json is absent`;
      continue;
    }
    await test.step(world, async () => {
      try {
        report.worlds[world] = await measureWorld(page, world);
      } catch (err) {
        // Report, don't gate: other specs own correctness. The dev world must always measure.
        report.errors[world] = err instanceof Error ? err.message : String(err);
        if (world === "dev") throw err;
      }
      write();
    });
  }

  report.environment.userAgent = await page.evaluate(() => navigator.userAgent);
  report.environment.gl = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2") ?? document.createElement("canvas").getContext("webgl");
    if (!gl) return null;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return ext
      ? { vendor: String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)), renderer: String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) }
      : { vendor: String(gl.getParameter(gl.VENDOR)), renderer: String(gl.getParameter(gl.RENDERER)) };
  });
  write();

  const rows = Object.entries(report.worlds).flatMap(([w, r]) =>
    Object.entries(r.views).map(([v, s]) => ({
      view: `${w}/${v}`,
      "median ms": s.medianMs,
      "p95 ms": s.p95Ms,
      "draw calls": s.render?.drawCalls ?? s.glDrawCalls,
      triangles: s.render?.triangles ?? s.glTriangles,
      "gl calls": s.glDrawCalls,
      "gl tris": s.glTriangles,
      tiles: s.render?.tilesLoaded ?? "-",
      "sim ms/tick": r.simMsPerTick,
    })),
  );
  console.log(`perf (${report.environment.gl?.renderer ?? "unknown GL"}) -> ${OUT}`);
  console.table(rows);
  await test.info().attach("perf.json", { path: OUT, contentType: "application/json" });
});
