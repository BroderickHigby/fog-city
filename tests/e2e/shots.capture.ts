// `pnpm shots` (config: tests/e2e/shots.config.ts). Boots each world that exists and saves
// screenshots from fixed camera positions to test-results/shots/<id>.png, plus index.json and
// an index.html contact sheet. Uses window.__fogcity.flyTo() when the renderer has it;
// without it only the spawn (chase camera) view can be taken, and the rest are listed as
// skipped. A world that is absent is skipped with a reason, never an error.
//
// Street-level SF views snap to the named street in roads.json, and the Salesforce Tower view
// aims at the tallest collider near the tower's address, so the shots stay framed when the
// data moves by a few metres.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type Page } from "@playwright/test";
import { toLocal } from "../../src/geo/project.ts";
import { groundHeight, type World } from "../../src/sim/index.ts";
import { ROOT, loadWorld, worldExists, type RoadGraphFile, type WorldManifest } from "../helpers.ts";
import {
  bootWorld,
  distanceToPolyline,
  features,
  frames,
  newSharedPage,
  renderInfo,
  settle,
  type FogWindow,
  type RenderInfoLike,
} from "./fixtures.ts";
import { decodePng, imageStats, looksDrawn, type ImageStats } from "./png.ts";

const DIR = join(ROOT, "test-results", "shots");

interface Point {
  x: number;
  z: number;
  /** Metres above the ground at (x, z). */
  up: number;
}

interface Shot {
  id: string;
  title: string;
  /** Camera and look-at point; omitted = the default chase camera at the spawn. */
  from?: Point;
  at?: Point;
  night?: boolean;
}

interface Entry {
  id: string;
  world: string;
  title: string;
  file: string | null;
  skipped?: string;
  camera?: { x: number; y: number; z: number; yawDeg: number; pitchDeg: number } | "chase";
  settled?: boolean;
  ms?: number;
  stats?: ImageStats;
  blank?: boolean;
  render?: RenderInfoLike | null;
  problems?: string[];
}

interface Ctx {
  world: World;
  manifest: WorldManifest;
  roads: RoadGraphFile | null;
}

/** Ahead of `p` along compass `headingDeg` by `m` metres. */
function ahead(p: { x: number; z: number }, headingDeg: number, m: number, up: number): Point {
  const h = (headingDeg * Math.PI) / 180;
  return { x: p.x + Math.sin(h) * m, z: p.z - Math.cos(h) * m, up };
}

/**
 * The point on the street called `name` nearest to `near`, and the street's compass heading
 * there, oriented towards `toward` when given.
 */
function onStreet(ctx: Ctx, name: RegExp, near: { x: number; z: number }, toward?: { x: number; z: number }) {
  let best: { x: number; z: number; heading: number; d: number } | null = null;
  for (const e of ctx.roads?.edges ?? []) {
    if (!name.test(e.name ?? "")) continue;
    for (let i = 1; i < e.points.length; i++) {
      const a = e.points[i - 1]!;
      const b = e.points[i]!;
      const d = distanceToPolyline(near.x, near.z, [a, b]);
      if (best && d >= best.d) continue;
      const ex = b[0] - a[0];
      const ez = b[1] - a[1];
      const len2 = ex * ex + ez * ez || 1;
      const t = Math.max(0, Math.min(1, ((near.x - a[0]) * ex + (near.z - a[1]) * ez) / len2));
      let heading = (Math.atan2(ex, -ez) * 180) / Math.PI;
      if (toward) {
        const fx = Math.sin((heading * Math.PI) / 180);
        const fz = -Math.cos((heading * Math.PI) / 180);
        if ((toward.x - near.x) * fx + (toward.z - near.z) * fz < 0) heading += 180;
      }
      best = { x: a[0] + ex * t, z: a[1] + ez * t, heading: (heading + 360) % 360, d };
    }
  }
  // Within a block of the intended spot, or the street is not in the data.
  return best && best.d < 120 ? best : null;
}

/** Centroid of the tallest building with a vertex within `r` metres of `near`. */
function tallestNear(ctx: Ctx, near: { x: number; z: number }, r: number): { x: number; z: number; height: number } | null {
  let best: { x: number; z: number; height: number } | null = null;
  for (const t of ctx.world.tiles) {
    for (const b of t.buildings) {
      if (!b.footprint.some(([x, z]) => Math.hypot(x - near.x, z - near.z) < r)) continue;
      const height = b.topY - b.baseY;
      if (best && height <= best.height) continue;
      const n = b.footprint.length;
      best = {
        x: b.footprint.reduce((s, p) => s + p[0], 0) / n,
        z: b.footprint.reduce((s, p) => s + p[1], 0) / n,
        height,
      };
    }
  }
  return best;
}

