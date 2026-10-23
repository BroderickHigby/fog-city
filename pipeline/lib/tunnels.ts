// Tunnels (W-02). The 3DEP DEM is bare earth, so a tunnel's centreline drapes over the hill above
// it (the Broadway Tunnel climbed 49 m over Russian Hill, through 31 houses). Here:
//   - Surface tunnel edges are found by name ("... Tunl", "... Tunnel"); freeway tunnels (the
//     MacArthur Tunnel on Hwy 1, the Presidio Parkway's Battery and Main Post tunnels on
//     Hwy 101) by FREEWAY_TUNNELS: a bore on the route's freeway edges near the tunnel. Edges
//     the source splits inside a tunnel are one chain. The Yerba Buena Island tunnel has fixed
//     portals instead: the Bay Bridge spans either side of it are at sea level in the DEM (the
//     bridge models carry them, Assets W-24) and the island's flanks fall steeply under its
//     viaducts, so no cone from the ground finds its bore; its portals are where the road's
//     benches (cut into the island at about 52 m and 57 m) meet the ridge, and the bore runs
//     straight between the benches' ground.
//   - The bore (bore()) runs on the straight line between two portals, where the hill stands
//     over the highest road that never climbs faster than TUNNEL_GRADE. Outside the portals the
//     road is at grade (a freeway's deck, decks.ts, joins it there).
//   - Each bore is a ribbon with a ceiling CLEARANCE_M over the road (structures.ts tunnels),
//     the edge is flagged tunnel, and the buildings above it get an underside (underY), so a
//     body in the bore passes under them while the street above is unchanged.

import type { Building } from "./buildings.ts";
import { pointInRing, r2, type P2 } from "./geom.ts";
import type { RoadEdge, RoadGraph } from "./roads.ts";
import { cmVertex, splitPieces, type RibbonVertex, type Tunnel } from "./structures.ts";

/** The hill must stand at least this far over the bore's line for it to be underground. */
export const PORTAL_COVER_M = 3;
/** Ceiling height over the road in a bore. */
export const CLEARANCE_M = 5;
/** A building over a bore must clear the ceiling by this much to be passed under. */
const ROOF_OVER_CEILING_M = 0.3;

/**
 * Freeway tunnels: a bore found on a freeway route (by name) counts only when its middle lies
 * within radiusM of the tunnel (lat, lon). Elsewhere a freeway's cover in the bare-earth profile
 * is a cut, a climb or a bridge approach, not a tunnel.
 */
export const FREEWAY_TUNNELS: ReadonlyArray<{ name: string; street: RegExp; at: [number, number]; radiusM: number; portals?: [[number, number], [number, number]] }> = [
  { name: "MacArthur Tunnel", street: /^Hwy 1 (North|South)bound$/, at: [37.7945, -122.4696], radiusM: 500 },
  { name: "Presidio Parkway Battery Tunnel", street: /^Hwy 101 (North|South)bound$/, at: [37.8019, -122.464], radiusM: 300 },
  { name: "Presidio Parkway Main Post Tunnel", street: /^Hwy 101 (North|South)bound$/, at: [37.8025, -122.456], radiusM: 300 },
  // Both decks of the double-decked bore (the source draws them side by side).
  { name: "Yerba Buena Island Tunnel", street: /^I-80 (East|West)bound$/, at: [37.80955, -122.36566], radiusM: 200, portals: [[37.80892, -122.36631], [37.81019, -122.36496]] },
];
/** A fixed portal is on a chain when its centreline passes this close. */
const PORTAL_REACH_M = 30;

export const isTunnelName = (name: string): boolean => /(\bTunl|\bTunnel)$/.test(name);

export interface Bore {
  edge: string;
  name: string;
  /** Arc length along the edge of the two portals, and the road height there. */
  s0: number;
  s1: number;
  y0: number;
  y1: number;
}

/** Arc-length samples (every metre) of an edge with the ground height. */
function profile(points: readonly P2[], heightAt: (x: number, z: number) => number): Array<{ x: number; z: number; s: number; h: number }> {
  const out: Array<{ x: number; z: number; s: number; h: number }> = [];
  let s = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(L));
    for (let k = i === 1 ? 0 : 1; k <= n; k++) {
      const x = a[0] + ((b[0] - a[0]) * k) / n;
      const z = a[1] + ((b[1] - a[1]) * k) / n;
      out.push({ x, z, s: s + (L * k) / n, h: heightAt(x, z) });
    }
    s += L;
  }
  return out;
}

