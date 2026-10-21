// W-14: streets that cross freeways and cuts launched the car: the bare-earth DEM removes the
// bridge, so a street over a freeway cut dives into the cut (Richland Ave's 15 m trench over
// San Jose Ave) and a street climbing embankments to a bridge humps over the gap. Every grade
// separation now carries the edge on top on an overpass deck (decks.ts), and both edges' surfaces
// (deck or ground) cross with no crest a car at 25 m/s would leave (radius 64 m) and no trench
// over 1 m (both against a 20 m chord).

import { describe, expect, it, vi } from "vitest";
import { distToSegment } from "../../pipeline/lib/geom.ts";
import type { Deck, Tunnel } from "../../pipeline/lib/structures.ts";
import { loadSfPack, type SfRoads } from "./util.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

type Edge = SfRoads["edges"][number];
const isFreeway = (e: Edge): boolean => !!e.gradeSeparated || e.kind === "freeway" || e.kind === "ramp";

function ribbonY(ribbons: ReadonlyArray<Deck | Tunnel>, x: number, z: number): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  for (const r of ribbons) {
    for (let i = 1; i < r.path.length; i++) {
      const a = r.path[i - 1]!, b = r.path[i]!;
      const q = distToSegment(x, z, [a[0], a[2]], [b[0], b[2]]);
      if (q.d <= Math.max(a[3], b[3]) / 2 + 0.25 && q.d < bestD) {
        bestD = q.d;
        best = a[1] + (b[1] - a[1]) * q.t;
      }
    }
  }
  return best;
}

/** Arc length and point of a polyline every `step` metres. */
function stationsOf(points: ReadonlyArray<[number, number]>, step: number): Array<{ s: number; x: number; z: number }> {
  const out = [{ s: 0, x: points[0]![0], z: points[0]![1] }];
  let s = 0;
  for (let i = 1; i < points.length; i++) {
    const [ax, az] = points[i - 1]!;
    const [bx, bz] = points[i]!;
    const L = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(L / step));
    for (let k = 1; k <= n; k++) out.push({ s: s + (L * k) / n, x: ax + ((bx - ax) * k) / n, z: az + ((bz - az) * k) / n });
    s += L;
  }
  return out;
}

