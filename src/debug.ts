// window.__fogcity: a small handle for e2e tests and debugging. Read-only views of the
// sim plus explicit stepping, so browser tests can drive the game deterministically.

import type { SimInput, SimState } from "./sim/contract.ts";

export interface DebugHandle {
  ready: true;
  world: string;
  state(): SimState;
  hash(): string;
  pause(): void;
  resume(): void;
  stepN(n: number, input?: SimInput): void;
}

declare global {
  interface Window {
    __fogcity?: DebugHandle;
  }
}

export function installDebugHandle(h: Omit<DebugHandle, "ready">): void {
  window.__fogcity = { ready: true, ...h };
}
