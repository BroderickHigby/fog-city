// Boot: load a world manifest, the whole world's colliders (the citywide collider pack when
// the manifest names one, else every tile's collider JSON), the road graph and the world's
// edge (the sim needs the whole world for determinism: src/io/world-load.ts), build the sim
// world once behind the loading text (the road graph's clearance sampling takes ~0.2 s for a
// small world, ~1.5 s citywide; never per frame), then run a fixed-timestep loop and render
// interpolated poses: players, and the sim's ambient agents (robotaxis, robots, people).
// Render tiles stream in and out around the camera without ever blocking the loop; the far
// skyline is drawn beyond them.
//
// Files come through src/io/assets.ts: loose files from the dev server, or the packed layout
// of a production build (pnpm build), always relative to the page.
//
// URL parameters:
//   ?world=dev | dev-city | sf   world directory under public/tiles/ (default dev; a production
//                                build opens its default world, sf)
//   &radius=1500                 tile load radius, metres
//   &night=1                     start at night (KeyN toggles the look; the clock starts at 22:40)
//   &shadows=1                   sun shadows (off by default for performance)
//   &pr=1.5                      cap on devicePixelRatio
//   &cam=chase|first-person|fly  starting camera
//
// Keys: WASD/arrows drive (or walk), Space brake (sprint on foot); F enter/exit, E fire,
// Q scan, H horn (sim actions). Render only: C chase/first-person, V free fly camera (WASD
// move, Space/Shift up/down, arrows or mouse drag look, wheel speed, right Shift boost), N night.

import { houseKit as houseKitDoc, landmarks as landmarksDoc, models } from "virtual:fogcity-assets";
import { installDebugHandle } from "./debug.ts";
import { openAssets } from "./io/assets.ts";
import { loadWorldFiles } from "./io/world-load.ts";
import { Keyboard } from "./input/keyboard.ts";
import { PointerLook } from "./input/pointer.ts";
import type { CarPose, WalkerPose } from "./render/actors.ts";
import { NO_FLY_INPUT, type CameraMode, type CameraTarget, type FlyInput } from "./render/cameras.ts";
import { clockStartMinute, gameMinuteOfDay } from "./render/clock.ts";
import { Hud, exitHint, type HudData } from "./render/hud.ts";
import { SceneRenderer } from "./render/scene.ts";
import { parseGfxRequest } from "./render/gfx.ts";
import type { SidewalkGraph } from "./render/sidewalks.ts";
import { HouseColours, houseLookFn, type DistrictsLike } from "./render/house-colours.ts";
import type { StorefrontAnchor } from "./render/house-kit-props.ts";
import type { Manifest, RoadGraph } from "./render/types.ts";
import {
  Action,
  DT,
  NEUTRAL_INPUT,
  activeBody,
  agentsOf,
  buildWorld,
  createInitialState,
  groundHeight,
  hashState,
  nearbyBuildings,
  pointInPolygon,
  sortedIds,
  step,
  wrapAngle,
  type InputFrame,
  type SimEvent,
  type SimInput,
  type SimState,
  type TileCollider,
} from "./sim/index.ts";

const LOCAL_PLAYER = "p1";
const SEED = 1;
/** The sim catches up at most this much per frame (a slow frame slows the game, never jumps it). */
const MAX_FRAME_S = 0.25;
const CAMERA_MODES: readonly CameraMode[] = ["chase", "first-person", "fly"];

function numParam(p: URLSearchParams, k: string): number | null {
  const v = p.get(k);
  if (v === null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Let the browser paint the loading text before a long synchronous step: a timeout queued
 * from inside an animation frame runs after that frame is painted. A hidden tab runs no
 * animation frames, so a fallback timer keeps boot from waiting for the tab to be shown.
 */
function paint(): Promise<void> {
  return new Promise((done) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      done();
    };
    requestAnimationFrame(() => setTimeout(finish, 0));
    setTimeout(finish, 250);
  });
}

