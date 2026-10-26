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
// Keys: WASD/arrows drive (or walk), Space brake; on foot W jogs, Shift (or Space, pad LT) sprints, F beside an empty robotaxi hops in
// (a phone-map waypoint is where it goes; F again gets out); F enter/exit, E fire,
// Q scan, H horn (sim actions; src/audio/horn.ts sounds it). Render only: C chase/first-person, V free fly camera (WASD
// move, Space/Shift up/down, arrows or mouse drag look, wheel speed, right Shift boost), N night;
// in the chase camera, mouse or touch drag on the view (or the pad's right stick) orbits round you.

import { landmarks as landmarksDoc, models } from "virtual:fogcity-assets";
import * as THREE from "three";
import { installDebugHandle } from "./debug.ts";
import { FramePacer } from "./frame-pacer.ts";
import { openAssets } from "./io/assets.ts";
import { buildLoadedWorld, loadWorldFiles } from "./io/world-load.ts";
import { Keyboard } from "./input/keyboard.ts";
import { PointerLook } from "./input/pointer.ts";
import { availableGamepads } from "./input/controller.ts";
import { uiText } from "./content/ui.ts";
import { mountGameUI, createGameplayDispatcher, type MapPoint } from "./ui/index.ts";
import { mountMultiplayer } from "./ui/multiplayer.ts";
import { relayUrl } from "./net/config.ts";
import { nextCampaignMission } from "./ui/campaign.ts";
import { uiProjection } from "./ui/projection.ts";
import { CombatLayer } from "./render/combat-layer.ts";
import { ImpactLayer } from "./render/impact-layer.ts";
import { PropDamage } from "./render/prop-damage.ts";
import { propIndex } from "./sim/props.ts";
import { meshGroundHeight } from "./sim/world.ts";
import { SprayTracker } from "./render/held-blaster.ts";
import { SOFTWARE_GPU, TIER_SETTINGS, chooseTier, parseGfxRequest, probeGpu } from "./render/gfx.ts";
import { ContextGuard, RESUME_KEY, SAFE_MODE_KEY, hideGraphicsNotice, showGraphicsNotice } from "./render/context-guard.ts";
import { createGameAudioDirector } from "./audio/index.ts";
import { hornBlasts } from "./audio/horn.ts";
import { SaveStore, IndexedDbSaveBackend, MemorySaveBackend, Autosave } from "./save/index.ts";
import { captureProgression, restoreProgression, validateSavedProgression } from "./save/progression.ts";
import { restoreSpawn } from "./save/restore-spawn.ts";
import { contentHash } from "./content/barks.ts";
import { VENDOR } from "./content/vendor.ts";
import { STARTUP_KITS } from "./content/kits.ts";
import { DEFAULT_CATALOG } from "./sim/player/catalog.ts";
import { createGameSystems } from "./sim/game-systems.ts";
import { missionParkingDestination } from "./sim/missions/parking-world.ts";
import { agentsRuntimeOf } from "./sim/agents/runtime.ts";
import { renderWithRuntimeActors } from "./render/runtime-actors.ts";
import { gameplaySnapshot } from "./sim/player/adapter.ts";
import { gameTime } from "./sim/clock/calendar.ts";
import { TIDE_PROMENADE, WEATHER, promenadeAt, weatherView } from "./sim/fog/index.ts";
import { RIDE_DESTINATION_EVENT, boardableTaxi, takeoverTaxi } from "./sim/ride.ts";
import { canEnterCar } from "./sim/foot.ts";
import { MISSIONS } from "./content/catalog.ts";
import type { CarPose, WalkerPose } from "./render/actors.ts";
import { NO_FLY_INPUT, type CameraMode, type CameraTarget, type FlyInput } from "./render/cameras.ts";
import { clockStartMinute, gameMinuteOfDay } from "./render/clock.ts";
import { HINT_SPRINT, HINT_SPRINT_TOUCH, HINT_TAXI_BOARD, HINT_TAXI_DRIVE, HINT_TAXI_DRIVING, HINT_TAXI_EXIT, HINT_TAXI_HAILED, HINT_TAXI_HEADING, HINT_TAXI_RIDING, Hud, SPRINT_HINTS, exitHint, type HudData } from "./render/hud.ts";
import { SceneRenderer } from "./render/scene.ts";
import { leapDrawOffset } from "./render/human-motion.ts";
import type { Manifest, RoadGraph } from "./render/types.ts";
import {
  Action,
  DT,
  NEUTRAL_INPUT,
  activeBody,
  agentsOf,
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
/** The override's drawn offset for a player on foot (render/human-motion.ts). */
const leapOff = { x: 0, z: 0 };
const SEED = 1;
/** The released wave. ?wave=4 previews the next wave's missions (QA and browser tests only). */
const RELEASED_WAVE = 3;
const PREVIEW_WAVE = Number(new URLSearchParams(location.search).get("wave"));
const GAME_WAVE: 3 | 4 = PREVIEW_WAVE === 4 ? 4 : RELEASED_WAVE;
/** The sim catches up at most this much per frame (a slow frame slows the game, never jumps it). */
const MAX_FRAME_S = 0.25;
const CAMERA_MODES: readonly CameraMode[] = ["chase", "first-person", "fly"];
/** Chase orbit: radians per pixel dragged, and radians per second at full right stick. */
const ORBIT_PER_PX = 0.006;
const ORBIT_STICK_RATE = 2.6;

/** A sessionStorage value, or null where storage is unavailable (private mode, sandboxed frames). */
function sessionValue(key: string): string | null {
  try { return sessionStorage.getItem(key); } catch { return null; }
}
function setSessionValue(key: string, value: string | null): void {
  try { if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

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
  const worldName = params.get("world") ?? assets.defaultWorld ?? "sf";
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
  // Render-only data: the districts' park polygons tint the ground green. Never fatal.
  const districtsFile = files.manifest.layers?.districts;
  const districts: unknown = districtsFile
    ? await assets.json<unknown>(base + districtsFile).catch((err: unknown) => {
        console.warn(`[fog-city] districts ${districtsFile}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      })
    : null;
  const { manifest, tiles } = files;
  const roads = files.roads as RoadGraph | null;
  // One reference-only presentation packet: the map uses exactly the loaded SF city.
  const mapGeography = { tiles, roads, boundary: files.boundary, districts };
  // Once, at load: with the road graph the sim runs ambient traffic (state.ext.agents).
  status(roads ? `building ${worldName} streets…` : `building ${worldName}…`);
  await paint();
  const tBuild = performance.now();
  const world = buildLoadedWorld(files);
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
  // The graphics tier (gfx.ts): from the GPU unless ?gfx= names one; after the GPU was lost
  // this session (context-guard.ts), safe mode starts low. ?quality= and ?shadows= still win.
  const safeMode = sessionValue(SAFE_MODE_KEY) === "1";
  const rendererRequest = params.get("renderer");
  const gpu = probeGpu();
  const gfxRequest = parseGfxRequest(params.get("gfx"));
  const gfx = chooseTier(gfxRequest, gpu, safeMode);
  const tierSettings = TIER_SETTINGS[gfx.tier];
  const view = await SceneRenderer.create(
    container,
    { manifest, base, colliders, roads, ground, occluded, assets, districts, fallbackCollider },
    {
      backend: ["webgpu", "webgl", "legacy"].includes(rendererRequest ?? "")
        ? rendererRequest as "webgpu" | "webgl" | "legacy" : safeMode ? "legacy" : "auto",
      // Keep full-detail geometry bounded; the independent far layer retains the skyline.
      radius: numParam(params, "radius") ?? 600,
      shadows: params.has("shadows") ? params.get("shadows") === "1" : tierSettings.shadows,
      quality: params.has("quality") ? params.get("quality") === "1" : tierSettings.post,
      gpuMemory: params.get("gpumem") === "1",
      timeOfDay: ["golden", "noon", "twilight", "night"].includes(params.get("tod") ?? "")
        ? params.get("tod") as "golden" | "noon" | "twilight" | "night" : undefined,
      night: bootedAtNight,
      maxPixelRatio: numParam(params, "pr") ?? tierSettings.maxPixelRatio,
      pixelBudget: params.has("pr") ? undefined : tierSettings.pixelBudget,
      tier: gfx.tier,
      governed: gfxRequest === "auto" && !params.has("pr") && !params.has("quality") && !params.has("shadows"),
      preserveDrawingBuffer: SOFTWARE_GPU.test(gpu.renderer),
      models: new Set(models),
      landmarks: landmarksDoc,
      tide: { line: TIDE_PROMENADE, nearM: WEATHER.promenadeNearM, farM: WEATHER.promenadeFarM, floods: (x, z) => promenadeAt(world, x, z) },
    },
  );
  // ?debug=1 exposes the renderer for diagnostics and graphics-recovery browser checks.
  if (params.get("debug") === "1") (window as unknown as { __fogcityView?: SceneRenderer }).__fogcityView = view;
  const startCam = params.get("cam") as CameraMode | null;
  if (startCam && CAMERA_MODES.includes(startCam)) view.setCameraMode(startCam);
  // Reproducible render-only views for local visual QA. The player's pose is untouched.
  const captureEnabled = params.get("debug") === "1" && ["1", "stats"].includes(params.get("capture") ?? "");
  const captureMode = captureEnabled && params.get("capture") === "1";
  const cameraPose = params.get("debug") === "1" ? params.get("camera")?.split(",").map(Number) : undefined;
  if (cameraPose?.length === 5 && cameraPose.every(Number.isFinite)) {
    view.flyTo(cameraPose[0]!, cameraPose[1]!, cameraPose[2]!, cameraPose[3]! * Math.PI / 180, cameraPose[4]! * Math.PI / 180);
  }
  const captureProof = captureEnabled ? document.createElement("pre") : null;
  if (captureProof) { captureProof.hidden = true; captureProof.setAttribute("data-fog-capture", ""); container.append(captureProof); }
  let nextCaptureProof = 0;

  const keyboard = new Keyboard();
  const pointer = new PointerLook(view.renderer.domElement);
  let prev: SimState = createInitialState(world, SEED, [LOCAL_PLAYER], manifest.spawn);
  let curr: SimState = prev;
  // Two independent pauses: the debug handle's (tests step the sim by hand and nothing else may
  // advance it) and the UI's (an open modal). Only a UI pause lets a queued command through.
  let debugPaused = captureMode;
  let uiPaused = false;
  let paused = captureMode;
  const setPaused = (): void => {
    paused = debugPaused || uiPaused;
    pacer.reset();
    last = performance.now();
  };
  const pacer = new FramePacer(DT);
  let last = performance.now();
  const systems=createGameSystems({wave:GAME_WAVE});
  let requestedMission="hot-desk";
  let waypoint:MapPoint|undefined;
  let queuedEvents:SimEvent[]=[];
  const recordedCommands:SimEvent[]=[];
  const send=createGameplayDispatcher({playerId:LOCAL_PLAYER,tick:()=>curr.tick+1,emit:event=>{queuedEvents.push(event);recordedCommands.push(event);}});
  const saveStore=new SaveStore({backends:[new IndexedDbSaveBackend(),new MemorySaveBackend()],contentHash:contentHash([JSON.stringify(MISSIONS),JSON.stringify(VENDOR),JSON.stringify(STARTUP_KITS),JSON.stringify(DEFAULT_CATALOG.sites),JSON.stringify(DEFAULT_CATALOG.activities)]),validate:validateSavedProgression});
  const autosave=new Autosave(saveStore,()=>captureProgression(curr,LOCAL_PLAYER));
  const startupForm=MISSIONS.find(mission=>mission.id==="hot-desk")?.steps.find(step=>step.type==="form");
  const audio=createGameAudioDirector({host:container,missions:MISSIONS,weather:(s,x,z)=>weatherView(world,s,x,z)});void audio.load();
  const restoreSave=(data:Parameters<typeof validateSavedProgression>[0]):void=>{
    const clean=validateSavedProgression(data),player=clean.player as Record<string,unknown>,wallet=clean.wallet as {ownedSiteIds:string[]};
    const site=DEFAULT_CATALOG.sites.find(site=>site.id===player.safehouseId)||DEFAULT_CATALOG.sites.find(site=>site.kind==="safehouse"&&wallet.ownedSiteIds.includes(site.id));
    const spawn=site?restoreSpawn(world,site):manifest.spawn;
    const fresh=step(world,createInitialState(world,SEED,[LOCAL_PLAYER],spawn),{[LOCAL_PLAYER]:{...NEUTRAL_INPUT}},[],systems);
    curr=restoreProgression(fresh,clean,LOCAL_PLAYER);prev=curr;audio.restore(curr);queuedEvents=[];waypoint=undefined;pacer.reset();last=performance.now();
    const completed=(clean.missions as {completedIds:string[]}).completedIds;const next=nextCampaignMission(completed,GAME_WAVE);requestedMission=next?.id??"";if(next)send({kind:"mission-start",targetId:next.id});
  };
  const gameUI=mountGameUI(container,{audioSettings:doc=>audio.mountSettings(doc),copy:uiText,keyboard,startupChoices:startupForm?.type==="form"?startupForm.form.multipleChoice:undefined,touch:matchMedia("(pointer: coarse)").matches,showPerformance:params.get("debug")==="1"||params.get("perf")==="1",lightingPreset:["noon","golden","twilight","night"].includes(params.get("tod")??"")?params.get("tod") as "noon"|"golden"|"twilight"|"night":bootedAtNight?"night":"live",saves:{store:saveStore,capture:()=>captureProgression(curr,LOCAL_PLAYER),restore:restoreSave},callbacks:{
    pause:value=>{uiPaused=value;setPaused();},
    lighting:preset=>{if(preset==="live")view.setNight(false);else view.setTimeOfDay(preset);},
    purchase:(itemId,targetId)=>send({kind:"buy",itemId,targetId}),startup:kitId=>send({kind:"startup-define",kitId}),closeAd:targetId=>send({kind:"close-ad",targetId}),
    waypoint:point=>{waypoint=point;sendRideDestination();},
    interaction:choiceId=>{
      const progress=gameplaySnapshot({state:curr}).missions.players[LOCAL_PLAYER];
      const mission=MISSIONS.find(m=>m.id===progress?.missionId),current=mission?.steps.find(s=>s.id===progress?.stepId);
      if(choiceId==="retry")send({kind:"mission-retry"});
      else if(current?.type==="dialogue"){const questionId=current.questions[progress?.questionIndex??0]?.id;send({kind:"mission-answer",questionId,choiceId});if(questionId)audio.answered(questionId,choiceId);}
      else send({kind:"mission-ack"});
    },
  }});
  /** A rider's destination enters the sim as a recorded event (src/sim/ride.ts). */
  const sendRideDestination=():void=>{
    if(!waypoint||!curr.players[LOCAL_PLAYER]?.ride||curr.players[LOCAL_PLAYER]?.ride?.manual)return;
    const event:SimEvent={tick:curr.tick+1,kind:RIDE_DESTINATION_EVENT,playerId:LOCAL_PLAYER,payload:{x:Math.round(waypoint.x),z:Math.round(waypoint.z)}};
    queuedEvents.push(event);recordedCommands.push(event);
  };
  // Online Bot Sweep (src/ui/multiplayer.ts): absent without a configured relay. The city waits,
  // unstepped, while a match owns the screen.
  const projected=new THREE.Vector3();let lookIds:string[]=[];
  const multiplayer=mountMultiplayer({host:container,relayUrl:relayUrl(),world,files,worldName,
    onLooks:looks=>{for(const id of lookIds)if(!(id in looks))view.actors.setLookSlot(id,null);lookIds=Object.keys(looks);for(const id of lookIds)view.actors.setLookSlot(id,looks[id]!);},
    project:(x,y,z)=>{const cam=view.camera;projected.set(x,y,z);const distance=projected.distanceTo(cam.position);projected.project(cam);if(projected.z>1||projected.z<-1)return null;const r=view.renderer.domElement.getBoundingClientRect();return {x:r.left+(projected.x+1)/2*r.width,y:r.top+(1-projected.y)/2*r.height,distance};},onModeChange:()=>{keyboard.releaseAll();view.actors.remove(new Set());playersKey="";pacer.reset();last=performance.now();},city:{playerId:LOCAL_PLAYER,get:()=>curr,set:state=>{curr=state;prev=state;},save:()=>autosave.flush(),
    restoreAutosave:async()=>{const save=await saveStore.load("auto");if(!save)return false;restoreSave(save.data);return true;}}});
  const combatLayer=new CombatLayer(view.scene);
  const impactLayer=new ImpactLayer(view.scene);
  const props=propIndex(world);
  const propDamage=new PropDamage(view.scene,{prop:id=>props.byId.get(id),
    hydrants:(world.gameplay?.refills??[]).filter(r=>r.kind==="hydrant").map(r=>({id:`hydrant:${r.id}`,x:r.x,z:r.z})),
    ground:(x,z)=>meshGroundHeight(world,x,z),setFoliageOverride:fn=>view.setFoliageOverride(fn)});
  if (params.get("debug") === "1") (window as unknown as { __fogcityImpacts?: ImpactLayer }).__fogcityImpacts = impactLayer;
  if (params.get("debug") === "1") (window as unknown as { __fogcityProps?: PropDamage }).__fogcityProps = propDamage;
  const sprayTracker=new SprayTracker();
  const unlockAudio=()=>audio.unlock();window.addEventListener("pointerdown",unlockAudio,{once:true});window.addEventListener("keydown",unlockAudio,{once:true});
  send({kind:"mission-start",targetId:"hot-desk"});
  const diagnostics=params.get("debug")==="1";
  // Debug only: a small badge while the sim cannot keep up and game time runs slower (frame-pacer.ts).
  const slowBadge=diagnostics||params.get("perf")==="1"?document.createElement("div"):null;
  if(slowBadge){slowBadge.id="sim-slow";slowBadge.hidden=true;slowBadge.style.cssText="position:fixed;left:8px;bottom:8px;z-index:50;padding:2px 6px;font:12px/1.4 monospace;color:#fff;background:rgba(160,40,20,.8);border-radius:3px;pointer-events:none";document.body.appendChild(slowBadge);}
  const legacyHud=document.getElementById("hud");if(legacyHud)legacyHud.hidden=!diagnostics;
  const legacyCompass=document.getElementById("compass");if(legacyCompass)legacyCompass.hidden=true;
  /** One game clock, chosen at boot: night mode is a look and never moves it. */
  const clockStart = clockStartMinute(bootedAtNight);
  let nextWeather = 0;

  const advanceFrame = (frame: InputFrame, events: readonly SimEvent[] = []): void => {
    prev = curr;
    const tick=curr.tick+1,pending=queuedEvents.filter(event=>event.tick===tick);
    queuedEvents=queuedEvents.filter(event=>event.tick>tick);
    curr = step(world, curr, frame, [...events,...pending],systems);
    // Every horn in the stepped frame sounds (keys, pad and touch all set Action.horn).
    const me = curr.players[LOCAL_PLAYER];
    if (me) for (const blast of hornBlasts(frame, curr, prev)) audio.playHorn(blast);
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
  const target: CameraTarget = { x: 0, y: 0, z: 0, heading: 0, speed: 0, onFoot: false, pitch: 0 };
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
    commands:()=>JSON.parse(JSON.stringify(recordedCommands)) as SimEvent[],
    hash: () => hashState(curr),
    pause: () => {
      debugPaused = true;
      setPaused();
    },
    resume: () => {
      debugPaused = false;
      setPaused();
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
    previewCombatLook: (stages) => view.previewCombatLook(stages),
    setTimeOfDay: (name) => view.setTimeOfDay(name),
    renderStats: () => view.renderStats(),
    loseContext: () => view.forceContextLoss(),
    restoreContext: () => view.forceContextRestore(),
    setCameraMode: (m) => view.setCameraMode(m),
    flyTo: (x, y, z, yawDeg, pitchDeg) => view.flyTo(x, y, z, (yawDeg * Math.PI) / 180, (pitchDeg * Math.PI) / 180),
    tilesSettled: () => view.tilesSettled(),
    hint: () => hud.hintText(),
    setAgentBags: (full) => view.agents.setBags(full),
  });

  let nextUiUpdate=0;
  const touchControls = matchMedia("(pointer: coarse)").matches;
  let sprintHints = 0;
  let nextTaxiHint = 0;
  let sprintHintDue = false;
  // A lost WebGL context (context-guard.ts): stop drawing, keep the sim and the UI going, and
  // rebuild on restore. If it does not come back, save and reload in safe mode at that save.
  const guard = new ContextGuard(view.renderer.domElement, {
    onLost: () => showGraphicsNotice(container, "Graphics paused: the GPU is resetting…"),
    onRestored: () => { view.contextRestored(); hideGraphicsNotice(container); },
    onGiveUp: () => {
      showGraphicsNotice(container, "Graphics reset. Reloading at your last save…");
      setSessionValue(SAFE_MODE_KEY, "1");
      setSessionValue(RESUME_KEY, "1");
      void saveStore.save("auto", captureProgression(curr, LOCAL_PLAYER)).catch(() => {}).finally(() => {
        // A runtime failure must not loop on an explicitly requested failing backend.
        const next = new URL(location.href); next.searchParams.set("renderer", "legacy");
        history.replaceState(null, "", next); location.reload();
      });
    },
  });
  // Back from a graphics reset: carry on from the save made just before it.
  if (sessionValue(RESUME_KEY) === "1") {
    setSessionValue(RESUME_KEY, null);
    void saveStore.load("auto").then((save) => { if (save) restoreSave(save.data); }).catch(() => {});
  }

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
    if (flying) { gameUI.hideReticle(); readFly(dtFrame); }
    else {
      // Chase orbit (render only): mouse/touch drag, or the pad's right stick.
      pointer.takeDrag(drag);
      pointer.takeWheel();
      const pad = availableGamepads().find((p) => p?.connected);
      const stick = (v: number | undefined): number => (v === undefined || !Number.isFinite(v) || Math.abs(v) < 0.18 ? 0 : v);
      view.rig.orbit(drag.x * ORBIT_PER_PX + stick(pad?.axes[2]) * ORBIT_STICK_RATE * dtFrame,
        drag.y * ORBIT_PER_PX + stick(pad?.axes[3]) * ORBIT_STICK_RATE * dtFrame);
    }
    const simStart = performance.now(); // discount city or online simulation time in the graphics governor
    // During a match the relay's timeline is drawn instead of the city (which does not step).
    const inOnlineMatch = multiplayer.inMatch();
    const match = inOnlineMatch ? multiplayer.frame(dtFrame, flying ? () => ({ ...NEUTRAL_INPUT }) : () => gameUI.sampleInput()) : null;
    if (inOnlineMatch) {
      if (flying) keyboard.clearActions();
    } else if (!paused) {
      pacer.begin(dtFrame);
      while (pacer.wantTick()) {
        const t0 = performance.now();
        if (flying) {
          // The fly camera owns the keys: the player gets neutral input.
          keyboard.clearActions();
          advance({ ...NEUTRAL_INPUT });
        } else {
          const input = gameUI.sampleInput();
          const before = curr.players[LOCAL_PLAYER];
          advance(input);
          // (A robotaxi rider gets out when the taxi stops: no car exit hints.)
          const hailed = curr.players[LOCAL_PLAYER]?.hail;
          const newHail = !!hailed && hailed.agentId !== before?.hail?.agentId;
          if (newHail) hud.hint(HINT_TAXI_HAILED, now);
          const hint = before?.ride || curr.players[LOCAL_PLAYER]?.ride || newHail ? null : exitHint(before, curr.players[LOCAL_PLAYER], (input.actions & Action.enterExit) !== 0);
          if (hint) hud.hint(hint, now);
          const rider = curr.players[LOCAL_PLAYER];
          if (rider?.ride?.manual && !before?.ride?.manual) {
            hud.hint(HINT_TAXI_DRIVING, now);
          } else if (rider?.ride && !before?.ride) {
            // Just hopped in as a passenger: head for the waypoint if one is set.
            sendRideDestination();
            hud.hint(waypoint ? HINT_TAXI_HEADING : HINT_TAXI_RIDING, now);
          }
          if (rider?.ride?.exitPending && !before?.ride?.exitPending) hud.hint(HINT_TAXI_EXIT, now);
          // The first few times the player jogs off after getting out, say how to sprint.
          const after = curr.players[LOCAL_PLAYER];
          if (before?.mode === "vehicle" && after?.mode === "foot" && sprintHints < SPRINT_HINTS) sprintHintDue = true;
          if (sprintHintDue && after?.mode === "foot" && after.foot && after.foot.speed > 1.5 && !after.foot.sprint) {
            sprintHintDue = false;
            sprintHints++;
            hud.hint(touchControls ? HINT_SPRINT_TOUCH : HINT_SPRINT, now);
          }
        }
        pacer.ticked(performance.now() - t0);
      }
      pacer.end();
    }
    // A UI-paused game still applies a command the modal just queued (an answer, a purchase).
    // Under a debug pause only stepN/stepFrames advance the sim; queued commands wait for them.
    else if(!debugPaused&&queuedEvents.some(event=>event.tick===curr.tick+1))advance({...NEUTRAL_INPUT});
    const simSeconds = (performance.now() - simStart) / 1000;
    const simCatchingUp = (match ? match.ticksThisFrame : pacer.stats().ticksThisFrame) > 1;
    const alpha = match ? match.alpha : paused ? 1 : pacer.alpha();
    const shownPrev = match ? match.prev : prev, shown = match ? match.curr : curr, me_ = match ? match.playerId : LOCAL_PLAYER;

    // Player ids change only when the sim state does (once per tick at most).
    if (shown.players !== idsFor) {
      idsFor = shown.players;
      ids = sortedIds(shown.players);
      const key = ids.join("\u0001");
      if (key !== playersKey) {
        playersKey = key;
        view.actors.remove(new Set(ids));
      }
    }
    for (const id of ids) {
      const pc = shown.players[id]!;
      const pp = shownPrev.players[id] ?? pc;
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
        f.dodge = fb.dodge;
        // The override moved them at once: drawn as a shove aside (render/human-motion.ts).
        if (fb.dodge && fb.dodge.leap && fb.dodge.phase === "dive") {
          leapDrawOffset(fb.dodge, alpha, leapOff);
          f.x = fb.x + leapOff.x;
          f.y = fb.y;
          f.z = fb.z + leapOff.z;
        }
      }
      view.setFoot(id, onFoot ? P.foot : null);
      if (id === me_) {
        // The camera and HUD follow the body the player controls (activeBody), interpolated.
        const src = onFoot ? P.foot : c;
        target.x = src.x;
        target.y = src.y;
        target.z = src.z;
        target.heading = src.heading;
        target.onFoot = onFoot;
        target.speed = onFoot ? P.foot.speed : c.speed;
        target.pitch = onFoot || pc.ride ? 0 : c.pitch;
        target.robotaxiId = pc.ride?.agentId;
        // Riding a robotaxi: follow the taxi, not the parked car.
        const rb = pc.ride, ra = pp.ride ?? rb;
        if (rb && ra) {
          target.x = lerp(ra.x, rb.x, alpha);
          target.y = lerp(ra.y, rb.y, alpha);
          target.z = lerp(ra.z, rb.z, alpha);
          target.heading = ra.heading + wrapAngle(rb.heading - ra.heading) * alpha;
          target.speed = lerp(ra.speed, rb.speed, alpha);
          const cb = agentsOf(shown).find(a => a.id === rb.agentId)?.manualCar;
          const ca = agentsOf(shownPrev).find(a => a.id === rb.agentId)?.manualCar ?? cb;
          if (cb && ca) target.pitch = lerp(ca.pitch, cb.pitch, alpha);
        }
      }
    }
    // The blaster and its stream follow the displayed city or online match.
    const sprays = sprayTracker.update(shown.ext.combat?.projectiles);
    for (const id of ids) view.setSpray(id, sprays.get(id) ?? null);
    view.setSim(renderWithRuntimeActors(shownPrev,Object.values(agentsRuntimeOf(shownPrev)?.actors??{})),renderWithRuntimeActors(shown,Object.values(agentsRuntimeOf(shown)?.actors??{})),alpha);
    combatLayer.update(shownPrev.ext.combat,shown.ext.combat,alpha,(id,out)=>view.nozzle(id,out),dtFrame);
    impactLayer.update(shownPrev,shown,alpha,dtFrame,target.x,target.z);
    propDamage.update(shown,dtFrame,target.x,target.z);
    audio.update({state:shown,playerId:me_,paused:paused&&!match,nowMs:now});
    // The sim's calendar is the game clock when its clock system runs; the light follows it
    // unless a look is pinned (?tod=, ?night=1, N). The weather is read at the camera.
    const calendar = shown.ext.clock ? gameTime(shown) : null;
    const minute = calendar ? calendar.hour * 60 + calendar.minute + calendar.second / 60 : gameMinuteOfDay(shown, clockStart);
    if (calendar) view.setDaylight(calendar.month, calendar.day, minute / 60);
    if (now >= nextWeather) {
      nextWeather = now + 100;
      const cam = view.camera.position;
      view.setWeather(weatherView(world, shown, cam.x, cam.z));
    }
    local.id = me_;
    view.frame(dtFrame, shown.players[me_] ? local : null, flying ? fly : NO_FLY_INPUT, minute, frameS, simSeconds, simCatchingUp);
    if (!guard.contextLost) view.render();
    multiplayer.overlay();

    const info = view.info(renderInfo);
    if (captureProof && now >= nextCaptureProof) {
      nextCaptureProof = now + 1000;
      const geometries = new Set<THREE.BufferGeometry>(); let meshes = 0;
      const detailMeshes: {name:string;triangles:number}[] = [];
      view.scene.traverse(object => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh || !mesh.geometry) return;
        meshes++; geometries.add(mesh.geometry);
        if (["grass-surface", "grass-blades", "building-character-details"].includes(mesh.name)) {
          detailMeshes.push({name:mesh.name,triangles:(mesh.geometry.getIndex()?.count ?? mesh.geometry.getAttribute("position")?.count ?? 0)/3});
        }
      });
      const device = (view.renderer as unknown as {backend?:{device?:{adapterInfo?:{vendor?:string;architecture?:string;device?:string;description?:string};limits?:{maxVertexBuffers?:number;maxTextureDimension2D?:number}}}}).backend?.device;
      const adapter = device?.adapterInfo;
      const proof = {
        ready:view.tilesSettled() && !info.grass?.pending && !info.buildingDetail?.pending,
        render:info,resources:view.renderStats(),backendMemory:{...view.renderer.info.memory},scene:{meshes,geometries:geometries.size,details:detailMeshes},
        sim:{seed:curr.seed,tick:curr.tick,version:curr.version,assets:assets.mode,colliders:files.colliders},
        camera:{x:view.camera.position.x,y:view.camera.position.y,z:view.camera.position.z,mode:info.cameraMode},
        device:device?{adapter:adapter?{vendor:adapter.vendor,architecture:adapter.architecture,device:adapter.device,description:adapter.description}:null,limits:{maxVertexBuffers:device.limits?.maxVertexBuffers,maxTextureDimension2D:device.limits?.maxTextureDimension2D}}:null,
      };
      const json=JSON.stringify(proof);captureProof.textContent=json;captureProof.setAttribute("data-report",json);
    }
    const me = shown.players[me_];
    hudData.speedMps = me ? activeBody(me).speed : 0;
    // On foot beside an empty robotaxi (and not beside your own car): say F hops in.
    if (me && me.mode === "foot" && me.foot && now >= nextTaxiHint && !hud.hintText()) {
      nextTaxiHint = now + 500;
      const canDriveTaxi = takeoverTaxi(world, shown, me.foot.x, me.foot.z, me_);
      if (canDriveTaxi) hud.hint(canEnterCar(world, me.car, me.foot.x, me.foot.z) ? HINT_TAXI_DRIVE : HINT_TAXI_BOARD, now);
      else if (!canEnterCar(world, me.car, me.foot.x, me.foot.z) && boardableTaxi(world, shown, me.foot.x, me.foot.z)) hud.hint("F: hop in the robotaxi", now);
    }
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
    const progress=gameplaySnapshot({state:curr}),mission=progress.missions.players[LOCAL_PLAYER];
    if(!inOnlineMatch)autosave.observe(curr.tick,JSON.stringify([mission?.completedIds??[],progress.activities.players[LOCAL_PLAYER]?.completedIds??[]]));
    if(!inOnlineMatch&&mission?.status==="complete"){const next=nextCampaignMission(mission.completedIds,GAME_WAVE);if(next&&next.id!==requestedMission){requestedMission=next.id;send({kind:"mission-start",targetId:next.id});}}
    if(now>=nextUiUpdate){nextUiUpdate=now+100;const uiView=match?{...uiProjection(shown,me_,null,undefined,GAME_WAVE,undefined),cashCents:uiProjection(curr,LOCAL_PLAYER,roads,undefined,GAME_WAVE,undefined,mapGeography).cashCents,objective:undefined}:uiProjection(curr,LOCAL_PLAYER,roads,waypoint,GAME_WAVE,missionParkingDestination(world,curr,LOCAL_PLAYER),mapGeography);const pace=pacer.stats();gameUI.update({...uiView,performance:{fps:info.fps,drawCalls:info.drawCalls,triangles:info.triangles,simMs:inOnlineMatch?undefined:pace.tickMs,backend:info.backend,shadowCascades:info.shadowCascades}});if(slowBadge){slowBadge.hidden=inOnlineMatch||!pace.slow;slowBadge.textContent=`running slow · ${Math.round(pace.speed*100)}% speed · ${pace.tickMs.toFixed(1)} ms/tick`;}}
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

boot().catch((err: unknown) => {
  const hud = document.getElementById("hud");
  if (hud) hud.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
  console.error(err);
});
