// The reference road-surface lookup (schemas/world-colliders.md, "Decks and tunnels are road
// surfaces"): what the sim's surfaceHeight(x, z, yHint) returns once it reads the pack's decks
// and tunnels. At (x, z), for a body whose feet are near yHint:
//   - the candidates are the ground, every deck whose ribbon covers the point, and every tunnel
//     floor whose bore covers it;
//   - a body in a bore (feet under its ceiling, and under the ground above it) stands on the
//     bore's floor: the ground over the bore is not its surface;
//   - otherwise the surface is the highest candidate at or below the feet plus STEP_M (a car on
//     a viaduct stands on the deck, a car on the street under it on the ground).
// Pure and deterministic; a grid of ribbon segments makes each lookup O(1).

import type { Deck, Tunnel } from "./structures.ts";
import { PackGroundIndex, type WorldColliders } from "./world-colliders.ts";

/** A surface this far above the feet still counts (a kerb, a deck's joint). */
export const STEP_M = 0.5;
const CELL_M = 25;

export interface Surface {
  y: number;
  kind: "ground" | "deck" | "tunnel";
  /** The deck or tunnel piece. */
  id?: string;
  /** In a bore: its ceiling. */
  ceiling?: number;
}

interface Seg {
  ax: number; ay: number; az: number; aw: number;
  bx: number; by: number; bz: number; bw: number;
  id: string;
  tunnel: boolean;
  clearance: number;
}

export class SurfaceIndex {
  private readonly ground: PackGroundIndex;
  private readonly cells = new Map<number, number[]>();
  private readonly segs: Seg[] = [];

  constructor(world: WorldColliders) {
    this.ground = new PackGroundIndex(world);
    const add = (r: Deck | Tunnel, tunnel: boolean, clearance: number): void => {
      for (let i = 1; i < r.path.length; i++) {
        const a = r.path[i - 1]!, b = r.path[i]!;
        const k = this.segs.push({ ax: a[0], ay: a[1], az: a[2], aw: a[3], bx: b[0], by: b[1], bz: b[2], bw: b[3], id: r.id, tunnel, clearance }) - 1;
        const r2 = Math.max(a[3], b[3]) / 2;
        for (let cx = Math.floor((Math.min(a[0], b[0]) - r2) / CELL_M); cx <= Math.floor((Math.max(a[0], b[0]) + r2) / CELL_M); cx++) {
          for (let cz = Math.floor((Math.min(a[2], b[2]) - r2) / CELL_M); cz <= Math.floor((Math.max(a[2], b[2]) + r2) / CELL_M); cz++) {
            const key = (cx + 4096) * 8192 + cz + 4096;
            (this.cells.get(key) ?? this.cells.set(key, []).get(key)!).push(k);
          }
        }
      }
    };
    for (const t of world.tiles) {
      for (const d of t.decks ?? []) add(d, false, 0);
      for (const u of t.tunnels ?? []) add(u, true, u.clearanceM);
    }
  }

  /** The ribbon surfaces covering (x, z): each segment's height there. */
  private under(x: number, z: number): Array<{ y: number; seg: Seg }> {
    const out: Array<{ y: number; seg: Seg }> = [];
    for (const k of this.cells.get((Math.floor(x / CELL_M) + 4096) * 8192 + Math.floor(z / CELL_M) + 4096) ?? []) {
      const s = this.segs[k]!;
      const ex = s.bx - s.ax, ez = s.bz - s.az;
      const L2 = ex * ex + ez * ez;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - s.ax) * ex + (z - s.az) * ez) / L2)) : 0;
      const half = (s.aw + (s.bw - s.aw) * t) / 2;
      if (Math.hypot(x - (s.ax + ex * t), z - (s.az + ez * t)) > half) continue;
      out.push({ y: s.ay + (s.by - s.ay) * t, seg: s });
    }
    return out;
  }

  surfaceAt(x: number, z: number, yHint: number): Surface {
    const g = this.ground.heightAt(x, z);
    const ribbons = this.under(x, z);
    // In a bore: under its ceiling and under the ground above it.
    let bore: Surface | null = null;
    for (const { y, seg } of ribbons) {
      if (!seg.tunnel) continue;
      const ceiling = y + seg.clearance;
      if (yHint <= ceiling && yHint < g - STEP_M && yHint >= y - STEP_M && (!bore || y > bore.y)) bore = { y, kind: "tunnel", id: seg.id, ceiling };
    }
    if (bore) return bore;
    const cands: Surface[] = [{ y: g, kind: "ground" }];
    for (const { y, seg } of ribbons) if (!seg.tunnel) cands.push({ y, kind: "deck", id: seg.id });
    // The highest at or below the feet; a body under everything (feet below the ground) stands on the lowest.
    let best: Surface | null = null;
    for (const c of cands) if (c.y <= yHint + STEP_M && (!best || c.y > best.y)) best = c;
    if (best) return best;
    return cands.reduce((m, c) => (c.y < m.y ? c : m));
  }
}