function shotsFor(name: string, ctx: Ctx): Array<Shot | { id: string; title: string; skipped: string }> {
  const s = ctx.manifest.spawn;
  const hDeg = (s.heading * 180) / Math.PI;
  const spawn: Shot = { id: `${name}-spawn`, title: `${name}: the player's view at the spawn (chase camera)` };
  const street: Shot = {
    id: `${name}-street`,
    title: `${name}: street level behind the spawn, looking along its heading`,
    from: ahead(s, hDeg, -20, 3),
    at: ahead(s, hDeg, 200, 3),
  };
  if (name === "dev") {
    return [spawn, { id: "dev-overview", title: "dev: overview from the south-east", from: { x: 70, z: 110, up: 55 }, at: { x: 0, z: -20, up: 5 } }];
  }
  if (name !== "sf") {
    return [
      spawn,
      street,
      {
        id: `${name}-overview`,
        title: `${name}: overview from above the spawn`,
        from: { x: s.x + 180, z: s.z + 300, up: 160 },
        at: { x: s.x, z: s.z - 200, up: 0 },
      },
    ];
  }

  const out: Array<Shot | { id: string; title: string; skipped: string }> = [spawn];
  const ferry = { x: 0, z: 0 };
  out.push({
    id: "sf-ferry-building-embarcadero",
    title: "Ferry Building from the Embarcadero, facing its main facade",
    // 120 m out on bearing 240 from the clock tower: the plaza where Market meets the Embarcadero.
    from: ahead(ferry, 240, 120, 3),
    at: { ...ferry, up: 18 },
  });
  const market = onStreet(ctx, /^market\b/i, toLocal(37.7894, -122.4013), ferry);
  const marketShot = market
    ? { from: { x: market.x, z: market.z, up: 3 }, at: { ...ferry, up: 25 } }
    : { from: { ...toLocal(37.7894, -122.4013), up: 3 }, at: { ...ferry, up: 25 } };
  out.push({ id: "sf-market-street", title: "Market Street at Montgomery, looking to the Ferry Building", ...marketShot });
  const tower = tallestNear(ctx, toLocal(37.78971, -122.39701), 120);
  if (tower) {
    const from = { ...toLocal(37.7914, -122.395), up: 2 };
    out.push({
      id: "sf-salesforce-tower-base",
      title: `Salesforce Tower base from Mission St (tallest collider there: ${tower.height.toFixed(0)} m)`,
      from,
      at: { x: tower.x, z: tower.z, up: 100 },
    });
  } else {
    out.push({ id: "sf-salesforce-tower-base", title: "Salesforce Tower base", skipped: "no building near the tower's address in the colliders" });
  }
  const columbus = onStreet(ctx, /^columbus\b/i, toLocal(37.79866, -122.40706), toLocal(37.8011, -122.4103));
  if (columbus) {
    out.push({
      id: "sf-north-beach-columbus",
      title: "North Beach: Columbus Avenue at Vallejo, looking north-west",
      from: { x: columbus.x, z: columbus.z, up: 3 },
      at: ahead(columbus, columbus.heading, 250, 6),
    });
  } else {
    out.push({
      id: "sf-north-beach-columbus",
      title: "North Beach: Columbus Avenue at Vallejo, looking north-west",
      from: { ...toLocal(37.79866, -122.40706), up: 3 },
      at: ahead(toLocal(37.79866, -122.40706), 316, 250, 6),
    });
  }
  const marina = toLocal(37.8063, -122.4417);
  out.push({
    id: "sf-marina-green",
    title: "Marina Green, looking south over the Marina",
    from: { ...marina, up: 30 },
    at: ahead(marina, 200, 350, 0),
  });
  out.push({ id: "sf-market-street-night", title: "Market Street at night", ...marketShot, night: true });
  out.push({ id: "sf-downtown-aerial", title: "Downtown from over the bay", from: { x: 900, z: -700, up: 450 }, at: { x: -700, z: 700, up: 0 } });
  return out;
}

