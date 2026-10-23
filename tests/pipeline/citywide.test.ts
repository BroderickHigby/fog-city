// Goldens on the citywide world (public/tiles/sf): terrain landmarks, routing across the city,
// districts, the sidewalk graph and the gameplay layers. No network: committed files only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { inPolygon } from "../../pipeline/lib/districts.ts";
import { signedArea, type P2 } from "../../pipeline/lib/geom.ts";
import { decodeWorldColliders, PackGroundIndex } from "../../pipeline/lib/world-colliders.ts";
import { TILE_SIZE_M, tileId, toLocal } from "../../src/geo/project.ts";
import { SOUTH_CROP_Z } from "../../pipeline/lib/build.ts";
import { pointInPolygon } from "../../src/sim/index.ts";
import { ROOT, readJson } from "../helpers.ts";
import type { SfManifest, SfRoads } from "./util.ts";

// Whole-city checks: generous timeouts, since the suite shares the CPU with other workers.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const DIR = "public/tiles/sf";
const manifest = readJson<SfManifest>(`${DIR}/manifest.json`);
const roads = readJson<SfRoads>(`${DIR}/roads.json`);
const pack = decodeWorldColliders(new Uint8Array(readFileSync(join(ROOT, DIR, manifest.worldColliders))));
const ground = new PackGroundIndex(pack);
const tiles = new Map(pack.tiles.map((t) => [t.tileId, t]));
const layer = <T>(name: string): T => readJson<T>(`${DIR}/${manifest.layers[name]}`);

const at = (lat: number, lon: number): { x: number; z: number } => toLocal(lat, lon);
const isWater = (x: number, z: number): boolean => {
  const t = tiles.get(tileId(Math.floor(x / TILE_SIZE_M), Math.floor(z / TILE_SIZE_M)));
  if (!t) return true;
  const i = Math.round((x - t.ground.x0) / 10);
  const k = Math.round((z - t.ground.z0) / 10);
  return t.ground.water[k * 51 + i] === 1;
};

/**
 * Clearance from the road surfaces (centreline +- half width, pedestrian-only ways excluded):
 * metres outside the nearest kerb line, negative inside a road. Independent of the pipeline's
 * road-surface.ts. Clearances of 3 m and more come back as 3.
 */
const roadClearance = (() => {
  const C = 25;
  const cells = new Map<string, Array<[number, number, number, number, number]>>();
  for (const e of roads.edges) {
    if (e.pedestrian) continue;
    for (let i = 1; i < e.points.length; i++) {
      const [ax, az] = e.points[i - 1]!, [bx, bz] = e.points[i]!;
      const pad = e.widthM / 2 + 3;
      for (let cx = Math.floor((Math.min(ax, bx) - pad) / C); cx <= Math.floor((Math.max(ax, bx) + pad) / C); cx++) {
        for (let cz = Math.floor((Math.min(az, bz) - pad) / C); cz <= Math.floor((Math.max(az, bz) + pad) / C); cz++) {
          const k = `${cx},${cz}`;
          (cells.get(k) ?? cells.set(k, []).get(k)!).push([ax, az, bx, bz, e.widthM / 2]);
        }
      }
    }
  }
  return (x: number, z: number): number => {
    let best = 3;
    for (const [ax, az, bx, bz, half] of cells.get(`${Math.floor(x / C)},${Math.floor(z / C)}`) ?? []) {
      const ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2)) : 0;
      best = Math.min(best, Math.hypot(x - ax - ex * t, z - az - ez * t) - half);
    }
    return best;
  };
})();