/**
 * The bores on a profile, longest first. The road through a hill is the highest profile that
 * never rises above the ground and never climbs or falls faster than TUNNEL_GRADE: the ground
 * eroded by a cone of that slope, y(s) = min over t of ground(t) + TUNNEL_GRADE·|s - t|. A bore
 * is a stretch where the hill stands more than PORTAL_COVER_M over that road, widened to where
 * the cover falls under PORTAL_FOOT_M (the portals' feet); between the portals the road runs
 * straight.
 */
function findBores(p: ReturnType<typeof profile>): Array<{ i0: number; i1: number; y0: number; y1: number }> {
  const n = p.length - 1;
  if (n < 10) return [];
  const y = p.map((q) => q.h);
  // Two sweeps make the cone erosion exact on a 1-D profile.
  for (let i = 1; i <= n; i++) y[i] = Math.min(y[i]!, y[i - 1]! + TUNNEL_GRADE * (p[i]!.s - p[i - 1]!.s));
  for (let i = n - 1; i >= 0; i--) y[i] = Math.min(y[i]!, y[i + 1]! + TUNNEL_GRADE * (p[i + 1]!.s - p[i]!.s));
  const cover = (i: number): number => p[i]!.h - y[i]!;
  const runs: Array<[number, number]> = [];
  let run0 = -1;
  for (let i = 0; i <= n + 1; i++) {
    const covered = i <= n && cover(i) > PORTAL_COVER_M;
    if (covered && run0 < 0) run0 = i;
    if (!covered && run0 >= 0) {
      runs.push([run0, i - 1]);
      run0 = -1;
    }
  }
  const out: Array<{ i0: number; i1: number; y0: number; y1: number }> = [];
  for (const [a, b] of runs) {
    let f0 = a;
    let f1 = b;
    while (f0 > 0 && cover(f0 - 1) > PORTAL_FOOT_M) f0--;
    while (f1 < n && cover(f1 + 1) > PORTAL_FOOT_M) f1++;
    if (f1 - f0 >= 10 && !out.some((o) => o.i0 === f0 && o.i1 === f1)) out.push({ i0: f0, i1: f1, y0: y[f0]!, y1: y[f1]! });
  }
  // Longest first (ties: earlier first).
  return out.sort((u, v) => v.i1 - v.i0 - (u.i1 - u.i0) || u.i0 - v.i0);
}

/** The steepest a road in a tunnel climbs or falls. */
const TUNNEL_GRADE = 0.06;

/** The cover at a portal's foot: the bore ends this close under the ground (a step no car notices). */
export const PORTAL_FOOT_M = 0.1;
/** A building whose roof is less than this over a bore's ceiling stands in the bore's open cut. */
const MIN_SLAB_M = 0.5;

export interface TunnelResult {
  bores: Bore[];
  /** True where the clearance pass must leave an edge alone (inside a bore, under cover). */
  skip: (edge: string, s: number) => boolean;
  /** Edges with a bore: never re-registered. */
  edges: Set<string>;
}

/**
 * Chains of candidate edges: maximal runs through nodes where exactly one candidate edge of the
 * same name arrives and one leaves (a tunnel the source splits at a node inside it is one bore).
 */
