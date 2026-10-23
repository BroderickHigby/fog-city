// window.__fogcity: a small handle for e2e tests and debugging. Read-only views of the
// sim plus explicit stepping, so browser tests can drive the game deterministically, and
// read-only render stats plus render-only controls (night, cameras) for screenshots.

import type { InputFrame, SimEvent, SimInput, SimState } from "./sim/contract.ts";

export type CameraModeName = "chase" | "first-person" | "fly";

export interface RenderInfo {
  /** Draw calls and triangles of the last rendered frame (renderer.info). */
  drawCalls: number;
  triangles: number;
  /** Tiles whose meshes are in the scene. */
  tilesLoaded: number;
  cameraMode: CameraModeName;
  night: boolean;
  /** Additive extras below: may grow, never shrink. */
  tilesPending: number;
  tilesTotal: number;
  tilesFailed: number;
  landmarks: number;
  /** Display only; never assert on it (SwiftShader). */
  fps: number;
  pixelRatio: number;
  shadows: boolean;
  /** Ambient agents drawn last frame (full models near the camera plus far proxies). */
  agents: number;
  /** Of those, drawn with the full, animated model. */
  agentsNear: number;
  /** Agents in the sim state the renderer drew from. */
  agentsTotal: number;
  /** Draw calls the agents took last frame. */
  agentDrawCalls: number;
  /** Agent kinds drawn from their model files ("robotaxi", "errandRobot", "sidewalkBot"). */
  agentModels: string[];
  /** Players whose car is models/civilian-car.glb (not the procedural stand-in). */
  playerCarsFromFile: number;
  /** Players drawn on foot last frame. */
  walkers: number;
  /** Far-LOD skyline cells: listed in the manifest, loaded, and drawn in the last frame. */
  farCellsTotal: number;
  farCells: number;
  farCellsDrawn: number;
  farTriangles: number;
  /** Far quads at the city's outer edge stitched to the streamed tiles' ground (no crack at the city limit). */
  farSeamEdges: number;
  /** The camera's far plane, metres. */
  cameraFar: number;
  /** Pipeline-placed street detail near the camera: junction patches, crosswalks, stop bars, signals, stop signs. */
  streetDetail?: { layers: string[]; junctions: number; cellsBuilt: number; patches: number; crosswalks: number; stopBars: number; signals: number; stopSigns: number };
}

export interface LandmarkInfo {
  id: string;
  x: number;
  y: number;
  z: number;
  /** The model is in the scene. */
  loaded: boolean;
}

export interface SimInfo {
  seed: number;
  /** Players in the current state, ascending. */
  playerIds: string[];
  /** The sim world was built with the manifest's road graph (ambient traffic runs). */
  roads: boolean;
  /** Ambient agents in the current state. */
  agents: number;
  /** Where the sim's colliders came from: the citywide collider pack, or per-tile JSON. */
  colliders: "pack" | "json";
  /** Wall segments at the world's edge and shore (0 when the world has no boundary.json). */
  walls: number;
  /** How this build serves its files: loose (dev server) or packed (production build). */
  assets: "loose" | "packed";
  /**
   * Boot timings, ms (display only, never assert on them): fetching and decoding the world's
   * sim files, buildWorld(), and navigation start to the game being ready.
   */
  boot: { loadMs: number; buildMs: number; readyMs: number };
}

export interface DebugHandle {
  ready: true;
  world: string;
  state(): SimState;
  /** Defensive copies of recorded UI commands, for browser replay checks. */
  commands?(): readonly SimEvent[];
  hash(): string;
  pause(): void;
  resume(): void;
  stepN(n: number, input?: SimInput): void;
  /**
   * Advance one tick per frame, every player's input from the frame (a missing player is
   * neutral), passing step() the events whose tick equals the new tick, as the netcode will.
   */
  stepFrames(frames: readonly InputFrame[], events?: readonly SimEvent[]): void;
  simInfo(): SimInfo;
  renderInfo(): RenderInfo;
  /** One entry per content/landmarks.json placement. */
  landmarks(): LandmarkInfo[];
  setNight(on: boolean): void;
  setCameraMode(mode: CameraModeName): void;
  /** Switch to the fly camera at (x, y, z) looking along compass yaw, pitch (degrees, + up). */
  flyTo(x: number, y: number, z: number, yawDeg: number, pitchDeg: number): void;
  /** True when no tile is queued, loading or building. */
  tilesSettled(): boolean;
  /** The HUD hint on screen now ("" when none), e.g. "No room to get out". */
  hint(): string;
  /**
   * Render-only: errand robots' bags full (true), empty (false), or as each agent says (null,
   * the default: full, since the sim carries no bag tell yet).
   */
  setAgentBags(full: boolean | null): void;
}

declare global {
  interface Window {
    __fogcity?: DebugHandle;
  }
}

export function installDebugHandle(h: Omit<DebugHandle, "ready">): void {
  window.__fogcity = { ready: true, ...h };
}