describe("citywide: coverage", () => {
  it("covers the whole city: every district's land, the Presidio, Ocean Beach, the southern limit, Treasure Island", () => {
    const sel = readJson<{ selection: Record<string, number> }>(`${DIR}/report.json`).selection;
    expect(manifest.tiles.length).toBeGreaterThan(550);
    expect(sel.built).toBe(manifest.tiles.length);
    expect(sel.water).toBe(manifest.water.tiles.length);
    const has = (lat: number, lon: number): boolean => {
      const p = at(lat, lon);
      return tiles.has(tileId(Math.floor(p.x / TILE_SIZE_M), Math.floor(p.z / TILE_SIZE_M)));
    };
    for (const [name, lat, lon] of [
      ["Golden Gate Bridge toll plaza", 37.8075, -122.4753],
      ["Presidio", 37.7989, -122.4662],
      ["Ocean Beach", 37.7604, -122.5096],
      ["Lands End", 37.7802, -122.5049],
      ["Lake Merced", 37.7258, -122.4935],
      ["Visitacion Valley (southern limit)", 37.7110, -122.4045],
      ["Hunters Point", 37.7273, -122.3708],
      ["Treasure Island", 37.8235, -122.3707],
      ["Yerba Buena Island", 37.8098, -122.3646],
      ["Bay Bridge touchdown", 37.7880, -122.3900],
      ["Twin Peaks", 37.7516, -122.4478],
      ["Mission", 37.7599, -122.4148],
    ] as const) {
      expect(has(lat, lon), name).toBe(true);
    }
  });

  it("marks the open Bay and Pacific as water tiles the renderer fills with sea", () => {
    const ws = new Set(manifest.water.tiles);
    for (const [name, lat, lon] of [
      ["the Pacific off Ocean Beach, at the world's west edge", 37.745, -122.5155],
      ["the Bay between the city and Treasure Island", 37.812, -122.385],
    ] as const) {
      const p = at(lat, lon);
      expect(ws.has(tileId(Math.floor(p.x / TILE_SIZE_M), Math.floor(p.z / TILE_SIZE_M))), name).toBe(true);
    }
    expect(manifest.water.y).toBe(0);
    for (const t of manifest.tiles) expect(ws.has(t.id)).toBe(false);
  });

  it("lists every land tile with no file, by area: Alcatraz (in SF, no city data), Marin, San Mateo County", () => {
    const sel = readJson<{ selection: { candidates: number; outside: number } }>(`${DIR}/report.json`).selection;
    const out = new Map(manifest.outside.tiles.map((t) => [t.id, t.area]));
    expect(out.size).toBe(sel.outside);
    // Every candidate tile is exactly one of: built, open water, land outside the world.
    const built = new Set(manifest.tiles.map((t) => t.id));
    const water = new Set(manifest.water.tiles);
    for (const id of out.keys()) {
      expect(built.has(id) || water.has(id), id).toBe(false);
    }
    // W-40: the outside ring may reach past the candidate rectangle (manifest.water.bbox); every
    // such tile is land beside a built tile. The rest partition the candidates.
    const [wx0, wz0, wx1, wz1] = manifest.water.bbox;
    const beyond = manifest.outside.tiles.filter((t) => {
      const m = /^t(-?\d+)_(-?\d+)$/.exec(t.id)!;
      const x = Number(m[1]) * TILE_SIZE_M + 1, z = Number(m[2]) * TILE_SIZE_M + 1;
      return x < wx0 || x > wx1 || z < wz0 || z > wz1;
    });
    for (const t of beyond) {
      const m = /^t(-?\d+)_(-?\d+)$/.exec(t.id)!;
      const ix = Number(m[1]), iz = Number(m[2]);
      expect([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => built.has(tileId(ix + dx!, iz + dz!))), t.id).toBe(true);
    }
    expect(beyond.length).toBeLessThanOrEqual(8);
    expect(built.size + water.size + out.size - beyond.length).toBe(sel.candidates);
    const area = (lat: number, lon: number): string | undefined => {
      const p = at(lat, lon);
      return out.get(tileId(Math.floor(p.x / TILE_SIZE_M), Math.floor(p.z / TILE_SIZE_M)));
    };
    expect(area(37.8267, -122.423), "Alcatraz").toBe("alcatraz");
    expect(area(37.8302, -122.4836), "Marin headlands at the bridge").toBe("marin");
    expect(area(37.7025, -122.4615), "Daly City, south of the city limit").toBe("san-mateo-county");
    expect(new Set(out.values()).has("other")).toBe(false);
  });
});

describe("citywide: terrain goldens", () => {
  it("Twin Peaks: the summit next to 37.7544, -122.4477 stands 270-290 m (the coordinate itself is on its north slope)", () => {
    const c = at(37.7544, -122.4477);
    let top = -Infinity;
    for (let dx = -150; dx <= 150; dx += 2) for (let dz = -150; dz <= 150; dz += 2) if (Math.hypot(dx, dz) <= 150) top = Math.max(top, ground.heightAt(c.x + dx, c.z + dz));
    expect(top).toBeGreaterThan(270);
    expect(top).toBeLessThan(290);
    expect(ground.heightAt(c.x, c.z)).toBeGreaterThan(230);
    // And the south peak, 310 m away, is the city's other summit.
    const s = at(37.7516, -122.4478);
    expect(ground.heightAt(s.x, s.z)).toBeGreaterThan(270);
  });

  it("the highest ground in the city is under 290 m (Mount Davidson, 282 m)", () => {
    let max = -Infinity;
    for (const t of pack.tiles) for (const h of t.ground.heights) max = Math.max(max, h);
    expect(max).toBeGreaterThan(275);
    expect(max).toBeLessThan(290);
    const d = at(37.7383, -122.4542);
    expect(ground.heightAt(d.x, d.z)).toBeGreaterThan(270);
  });

  it("Ocean Beach is near sea level: open Pacific to the west, the sand under 5 m within 30 m of the water's edge", () => {
    for (const lat of [37.735, 37.75, 37.76, 37.77]) {
      const z = at(lat, -122.5).z;
      let shore = NaN;
      for (let x = -11000; x < -9500; x += 5) {
        if (!isWater(x, z)) {
          shore = x;
          break;
        }
      }
      expect(Number.isFinite(shore), `shore at ${lat}`).toBe(true);
      expect(isWater(shore - 100, z)).toBe(true);
      expect(ground.heightAt(shore - 100, z)).toBe(0);
      expect(ground.heightAt(shore + 30, z), `sand at ${lat}`).toBeLessThan(5);
      expect(ground.heightAt(shore + 150, z), `Great Highway side at ${lat}`).toBeLessThan(15);
    }
  });
});