function chains(cands: readonly RoadEdge[]): RoadEdge[][] {
  const outOf = new Map<string, RoadEdge[]>();
  const into = new Map<string, RoadEdge[]>();
  for (const e of cands) {
    (outOf.get(e.a) ?? outOf.set(e.a, []).get(e.a)!).push(e);
    (into.get(e.b) ?? into.set(e.b, []).get(e.b)!).push(e);
  }
  const next = (e: RoadEdge): RoadEdge | undefined => {
    const o = outOf.get(e.b) ?? [];
    const i = into.get(e.b) ?? [];
    // Never back along the other carriageway (a one-way pair shares its two nodes).
    return o.length === 1 && i.length === 1 && o[0]!.name === e.name && o[0] !== e && o[0]!.b !== e.a ? o[0] : undefined;
  };
  const hasPrev = new Set<RoadEdge>();
  for (const e of cands) {
    const n = next(e);
    if (n) hasPrev.add(n);
  }
  const done = new Set<RoadEdge>();
  const out: RoadEdge[][] = [];
  const sorted = [...cands].sort((p, q) => (p.id < q.id ? -1 : 1));
  for (const pass of [0, 1]) {
    for (const e of sorted) {
      if (done.has(e) || (pass === 0 && hasPrev.has(e))) continue;
      const c: RoadEdge[] = [];
      for (let q: RoadEdge | undefined = e; q && !done.has(q); q = next(q)) {
        done.add(q);
        c.push(q);
      }
      out.push(c);
    }
  }
  return out;
}

/** Find the tunnels in the graph and flag their edges (mutates edge.tunnel). */
export function findTunnels(graph: RoadGraph, heightAt: (x: number, z: number) => number, toLocal?: (lat: number, lon: number) => { x: number; z: number }): TunnelResult {
  const bores: Bore[] = [];
  const surface = graph.edges.filter((e) => !e.gradeSeparated && isTunnelName(e.name));
  const freeway = graph.edges.filter((e) => e.kind === "freeway" && FREEWAY_TUNNELS.some((t) => t.street.test(e.name)));
  for (const [kind, cands] of [["surface", surface], ["freeway", freeway]] as const) {
    for (const chain of chains(cands)) {
      // The chain's profile, and where each edge starts on it.
      const starts: number[] = [];
      const p: ReturnType<typeof profile> = [];
      let off = 0;
      for (const e of chain) {
        starts.push(off);
        const q = profile(e.points, heightAt);
        for (let i = p.length ? 1 : 0; i < q.length; i++) p.push({ ...q[i]!, s: off + q[i]!.s });
        off += q[q.length - 1]!.s;
      }
      const found = findBores(p);
      // A surface tunnel is its chain's longest bore; a freeway tunnel is the longest bore near
      // one of FREEWAY_TUNNELS (a freeway's other cover is a cut, a climb or a bridge approach).
      const picked: Array<{ b: (typeof found)[number]; name: string }> = [];
      if (kind === "surface") {
        if (found[0]) picked.push({ b: found[0], name: chain[0]!.name });
      } else if (toLocal) {
        for (const f of FREEWAY_TUNNELS) {
          if (!f.street.test(chain[0]!.name)) continue;
          const c = toLocal(f.at[0], f.at[1]);
          if (f.portals) {
            // The profile samples nearest the two portals, in chain order; the bore runs between
            // the ground there.
            const at = f.portals.map(([lat, lon]) => {
              const q = toLocal(lat, lon);
              let best = -1, bd = Infinity;
              p.forEach((v, i) => {
                const d = Math.hypot(v.x - q.x, v.z - q.z);
                if (d < bd) {
                  bd = d;
                  best = i;
                }
              });
              return bd <= PORTAL_REACH_M ? best : -1;
            });
            if (at[0]! < 0 || at[1]! < 0) continue;
            const i0 = Math.min(at[0]!, at[1]!), i1 = Math.max(at[0]!, at[1]!);
            const b = { i0, i1, y0: p[i0]!.h, y1: p[i1]!.h };
            const L = p[i1]!.s - p[i0]!.s;
            let cover = 0;
            for (let i = i0; i <= i1; i++) cover = Math.max(cover, p[i]!.h - (b.y0 + ((b.y1 - b.y0) * (p[i]!.s - p[i0]!.s)) / (L || 1)));
            if (L > 10 && Math.abs(b.y1 - b.y0) / L <= TUNNEL_GRADE && cover > PORTAL_COVER_M) picked.push({ b, name: f.name });
            continue;
          }
          const b = found.find((q) => {
            const mid = p[(q.i0 + q.i1) >> 1]!;
            return Math.hypot(mid.x - c.x, mid.z - c.z) <= f.radiusM;
          });
          if (b && !picked.some((q) => q.b === b)) picked.push({ b, name: f.name });
        }
      }
      for (const { b: found0, name } of picked) {
        // The bore runs on to where the hill no longer stands over its line's extension (the
        // cover search reads the eroded profile, which can leave a hump just outside a portal).
        const b = { ...found0 };
        const slope = (b.y1 - b.y0) / (p[b.i1]!.s - p[b.i0]!.s || 1);
        while (b.i1 < p.length - 1 && p[b.i1 + 1]!.h > b.y1 + slope * (p[b.i1 + 1]!.s - p[b.i1]!.s) + PORTAL_FOOT_M) {
          b.y1 += slope * (p[b.i1 + 1]!.s - p[b.i1]!.s);
          b.i1++;
        }
        while (b.i0 > 0 && p[b.i0 - 1]!.h > b.y0 - slope * (p[b.i0]!.s - p[b.i0 - 1]!.s) + PORTAL_FOOT_M) {
          b.y0 -= slope * (p[b.i0]!.s - p[b.i0 - 1]!.s);
          b.i0--;
        }
        const S0 = p[b.i0]!.s;
        const S1 = p[b.i1]!.s;
        const yAt = (S: number): number => b.y0 + ((b.y1 - b.y0) * (S - S0)) / (S1 - S0 || 1);
        chain.forEach((e, k) => {
          const e0 = starts[k]!;
          const e1 = k + 1 < chain.length ? starts[k + 1]! : off;
          const a = Math.max(S0, e0);
          const z = Math.min(S1, e1);
          if (z - a < 1) return;
          bores.push({ edge: e.id, name, s0: r2(a - e0), s1: r2(z - e0), y0: r2(yAt(a)), y1: r2(yAt(z)) });
          e.tunnel = true;
        });
      }
    }
  }
  bores.sort((p, q) => (p.edge < q.edge ? -1 : p.edge > q.edge ? 1 : 0));
  const covers = new Map<string, Set<number>>();
  for (const b of bores) {
    const e = graph.edges.find((q) => q.id === b.edge)!;
    const p = profile(e.points, heightAt);
    const cover = covers.get(b.edge) ?? covers.set(b.edge, new Set()).get(b.edge)!;
    for (const q of p) {
      const y = boreY(b, q.s);
      if (y === null) continue;
      if (q.h - (y + CLEARANCE_M) >= ROOF_OVER_CEILING_M) cover.add(Math.round(q.s));
    }
  }
  return { bores, skip: (edge, s) => covers.get(edge)?.has(Math.round(s)) ?? false, edges: new Set(covers.keys()) };
}

