// Boot: load a world manifest and every tile's collider (the sim needs the whole world for
// determinism), build the sim world, then run a fixed-timestep loop and render interpolated
// poses. Render tiles stream in and out around the camera without ever blocking the loop.
//
// URL parameters:
//   ?world=dev | dev-city | sf   world directory under public/tiles/ (default dev)
//   &radius=1500                 tile load radius, metres
//   &night=1                     start at night (KeyN toggles)
//   &shadows=1                   sun shadows (off by default for performance)
//   &pr=1.5                      cap on devicePixelRatio
//   &cam=chase|first-person|fly  starting camera
//
// Keys: WASD/arrows drive, Space brake; F enter/exit, E fire, Q scan, H horn (sim actions).
// Render only: C chase/first-person, V free fly camera (WASD move, Space/Shift up/down,
// arrows or mouse drag look, wheel speed, right Shift boost), N night.

import { landmarks as landmarksDoc, models } from "virtual:fogcity-assets";
import { installDebugHandle } from "./debug.ts";
import { Keyboard } from "./input/keyboard.ts";
import { PointerLook } from "./input/pointer.ts";
import { footPose } from "./render/actors.ts";
import { NO_FLY_INPUT, type CameraMode, type CameraTarget, type FlyInput } from "./render/cameras.ts";
import { gameMinuteOfDay } from "./render/clock.ts";
import { makeGroundFn } from "./render/ground.ts";
import { Hud, type HudData } from "./render/hud.ts";
import { SceneRenderer } from "./render/scene.ts";
import type { Manifest, Pose, RoadGraph } from "./render/types.ts";
import {
  DT,
  NEUTRAL_INPUT,
  buildWorld,
  createInitialState,
  hashState,
  nearbyBuildings,
  pointInPolygon,
  sortedIds,
  step,
  wrapAngle,
  type SimInput,
  type SimState,
  type TileCollider,
} from "./sim/index.ts";

const LOCAL_PLAYER = "p1";
const MAX_FRAME_S = 0.25;
const CAMERA_MODES: readonly CameraMode[] = ["chase", "first-person", "fly"];