/** Directed road graph (one-ways respected, pedestrian ways excluded): Dijkstra from a node. */
function shortest(from: string): Map<string, number> {
  const adj = new Map<string, Array<[string, number]>>();
  const link = (a: string, b: string, w: number): void => {
    let l = adj.get(a);
    if (!l) adj.set(a, (l = []));
    l.push([b, w]);
  };
  for (const e of roads.edges) {
    if (e.pedestrian) continue;
    let len = 0;
    for (let i = 1; i < e.points.length; i++) len += Math.hypot(e.points[i]![0] - e.points[i - 1]![0], e.points[i]![1] - e.points[i - 1]![1]);
    link(e.a, e.b, len);
    if (!e.oneway) link(e.b, e.a, len);
  }
  const dist = new Map<string, number>([[from, 0]]);
  const done = new Set<string>();
  // Binary heap of [distance, node].
  const heap: Array<[number, string]> = [[0, from]];
  const push = (d: number, n: string): void => {
    heap.push([d, n]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p]![0] <= heap[i]![0]) break;
      [heap[p], heap[i]] = [heap[i]!, heap[p]!];
      i = p;
    }
  };
  const pop = (): [number, string] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l;
        if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i]!, heap[m]!];
        i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [d, n] = pop();
    if (done.has(n)) continue;
    done.add(n);
    for (const [m, w] of adj.get(n) ?? []) {
      const nd = d + w;
      if (nd < (dist.get(m) ?? Infinity)) {
        dist.set(m, nd);
        push(nd, m);
      }
    }
  }
  return dist;
}

/** The road node nearest a lat/lon that a car can use (not only on pedestrian ways). */
function nodeNear(lat: number, lon: number, kinds?: readonly string[]): { id: string; d: number } {
  const p = at(lat, lon);
  const usable = new Set(roads.edges.filter((e) => !e.pedestrian && (!kinds || kinds.includes(e.kind))).flatMap((e) => [e.a, e.b]));
  let best = { id: "", d: Infinity };
  for (const n of roads.nodes) {
    if (!usable.has(n.id)) continue;
    const d = Math.hypot(n.x - p.x, n.z - p.z);
    if (d < best.d) best = { id: n.id, d };
  }
  return best;
}

describe("citywide: the road graph joins the city", () => {
  let fromFerry: Map<string, number>;
  beforeAll(() => {
    const ferry = nodeNear(37.7955, -122.3937);
    expect(ferry.d).toBeLessThan(150);
    fromFerry = shortest(ferry.id);
  });

  it("routes the Ferry Building to Pier 70 (Dogpatch) in at most 5.5 km", () => {
    const pier70 = nodeNear(37.7606, -122.3838);
    expect(pier70.d).toBeLessThan(150);
    const d = fromFerry.get(pier70.id);
    expect(d, "Pier 70 is reachable").toBeDefined();
    expect(d!).toBeLessThanOrEqual(5500);
    expect(d!).toBeGreaterThan(3900); // the straight line is ~3.9 km
  });

  it("reaches the Golden Gate Bridge toll plaza and Ocean Beach", () => {
    const toll = nodeNear(37.8075, -122.4753);
    expect(toll.d).toBeLessThan(250);
    const beach = nodeNear(37.7648, -122.5085);
    expect(beach.d).toBeLessThan(150);
    expect(fromFerry.get(toll.id), "toll plaza").toBeLessThan(15000);
    expect(fromFerry.get(beach.id), "Ocean Beach").toBeLessThan(16000);
  });

  it("one component holds almost every node", () => {
    const reached = [...fromFerry.keys()].length;
    expect(reached / roads.nodes.length).toBeGreaterThan(0.95);
  });
});

interface Districts {
  districts: Array<{ id: string; name: string; polygons: P2[][][]; bbox: number[]; areaM2: number; tiles: string[] }>;
}