/** The road height in a bore at arc length s (between the portals), else null. */
export function boreY(b: Bore, s: number): number | null {
  // s0 and s1 are rounded to centimetres: the portal samples themselves are in.
  if (s < b.s0 - 0.006 || s > b.s1 + 0.006) return null;
  const t = Math.min(1, Math.max(0, (s - b.s0) / (b.s1 - b.s0 || 1)));
  return b.y0 + (b.y1 - b.y0) * t;
}

/**
 * Buildings standing over a bore get an underside (a body in the bore passes under them; on the
 * street above nothing changes): at their foot, or, where the hill's cover is thin and a
 * footprint reaches down a slope below the ceiling, ROOF_OVER_CEILING_M over the ceiling (the
 * part below is ground a body cannot reach: under a metre high). A tower over a bore gets its
 * floor, its podium's roof. A building whose roof barely clears the ceiling stands in a portal's
 * open cut and is dropped. Returns the updated list, the ids given an underside and the ids
 * dropped.
 */
export function undersideOverBores(buildings: readonly Building[], graph: RoadGraph, bores: readonly Bore[], heightAt: (x: number, z: number) => number): { buildings: Building[]; ids: string[]; dropped: string[] } {
  const hit = new Map<string, number>(); // id -> highest ceiling under it
  for (const b of bores) {
    const e = graph.edges.find((q) => q.id === b.edge)!;
    const half = e.widthM / 2 + 0.5;
    // Buildings near the edge at all (bounding boxes), then the bore's cross-section per metre.
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [x, z] of e.points) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    const near = buildings.filter((bl) => {
      for (const [x, z] of bl.footprint) if (x >= x0 - 60 && x <= x1 + 60 && z >= z0 - 60 && z <= z1 + 60) return true;
      return false;
    });
    const p = profile(e.points, heightAt);
    p.forEach((q, k) => {
      const y = boreY(b, q.s);
      if (y === null) return;
      const ceiling = y + CLEARANCE_M;
      const a = p[Math.max(0, k - 1)]!;
      const c = p[Math.min(p.length - 1, k + 1)]!;
      const L = Math.hypot(c.x - a.x, c.z - a.z) || 1;
      const nx = -(c.z - a.z) / L, nz = (c.x - a.x) / L;
      for (const o of [-half, 0, half]) {
        const x = q.x + nx * o, z = q.z + nz * o;
        for (const bl of near) {
          if (!pointInRing(x, z, bl.footprint)) continue;
          hit.set(bl.id, Math.max(hit.get(bl.id) ?? -Infinity, ceiling));
        }
      }
    });
  }
  const ids: string[] = [];
  const dropped: string[] = [];
  const out: Building[] = [];
  for (const bl of buildings) {
    const c = hit.get(bl.id);
    if (c === undefined) {
      out.push(bl);
      continue;
    }
    const u = Math.ceil((c + ROOF_OVER_CEILING_M) * 100) / 100;
    const floor = bl.meta.towerOf !== undefined ? (bl.meta.podiumTopY ?? bl.meta.footY) : bl.meta.footY;
    const underY = Math.max(floor, u);
    if (bl.topY - underY < MIN_SLAB_M && bl.meta.tower === undefined && bl.meta.towerOf === undefined) {
      dropped.push(bl.id);
      continue;
    }
    ids.push(bl.id);
    out.push({ ...bl, underY: r2(underY) });
  }
  return { buildings: out, ids: ids.sort(), dropped: dropped.sort() };
}

