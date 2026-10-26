// Deterministic hashing for appearance (building colours, prop placement). Visual only:
// the sim has its own RNG and never sees these values.

/** FNV-1a over a string, 32-bit unsigned. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mix an integer into a hash (murmur3 finaliser). */
export function mix32(h: number, v: number): number {
  let x = (h ^ Math.imul(v | 0, 0x9e3779b1)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Hash to [0, 1). */
export function unit(h: number): number {
  return (h >>> 0) / 4294967296;
}

/** The n-th uniform [0, 1) value derived from a string seed. */
export function rand01(seed: string, n = 0): number {
  return unit(mix32(hashString(seed), n + 1));
}

/** Small stateful generator for offline tools (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
