// The world's boundary for the sim (boundary.json, schemas/boundary.schema.json):
//
//   * edges: the outline of the built tiles, as polylines. "land" runs are where the world
//     stops on dry ground (the southern city limit, where the last built tile meets Daly City
//     or Brisbane): the sim needs a wall there, since beyond it there is no ground. "water"
//     runs are where the outline crosses open water (the sea-wall and towing rules apply).
//   * shore: the land/water contour inside the built tiles (marching squares on the 10 m
//     ground lattice's water flags, simplified): the line for the sea-wall collider and the
//     Bay-edge refill zone. Piers are land in the elevation model, so the shore runs round them.
//
// Everything is on the global 10 m lattice, so the output is a pure function of the tiles.

import { TILE_SIZE_M } from "../../src/geo/project.ts";
import type { TileRef } from "./config.ts";
import { r2, simplifyLine, type P2 } from "./geom.ts";
import { GROUND_CELL_M, SAMPLES_PER_TILE, type Heightfield } from "./terrain.ts";

/** Douglas-Peucker tolerance for the shore, metres (the lattice is 10 m). */
export const SHORE_SIMPLIFY_M = 2.5;

export interface BoundaryEdge {
  kind: "land" | "water";
  /** A whole outline loop of one kind (the last point joins the first). */
  closed: boolean;
  points: P2[];
}

export interface ShoreLine {
  closed: boolean;
  points: P2[];
}

export interface BoundaryStats {
  landEdgeM: number;
  waterEdgeM: number;
  shoreM: number;
  shoreLines: number;
}

const CELLS = SAMPLES_PER_TILE - 1; // 50 lattice cells per tile side
const k2 = (gx: number, gz: number): string => `${gx},${gz}`;

function polyLength(pts: readonly P2[], closed: boolean): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
  if (closed && pts.length > 1) s += Math.hypot(pts[0]![0] - pts[pts.length - 1]![0], pts[0]![1] - pts[pts.length - 1]![1]);
  return s;
}

/** Drop vertices where a lattice polyline goes straight on. */
function dropStraight(pts: P2[], closed: boolean): P2[] {
  const n = pts.length;
  const keep = (i: number): boolean => {
    if (!closed && (i === 0 || i === n - 1)) return true;
    const a = pts[(i - 1 + n) % n]!, b = pts[i]!, c = pts[(i + 1) % n]!;
    return (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) !== 0;
  };
  return pts.filter((_, i) => keep(i));
}