function segmentsCross(a: P2, b: P2, c: P2, d: P2): boolean {
  const o = (p: P2, q: P2, r: P2): number => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

describe("citywide: districts", () => {
  const ds = layer<Districts>("districts").districts;

  it("41 neighbourhoods with unique slug ids, each tile list naming built tiles", () => {
    expect(ds.length).toBe(41);
    expect(new Set(ds.map((d) => d.id)).size).toBe(ds.length);
    const built = new Set(manifest.tiles.map((t) => t.id));
    for (const d of ds) {
      expect(d.tiles.length, d.id).toBeGreaterThan(0);
      for (const t of d.tiles) expect(built.has(t), `${d.id} ${t}`).toBe(true);
    }
    for (const name of ["Financial District/South Beach", "Mission", "Presidio", "Golden Gate Park", "Treasure Island", "Twin Peaks", "Sunset/Parkside"]) {
      expect(ds.some((d) => d.name === name), name).toBe(true);
    }
  });

  it("every polygon validates: rings of 3+ points, outer counter-clockwise and holes clockwise, no self-intersection, holes inside", () => {
    for (const d of ds) {
      let area = 0;
      for (const poly of d.polygons) {
        poly.forEach((ring, i) => {
          expect(ring.length, d.id).toBeGreaterThanOrEqual(3);
          const a = signedArea(ring);
          if (i === 0) expect(a, `${d.id} outer`).toBeLessThan(0);
          else {
            expect(a, `${d.id} hole`).toBeGreaterThan(0);
            const inside = ring.filter(([x, z]) => pointInPolygon(x, z, poly[0]!)).length;
            expect(inside / ring.length, `${d.id} hole inside its outer ring`).toBeGreaterThan(0.9);
          }
          area -= a;
          // Simple ring: no two non-adjacent edges cross.
          const n = ring.length;
          const crossing: string[] = [];
          for (let p = 0; p < n; p++) {
            for (let q = p + 2; q < n; q++) {
              if (p === 0 && q === n - 1) continue;
              if (segmentsCross(ring[p]!, ring[(p + 1) % n]!, ring[q]!, ring[(q + 1) % n]!)) crossing.push(`${p}/${q}`);
            }
          }
          expect(crossing, `${d.id} ring ${i} self-intersects`).toEqual([]);
        });
      }
      expect(Math.abs(area - d.areaM2), d.id).toBeLessThan(2);
    }
  });

  it("districts contain their landmarks, and together cover about the city's 121 km² of land", () => {
    const where = (lat: number, lon: number): string | undefined => {
      const p = at(lat, lon);
      return ds.find((d) => d.polygons.some((poly) => inPolygon(p.x, p.z, poly)))?.id;
    };
    expect(where(37.7955, -122.3937)).toBe("financial-district-south-beach");
    expect(where(37.7599, -122.4148)).toBe("mission");
    expect(where(37.7516, -122.4478)).toBe("twin-peaks");
    expect(where(37.7694, -122.4862)).toBe("golden-gate-park");
    expect(where(37.8235, -122.3707)).toBe("treasure-island");
    const total = ds.reduce((s, d) => s + d.areaM2, 0) / 1e6;
    expect(total).toBeGreaterThan(115);
    expect(total).toBeLessThan(130);
  });
});

interface Walk {
  nodes: Array<{ id: string; x: number; z: number; y: number; road: string }>;
  edges: Array<{ id: string; a: string; b: string; kind: string; lengthM: number; road: string; side?: string; signal?: boolean; marked?: boolean; points?: P2[] }>;
}

describe("citywide: sidewalk graph", () => {
  const walk = layer<Walk>("sidewalks");
  const nodes = new Map(walk.nodes.map((n) => [n.id, n]));

  it("every edge connects existing nodes; ids are unique; lengths match the geometry", () => {
    expect(nodes.size).toBe(walk.nodes.length);
    const stats = readJson<{ sidewalks: { nodes: number; edges: number; sidewalks: number; crossings: number } }>(`${DIR}/report.json`).sidewalks;
    expect([stats.nodes, stats.edges, stats.sidewalks + stats.crossings]).toEqual([walk.nodes.length, walk.edges.length, walk.edges.length]);
    const ids = new Set<string>();
    const roadIds = new Set(roads.edges.map((e) => e.id));
    for (const e of walk.edges) {
      expect(ids.has(e.id), e.id).toBe(false);
      ids.add(e.id);
      const a = nodes.get(e.a), b = nodes.get(e.b);
      expect(a, `${e.id}.a`).toBeDefined();
      expect(b, `${e.id}.b`).toBeDefined();
      expect(roadIds.has(e.road), e.id).toBe(true);
      const pts: P2[] = [[a!.x, a!.z], ...(e.points ?? []), [b!.x, b!.z]];
      let len = 0;
      for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
      expect(Math.abs(len - e.lengthM), e.id).toBeLessThan(0.05);
    }
  });

  it("walkable road edges have a sidewalk each side (unless that side lies on another road), half the width plus 2 m out", () => {
    const sides = new Map<string, Set<string>>();
    for (const e of walk.edges) {
      if (e.kind !== "sidewalk") continue;
      // Whole sidewalks are <road>.<side>; pieces cut where another road crosses are <road>.<side>.<k>.
      expect(e.id, e.id).toMatch(new RegExp(`^${e.road}\\.${e.side}(\\.\\d+)?$`));
      (sides.get(e.road) ?? sides.set(e.road, new Set()).get(e.road)!).add(e.side!);
    }
    const byId = new Map(roads.edges.map((e) => [e.id, e]));
    let walkable = 0, both = 0;
    for (const e of roads.edges) {
      if (e.kind === "freeway" || e.kind === "ramp") expect(sides.has(e.id)).toBe(false);
      else {
        walkable++;
        if (sides.get(e.id)?.size === 2) both++;
      }
    }
    expect(both / walkable).toBeGreaterThan(0.85);
    // Offsets: interior points of a straight-ish sidewalk sit half the width + 2 m from the centreline.
    let checked = 0;
    for (const w of walk.edges) {
      if (w.kind !== "sidewalk" || !w.points) continue;
      const r = byId.get(w.road)!;
      for (const [x, z] of w.points) {
        let d = Infinity;
        for (let i = 1; i < r.points.length; i++) {
          const [ax, az] = r.points[i - 1]!, [bx, bz] = r.points[i]!;
          const ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez;
          const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (l2 || 1)));
          d = Math.min(d, Math.hypot(ax + ex * t - x, az + ez * t - z));
        }
        expect(d, w.id).toBeLessThan(r.widthM / 2 + 2 + 0.5);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10000);
  });

  it("no corner or clip end within 0.5 m of a road, and no stretch of sidewalk on one (sampled every metre)", () => {
    const bad: string[] = [];
    for (const n of walk.nodes) if (roadClearance(n.x, n.z) < 0.49) bad.push(`${n.id} ${roadClearance(n.x, n.z).toFixed(2)}`);
    expect(bad.slice(0, 10), `${bad.length} nodes on or by a road`).toEqual([]);
    let samples = 0;
    for (const e of walk.edges) {
      if (e.kind !== "sidewalk") continue;
      const a = nodes.get(e.a)!, b = nodes.get(e.b)!;
      const pts: P2[] = [[a.x, a.z], ...(e.points ?? []), [b.x, b.z]];
      for (let i = 1; i < pts.length; i++) {
        const [px, pz] = pts[i - 1]!, [qx, qz] = pts[i]!;
        const n = Math.max(1, Math.ceil(Math.hypot(qx - px, qz - pz)));
        for (let j = 0; j <= n; j++) {
          const x = px + ((qx - px) * j) / n, z = pz + ((qz - pz) * j) / n;
          samples++;
          if (roadClearance(x, z) < -0.02) bad.push(`${e.id} at ${x.toFixed(1)},${z.toFixed(1)}: ${roadClearance(x, z).toFixed(2)}`);
        }
      }
    }
    expect(samples).toBeGreaterThan(2_000_000);
    expect(bad.slice(0, 10), `${bad.length} sidewalk points inside a road`).toEqual([]);
  });

  it("is connected across tile seams: the largest component holds 98%+ of the mainland's nodes and spans the city", () => {
    const parent = new Map<string, string>(walk.nodes.map((n) => [n.id, n.id]));
    const find = (x: string): string => {
      while (parent.get(x) !== x) {
        parent.set(x, parent.get(parent.get(x)!)!);
        x = parent.get(x)!;
      }
      return x;
    };
    let seamEdges = 0;
    const tileOf = (n: { x: number; z: number }): string => tileId(Math.floor(n.x / TILE_SIZE_M), Math.floor(n.z / TILE_SIZE_M));
    for (const e of walk.edges) {
      const a = find(e.a), b = find(e.b);
      if (a !== b) parent.set(a, b);
      if (tileOf(nodes.get(e.a)!) !== tileOf(nodes.get(e.b)!)) seamEdges++;
    }
    const size = new Map<string, number>();
    for (const n of walk.nodes) size.set(find(n.id), (size.get(find(n.id)) ?? 0) + 1);
    const [root, biggest] = [...size.entries()].sort((p, q) => q[1] - p[1])[0]!;
    // Treasure Island and Yerba Buena Island have no walkable link to the city (the Bay Bridge is a freeway).
    const ti = layer<Districts>("districts").districts.find((d) => d.id === "treasure-island")!;
    const island = (n: { x: number; z: number }): boolean => ti.polygons.some((poly) => inPolygon(n.x, n.z, poly));
    const mainland = walk.nodes.filter((n) => !island(n));
    expect(mainland.length).toBeGreaterThan(30000);
    expect(biggest / mainland.length).toBeGreaterThan(0.98);
    expect(walk.nodes.filter((n) => find(n.id) === root && island(n))).toEqual([]);
    expect(seamEdges).toBeGreaterThan(1000);
    const tilesInBiggest = new Set(walk.nodes.filter((n) => find(n.id) === root).map(tileOf));
    expect(tilesInBiggest.size).toBeGreaterThan(450);
  });

  it("crossings: at intersections, signalised where the signal data says, painted where the crosswalk data says", () => {
    const crossings = walk.edges.filter((e) => e.kind === "crossing");
    expect(crossings.length).toBeGreaterThan(20000);
    expect(crossings.filter((e) => e.signal).length).toBeGreaterThan(4000);
    const signals = layer<{ signals: Array<{ node: string; kind: string }> }>("signals").signals;
    const signalNodes = new Set(signals.filter((s) => s.kind === "signal").map((s) => s.node));
    // A crossing carried over both carriageways of a divided road joins two junctions' corners.
    for (const e of crossings) if (e.signal) expect(signalNodes.has(nodes.get(e.a)!.road) || signalNodes.has(nodes.get(e.b)!.road), e.id).toBe(true);
  });
});

