// Native avatar diagnosis/acceptance on a separately served packed candidate.
// node --max-old-space-size=2048 scripts/qa/avatar-continuity.ts --artifact /absolute/build \
//   --url http://127.0.0.1:4371/ --out /absolute/evidence [--assert-modern]
// One browser/page, ordinary F/walk controls, real draw identities, no teleports or state edits.
import { chromium, type Browser, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import type { DebugHandle } from "../../src/debug.ts";
import type { SceneRenderer } from "../../src/render/scene.ts";
import type { AgentState } from "../../src/sim/agents.ts";
import type { InputFrame, SimInput, SimState } from "../../src/sim/contract.ts";

const { values } = parseArgs({ options: {
  artifact: { type: "string" }, url: { type: "string" }, out: { type: "string" },
  "expect-sha": { type: "string" }, "allow-stable": { type: "boolean", default: false },
  "assert-modern": { type: "boolean", default: false }, "quality-replay": { type: "boolean", default: false },
  help: { type: "boolean" },
} });
if (values.help) {
  console.log("node --max-old-space-size=2048 scripts/qa/avatar-continuity.ts --artifact /absolute/packed-build --url http://127.0.0.1:4371/ --out /absolute/evidence [--expect-sha SHA] [--assert-modern] [--quality-replay]\nDiagnosis defaults to recording actual model-family failures without accepting them. --assert-modern rejects any visible loaded pedestrian within12m drawn as an old procedural avatar. --allow-stable explicitly permits isolated-profile diagnosis against5173; it never changes that service or the user's browser.");
  process.exit(0);
}
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
assert(values.artifact && values.url && values.out, "--artifact, --url and --out are required; see --help");
assert(getHeapStatistics().heap_size_limit <= 3_000_000_000, "Run Node with --max-old-space-size=2048");
const root = fileURLToPath(new URL("../../", import.meta.url));
const artifact = resolve(values.artifact), out = resolve(values.out), base = new URL(values.url);
assert(["127.0.0.1", "localhost", "[::1]"].includes(base.hostname), "Target a local game only");
assert(base.port !== "5173" || values["allow-stable"], "Use a separate candidate port, or explicitly allow isolated stable-preview diagnosis");
const hash = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const source = () => ({ revision: git("rev-parse", "HEAD"), status: git("status", "--porcelain"), renderSourceSHA256: hash([
  "src/render/agent-layer.ts", "src/render/crowd-humans.ts", "src/render/player-body.ts", "src/render/agent-lod.ts",
].map(file => file + "\0" + readFileSync(join(root, file), "utf8")).join("\0")) });
if (values["expect-sha"]) assert(git("rev-parse", "HEAD").startsWith(values["expect-sha"]), "Source head differs from --expect-sha");
const html = readFileSync(join(artifact, "index.html"), "utf8");
const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)].map(match => match[1]!);
assert(scripts.length > 0, "Packed index has no JavaScript");
const candidate = await Promise.all(["index.html", "assets.index.json", ...scripts].map(async file => {
  const local = readFileSync(resolve(artifact, file.replace(/^\.\//, "")));
  const response = await fetch(new URL(file, base), { signal: AbortSignal.timeout(20_000) });
  assert(response.ok, `HTTP ${response.status}: ${file}`);
  assert(hash(local) === hash(new Uint8Array(await response.arrayBuffer())), `Served ${file} differs from supplied candidate`);
  return { file, bytes: local.length, sha256: hash(local) };
}));
mkdirSync(out, { recursive: true });
const report = {
  startedAt: new Date().toISOString(), base: base.href, artifact, candidate, sourceStart: source(), sourceEnd: null as ReturnType<typeof source> | null,
  scope: "Native packed SF crowd appearance; ordinary F/walk controls and actual draw identity. Camera/quality replay does not edit the simulation. Not FPS, physical RAM, or device-reset acceptance.",
  assertionsEnabled: values["assert-modern"], qualityReplay: values["quality-replay"], viewport: { width: 800, height: 500 },
  browserHeapMB: 1024, deadlineMinutes: 6, stateReplacementCalls: 0, teleports: 0, spawnOverrides: 0,
  errors: [] as string[], warnings: [] as string[], snapshots: [] as unknown[], shots: [] as string[],
  legacyNear: [] as { phase: string; tick: number; id: number; family: string; distance: number }[],
  transitions: [] as unknown[], replay: null as unknown, gpu: null as unknown, checks: [] as string[],
  recorded: false, passed: false, failure: null as string | null,
};
const flush = (): void => writeFileSync(join(out, "proof.json"), JSON.stringify(report, null, 2) + "\n");
type QAWindow = Window & { __fogcity: DebugHandle; __fogcityView: SceneRenderer };
type CrowdView = { loaded: number; drawn: number; group: import("three").Group };
type ObservedLayer = {
  lastCurr?: SimState; pairs: Array<[unknown, AgentState]>; poses: Array<{ x: number; y: number; z: number }>;
  tiers: Uint8Array; nearPeople: number[]; hiddenAgent: number | null; crowd: CrowdView | null;
  people: { body: { mesh: import("three").InstancedMesh } };
  peopleMid: { mesh: import("three").InstancedMesh }; peopleFar: { mesh: import("three").InstancedMesh };
};
let browser: Browser | undefined, page: Page | undefined, rejectFatal!: (reason: Error) => void;
const fatal = new Promise<never>((_, reject) => { rejectFatal = reject; }); void fatal.catch(() => {});
const checked = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, fatal]);
const fail = (message: string): void => { if (report.errors.length < 25) report.errors.push(message); rejectFatal(new Error(message)); };
const deadline = setTimeout(() => fail("Avatar QA exceeded its six-minute bound"), 6 * 60_000);
async function rendered(n = 3): Promise<void> {
  await checked(page!.evaluate(n => new Promise<void>((done, reject) => {
    const timer = setTimeout(() => reject(new Error("No normal rendered frame within30s")), 30_000);
    const frame = (): void => { if (--n <= 0) { clearTimeout(timer); done(); } else requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
  }), n));
  await checked(page!.waitForFunction(() => {
    const w = window as unknown as QAWindow, layer = w.__fogcityView.agents as unknown as ObservedLayer;
    return layer.lastCurr?.tick === w.__fogcity.state().tick;
  }, null, { timeout: 20_000, polling: "raf" }));
}
async function boot(gfx: "high" | "low"): Promise<{ hash: string; version: number }> {
  const url = new URL(base);
  for (const [key, value] of Object.entries({ world: "sf", seed: "1", renderer: "webgl", gfx, quality: gfx === "high" ? "1" : "0", shadows: "0", pr: "0.75", radius: "200", debug: "1", capture: "1", cam: "chase", tod: "golden" })) url.searchParams.set(key, value);
  await checked(page!.goto(url.href, { waitUntil: "domcontentloaded", timeout: 30_000 }));
  await checked(page!.waitForFunction(() => (window as unknown as QAWindow).__fogcity?.ready, null, { timeout: 60_000 }));
  await checked(page!.evaluate(() => (window as unknown as QAWindow).__fogcity.pause()));
  await checked(page!.waitForFunction(() => {
    const r = (window as unknown as QAWindow).__fogcity.renderInfo() as unknown as { crowdLoaded: number; graphicsError?: string };
    return r.crowdLoaded === 12 && !r.graphicsError;
  }, null, { timeout: 60_000 }));
  await rendered();
  const initial = await checked(page!.evaluate(() => {
    const w = window as unknown as QAWindow, h = w.__fogcity, s = h.state(), r = h.renderInfo();
    const gl = w.__fogcityView.renderer.getContext() as WebGL2RenderingContext, e = gl.getExtension("WEBGL_debug_renderer_info");
    return { hash: h.hash(), version: s.version, tick: s.tick, seed: s.seed, sim: h.simInfo(), render: r,
      gpu: { renderer: String(gl.getParameter(e?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER)), error: gl.getError() } };
  }));
  assert(initial.tick === 0 && initial.seed === 1, "Expected fresh paused seed1");
  assert(initial.sim.assets === "packed" && initial.render.backend === "webgl-node", "Expected actual packed node-WebGL game");
  assert(/Apple|Metal/i.test(initial.gpu.renderer) && !/SwiftShader|Software|llvmpipe/i.test(initial.gpu.renderer), "Expected native Apple/Metal");
  assert(initial.gpu.error === 0, "GPU error at boot"); report.gpu = initial.gpu; flush(); return initial;
}
const histories = new Map<string, { phase: string; family: string; character: string | null }>();
async function snapshot(phase: string): Promise<void> {
  await rendered(5);
  const result = await checked(page!.evaluate(phase => {
    const w = window as unknown as QAWindow, h = w.__fogcity, before = h.hash(), state = h.state(), view = w.__fogcityView;
    const layer = view.agents as unknown as ObservedLayer, player = state.players.p1!;
    const active = player.mode === "foot" && player.foot ? player.foot : player.ride ?? player.car;
    const modern = new Map<number, { character: string | null; root: string; skinned: number; meshes: number }>();
    layer.crowd?.group.traverseVisible(object => {
      const match = /^player-body:(\d+)$/.exec(object.name); if (!match) return;
      let skinned = 0, meshes = 0;
      object.traverseVisible(child => { const mesh = child as import("three").SkinnedMesh; if (mesh.isMesh) meshes++; if (mesh.isSkinnedMesh) skinned++; });
      modern.set(Number(match[1]), { character: object.parent?.name ?? null, root: object.uuid, skinned, meshes });
    });
    const nearIds = layer.nearPeople.map(i => layer.pairs[i]![1].id);
    const fallbackIds = nearIds.filter(id => !modern.has(id));
    const fallback = layer.people.body.mesh, mid = layer.peopleMid.mesh, far = layer.peopleFar.mesh;
    if (fallback.count !== fallbackIds.length) throw new Error(`Procedural count/identity mismatch: ${fallback.count}/${fallbackIds.length}`);
    const point = active && view.camera.position.clone(), matrix = view.camera.matrix.clone();
    const validate = (mesh: import("three").InstancedMesh, ids: number[]): void => {
      if (mesh.count !== ids.length) throw new Error(`Actual ${mesh.name} roster count ${mesh.count}/${ids.length}`);
      ids.forEach((id, index) => { const i = layer.pairs.findIndex(pair => pair[1].id === id), pose = layer.poses[i]!;
        mesh.getMatrixAt(index, matrix); point.setFromMatrixPosition(matrix);
        if (Math.hypot(point.x - pose.x, point.z - pose.z) > .05) throw new Error(`Actual ${mesh.name} instance ${index} does not match person${id}`);
      });
    };
    validate(fallback, fallbackIds);
    const tierIds = (tier: number): number[] => layer.pairs.flatMap((pair, i) => pair[1].kind === "person" && pair[1].id !== layer.hiddenAgent && layer.tiers[i] === tier ? [pair[1].id] : []);
    validate(mid, tierIds(2)); validate(far, tierIds(1));
    const people = layer.pairs.flatMap((pair, i) => {
      const a = pair[1]; if (a.kind !== "person" || a.id === layer.hiddenAgent) return [];
      const pose = layer.poses[i]!, m = modern.get(a.id), tier = layer.tiers[i]!;
      point.set(pose.x, pose.y + .9, pose.z).project(view.camera);
      const onscreen = point.z >= -1 && point.z <= 1 && Math.abs(point.x) <= .95 && Math.abs(point.y) <= .95;
      const family = m ? "modern-skinned" : fallbackIds.includes(a.id) ? "procedural-near" : tier === 2 ? "procedural-mid" : tier === 1 ? "procedural-far" : "hidden";
      return [{ id: a.id, tier, family, character: m?.character ?? null, root: m?.root ?? null, skinned: m?.skinned ?? 0,
        meshes: m?.meshes ?? 0, distance: Math.hypot(pose.x - active.x, pose.z - active.z), onscreen, pose }];
    });
    const result = { phase, tick: state.tick, hash: before, mode: player.mode, cameraMode: view.rig.mode, camera: view.camera.position.toArray(), player: active,
      modernIds: [...modern.keys()], nearIds, fallbackIds, actualFallbackCount: fallback.count, people, render: h.renderInfo() };
    if (h.hash() !== before) throw new Error("Read-only crowd inspection changed simulation"); return result;
  }, phase));
  report.snapshots.push(result);
  assert(result.render.agentDrawCalls <= 27, `Agent draw allocation exceeded27: ${result.render.agentDrawCalls}`);
  for (const p of result.people.filter(p => p.onscreen && p.distance <= 12 && p.family !== "hidden")) {
    const key = String(p.id), previous = histories.get(key);
    if (previous && (previous.family !== p.family || previous.character !== p.character)) report.transitions.push({ id: p.id, previous, current: { phase, family: p.family, character: p.character } });
    histories.set(key, { phase, family: p.family, character: p.character });
    if (p.family.startsWith("procedural")) report.legacyNear.push({ phase, tick: result.tick, id: p.id, family: p.family, distance: p.distance });
  }
  const shot = phase.replace(/[^a-z0-9-]/gi, "-") + ".png";
  await checked(page!.screenshot({ path: join(out, shot), timeout: 20_000 })); report.shots.push(shot); flush();
}

try {
  browser = await checked(chromium.launch({ headless: true, timeout: 25_000, args: ["--use-gl=angle", "--use-angle=metal", "--js-flags=--max-old-space-size=1024", "--disable-background-timer-throttling", "--disable-renderer-backgrounding"] }));
  page = await checked(browser.newPage({ viewport: report.viewport, deviceScaleFactor: 1 })); page.setDefaultTimeout(25_000);
  page.on("pageerror", error => fail(error.message)); page.on("crash", () => fail("Browser renderer crashed"));
  page.on("console", message => { if (message.type() === "error") fail(message.text()); else if (message.type() === "warning" && report.warnings.length < 20) report.warnings.push(message.text()); });
  page.on("response", response => { if (response.status() >= 400) fail(`HTTP ${response.status()}: ${response.url()}`); });
  const initial = await boot("high"), inputs: InputFrame[] = [], neutral: SimInput = { throttle: 0, steer: 0, brake: 0, actions: 0 };
  const step = async (input: SimInput, n: number): Promise<void> => { const frames = Array.from({ length: n }, () => ({ p1: input })); inputs.push(...frames); await checked(page!.evaluate(frames => (window as unknown as QAWindow).__fogcity.stepFrames(frames), frames)); await rendered(2); };
  await step({ ...neutral, actions: 1 }, 1);
  assert(await checked(page.evaluate(() => (window as unknown as QAWindow).__fogcity.state().players.p1!.mode === "foot")), "Ordinary F exit did not succeed");
  let targetId = -1, close = false;
  for (let batch = 0; batch < 180; batch++) {
    const next = await checked(page.evaluate(targetId => {
      const state = (window as unknown as QAWindow).__fogcity.state(), foot = state.players.p1!.foot!;
      const people = state.ext.agents!.list.filter(a => a.kind === "person");
      const target = people.find(a => a.id === targetId) ?? people.sort((a, b) => Math.hypot(a.x - foot.x, a.z - foot.z) - Math.hypot(b.x - foot.x, b.z - foot.z))[0];
      if (!target) throw new Error("No ordinary existing person to approach");
      let angle = Math.atan2(target.x - foot.x, -(target.z - foot.z)) - foot.heading;
      while (angle > Math.PI) angle -= 2 * Math.PI; while (angle < -Math.PI) angle += 2 * Math.PI;
      return { id: target.id, distance: Math.hypot(target.x - foot.x, target.z - foot.z), angle };
    }, targetId));
    targetId = next.id;
    if (next.distance <= 4.5) { close = true; break; }
    await step({ ...neutral, throttle: Math.abs(next.angle) > 1 ? 0 : 1, steer: Math.max(-1, Math.min(1, next.angle / .25)) }, 6);
  }
  assert(close, "Ordinary bounded walk never approached the existing person within4.5m");
  await step(neutral, 1); await snapshot("high-chase");
  const finalHash = await checked(page.evaluate(() => (window as unknown as QAWindow).__fogcity.hash()));
  for (const camera of ["first-person", "chase"] as const) { await checked(page.evaluate(camera => (window as unknown as QAWindow).__fogcity.setCameraMode(camera), camera)); await snapshot(`high-${camera}-return`); }
  if (values["quality-replay"]) {
    const low = await boot("low"); assert(low.hash === initial.hash, "Low graphics boot changed initial simulation");
    for (let i = 0; i < inputs.length; i += 32) { await checked(page.evaluate(frames => (window as unknown as QAWindow).__fogcity.stepFrames(frames), inputs.slice(i, i + 32))); await rendered(1); }
    assert(await checked(page.evaluate(() => (window as unknown as QAWindow).__fogcity.hash())) === finalHash, "Quality-only replay diverged");
    await snapshot("low-chase");
    for (const camera of ["first-person", "chase"] as const) { await checked(page.evaluate(camera => (window as unknown as QAWindow).__fogcity.setCameraMode(camera), camera)); await snapshot(`low-${camera}-return`); }
  }
  report.replay = { frames: inputs.length, initialHash: initial.hash, finalHash, targetId };
  writeFileSync(join(out, "controls.json"), JSON.stringify({ world: "sf", seed: 1, version: initial.version, frames: inputs, expectedFinalHash: finalHash, targetId }) + "\n");
  report.recorded = true; report.sourceEnd = source();
  assert(report.sourceEnd.renderSourceSHA256 === report.sourceStart.renderSourceSHA256, "Crowd source changed during QA");
  if (values["assert-modern"]) { assert(histories.size > 0, "No on-screen person within12m was measured"); assert(report.legacyNear.length === 0, `Loaded close pedestrians reverted to old avatars: ${JSON.stringify(report.legacyNear)}`); }
  report.passed = Boolean(values["assert-modern"]) && report.errors.length === 0;
  report.checks.push("Packed served bytes, native Apple/Metal, loaded crowd, actual same-tick draw rosters and27-call cap verified");
  report.checks.push(`Recorded${inputs.length} ordinary input frames; ${histories.size} nearby visible IDs; ${report.legacyNear.length} legacy near appearances`);
} catch (error) { report.failure = String(error instanceof Error ? error.stack : error); process.exitCode = 1; }
finally {
  clearTimeout(deadline); await browser?.close().catch(() => {}); flush();
  writeFileSync(join(out, "index.html"), `<!doctype html><meta charset="utf-8"><title>Fog City avatar continuity</title><style>body{font:15px system-ui;margin:24px;background:#182026;color:#eee}main{display:flex;flex-wrap:wrap;gap:12px}img{width:640px;max-width:100%}a{color:#aee}pre{white-space:pre-wrap}</style><h1>Avatar continuity — ${report.passed ? "passed" : report.recorded ? "diagnosis recorded" : "failed"}</h1><p>${report.scope}</p><p><a href="proof.json">Proof</a> · <a href="controls.json">Ordinary inputs</a></p><main>${report.shots.map(file => `<a href="${file}"><img src="${file}" alt="${file}"></a>`).join("")}</main><pre>${report.failure ?? report.checks.join("\n")}</pre>`);
  console.log(JSON.stringify({ passed: report.passed, recorded: report.recorded, legacyNear: report.legacyNear.length, out, failure: report.failure }));
}