function camera(world: World, from: Point, at: Point) {
  const y = groundHeight(world, from.x, from.z) + from.up;
  const ty = groundHeight(world, at.x, at.z) + at.up;
  const dx = at.x - from.x;
  const dz = at.z - from.z;
  const yawDeg = (((Math.atan2(dx, -dz) * 180) / Math.PI) + 360) % 360;
  const pitchDeg = (Math.atan2(ty - y, Math.hypot(dx, dz)) * 180) / Math.PI;
  const r = (v: number): number => Math.round(v * 100) / 100;
  return { x: r(from.x), y: r(y), z: r(from.z), yawDeg: r(yawDeg), pitchDeg: r(pitchDeg) };
}

async function capture(page: Page, world: string, ctx: Ctx, shot: Shot, problems: string[]): Promise<Entry> {
  const t0 = Date.now();
  const have = await features(page);
  const entry: Entry = { id: shot.id, world, title: shot.title, file: null };
  if (shot.from && shot.at) {
    if (!have.flyTo) return { ...entry, skipped: "window.__fogcity.flyTo() is not available in this renderer" };
    const cam = camera(ctx.world, shot.from, shot.at);
    entry.camera = cam;
    await page.evaluate((c) => (window as unknown as FogWindow).__fogcity!.flyTo!(c.x, c.y, c.z, c.yawDeg, c.pitchDeg), cam);
  } else {
    entry.camera = "chase";
    if (have.setCameraMode) await page.evaluate(() => (window as unknown as FogWindow).__fogcity!.setCameraMode!("chase"));
  }
  if (have.setNight) await page.evaluate((n) => (window as unknown as FogWindow).__fogcity!.setNight!(n), shot.night === true);
  else if (shot.night) return { ...entry, skipped: "window.__fogcity.setNight() is not available in this renderer" };

  const before = problems.length;
  entry.settled = await settle(page, 120_000);
  await frames(page, 4);
  const file = `${shot.id}.png`;
  const png = await page.screenshot({ path: join(DIR, file) });
  entry.file = file;
  entry.stats = imageStats(decodePng(png), 5);
  entry.blank = !looksDrawn(entry.stats);
  entry.render = await renderInfo(page);
  entry.ms = Date.now() - t0;
  entry.problems = problems.slice(before);
  return entry;
}