describe("citywide: gameplay layers", () => {
  it("hydrants stand on land, off every road, outside buildings, at least 120 m apart, at intersections across the city", () => {
    const hs = layer<{ hydrants: Array<{ id: string; x: number; z: number; y: number; at: string }> }>("hydrants").hydrants;
    expect(hs.length).toBeGreaterThan(3000);
    const grid = new Map<string, Array<{ x: number; z: number }>>();
    for (const h of hs) {
      expect(isWater(h.x, h.z), h.id).toBe(false);
      // On the pavement: a metre or more outside every road's kerb line.
      expect(roadClearance(h.x, h.z), h.id).toBeGreaterThanOrEqual(0.99);
      expect(Math.abs(h.y - ground.heightAt(h.x, h.z)), h.id).toBeLessThan(0.02);
      const k = `${Math.floor(h.x / 120)},${Math.floor(h.z / 120)}`;
      (grid.get(k) ?? grid.set(k, []).get(k)!).push(h);
    }
    for (const h of hs) {
      for (let cx = Math.floor(h.x / 120) - 1; cx <= Math.floor(h.x / 120) + 1; cx++) {
        for (let cz = Math.floor(h.z / 120) - 1; cz <= Math.floor(h.z / 120) + 1; cz++) {
          for (const o of grid.get(`${cx},${cz}`) ?? []) if (o !== h) expect(Math.hypot(o.x - h.x, o.z - h.z)).toBeGreaterThanOrEqual(119.99);
        }
      }
    }
    // Inside no building: every footprint whose bounding box holds the hydrant.
    const cells = new Map<string, Array<{ id: string; footprint: Array<[number, number]> }>>();
    for (const t of pack.tiles) {
      for (const b of t.buildings) {
        let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
        for (const [x, z] of b.footprint) {
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
        }
        for (let cx = Math.floor(x0 / 50); cx <= Math.floor(x1 / 50); cx++) for (let cz = Math.floor(z0 / 50); cz <= Math.floor(z1 / 50); cz++) {
          const k = `${cx},${cz}`;
          (cells.get(k) ?? cells.set(k, []).get(k)!).push(b);
        }
      }
    }
    for (const h of hs) {
      for (const b of cells.get(`${Math.floor(h.x / 50)},${Math.floor(h.z / 50)}`) ?? []) expect(pointInPolygon(h.x, h.z, b.footprint), `${h.id} in ${b.id}`).toBe(false);
    }
  }, 60_000);

  it("drinking fountains, transit routes (incl. the three cable car lines) and stops are in place", () => {
    const fs = layer<{ fountains: unknown[] }>("fountains").fountains;
    expect(fs.length).toBeGreaterThan(200);
    const t = layer<{ routes: Array<{ id: string; line: string; mode: string }>; stops: Array<{ id: string; routes: string[] }> }>("transit");
    const cable = t.routes.filter((r) => r.mode === "cable").map((r) => r.line).sort();
    expect([...new Set(cable)]).toEqual(["C", "PH", "PM"]);
    expect(t.routes.filter((r) => r.mode === "bus").length).toBeGreaterThan(80);
    expect(t.stops.length).toBeGreaterThan(3000);
    const routeIds = new Set(t.routes.map((r) => r.id));
    for (const s of t.stops) for (const r of s.routes) expect(routeIds.has(r)).toBe(true);
    expect(t.stops.filter((s) => s.routes.length > 0).length / t.stops.length).toBeGreaterThan(0.9);
  });

  it("street cleaning and parking rules name existing road edges", () => {
    const edgeIds = new Set(roads.edges.map((e) => e.id));
    const sc = layer<{ rules: Array<{ edge: string }> }>("streetCleaning").rules;
    const pk = layer<{ rules: Array<{ edge: string }> }>("parking").rules;
    expect(sc.length).toBeGreaterThan(30000);
    expect(pk.length).toBeGreaterThan(7000);
    for (const r of [...sc, ...pk]) expect(edgeIds.has(r.edge), r.edge).toBe(true);
  });
});

