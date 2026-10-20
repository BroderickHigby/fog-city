// window.__fogcity: a small handle for e2e tests and debugging. Read-only views of the
// sim plus explicit stepping, so browser tests can drive the game deterministically, and
// read-only render stats plus render-only controls (night, cameras) for screenshots.

import type { SimInput, SimState } from "./sim/contract.ts";

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
}

export interface DebugHandle {
  ready: true;
  world: string;
  state(): SimState;
  hash(): string;
  pause(): void;
  resume(): void;
  stepN(n: number, input?: SimInput): void;
  renderInfo(): RenderInfo;
  setNight(on: boolean): void;
  setCameraMode(mode: CameraModeName): void;
  /** Switch to the fly camera at (x, y, z) looking along compass yaw, pitch (degrees, + up). */
  flyTo(x: number, y: number, z: number, yawDeg: number, pitchDeg: number): void;
  /** True when no tile is queued, loading or building. */
  tilesSettled(): boolean;
}

declare global {
  interface Window {
    __fogcity?: DebugHandle;
  }
}

export function installDebugHandle(h: Omit<DebugHandle, "ready">): void {
  window.__fogcity = { ready: true, ...h };
}