interface PlayerPoses {
  car: CarPose;
  foot: WalkerPose;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

async function boot(): Promise<void> {
  // Since navigation start: module loading counts too.
  const tStart = 0;
  const params = new URLSearchParams(location.search);
  const loading = document.getElementById("hud");
  const status = (text: string): void => {
    if (loading) loading.textContent = text;
  };
  // A production build (pnpm build) reads its packed layout; the dev server serves loose files.
  const assets = await openAssets(import.meta.env.PROD);
  const worldName = params.get("world") ?? assets.defaultWorld ?? "dev";
  if (assets.worlds && !assets.worlds.includes(worldName)) {
    throw new Error(`world "${worldName}" is not in this build (it has ${assets.worlds.join(", ")})`);
  }
  const base = `tiles/${worldName}/`;
  status(`loading ${worldName}…`);
  // The colliders, road graph and boundary are all part of the deterministic world (the road
  // graph drives the ambient agents, the boundary walls stop cars at the edge): a client that
  // cannot load one its manifest names must not run a different world beside its peers, so
  // boot fails.
  const tLoad = performance.now();
  const files = await loadWorldFiles<Manifest>(assets, worldName);
  const loadMs = performance.now() - tLoad;
  const { manifest, tiles } = files;
  const roads = files.roads as RoadGraph | null;
  // Once, at load: with the road graph the sim runs ambient traffic (state.ext.agents).
  status(roads ? `building ${worldName} streets…` : `building ${worldName}…`);
  await paint();
  const tBuild = performance.now();
  const world = buildWorld(tiles, files.roads, files.boundary);
  const buildMs = performance.now() - tBuild;
  const colliders = new Map<string, TileCollider>();
  manifest.tiles.forEach((t, i) => colliders.set(t.id, tiles[i]!));
  // The renderer stands things on exactly the sim's ground.
  const ground = (x: number, z: number): number => groundHeight(world, x, z);
  const occluded = (x: number, y: number, z: number): boolean => {
    for (const b of nearbyBuildings(world, x, z, 0.6)) {
      if (y < b.topY + 0.3 && y > b.baseY - 2 && pointInPolygon(x, z, b.footprint)) return true;
    }
    return false;
  };

  const container = document.getElementById("game")!;
  const hud = new Hud();
  const bootedAtNight = params.get("night") === "1";
  // The collider pack has no building meta (use, year, stories); when a tile's glb fails, the
  // fallback build looks better from the tile's own collider JSON, which the loose layout (pnpm
  // dev) still has. The hosted build ships none: it builds from the pack's collider.
  const tileColliderFile = new Map(manifest.tiles.map((t) => [t.id, t.collider]));
  const fallbackCollider =
    files.colliders === "pack" && assets.mode === "loose"
      ? (id: string): Promise<TileCollider | null> => {
          const f = tileColliderFile.get(id);
          return f ? assets.json<TileCollider>(base + f).catch(() => null) : Promise.resolve(null);
        }
      : undefined;
  // The house kit's palettes (K3) pick by district: the districts layer is small and read before
  // the first tile, so every tile picks its colours the same way. Never fatal: without it the
  // palettes fall back to their district-free rules.
  // The storefront anchors (K5) are read with them: a wall with an anchor is drawn as a shopfront.
  const districtsFile = manifest.layers?.districts;
  const storefrontsFile = manifest.layers?.storefronts;
  const [districts, storefronts] = await Promise.all([
    districtsFile ? assets.json<DistrictsLike>(base + districtsFile).catch(() => null) : null,
    storefrontsFile
      ? assets.json<{ storefronts: StorefrontAnchor[] }>(base + storefrontsFile).then(
          (f) => f.storefronts,
          (err: unknown) => {
            console.warn(`[fog-city] storefronts ${storefrontsFile}: ${err instanceof Error ? err.message : String(err)}`);
            return null;
          },
        )
      : null,
  ]);
  const houseLook = houseLookFn(files.colliders === "pack" || worldName === "sf" ? new HouseColours(tiles, districts) : null);
  const view = new SceneRenderer(
    container,
    { manifest, base, colliders, roads, ground, occluded, assets, fallbackCollider, boundary: files.boundary, houseLook, storefronts },
    {
      radius: numParam(params, "radius") ?? 1500,
      shadows: params.get("shadows") === "1",
      night: bootedAtNight,
      maxPixelRatio: numParam(params, "pr") ?? 1.5,
      models: new Set(models),
      landmarks: landmarksDoc,
      houseKit: houseKitDoc,
      gfx: parseGfxRequest(params.get("gfx")),
      gfxOff: (params.get("gfxoff") ?? "").split(",").filter(Boolean),
    },
  );
  // ?debug=1 exposes the renderer for poking at from the console. Never used by tests.
  if (params.get("debug") === "1") (window as unknown as { __fogcityView?: SceneRenderer }).__fogcityView = view;
  const startCam = params.get("cam") as CameraMode | null;
  if (startCam && CAMERA_MODES.includes(startCam)) view.setCameraMode(startCam);
  // ?tod=noon|golden|night: the lighting (render-only; the HUD clock still follows the sim).
  const tod = params.get("tod");
  if (tod === "noon" || tod === "golden" || tod === "night") view.setTimeOfDay(tod);
  // Render-only: the sidewalk bands (W-45), after boot so the 10 MB graph never delays the first
  // frame. Never fatal: without it the streets have no pavement drawn, nothing else changes.
  const sidewalksFile = manifest.layers?.sidewalks;
  if (sidewalksFile) {
    assets.json<SidewalkGraph>(base + sidewalksFile).then(
      (g) => view.streamer.setSidewalks(g),
      (err: unknown) => console.warn(`[fog-city] sidewalks ${sidewalksFile}: ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  const keyboard = new Keyboard();
  const pointer = new PointerLook(view.renderer.domElement);
  let prev: SimState = createInitialState(world, SEED, [LOCAL_PLAYER], manifest.spawn);
  let curr: SimState = prev;
  let paused = false;
  let acc = 0;
  let last = performance.now();
  /** One game clock, chosen at boot: night mode is a look and never moves it. */
  const clockStart = clockStartMinute(bootedAtNight);

  const advanceFrame = (frame: InputFrame, events: readonly SimEvent[] = []): void => {
    prev = curr;
    curr = step(world, curr, frame, events);
  };
  const advance = (input: SimInput): void => advanceFrame({ [LOCAL_PLAYER]: input });

  // Reused every frame: no allocation in the render loop.
  const poses = new Map<string, PlayerPoses>();
  const poseFor = (id: string): PlayerPoses => {
    let p = poses.get(id);
    if (!p) {
      p = {
        car: { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, steer: 0, speed: 0 },
        foot: { x: 0, y: 0, z: 0, heading: 0, speed: 0 },
      };
      poses.set(id, p);
    }
    return p;
  };
  const target: CameraTarget = { x: 0, y: 0, z: 0, heading: 0, speed: 0, onFoot: false };
  const local = { id: LOCAL_PLAYER, target };
  const fly: FlyInput = { ...NO_FLY_INPUT };
  const drag = { x: 0, y: 0 };
  let playersKey = "";
  let idsFor: SimState["players"] | null = null;
  let ids: string[] = [];
  const renderInfo = view.info();
  const hudData: HudData = {
    world: worldName,
    speedMps: 0,
    x: 0,
    z: 0,
    onFoot: false,
    tilesReady: 0,
    tilesTotal: 0,
    tilesPending: 0,
    drawCalls: 0,
    triangles: 0,
    fps: 0,
    cameraMode: "chase",
    night: false,
    minuteOfDay: 0,
    viewHeading: 0,
  };

  const axis = (pos: string, neg: string): number => (keyboard.isDown(pos) ? 1 : 0) - (keyboard.isDown(neg) ? 1 : 0);
  const readFly = (dt: number): void => {
    fly.forward = axis("KeyW", "KeyS");
    fly.right = axis("KeyD", "KeyA");
    fly.up = axis("Space", "ShiftLeft");
    pointer.takeDrag(drag);
    fly.yaw = axis("ArrowRight", "ArrowLeft") * 1.3 * dt + drag.x * 0.0035;
    fly.pitch = axis("ArrowUp", "ArrowDown") * 1.0 * dt - drag.y * 0.0035;
    fly.boost = keyboard.isDown("ShiftRight");
    const w = pointer.takeWheel();
    if (w !== 0) view.rig.fly.speed = Math.max(2, Math.min(600, view.rig.fly.speed * Math.pow(1.25, -w)));
  };

  const readyAt = performance.now();
  installDebugHandle({
    world: worldName,
    state: () => curr,
    hash: () => hashState(curr),
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
      last = performance.now();
    },
    stepN: (n, input) => {
      for (let i = 0; i < n; i++) advance(input ?? { ...NEUTRAL_INPUT });
    },
    stepFrames: (frames, events = []) => {
      for (const f of frames) {
        const tick = curr.tick + 1;
        advanceFrame(
          f,
          events.filter((e) => e.tick === tick),
        );
      }
    },
    simInfo: () => ({
      seed: curr.seed,
      playerIds: sortedIds(curr.players),
      roads: world.roads !== null,
      agents: agentsOf(curr).length,
      colliders: files.colliders,
      walls: world.walls?.segments.length ?? 0,
      assets: assets.mode,
      boot: { loadMs, buildMs, readyMs: readyAt - tStart },
    }),
    renderInfo: () => view.info(),
    landmarks: () => view.landmarkEntries(),
    setNight: (on) => view.setNight(on),
    setTimeOfDay: (t) => view.setTimeOfDay(t),
    setCameraMode: (m) => view.setCameraMode(m),
    flyTo: (x, y, z, yawDeg, pitchDeg) => view.flyTo(x, y, z, (yawDeg * Math.PI) / 180, (pitchDeg * Math.PI) / 180),
    tilesSettled: () => view.tilesSettled(),
    groundHeight: (x, z) => ground(x, z),
    hint: () => hud.hintText(),
    setAgentBags: (full) => view.agents.setBags(full),
  });

  const frame = (now: number): void => {
    const frameS = (now - last) / 1000;
    const dtFrame = Math.min(frameS, MAX_FRAME_S);
    last = now;
    for (const code of keyboard.takeUiPresses()) {
      if (code === "KeyC") view.rig.cycle();
      else if (code === "KeyV") view.rig.toggleFly();
      else if (code === "KeyN") view.setNight(!view.night);
    }
    const flying = view.rig.mode === "fly";
    if (flying) readFly(dtFrame);
    else {
      pointer.takeDrag(drag);
      pointer.takeWheel();
    }
    if (!paused) {
      acc += dtFrame;
      while (acc >= DT) {
        if (flying) {
          // The fly camera owns the keys: the player gets neutral input.
          keyboard.clearActions();
          advance({ ...NEUTRAL_INPUT });
        } else {
          const input = keyboard.sample();
          const before = curr.players[LOCAL_PLAYER];
          advance(input);
          const hint = exitHint(before, curr.players[LOCAL_PLAYER], (input.actions & Action.enterExit) !== 0);
          if (hint) hud.hint(hint, now);
        }
        acc -= DT;
      }
    }
    const alpha = paused ? 1 : acc / DT;

    // Player ids change only when the sim state does (once per tick at most).
    if (curr.players !== idsFor) {
      idsFor = curr.players;
      ids = sortedIds(curr.players);
      const key = ids.join("\u0001");
      if (key !== playersKey) {
        playersKey = key;
        view.actors.remove(new Set(ids));
      }
    }
    for (const id of ids) {
      const pc = curr.players[id]!;
      const pp = prev.players[id] ?? pc;
      const P = poseFor(id);
      const a = pp.car;
      const b = pc.car;
      const c = P.car;
      c.x = lerp(a.x, b.x, alpha);
      c.y = lerp(a.y, b.y, alpha);
      c.z = lerp(a.z, b.z, alpha);
      c.heading = a.heading + wrapAngle(b.heading - a.heading) * alpha;
      c.pitch = lerp(a.pitch, b.pitch, alpha);
      c.roll = lerp(a.roll, b.roll, alpha);
      c.steer = lerp(a.steer, b.steer, alpha);
      c.speed = lerp(a.speed, b.speed, alpha);
      view.setCar(id, c);
      const onFoot = pc.mode === "foot" && pc.foot !== null;
      if (onFoot) {
        const fb = pc.foot!;
        const fa = pp.mode === "foot" && pp.foot ? pp.foot : fb;
        const f = P.foot;
        f.x = lerp(fa.x, fb.x, alpha);
        f.y = lerp(fa.y, fb.y, alpha);
        f.z = lerp(fa.z, fb.z, alpha);
        f.heading = fa.heading + wrapAngle(fb.heading - fa.heading) * alpha;
        f.speed = lerp(fa.speed, fb.speed, alpha);
      }
      view.setFoot(id, onFoot ? P.foot : null);
      if (id === LOCAL_PLAYER) {
        // The camera and HUD follow the body the player controls (activeBody), interpolated.
        const src = onFoot ? P.foot : c;
        target.x = src.x;
        target.y = src.y;
        target.z = src.z;
        target.heading = src.heading;
        target.onFoot = onFoot;
        target.speed = onFoot ? P.foot.speed : c.speed;
      }
    }
    view.setSim(prev, curr, alpha);
    const minute = gameMinuteOfDay(curr, clockStart);
    view.frame(dtFrame, curr.players[LOCAL_PLAYER] ? local : null, flying ? fly : NO_FLY_INPUT, minute, frameS);
    view.render();

    const info = view.info(renderInfo);
    const me = curr.players[LOCAL_PLAYER];
    hudData.speedMps = me ? activeBody(me).speed : 0;
    hudData.x = target.x;
    hudData.z = target.z;
    hudData.onFoot = target.onFoot;
    hudData.tilesReady = info.tilesLoaded;
    hudData.tilesTotal = info.tilesTotal;
    hudData.tilesPending = info.tilesPending;
    hudData.drawCalls = info.drawCalls;
    hudData.triangles = info.triangles;
    hudData.fps = info.fps;
    hudData.cameraMode = info.cameraMode;
    hudData.night = info.night;
    hudData.minuteOfDay = minute;
    hudData.viewHeading = view.rig.viewHeading();
    hud.update(now, hudData);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

boot().catch((err: unknown) => {
  const hud = document.getElementById("hud");
  if (hud) hud.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
  console.error(err);
});