export function buildBoundary(
  tiles: readonly TileRef[],
  fields: ReadonlyMap<string, Heightfield>,
): { edges: BoundaryEdge[]; shore: ShoreLine[]; stats: BoundaryStats } {
  if (TILE_SIZE_M / GROUND_CELL_M !== CELLS) throw new Error("boundary: tiles must be 50 lattice cells wide");
  const built = new Set(tiles.map((t) => `${t.ix},${t.iz}`));
  // Water flag at every lattice point of the built tiles (shared borders agree by construction).
  const water = new Map<string, number>();
  for (const t of tiles) {
    const f = fields.get(t.id)!;
    for (let k = 0; k < f.nz; k++) for (let i = 0; i < f.nx; i++) water.set(k2(t.ix * CELLS + i, t.iz * CELLS + k), f.water[k * f.nx + i]!);
  }
  const wAt = (gx: number, gz: number): number => water.get(k2(gx, gz))!;
  const P = (gx: number, gz: number): P2 => [gx * GROUND_CELL_M, gz * GROUND_CELL_M];

  // ---- Outline: unit lattice segments with the built tiles on the left.
  interface Seg { from: [number, number]; to: [number, number]; kind: "land" | "water" }
  const segs: Seg[] = [];
  const side = (x0: number, z0: number, dx: number, dz: number): void => {
    for (let s = 0; s < CELLS; s++) {
      const from: [number, number] = [x0 + dx * s, z0 + dz * s];
      const to: [number, number] = [from[0] + dx, from[1] + dz];
      segs.push({ from, to, kind: wAt(...from) === 1 && wAt(...to) === 1 ? "water" : "land" });
    }
  };
  for (const t of [...tiles].sort((a, b) => a.iz - b.iz || a.ix - b.ix)) {
    const X0 = t.ix * CELLS, Z0 = t.iz * CELLS, X1 = X0 + CELLS, Z1 = Z0 + CELLS;
    if (!built.has(`${t.ix},${t.iz - 1}`)) side(X1, Z0, -1, 0); // north edge, heading west
    if (!built.has(`${t.ix - 1},${t.iz}`)) side(X0, Z0, 0, 1); // west edge, heading south
    if (!built.has(`${t.ix},${t.iz + 1}`)) side(X0, Z1, 1, 0); // south edge, heading east
    if (!built.has(`${t.ix + 1},${t.iz}`)) side(X1, Z1, 0, -1); // east edge, heading north
  }
  const out = new Map<string, Seg[]>();
  for (const s of segs) (out.get(k2(...s.from)) ?? out.set(k2(...s.from), []).get(k2(...s.from))!).push(s);
  const used = new Set<Seg>();
  const edges: BoundaryEdge[] = [];
  const order = [...segs].sort((a, b) => a.from[1] - b.from[1] || a.from[0] - b.from[0] || a.to[1] - b.to[1] || a.to[0] - b.to[0]);
  for (const start of order) {
    if (used.has(start)) continue;
    const loop: Seg[] = [];
    let cur = start;
    for (;;) {
      used.add(cur);
      loop.push(cur);
      const dx = cur.to[0] - cur.from[0], dz = cur.to[1] - cur.from[1];
      const next = (out.get(k2(...cur.to)) ?? []).filter((s) => !used.has(s));
      if (next.length === 0) break;
      // Where two tiles touch only at a corner, take the left turn (keeps the loops simple).
      const turn = (s: Seg): number => {
        const ex = s.to[0] - s.from[0], ez = s.to[1] - s.from[1];
        const cross = dx * ez - dz * ex; // > 0: right turn on a north-up map (+z south)
        return cross < 0 ? 0 : cross === 0 ? 1 : 2;
      };
      cur = next.sort((a, b) => turn(a) - turn(b))[0]!;
    }
    // Split the loop into runs of one kind, starting at a change of kind.
    const n = loop.length;
    let s0 = 0;
    for (let i = 0; i < n; i++) {
      if (loop[i]!.kind !== loop[(i - 1 + n) % n]!.kind) {
        s0 = i;
        break;
      }
    }
    const uniform = loop.every((s) => s.kind === loop[0]!.kind);
    if (uniform) {
      edges.push({ kind: loop[0]!.kind, closed: true, points: dropStraight(loop.map((s) => P(...s.from)), true) });
      continue;
    }
    let run: Seg[] = [];
    for (let i = 0; i < n; i++) {
      const s = loop[(s0 + i) % n]!;
      if (run.length && run[0]!.kind !== s.kind) {
        edges.push({ kind: run[0]!.kind, closed: false, points: dropStraight([...run.map((q) => P(...q.from)), P(...run[run.length - 1]!.to)], false) });
        run = [];
      }
      run.push(s);
    }
    edges.push({ kind: run[0]!.kind, closed: false, points: dropStraight([...run.map((q) => P(...q.from)), P(...run[run.length - 1]!.to)], false) });
  }

  // ---- Shore: marching squares over every lattice cell of the built tiles, land on the left.
  // Crossing points sit at the middle of lattice edges: "h<gx>,<gz>" between (gx, gz) and
  // (gx + 1, gz); "v<gx>,<gz>" between (gx, gz) and (gx, gz + 1).
  const next = new Map<string, string>();
  const hasIn = new Set<string>();
  const ptOf = (key: string): P2 => {
    const [gx, gz] = key.slice(1).split(",").map(Number) as [number, number];
    return key[0] === "h" ? [(gx + 0.5) * GROUND_CELL_M, gz * GROUND_CELL_M] : [gx * GROUND_CELL_M, (gz + 0.5) * GROUND_CELL_M];
  };
  const link = (a: string, b: string, landX: number, landZ: number): void => {
    // Orient a -> b so the land point is on the left (left of travel is (dz, -dx), +z south).
    const pa = ptOf(a), pb = ptOf(b);
    const dx = pb[0] - pa[0], dz = pb[1] - pa[1];
    const left = (landX - pa[0]) * dz + (landZ - pa[1]) * -dx > 0;
    const [s, e] = left ? [a, b] : [b, a];
    if (next.has(s)) throw new Error(`boundary: shore point ${s} has two successors`);
    next.set(s, e);
    hasIn.add(e);
  };
  for (const t of [...tiles].sort((a, b) => a.iz - b.iz || a.ix - b.ix)) {
    for (let cz = t.iz * CELLS; cz < (t.iz + 1) * CELLS; cz++) {
      for (let cx = t.ix * CELLS; cx < (t.ix + 1) * CELLS; cx++) {
        const a = wAt(cx, cz), b = wAt(cx + 1, cz), c = wAt(cx + 1, cz + 1), d = wAt(cx, cz + 1);
        const sum = a + b + c + d;
        if (sum === 0 || sum === 4) continue;
        // Corners in order round the cell, with the lattice edge leaving each one.
        const corners: Array<{ w: number; x: number; z: number; edge: string }> = [
          { w: a, x: cx, z: cz, edge: `h${cx},${cz}` },
          { w: b, x: cx + 1, z: cz, edge: `v${cx + 1},${cz}` },
          { w: c, x: cx + 1, z: cz + 1, edge: `h${cx},${cz + 1}` },
          { w: d, x: cx, z: cz + 1, edge: `v${cx},${cz}` },
        ];
        // Each water corner whose neighbours round the cell are both land is cut off on its own
        // (saddles keep land connected); otherwise one segment separates the two halves.
        const crossings = corners.filter((q, i) => q.w !== corners[(i + 1) % 4]!.w).map((q) => q.edge);
        const land = corners.find((q) => q.w === 0)!;
        if (crossings.length === 2) {
          link(crossings[0]!, crossings[1]!, land.x * GROUND_CELL_M, land.z * GROUND_CELL_M);
        } else {
          // Saddle: two water corners on a diagonal. Cut each off with the edges either side of it.
          corners.forEach((q, i) => {
            if (q.w !== 1) return;
            const l = corners[(i + 1) % 4]!; // a land neighbour (the diagonal i + 2 is water)
            link(corners[(i + 3) % 4]!.edge, q.edge, l.x * GROUND_CELL_M, l.z * GROUND_CELL_M);
          });
        }
      }
    }
  }
  const shore: ShoreLine[] = [];
  const seen = new Set<string>();
  const walk = (start: string): string[] => {
    const chain = [start];
    seen.add(start);
    let cur = start;
    for (;;) {
      const nx = next.get(cur);
      if (nx === undefined || seen.has(nx)) {
        if (nx !== undefined && nx === start) chain.push(start);
        break;
      }
      chain.push(nx);
      seen.add(nx);
      cur = nx;
    }
    return chain;
  };
  const starts = [...next.keys()].filter((k) => !hasIn.has(k)).sort();
  const loops = [...next.keys()].sort();
  for (const k of [...starts, ...loops]) {
    if (seen.has(k)) continue;
    const chain = walk(k);
    const closed = chain.length > 2 && chain[chain.length - 1] === chain[0];
    const pts = simplifyLine(chain.map(ptOf), SHORE_SIMPLIFY_M).map(([x, z]) => [r2(x), r2(z)] as P2);
    if (closed) pts.pop();
    if (pts.length >= 2) shore.push({ closed, points: pts });
  }
  const key = (p: { points: P2[] }): string => `${p.points[0]![1].toFixed(2).padStart(12)} ${p.points[0]![0].toFixed(2).padStart(12)}`;
  shore.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  edges.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.kind < b.kind ? -1 : 1));

  const stats: BoundaryStats = {
    landEdgeM: Math.round(edges.filter((e) => e.kind === "land").reduce((s, e) => s + polyLength(e.points, e.closed), 0)),
    waterEdgeM: Math.round(edges.filter((e) => e.kind === "water").reduce((s, e) => s + polyLength(e.points, e.closed), 0)),
    shoreM: Math.round(shore.reduce((s, l) => s + polyLength(l.points, l.closed), 0)),
    shoreLines: shore.length,
  };
  return { edges, shore, stats };
}
