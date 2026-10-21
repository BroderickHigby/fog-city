// W-03 (and the deck part of W-07): freeways ran on the bare ground, through the streets they
// cross and the buildings beside them. Every freeway and ramp now has a profile (decks.ts):
// on decks where it leaves the ground, at least 5 m over every street it crosses, clear of the
// buildings under it, never steeper than 6% (8% where a ramp comes down to its street), and
// with no crest a car at speed would leave.

import { describe, expect, it, vi } from "vitest";
import { distToSegment, pointInRing } from "../../pipeline/lib/geom.ts";
import { Ground } from "../../pipeline/lib/terrain.ts";
import { CREST_RADIUS_M, DECK_CLEAR_M } from "../../pipeline/lib/decks.ts";
import type { Deck, Tunnel } from "../../pipeline/lib/structures.ts";
import { loadSfPack, type SfRoads } from "./util.ts";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

type Edge = SfRoads["edges"][number];
const isFreeway = (e: Edge): boolean => !!e.gradeSeparated || e.kind === "freeway" || e.kind === "ramp";

/** The surface of ribbons at (x, z): the nearest ribbon segment's height there, if within its half width. */
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

function samples(points: ReadonlyArray<[number, number]>, step: number): Array<[number, number]> {
  const out: Array<[number, number]> = [[points[0]![0], points[0]![1]]];
  for (let i = 1; i < points.length; i++) {
    const [ax, az] = points[i - 1]!;
    const [bx, bz] = points[i]!;
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n]);
  }
  return out;
}

