// Seeded RNG whose whole state lives inside SimState, so replays, snapshots and
// netcode reproduce every random choice. sfc32, using only exactly-specified integer ops.

import type { RngState } from "./contract.ts";

export function seedRng(seed: number): RngState {
  let s: RngState = [0x9e3779b9, 0x243f6a88, 0xb7e15162, seed >>> 0];
  // Warm up so nearby seeds diverge.
  for (let i = 0; i < 12; i++) s = nextU32(s)[1];
  return s;
}

/** Returns [uint32, nextState]. Pure: never mutates its input. */
export function nextU32(s: RngState): [number, RngState] {
  let [a, b, c, d] = s;
  const t = (((a + b) | 0) + d) | 0;
  d = (d + 1) | 0;
  a = b ^ (b >>> 9);
  b = (c + (c << 3)) | 0;
  c = (c << 21) | (c >>> 11);
  c = (c + t) | 0;
  return [t >>> 0, [a >>> 0, b >>> 0, c >>> 0, d >>> 0]];
}

/** Uniform float in [0, 1). */
export function nextFloat(s: RngState): [number, RngState] {
  const [u, n] = nextU32(s);
  return [u / 4294967296, n];
}