function numParam(p: URLSearchParams, k: string): number | null {
  const v = p.get(k);
  if (v === null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

interface PlayerPoses {
  car: Pose;
  foot: Pose;
  a: Pose;
  b: Pose;
}

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const worldName = params.get("world") ?? "dev";
  const base = `/tiles/${worldName}/`;
  const manifest = await fetchJson<Manifest>(`${base}manifest.json`);
  const tiles = await Promise.all(manifest.tiles.map((t) => fetchJson<TileCollider>(base + t.collider)));
  let roads: RoadGraph | null = null;
  if (manifest.roads) {
    try {
      roads = await fetchJson<RoadGraph>(base + manifest.roads);
    } catch (err) {
      console.warn("[fog-city] no road graph:", err);
    }
  }
  const world = buildWorld(tiles);
  const colliders = new Map<string, TileCollider>();
  manifest.tiles.forEach((t, i) => colliders.set(t.id, tiles[i]!));
  const ground = makeGroundFn(tiles);
  const occluded = (x: number, y: number, z: number): boolean => {
    for (const b of nearbyBuildings(world, x, z, 0.6)) {
      if (y < b.topY + 0.3 && y > b.baseY - 2 && pointInPolygon(x, z, b.footprint)) return true;
    }
    return false;
  };

  const container = document.getElementById("game")!;
  const hud = new Hud();
  const view = new SceneRenderer(
    container,
    { manifest, base, colliders, roads, ground, occluded },
    {
      radius: numParam(params, "radius") ?? 1500,
      shadows: params.get("shadows") === "1",
      night: params.get("night") === "1",
      maxPixelRatio: numParam(params, "pr") ?? 1.5,
      models: new Set(models),
      landmarks: landmarksDoc,
    },
  );
  // ?debug=1 exposes the renderer for poking at from the console. Never used by tests.
  if (params.get("debug") === "1") (window as unknown as { __fogcityView?: SceneRenderer }).__fogcityView = view;
  const startCam = params.get("cam") as CameraMode | null;
  if (startCam && CAMERA_MODES.includes(startCam)) view.rig.setMode(startCam);

  const keyboard = new Keyboard();
  const pointer = new PointerLook(view.renderer.domElement);
  let prev: SimState = createInitialState(world, 1, [LOCAL_PLAYER], manifest.spawn);
  let curr: SimState = prev;
  let paused = false;
  let acc = 0;
  let last = performance.now();

  const advance = (input: SimInput): void => {
    prev = curr;
    curr = step(world, curr, { [LOCAL_PLAYER]: input });
  };

  // Reused every frame: no allocation in the render loop.
  const poses = new Map<string, PlayerPoses>();
  const poseFor = (id: string): PlayerPoses => {
    let p = poses.get(id);
    if (!p) {
      const z = (): Pose => ({ x: 0, y: 0, z: 0, heading: 0 });
      poses.set(id, (p = { car: z(), foot: z(), a: z(), b: z() }));
    }
    return p;
  };
  const target: CameraTarget = { x: 0, y: 0, z: 0, heading: 0, speed: 0, onFoot: false };
  const local = { id: LOCAL_PLAYER, target };
  const fly: FlyInput = { ...NO_FLY_INPUT };
  const drag = { x: 0, y: 0 };
  let playersKey = "";
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
    renderInfo: () => view.info(),
    setNight: (on) => view.setNight(on),
    setCameraMode: (m) => view.rig.setMode(m),
    flyTo: (x, y, z, yawDeg, pitchDeg) => view.rig.setFlyPose(x, y, z, (yawDeg * Math.PI) / 180, (pitchDeg * Math.PI) / 180),
    tilesSettled: () => view.streamer.settled(),
  });

  const frame = (now: number): void => {
    const dtFrame = Math.min((now - last) / 1000, MAX_FRAME_S);
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
          advance(keyboard.sample());
        }
        acc -= DT;
      }
    }
    const alpha = paused ? 1 : acc / DT;

    const ids = sortedIds(curr.players);
    const key = ids.join("\u0001");
    if (key !== playersKey) {
      playersKey = key;
      view.actors.remove(new Set(ids));
    }
    for (const id of ids) {
      const pc = curr.players[id]!;
      const pp = prev.players[id] ?? pc;
      const P = poseFor(id);
      const a = pp.car;
      const b = pc.car;
      P.car.x = a.x + (b.x - a.x) * alpha;
      P.car.y = a.y + (b.y - a.y) * alpha;
      P.car.z = a.z + (b.z - a.z) * alpha;
      P.car.heading = a.heading + wrapAngle(b.heading - a.heading) * alpha;
      view.setCar(id, P.car);
      let onFoot = false;
      if (pc.mode === "foot") {
        const fb = footPose(pc, P.b);
        if (fb) {
          const fa = footPose(pp, P.a) ?? fb;
          P.foot.x = fa.x + (fb.x - fa.x) * alpha;
          P.foot.z = fa.z + (fb.z - fa.z) * alpha;
          P.foot.y = Number.isFinite(fb.y) && Number.isFinite(fa.y) ? fa.y + (fb.y - fa.y) * alpha : ground(P.foot.x, P.foot.z);
          const ha = Number.isFinite(fa.heading) ? fa.heading : P.foot.heading;
          const hb = Number.isFinite(fb.heading) ? fb.heading : ha;
          P.foot.heading = ha + wrapAngle(hb - ha) * alpha;
          onFoot = true;
        }
      }
      view.setFoot(id, onFoot ? P.foot : null);
      if (id === LOCAL_PLAYER) {
        const src = onFoot ? P.foot : P.car;
        target.x = src.x;
        target.y = src.y;
        target.z = src.z;
        target.heading = src.heading;
        target.onFoot = onFoot;
        target.speed = onFoot ? 0 : pc.car.speed;
      }
    }
    const minute = gameMinuteOfDay(curr, view.night);
    view.frame(dtFrame, curr.players[LOCAL_PLAYER] ? local : null, flying ? fly : NO_FLY_INPUT, minute);
    view.render();

    const info = view.info();
    hudData.speedMps = target.onFoot ? 0 : (curr.players[LOCAL_PLAYER]?.car.speed ?? 0);
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