/** The bore ribbons, cut into tiles (structures.ts). */
export function tunnelRibbons(graph: RoadGraph, bores: readonly Bore[], heightAt: (x: number, z: number) => number): Array<{ tile: string; tunnel: Tunnel }> {
  const out: Array<{ tile: string; tunnel: Tunnel }> = [];
  const perEdge = new Map<string, number>();
  for (const b of bores) perEdge.set(b.edge, (perEdge.get(b.edge) ?? 0) + 1);
  const nth = new Map<string, number>();
  for (const b of bores) {
    const k = nth.get(b.edge) ?? 0;
    nth.set(b.edge, k + 1);
    const rid = perEdge.get(b.edge)! > 1 ? `${b.edge}.t${k}` : b.edge;
    const e = graph.edges.find((q) => q.id === b.edge)!;
    // The portals exactly, and every 4th metre between them.
    const at = (s: number): [number, number] => {
      let acc = 0;
      for (let i = 1; i < e.points.length; i++) {
        const [ax, az] = e.points[i - 1]!, [bx, bz] = e.points[i]!;
        const L = Math.hypot(bx - ax, bz - az);
        if (acc + L >= s || i === e.points.length - 1) {
          const u = L > 0 ? Math.max(0, Math.min(1, (s - acc) / L)) : 0;
          return [ax + (bx - ax) * u, az + (bz - az) * u];
        }
        acc += L;
      }
      return [e.points[0]![0], e.points[0]![1]];
    };
    const path: RibbonVertex[] = [];
    const [x0, z0] = at(b.s0);
    path.push(cmVertex([x0, b.y0, z0, e.widthM]));
    for (const q of profile(e.points, heightAt)) {
      if (q.s <= b.s0 + 0.5 || q.s >= b.s1 - 0.5 || Math.round(q.s) % 4 !== 0) continue;
      path.push(cmVertex([q.x, boreY(b, q.s)!, q.z, e.widthM]));
    }
    const [x1, z1] = at(b.s1);
    path.push(cmVertex([x1, b.y1, z1, e.widthM]));
    if (path.length < 2) continue;
    for (const piece of splitPieces({ id: rid, path })) {
      out.push({ tile: piece.tile, tunnel: { id: piece.id, kind: "tunnel", edge: b.edge, clearanceM: CLEARANCE_M, path: piece.path } });
    }
  }
  return out;
}