function writeIndex(): void {
  const entries: Entry[] = [];
  for (const f of readdirSync(DIR).sort()) {
    if (f.endsWith(".json") && f !== "index.json") entries.push(...(JSON.parse(readFileSync(join(DIR, f), "utf8")) as Entry[]));
  }
  writeFileSync(join(DIR, "index.json"), JSON.stringify({ generatedAt: new Date().toISOString(), shots: entries }, null, 2) + "\n");
  const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const cards = entries
    .map((e) => {
      const cam = e.camera === "chase" ? "chase camera at spawn" : e.camera ? `x ${e.camera.x} y ${e.camera.y} z ${e.camera.z} · yaw ${e.camera.yawDeg}° pitch ${e.camera.pitchDeg}°` : "";
      const r = e.render ? `${e.render.drawCalls} draw calls · ${e.render.triangles.toLocaleString("en-US")} triangles · ${e.render.tilesLoaded ?? "?"} tiles` : "";
      const flags = [e.skipped ? `skipped: ${e.skipped}` : "", e.blank ? "BLANK FRAME" : "", e.settled === false ? "tiles not settled" : "", ...(e.problems ?? [])]
        .filter(Boolean)
        .map((f) => `<li>${esc(f)}</li>`)
        .join("");
      const img = e.file ? `<a href="${e.file}"><img src="${e.file}" alt="${esc(e.title)}" loading="lazy"></a>` : `<div class="none">no image</div>`;
      return `<figure>${img}<figcaption><b>${esc(e.title)}</b><span>${esc(e.id)}.png · ${esc(cam)}</span><span>${esc(r)}</span>${flags ? `<ul>${flags}</ul>` : ""}</figcaption></figure>`;
    })
    .join("\n");
  writeFileSync(
    join(DIR, "index.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fog City shots</title>
<style>
:root{--bg:#f4f5f7;--card:#fff;--ink:#1c2026;--muted:#5d6672;--warn:#a3341f}
@media (prefers-color-scheme:dark){:root{--bg:#121519;--card:#1c2026;--ink:#e9edf2;--muted:#9aa4b0;--warn:#ff8a70}}
body{margin:0;padding:16px;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,sans-serif}
h1{font-size:18px;margin:0 0 4px}p{margin:0 0 16px;color:var(--muted)}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,420px),1fr));gap:16px}
figure{margin:0;background:var(--card);border-radius:6px;overflow:hidden}
img{display:block;width:100%;height:auto}.none{aspect-ratio:16/9;display:grid;place-items:center;color:var(--muted)}
figcaption{padding:8px 10px;display:grid;gap:2px}figcaption span{color:var(--muted);font-size:12px}
ul{margin:4px 0 0;padding-left:18px;color:var(--warn);font-size:12px}
</style></head><body><h1>Fog City shots</h1><p>${entries.length} views · SwiftShader software WebGL · generated by <code>pnpm shots</code></p><main>
${cards}
</main></body></html>
`,
  );
}

/** Append one entry to test-results/shots/<file>.json and rebuild the index. */
function record(file: string, e: Entry): void {
  const path = join(DIR, `${file}.json`);
  let list: Entry[] = [];
  try {
    list = JSON.parse(readFileSync(path, "utf8")) as Entry[];
  } catch {
    list = [];
  }
  list = list.filter((x) => x.id !== e.id).concat(e);
  writeFileSync(path, JSON.stringify(list, null, 2) + "\n");
  writeIndex();
  console.log(`  ${e.id}: ${e.skipped ? `skipped (${e.skipped})` : `${e.file}${e.blank ? "  BLANK" : ""}  ${e.ms} ms`}`);
}

// One describe per world, one test per shot, one booted page per world (booting is the slow
// part). A shot that fails or times out costs only itself: the next one re-boots if needed.
for (const name of ["dev", "dev-city", "sf"]) {
  test.describe(name, () => {
    const present = worldExists(name);
    test.skip(!present, `public/tiles/${name}/manifest.json is absent on this checkout`);
    const ctx = present ? loadWorld(name) : null;
    const shots = ctx ? shotsFor(name, ctx) : [{ id: `${name}-spawn`, title: name, skipped: "absent" }];

    let page: Page | undefined;
    let problems: string[] = [];
    test.beforeAll(async ({ browser }, info) => {
      if (!present) return;
      page = await newSharedPage(browser, info.project.use);
      problems = await bootWorld(page, name, "", 150_000);
    });
    test.afterAll(async () => {
      await page?.context().close();
    });

    for (const shot of shots) {
      test(shot.id, async () => {
        const e = "skipped" in shot ? { id: shot.id, world: name, title: shot.title, file: null, skipped: shot.skipped } : await capture(page!, name, ctx!, shot, problems);
        record(name, e);
        test.skip(Boolean(e.skipped), e.skipped ?? "");
      });
    }
  });
}

// SHOT="<world> <x> <z> <yawDeg> <pitchDeg> [metres above ground]" pnpm shots --grep custom
test("custom shot from $SHOT", async ({ page }) => {
  const spec = process.env.SHOT?.trim();
  test.skip(!spec, 'set SHOT="<world> <x> <z> <yawDeg> <pitchDeg> [up]" to take one ad-hoc view');
  const [name, ...nums] = spec!.split(/\s+/);
  const [x, z, yawDeg, pitchDeg, up = 2] = nums.map(Number);
  if (!name || [x, z, yawDeg, pitchDeg, up].some((v) => v === undefined || !Number.isFinite(v))) {
    throw new Error(`SHOT must be "<world> <x> <z> <yawDeg> <pitchDeg> [up]", got "${spec}"`);
  }
  test.skip(!worldExists(name), `public/tiles/${name}/manifest.json is absent on this checkout`);
  const ctx = loadWorld(name);
  const problems = await bootWorld(page, name, "", 120_000);
  const h = ((yawDeg as number) * Math.PI) / 180;
  const p = ((pitchDeg as number) * Math.PI) / 180;
  const from = { x: x as number, z: z as number, up: up as number };
  // A look-at point 100 m out along yaw and pitch reproduces exactly that yaw and pitch.
  const at = { x: from.x + Math.sin(h) * Math.cos(p) * 100, z: from.z - Math.cos(h) * Math.cos(p) * 100, up: from.up + Math.sin(p) * 100 };
  const fromGround = groundHeight(ctx.world, from.x, from.z);
  at.up += fromGround - groundHeight(ctx.world, at.x, at.z);
  record("custom", await capture(page, name, ctx, { id: `custom-${name}`, title: `custom: ${spec}`, from, at }, problems));
});