describe("citywide: far-LOD", () => {
  it("holds every collider record, in cells that tile the world", () => {
    // Every collider record, plus the far-only Daly City strip (W-42): far scenery, no collider.
    const report = readJson<{ far: { records: number }; colliderPack: { buildings: number }; farOnly: { records: number; tiles: string[]; drawnInTiles: number } }>(`${DIR}/report.json`);
    expect(report.farOnly.records).toBeGreaterThan(1000);
    // The three row-20 tiles the strip alone made built before are among them, unbuilt.
    for (const id of ["t-16_20", "t-3_20", "t-4_20"]) expect(report.farOnly.tiles, id).toContain(id);
    // W-42: the strip's records stand in built tiles (past the county-line wall: their glb draws
    // them as scenery, since the renderer hides the far layer over a streamed tile) or in San
    // Mateo County's outside tiles.
    const built = new Set(manifest.tiles.map((t) => t.id));
    const area = new Map(manifest.outside.tiles.map((t) => [t.id, t.area]));
    let drawn = 0;
    for (const id of report.farOnly.tiles) {
      if (!built.has(id)) {
        expect(area.get(id), id).toBe("san-mateo-county");
        continue;
      }
      const b = readFileSync(join(ROOT, DIR, `${id}.glb`));
      const json = JSON.parse(new TextDecoder().decode(b.subarray(20, 20 + b.readUInt32LE(12)))) as { nodes: Array<{ name: string; extras?: { scenery?: unknown[] } }> };
      const node = json.nodes.find((q) => q.name === "buildings-scenery");
      expect(node, id).toBeDefined();
      drawn += node!.extras!.scenery!.length;
    }
    expect(drawn).toBe(report.farOnly.drawnInTiles);
    expect(drawn).toBeGreaterThan(1000);
    expect(report.far.records).toBe(report.colliderPack.buildings + report.farOnly.records);
    expect(manifest.far.reduce((s, c) => s + c.stats.records!, 0)).toBe(report.far.records);
    for (const c of manifest.far) {
      expect(c.bbox[2]).toBeGreaterThan(c.bbox[0]);
      expect(c.bbox[3]).toBeGreaterThan(c.bbox[1]);
    }
  });
});

