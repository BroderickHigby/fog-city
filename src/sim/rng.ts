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

/**
 * One-word PRNG step (mulberry32) for per-agent streams kept inside agent state.
 * Returns [uint32, nextState]. Exact integer ops only.
 */
export function nextU32Word(s: number): [number, number] {
  const n = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(n ^ (n >>> 15), n | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [(t ^ (t >>> 14)) >>> 0, n >>> 0];
}

/** Uniform float in [0, 1) from a one-word stream. */
export function nextFloatWord(s: number): [number, number] {
  const [u, n] = nextU32Word(s);
  return [u / 4294967296, n];
}

/** Stateless 32-bit hash of a list of integers (murmur3 finaliser per word). Same on every engine. */
export function hash32(...words: number[]): number {
  let h = 0x811c9dc5;
  for (const w of words) {
    let k = Math.imul(w | 0, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