describe("sf world: grade separations (W-14)", () => {
  const { pack, roads, heightAt } = loadSfPack();
  const ribbons = new Map<string, Array<Deck | Tunnel>>();
  for (const r of pack.tiles.flatMap((t) => [...(t.decks ?? []), ...(t.tunnels ?? [])])) if (r.edge) (ribbons.get(r.edge) ?? ribbons.set(r.edge, []).get(r.edge)!).push(r);
  /** An edge's drawn and driven surface every 2 m: its deck or bore, else the ground. */
  const profile = (e: Edge): Array<{ s: number; x: number; z: number; y: number }> =>
    stationsOf(e.points, 2).map((q) => ({ ...q, y: ribbonY(ribbons.get(e.id) ?? [], q.x, q.z) ?? heightAt(q.x, q.z) }));
  /** Crest (+) and sag (-) of the surface at station i against the stations D metres either side. */
  const D = 10;
  const bend = (p: ReturnType<typeof profile>, i: number): number => {
    const k = D / 2;
    if (i - k < 0 || i + k >= p.length) return 0;
    return p[i]!.y - (p[i - k]!.y + p[i + k]!.y) / 2;
  };
  /** A car at 25 m/s leaves a crest tighter than v^2/g = 64 m: over a 20 m chord, D^2/(2R). */
  const CREST_M = (D * D) / (2 * 64);
  const TRENCH_M = 1;

  it("every grade separation (two edges crossing with no node in common) is crossed with no launching crest and no trench over 1 m", () => {
    const usable = roads.edges.filter((e) => !e.stairs);
    const box = (e: Edge): [number, number, number, number] => {
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const [x, z] of e.points) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x);
        z0 = Math.min(z0, z); z1 = Math.max(z1, z);
      }
      return [x0, z0, x1, z1];
    };
    const boxes = new Map(usable.map((e) => [e.id, box(e)]));
    const grid = new Map<number, Edge[]>();
    const key = (cx: number, cz: number): number => (cx + 4096) * 8192 + cz + 4096;
    for (const e of usable) {
      const [x0, z0, x1, z1] = boxes.get(e.id)!;
      for (let cx = Math.floor(x0 / 100); cx <= Math.floor(x1 / 100); cx++) for (let cz = Math.floor(z0 / 100); cz <= Math.floor(z1 / 100); cz++) (grid.get(key(cx, cz)) ?? grid.set(key(cx, cz), []).get(key(cx, cz))!).push(e);
    }
    const profiles = new Map<string, ReturnType<typeof profile>>();
    const prof = (e: Edge): ReturnType<typeof profile> => profiles.get(e.id) ?? profiles.set(e.id, profile(e)).get(e.id)!;
    const bad: string[] = [];
    let n = 0;
    for (const f of usable) {
      const [x0, z0, x1, z1] = boxes.get(f.id)!;
      const near = new Set<Edge>();
      for (let cx = Math.floor(x0 / 100); cx <= Math.floor(x1 / 100); cx++) for (let cz = Math.floor(z0 / 100); cz <= Math.floor(z1 / 100); cz++) for (const g of grid.get(key(cx, cz)) ?? []) near.add(g);
      for (const g of near) {
        if (g.id <= f.id || g.a === f.a || g.a === f.b || g.b === f.a || g.b === f.b) continue;
        for (let i = 1; i < f.points.length; i++) {
          const a = f.points[i - 1]!, b = f.points[i]!;
          for (let j = 1; j < g.points.length; j++) {
            const c = g.points[j - 1]!, d = g.points[j]!;
            const rx = b[0] - a[0], rz = b[1] - a[1], sx = d[0] - c[0], sz = d[1] - c[1];
            const den = rx * sz - rz * sx;
            if (Math.abs(den) < 1e-12) continue;
            const qx = c[0] - a[0], qz = c[1] - a[1];
            const t = (qx * sz - qz * sx) / den, u = (qx * rz - qz * rx) / den;
            if (t < 0 || t > 1 || u < 0 || u > 1) continue;
            const X = a[0] + rx * t, Z = a[1] + rz * t;
            n++;
            for (const e of [f, g]) {
              if (e.tunnel) continue; // a bore far under the other
              const p = prof(e);
              const at = p.reduce((m, q, k) => (Math.hypot(q.x - X, q.z - Z) < Math.hypot(p[m]!.x - X, p[m]!.z - Z) ? k : m), 0);
              for (let k = Math.max(0, at - 20); k <= Math.min(p.length - 1, at + 20); k++) {
                const w = bend(p, k);
                if (w > CREST_M || -w > TRENCH_M) {
                  bad.push(`${e.id} ${e.name} crossing ${(e === f ? g : f).name} at s=${p[k]!.s.toFixed(0)}: ${w > 0 ? "crest" : "trench"} ${Math.abs(w).toFixed(2)} m`);
                  break;
                }
              }
            }
          }
        }
      }
    }
    expect(n).toBeGreaterThan(200);
    expect(bad).toEqual([]);
  });

  it("Richland Ave (over San Jose Ave's cut) has no launching crest or trench anywhere: the 15 m trench is bridged", () => {
    const es = roads.edges.filter((e) => e.name === "Richland Ave");
    expect(es.length).toBeGreaterThan(0);
    expect(ribbons.get("c11011002")?.some((r) => (r as Deck).kind === "overpass")).toBe(true);
    for (const e of es) {
      const p = profile(e);
      for (let k = 0; k < p.length; k++) {
        const w = bend(p, k);
        expect(w, `${e.id} at s=${p[k]!.s.toFixed(0)}`).toBeLessThanOrEqual(CREST_M);
        expect(-w, `${e.id} at s=${p[k]!.s.toFixed(0)}`).toBeLessThanOrEqual(TRENCH_M);
      }
    }
  });
});