interface Boundary {
  seaLevelY: number;
  edges: Array<{ kind: "land" | "water"; closed: boolean; points: P2[] }>;
  shore: Array<{ closed: boolean; points: P2[] }>;
}

describe("citywide: the world's edge and shore", () => {
  const b = layer<Boundary>("boundary");
  const built = new Set(manifest.tiles.map((t) => t.id));
  const tileAt = (x: number, z: number): string => tileId(Math.floor(x / TILE_SIZE_M), Math.floor(z / TILE_SIZE_M));
  /** Unit steps (10 m) along an axis-aligned polyline, as [x, z, dx, dz]. */
  const steps = function* (pts: readonly P2[], closed: boolean): Generator<[number, number, number, number]> {
    const all = closed ? [...pts, pts[0]!] : pts;
    for (let i = 1; i < all.length; i++) {
      const [ax, az] = all[i - 1]!, [bx, bz] = all[i]!;
      expect(ax === bx || az === bz, "axis-aligned").toBe(true);
      const n = Math.round(Math.hypot(bx - ax, bz - az) / 10);
      for (let k = 0; k < n; k++) yield [ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n, (bx - ax) / n, (bz - az) / n];
    }
  };

  it("the outline runs between built tiles (on its left) and tiles with no file or the land past the county line (on its right)", () => {
    // W-42: inside the last built row the land wall follows the county line: past it (south of
    // z = 9,600 and in no San Francisco neighbourhood) is outside the world.
    const ds = layer<Districts>("districts").districts;
    const inSf = (x: number, z: number): boolean => ds.some((d) => d.polygons.some((poly) => inPolygon(x, z, poly)));
    // (An all-water cell is never cut; only the right side is checked.)
    const inWorld = (x: number, z: number): boolean => built.has(tileAt(x, z)) && !(z > SOUTH_CROP_Z && !inSf(x, z));
    let n = 0;
    let county = 0;
    for (const e of b.edges) {
      for (const [x, z, dx, dz] of steps(e.points, e.closed)) {
        // Left of travel is (dz, -dx) on a north-up map; probe 1 m either side of the step's middle.
        const mx = x + dx / 2, mz = z + dz / 2;
        const lx = mx + Math.sign(dz) * 1, lz = mz - Math.sign(dx) * 1;
        const rx = mx - Math.sign(dz) * 1, rz = mz + Math.sign(dx) * 1;
        expect(built.has(tileAt(lx, lz)), `${e.kind} at ${mx},${mz}: left`).toBe(true);
        if (built.has(tileAt(rx, rz))) {
          // A wall inside a built tile is the county line: land past it is cut (cell by cell, so
          // probe the cells' centres either side).
          const lc: [number, number] = [mx + Math.sign(dz) * 5, mz - Math.sign(dx) * 5];
          const rc: [number, number] = [mx - Math.sign(dz) * 5, mz + Math.sign(dx) * 5];
          expect(inWorld(...rc), `${e.kind} at ${mx},${mz}: right cell`).toBe(false);
          expect(lc[1] > SOUTH_CROP_Z - 10, `${e.kind} at ${mx},${mz}: a wall inside a built tile only at the county line`).toBe(true);
          county++;
        }
        n++;
      }
    }
    expect(n).toBeGreaterThan(5000);
    expect(county * 10, "metres of wall on the county line inside built tiles").toBeGreaterThan(5000);
  });

  it("walls the world off on dry ground: the southern city limit is land, the Pacific and the Bay are water", () => {
    const landAt = (x: number, z: number, kind: string): boolean =>
      b.edges.some((e) => e.kind === kind && [...steps(e.points, e.closed)].some(([sx, sz, dx, dz]) => Math.hypot(sx + dx / 2 - x, sz + dz / 2 - z) < 260));
    // South of Visitacion Valley and of the Excelsior the world stops on dry ground: a land wall
    // runs between the point and its tile's south edge (the county line or that edge, W-42).
    for (const [name, lat, lon] of [["Visitacion Valley", 37.7085, -122.4045], ["Excelsior", 37.7085, -122.43]] as const) {
      const p = at(lat, lon);
      const southEdge = (Math.floor(p.z / TILE_SIZE_M) + 1) * TILE_SIZE_M;
      const wall = b.edges.some((e) => e.kind === "land" && [...steps(e.points, e.closed)].some(([sx, sz, dx]) => dx !== 0 && Math.abs(sx - p.x) < 100 && sz >= p.z && sz <= southEdge));
      expect(wall, name).toBe(true);
    }
    const land = b.edges.filter((e) => e.kind === "land");
    expect(land.length).toBeGreaterThan(0);
    // Off Ocean Beach the outline crosses open water.
    const ob = at(37.75, -122.51);
    const west = Math.floor(ob.x / TILE_SIZE_M) * TILE_SIZE_M;
    expect(landAt(west, ob.z, "water")).toBe(true);
    expect(landAt(west, ob.z, "land")).toBe(false);
  });

  it("the shore separates land (left) from water (right), and passes Ocean Beach where the ground does", () => {
    let agree = 0, total = 0;
    // The sea's lines (the lakes' rings, tagged, are checked in inland-water.test.ts).
    for (const l of b.shore as Array<{ closed: boolean; points: P2[]; lake?: string }>) {
      if (l.lake !== undefined) continue;
      const pts = l.closed ? [...l.points, l.points[0]!] : l.points;
      for (let i = 1; i < pts.length; i++) {
        const [ax, az] = pts[i - 1]!, [bx, bz] = pts[i]!;
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 10) continue;
        const mx = (ax + bx) / 2, mz = (az + bz) / 2, ux = (bx - ax) / len, uz = (bz - az) / len;
        const left = isWater(mx + uz * 12, mz - ux * 12), right = isWater(mx - uz * 12, mz + ux * 12);
        total++;
        if (!left && right) agree++;
      }
    }
    expect(total).toBeGreaterThan(1000);
    expect(agree / total).toBeGreaterThan(0.9);
    for (const lat of [37.735, 37.75, 37.77]) {
      const z = at(lat, -122.5).z;
      let shoreX = NaN;
      for (let x = -11000; x < -9500; x += 5) {
        if (!isWater(x, z)) {
          shoreX = x;
          break;
        }
      }
      let best = Infinity;
      for (const l of b.shore) for (const [x, zz] of l.points) if (Math.abs(zz - z) < 40) best = Math.min(best, Math.abs(x - shoreX));
      expect(best, `shore at ${lat}`).toBeLessThan(25);
    }
  });
});

