// Content's own small deterministic PRNG and string hash.
//
// Deliberately independent of the sim's RNG (src/sim/rng.ts): generating a billboard or a
// startup name from a seed must never read or advance SimState. Only exactly-specified
// integer ops (Math.imul, shifts, xor) and an exact power-of-two division, so every JS engine
// produces the same sequence for the same seed.

/** FNV-1a, 32-bit. Stable seeds from strings such as building or player ids. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Any number or string to a uint32 seed. Non-finite numbers become 0. */
export function toSeed(seed: number | string): number {
  if (typeof seed === "string") return hashString(seed);
  if (!Number.isFinite(seed)) return 0;
  return Math.trunc(seed) >>> 0;
}

export interface Prng {
  /** Uniform uint32. */
  nextU32(): number;
  /** Uniform integer in [0, n). n must be a positive integer below 2^21. */
  int(n: number): number;
  /** Uniform element of a non-empty array. */
  pick<T>(xs: readonly T[]): T;
  /** Element chosen with the given non-negative integer weights (same length as xs). */
  weighted<T>(xs: readonly T[], weights: readonly number[]): T;
}

/** mulberry32 behind a seed scramble, so neighbouring seeds (0, 1, 2 ...) diverge at once. */
export function makePrng(seed: number | string): Prng {
  let a = scramble(toSeed(seed));
  const nextU32 = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
  const int = (n: number): number => {
    if (!Number.isInteger(n) || n <= 0 || n >= 2097152) throw new RangeError(`prng.int: bad bound ${n}`);
    return Math.floor((nextU32() / 4294967296) * n);
  };
  return {
    nextU32,
    int,
    pick<T>(xs: readonly T[]): T {
      if (xs.length === 0) throw new RangeError("prng.pick: empty array");
      return xs[int(xs.length)] as T;
    },
    weighted<T>(xs: readonly T[], weights: readonly number[]): T {
      if (xs.length === 0 || xs.length !== weights.length) throw new RangeError("prng.weighted: bad arrays");
      let total = 0;
      for (const w of weights) {
        if (!Number.isInteger(w) || w < 0) throw new RangeError(`prng.weighted: bad weight ${w}`);
        total += w;
      }
      let r = int(total);
      for (let i = 0; i < xs.length; i++) {
        r -= weights[i] as number;
        if (r < 0) return xs[i] as T;
      }
      return xs[xs.length - 1] as T;
    },
  };
}

/** murmur3 fmix32: a bijective avalanche on the seed. */
function scramble(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h | 0;
}