describe("sf world: freeway decks (W-03, W-07)", () => {
  const { pack, roads, buildings, heightAt } = loadSfPack();
  const decks = pack.tiles.flatMap((t) => t.decks ?? []);
  const tunnels = pack.tiles.flatMap((t) => t.tunnels ?? []);
  const decksOf = new Map<string, Deck[]>();
  for (const d of decks) if (d.edge) (decksOf.get(d.edge) ?? decksOf.set(d.edge, []).get(d.edge)!).push(d);
  const tunnelsOf = new Map<string, Tunnel[]>();
  for (const t of tunnels) if (t.edge) (tunnelsOf.get(t.edge) ?? tunnelsOf.set(t.edge, []).get(t.edge)!).push(t);
  const fwy = roads.edges.filter(isFreeway);
  /** The road surface of an edge at (x, z): its deck, its bore or underpass, else the ground. */
  const surfaceY = (e: Edge, x: number, z: number): number => ribbonY(tunnelsOf.get(e.id) ?? [], x, z) ?? ribbonY(decksOf.get(e.id) ?? [], x, z) ?? heightAt(x, z);
  const fwDecks = decks.filter((d) => d.kind === "freeway" || d.kind === "ramp");

  it("I-80, US-101 and I-280 have decks: viaducts, kilometres of them", () => {
    let len = 0;
    for (const d of fwDecks) for (let i = 1; i < d.path.length; i++) len += Math.hypot(d.path[i]![0] - d.path[i - 1]![0], d.path[i]![2] - d.path[i - 1]![2]);
    expect(len).toBeGreaterThan(10_000);
    const names = new Set(fwDecks.map((d) => roads.edges.find((e) => e.id === d.edge)!.name));
    for (const n of ["I-80 Eastbound", "I-80 Westbound", "Hwy 101 Northbound", "Hwy 101 Southbound", "I-280 Northbound", "I-280 Southbound"]) expect(names.has(n), n).toBe(true);
    for (const d of fwDecks) expect(roads.edges.find((e) => e.id === d.edge)!.deck, d.id).toBe(true);
  });

  it("no deck runs under the ground", () => {
    const bad: string[] = [];
    for (const d of decks) for (const [x, y, z] of d.path) if (y < heightAt(x, z) - 0.02) bad.push(`${d.id} at ${x},${z}: ${(heightAt(x, z) - y).toFixed(2)} m under`);
    expect(bad).toEqual([]);
  });

  it("0 m of freeway or ramp centreline runs through a building (allow-list: none)", () => {
    const bad = new Set<string>();
    const boxes = buildings.map((b) => {
      let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
      for (const [x, z] of b.footprint) {
        bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x);
        bz0 = Math.min(bz0, z); bz1 = Math.max(bz1, z);
      }
      return [bx0, bz0, bx1, bz1] as const;
    });
    const grid = new Map<number, number[]>();
    boxes.forEach(([bx0, bz0, bx1, bz1], i) => {
      for (let cx = Math.floor(bx0 / 25); cx <= Math.floor(bx1 / 25); cx++) {
        for (let cz = Math.floor(bz0 / 25); cz <= Math.floor(bz1 / 25); cz++) {
          const k = (cx + 4096) * 8192 + cz + 4096;
          (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
        }
      }
    });
    for (const e of fwy) {
      for (const [x, z] of samples(e.points, 1)) {
        const cell = grid.get((Math.floor(x / 25) + 4096) * 8192 + Math.floor(z / 25) + 4096) ?? [];
        if (!cell.length) continue;
        const y = surfaceY(e, x, z);
        for (const i of cell) {
          const b = buildings[i]!;
          if (!pointInRing(x, z, b.footprint)) continue;
          if (b.topY > y + 0.5 && (b.underY ?? -Infinity) < y + 4.5) bad.add(`${e.id} ${e.name}: ${b.id}`);
        }
      }
    }
    expect([...bad].sort()).toEqual([]);
  });

  it(`every deck stands ${DECK_CLEAR_M} m over every street it crosses`, () => {
    // A 50 m grid of street segments.
    const grid = new Map<number, Array<[Edge, number]>>();
    const key = (cx: number, cz: number): number => (cx + 4096) * 8192 + cz + 4096;
    for (const g of roads.edges) {
      if (isFreeway(g)) continue;
      for (let j = 1; j < g.points.length; j++) {
        const c = g.points[j - 1]!, f = g.points[j]!;
        for (let cx = Math.floor(Math.min(c[0], f[0]) / 50); cx <= Math.floor(Math.max(c[0], f[0]) / 50); cx++) {
          for (let cz = Math.floor(Math.min(c[1], f[1]) / 50); cz <= Math.floor(Math.max(c[1], f[1]) / 50); cz++) {
            (grid.get(key(cx, cz)) ?? grid.set(key(cx, cz), []).get(key(cx, cz))!).push([g, j]);
          }
        }
      }
    }
    const bad: string[] = [];
    let crossings = 0;
    for (const d of fwDecks) {
      for (let i = 1; i < d.path.length; i++) {
        const a = d.path[i - 1]!, b = d.path[i]!;
        const cand = new Set<[Edge, number]>();
        for (let cx = Math.floor(Math.min(a[0], b[0]) / 50); cx <= Math.floor(Math.max(a[0], b[0]) / 50); cx++) {
          for (let cz = Math.floor(Math.min(a[2], b[2]) / 50); cz <= Math.floor(Math.max(a[2], b[2]) / 50); cz++) {
            for (const q of grid.get(key(cx, cz)) ?? []) cand.add(q);
          }
        }
        for (const [g, j] of cand) {
          {
            const c = g.points[j - 1]!, f = g.points[j]!;
            const rx = b[0] - a[0], rz = b[2] - a[2], sx = f[0] - c[0], sz = f[1] - c[1];
            const den = rx * sz - rz * sx;
            if (Math.abs(den) < 1e-12) continue;
            const qx = c[0] - a[0], qz = c[1] - a[2];
            const t = (qx * sz - qz * sx) / den, u = (qx * rz - qz * rx) / den;
            if (t < 0 || t > 1 || u < 0 || u > 1) continue;
            const x = a[0] + rx * t, z = a[2] + rz * t;
            const deckY = a[1] + (b[1] - a[1]) * t;
            const streetY = surfaceY(g, x, z);
            // A street on an overpass over the freeway: it is the one on top.
            if ((decksOf.get(g.id) ?? []).some((q) => q.kind === "overpass") && streetY > deckY) continue;
            crossings++;
            if (deckY - streetY < DECK_CLEAR_M - 0.05) bad.push(`${d.id} over ${g.id} ${g.name}: ${(deckY - streetY).toFixed(2)} m`);
          }
        }
      }
    }
    expect(crossings).toBeGreaterThan(100);
    expect(bad).toEqual([]);
  });

  it("decks are no steeper than 6% (water 0.5%; 8% where a ramp comes down to its street) and round every crest", () => {
    const bad: string[] = [];
    for (const d of fwDecks) {
      const p = d.path;
      for (let i = 1; i < p.length; i++) {
        const ds = Math.hypot(p[i]![0] - p[i - 1]![0], p[i]![2] - p[i - 1]![2]);
        if (ds < 0.5) continue;
        const g = Math.abs(p[i]![1] - p[i - 1]![1]) / ds;
        const limit = d.kind === "ramp" ? 0.081 : 0.0605;
        if (g > limit + 0.01 / ds) bad.push(`${d.id} grade ${(g * 100).toFixed(1)}% at ${p[i]![0]},${p[i]![2]}`);
      }
      for (let i = 1; i + 1 < p.length; i++) {
        const dj = Math.hypot(p[i]![0] - p[i - 1]![0], p[i]![2] - p[i - 1]![2]);
        const dk = Math.hypot(p[i + 1]![0] - p[i]![0], p[i + 1]![2] - p[i]![2]);
        if (dj < 0.5 || dk < 0.5) continue;
        const interp = (dk * p[i - 1]![1] + dj * p[i + 1]![1]) / (dj + dk);
        if (p[i]![1] - interp > (dj * dk) / (2 * CREST_RADIUS_M) + 0.02) bad.push(`${d.id} crest at ${p[i]![0]},${p[i]![2]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("I-280 crosses Mission Creek and Islais Creek on decks 3 m or more above the water (W-07)", () => {
    const g = new Ground(pack.tiles.map((t) => ({ ix: t.ix, iz: t.iz, field: t.ground })));
    let wet = 0;
    for (const d of fwDecks) {
      const name = roads.edges.find((e) => e.id === d.edge)!.name;
      if (!/^I-280/.test(name)) continue;
      for (let i = 1; i < d.path.length; i++) {
        const a = d.path[i - 1]!, b = d.path[i]!;
        const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[2] - a[2]) / 2));
        for (let k = 0; k <= n; k++) {
          const x = a[0] + ((b[0] - a[0]) * k) / n, y = a[1] + ((b[1] - a[1]) * k) / n, z = a[2] + ((b[2] - a[2]) * k) / n;
          if (!g.waterAt(x, z)) continue;
          wet++;
          expect(y, `${d.id} at ${x.toFixed(1)},${z.toFixed(1)}`).toBeGreaterThanOrEqual(3);
        }
      }
    }
    expect(wet).toBeGreaterThan(5);
  });

  it("the MacArthur Tunnel and the Presidio Parkway's Battery Tunnel are freeway bores, not decks over the hills", () => {
    const bored = new Set(tunnels.filter((t) => t.kind === "tunnel").map((t) => roads.edges.find((e) => e.id === t.edge)!.name));
    for (const n of ["Hwy 1 Northbound", "Hwy 1 Southbound", "Hwy 101 Northbound", "Hwy 101 Southbound"]) expect(bored.has(n), n).toBe(true);
  });
});
