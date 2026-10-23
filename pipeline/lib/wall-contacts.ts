// Where neighbouring footprints' walls meet (W-36): pairs of near-parallel walls of different
// footprints that overlap along their length, with the gap between them. A gap under
// TOUCH_M is a shared party wall; TOUCH_M to CRACK_M is a crack (the houses audit's categories).
// Used by pipeline/tools/shared-walls-fixture.ts (on the raw DataSF rings) and by
// tests/pipeline/shared-walls.test.ts (on the built colliders).

import type { P2 } from "./geom.ts";

export const TOUCH_M = 0.05;
export const CRACK_M = 0.6;
/** Walls are near-parallel within this angle. */
const MAX_ANGLE = (8 * Math.PI) / 180;
/** Walls must overlap at least this far along their length. */
const MIN_OVERLAP_M = 0.5;
/** Pairs farther apart than this are not neighbours. */
const MAX_GAP_M = 1.5;

export interface Footprint {
  /** Pieces of one building share an id (their walls with each other are not counted). */
  id: string;
  ring: readonly P2[];
}

export interface Contact {
  /** Worst gap over the overlap (metres, + = apart, - = overlapping), for the closest wall pair. */
  gap: number;
  /** The middle of that overlap, on the first footprint's wall. */
  at: P2;
}

/**
 * For every pair of footprints with near-parallel walls overlapping by MIN_OVERLAP_M within
 * MAX_GAP_M of each other: the closest such wall pair's gap. Keyed "idA|idB" with idA < idB.
 */
export function wallContacts(list: readonly Footprint[]): Map<string, Contact> {
  const C = 10;
  const sin = Math.sin(MAX_ANGLE);
  interface E { f: number; ax: number; az: number; bx: number; bz: number; ux: number; uz: number; len: number }
  const edges: E[] = [];
  const grid = new Map<number, number[]>();
  const key = (cx: number, cz: number): number => (cx + 16384) * 32768 + (cz + 16384);
  list.forEach((fp, fi) => {
    const r = fp.ring;
    for (let i = 0; i < r.length; i++) {
      const a = r[i]!;
      const b = r[(i + 1) % r.length]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < MIN_OVERLAP_M) continue;
      const ei = edges.push({ f: fi, ax: a[0], az: a[1], bx: b[0], bz: b[1], ux: (b[0] - a[0]) / len, uz: (b[1] - a[1]) / len, len }) - 1;
      for (let gx = Math.floor((Math.min(a[0], b[0]) - MAX_GAP_M) / C); gx <= Math.floor((Math.max(a[0], b[0]) + MAX_GAP_M) / C); gx++) {
        for (let gz = Math.floor((Math.min(a[1], b[1]) - MAX_GAP_M) / C); gz <= Math.floor((Math.max(a[1], b[1]) + MAX_GAP_M) / C); gz++) {
          const k = key(gx, gz);
          const l = grid.get(k);
          if (l) l.push(ei);
          else grid.set(k, [ei]);
        }
      }
    }
  });
  const out = new Map<string, Contact>();
  edges.forEach((e, ei) => {
    const seen = new Set<number>();
    for (let gx = Math.floor(Math.min(e.ax, e.bx) / C); gx <= Math.floor(Math.max(e.ax, e.bx) / C); gx++) {
      for (let gz = Math.floor(Math.min(e.az, e.bz) / C); gz <= Math.floor(Math.max(e.az, e.bz) / C); gz++) {
        for (const oi of grid.get(key(gx, gz)) ?? []) {
          if (oi <= ei || seen.has(oi)) continue;
          seen.add(oi);
          const o = edges[oi]!;
          if (o.f === e.f || Math.abs(e.ux * o.uz - e.uz * o.ux) > sin) continue;
          // Overlap of o's projection on e.
          const t0 = (o.ax - e.ax) * e.ux + (o.az - e.az) * e.uz;
          const t1 = (o.bx - e.ax) * e.ux + (o.bz - e.az) * e.uz;
          const lo = Math.max(0, Math.min(t0, t1));
          const hi = Math.min(e.len, Math.max(t0, t1));
          if (hi - lo < MIN_OVERLAP_M) continue;
          // Distance from e's line to o's line at both ends of the overlap: the worst is the gap.
          const at = (t: number): number => {
            const s = (t - t0) / (t1 - t0 || 1);
            const ox = o.ax + (o.bx - o.ax) * s;
            const oz = o.az + (o.bz - o.az) * s;
            return Math.abs((ox - e.ax) * e.uz - (oz - e.az) * e.ux);
          };
          const gap = Math.max(at(lo), at(hi));
          if (gap > MAX_GAP_M) continue;
          const A = list[e.f]!.id;
          const B = list[o.f]!.id;
          if (A === B) continue; // two pieces of one building
          const k = A < B ? `${A}|${B}` : `${B}|${A}`;
          const prev = out.get(k);
          if (!prev || gap < prev.gap) {
            const m = (lo + hi) / 2;
            out.set(k, { gap, at: [e.ax + e.ux * m, e.az + e.uz * m] });
          }
        }
      }
    }
  });
  return out;
}

/** Pairs whose closest walls are a crack (TOUCH_M to CRACK_M apart). */
export function countCracks(contacts: ReadonlyMap<string, Contact>): number {
  let n = 0;
  for (const c of contacts.values()) if (c.gap >= TOUCH_M && c.gap < CRACK_M) n++;
  return n;
}