describe("citywide: building records", () => {
  const report = readJson<{
    buildings: { twoTier: number; maxOutlier: number; canopyTowersDropped: number; thinTowers: number; thinTowerMaxM: number; spikeTowersDropped: number };
    probes: Array<{ id: string; buildings: string[] }>;
  }>(`${DIR}/report.json`);

  it("thin LiDAR towers are few and short: under 60 m² rising 15+ m over a podium under 15 m", () => {
    const recs = new Map<string, { footprint: P2[]; baseY: number; topY: number }>();
    for (const t of pack.tiles) for (const r of t.buildings) recs.set(r.id, r);
    let thin = 0, tallest = 0;
    for (const [id, r] of recs) {
      if (!id.endsWith("-tower")) continue;
      const pod = recs.get(id.slice(0, -"-tower".length))!;
      expect(pod, id).toBeDefined();
      const area = Math.abs(signedArea(r.footprint));
      const podH = pod.topY - pod.baseY, towerH = r.topY - r.baseY;
      if (area < 60 && podH < 15 && r.topY - pod.topY > 15) {
        thin++;
        tallest = Math.max(tallest, towerH);
      }
    }
    expect(thin).toBeLessThanOrEqual(200);
    expect(tallest).toBeLessThan(60);
    expect(report.buildings.thinTowers).toBeLessThanOrEqual(200);
    expect(report.buildings.thinTowerMaxM).toBeLessThan(60);
    // Most rejected maxima never become towers (the moment model calls them outliers); the
    // canopy and spike checks then remove plausible-looking towers the assessor contradicts.
    expect(report.buildings.maxOutlier).toBeGreaterThan(5000);
    expect(report.buildings.canopyTowersDropped).toBeGreaterThan(100);
    expect(report.buildings.spikeTowersDropped).toBeGreaterThan(50);
    expect(report.buildings.twoTier).toBeGreaterThan(2000);
    expect(report.buildings.twoTier).toBeLessThan(4000);
  });

  it("the Sutro Tower probe lists every record around its legs, for the landmark to replace", () => {
    const sutro = report.probes.find((p) => p.id === "sutro-tower")!;
    // The LiDAR maxima over the legs are the tower itself: outliers or overrides (3 m plinths
    // in pipeline/overrides.json), so no -tower records.
    expect(sutro.buildings).toEqual(["201006.0001431", "201006.0009087", "201006.0062170", "201006.0077893", "201006.0167582", "201006.0168289"]);
  });
});
