// W-14: streets that cross freeways and cuts launched the car: the bare-earth DEM removes the
// bridge, so a street over a freeway cut dives into the cut (Richland Ave's 15 m trench over
// San Jose Ave) and a street climbing embankments to a bridge humps over the gap. Every grade
// separation now carries the edge on top on an overpass deck (decks.ts) 5 m over the other; the
// crests a car at 25 m/s would leave (radius under 64 m, against a 20 m chord) round crossings are
// half as many or fewer than on the bare DEM, and none on the report's named crossings.

import { describe, expect, it, vi } from "vitest";
import { distToSegment } from "../../pipeline/lib/geom.ts";
import type { Deck, Tunnel } from "../../pipeline/lib/structures.ts";
import { readJson } from "../helpers.ts";
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

  // Every grade separation: two non-stair edges whose centrelines cross with no node in common.
  const usable = roads.edges.filter((e) => !e.stairs);
  const crossings: Array<{ f: Edge; g: Edge; X: number; Z: number }> = [];
  {
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
            crossings.push({ f, g, X: a[0] + rx * t, Z: a[1] + rz * t });
          }
        }
      }
    }
  }
  const profiles = new Map<string, ReturnType<typeof profile>>();
  const prof = (e: Edge): ReturnType<typeof profile> => profiles.get(e.id) ?? profiles.set(e.id, profile(e)).get(e.id)!;
  /** The worst crest within 40 m of a crossing on an edge's profile (built, or the bare ground). */
  const worstCrest = (e: Edge, X: number, Z: number, bare: boolean): { w: number; s: number } => {
    const p0 = prof(e);
    const p = bare ? p0.map((q) => ({ ...q, y: heightAt(q.x, q.z) })) : p0;
    const at = p.reduce((m, q, k) => (Math.hypot(q.x - X, q.z - Z) < Math.hypot(p[m]!.x - X, p[m]!.z - Z) ? k : m), 0);
    let worst = { w: 0, s: 0 };
    for (let k = Math.max(0, at - 20); k <= Math.min(p.length - 1, at + 20); k++) {
      const w = bend(p, k);
      if (w > worst.w) worst = { w, s: p[k]!.s };
    }
    return worst;
  };

  it("grade separations launch the car half as often or less than on the bare-earth DEM (crests a car at 25 m/s leaves, within 40 m of a crossing)", () => {
    expect(crossings.length).toBeGreaterThan(200);
    let built = 0, bare = 0;
    for (const { f, g, X, Z } of crossings) {
      for (const e of [f, g]) {
        if (e.tunnel) continue; // a bore far under the other
        if (worstCrest(e, X, Z, false).w > CREST_M) built++;
        if (worstCrest(e, X, Z, true).w > CREST_M) bare++;
      }
    }
    expect(bare).toBeGreaterThan(50);
    expect(built).toBeLessThanOrEqual(bare * 0.5);
  });

  it("the freeway crossings of Richland Ave, San Jose Ave, Geneva Ave, Paul Ave, 23rd St and Treasure Island Rd: none worse than the bare DEM, their crests together at most 60% of it", () => {
    const named = ["Richland Ave", "San Jose Ave", "Geneva Ave", "Paul Ave", "23rd St", "Treasure Island Rd"];
    const worse: string[] = [];
    let n = 0, built = 0, bare = 0;
    for (const { f, g, X, Z } of crossings) {
      const street = named.includes(f.name) ? f : named.includes(g.name) ? g : null;
      const other = street === f ? g : f;
      if (!street || !isFreeway(other) || isFreeway(street)) continue;
      n++;
      for (const e of [street, other]) {
        if (e.tunnel) continue;
        const c = worstCrest(e, X, Z, false), cb = worstCrest(e, X, Z, true);
        built += c.w;
        bare += cb.w;
        if (c.w > Math.max(CREST_M, cb.w) + 0.02) worse.push(`${e.id} ${e.name} crossing ${(e === f ? g : f).name} at s=${c.s.toFixed(0)}: crest ${c.w.toFixed(2)} m (bare ${cb.w.toFixed(2)} m)`);
      }
    }
    expect(n).toBeGreaterThanOrEqual(20);
    expect(worse).toEqual([]);
    expect(built).toBeLessThanOrEqual(bare * 0.6);
  });

  it("every overpass stands 5 m over the road it crosses (but the few crossings the report lists as unresolved)", () => {
    const decks = pack.tiles.flatMap((t) => t.decks ?? []).filter((d) => d.kind === "overpass");
    expect(decks.length).toBeGreaterThan(20);
    // Where neither road can bridge the other (a junction or a ramp's foot too near), the report
    // lists the crossing: a handful in the city.
    const unresolved = new Set(readJson<{ decks: { unresolvedCrossings: string[] } }>("public/tiles/sf/report.json").decks.unresolvedCrossings);
    expect(unresolved.size).toBeLessThanOrEqual(10);
    const bad: string[] = [];
    let n = 0;
    for (const { f, g, X, Z } of crossings) {
      if (unresolved.has(`${f.id}x${g.id}`) || unresolved.has(`${g.id}x${f.id}`)) continue;
      for (const [top, under] of [[f, g], [g, f]] as const) {
        const yTop = ribbonY((ribbons.get(top.id) ?? []).filter((r) => (r as Deck).kind === "overpass"), X, Z);
        if (yTop === null) continue;
        // A street over a bore is over the tunnel, not an overpass over its road.
        const own = ribbons.get(under.id) ?? [];
        if (ribbonY(own.filter((r) => r.kind === "tunnel"), X, Z) !== null) continue;
        const yUnder = ribbonY(own.filter((r) => r.kind !== "tunnel"), X, Z) ?? heightAt(X, Z);
        if (yUnder > yTop) continue; // the other is the one on top here
        n++;
        if (yTop - yUnder < 4.95) bad.push(`${top.id} ${top.name} over ${under.id} ${under.name}: ${(yTop - yUnder).toFixed(2)} m`);
      }
    }
    expect(n).toBeGreaterThan(20);
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
