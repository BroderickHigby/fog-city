// Road surfaces for clearance queries: each road edge is a ribbon of its centreline +/- half
// its width (kerb to kerb), the same ribbon mesh.ts draws. clearance(x, z) is how far the
// point lies outside the nearest ribbon: negative inside a road, 0 on a kerb line.
//
// Used to keep sidewalks and hydrants off the carriageway (sidewalks.ts, gameplay.ts).
// Pedestrian-only ways (STREETS_PEDESTRI) are not traffic and are left out by the callers.

import type { RoadEdge } from "./roads.ts";

/** Cell size of the segment grid, metres. */
const CELL_M = 8;
const key = (cx: number, cz: number): number => (cx + 32768) * 65536 + (cz + 32768);

export class RoadSurface {
  /** Clearances at or above this are reported as Infinity (no segment within reach). */
  readonly reach: number;
  private readonly edges: readonly RoadEdge[];
  private readonly seg: Float64Array; // ax, az, bx, bz, half per segment
  private readonly segEdge: Int32Array;
  private readonly cells = new Map<number, number[]>();

  constructor(edges: readonly RoadEdge[], reach = 3) {
    this.reach = reach;
    this.edges = edges;
    let n = 0;
    for (const e of edges) n += Math.max(0, e.points.length - 1);
    this.seg = new Float64Array(n * 5);
    this.segEdge = new Int32Array(n);
    let s = 0;
    edges.forEach((e, ei) => {
      const half = e.widthM / 2;
      for (let i = 1; i < e.points.length; i++) {
        const a = e.points[i - 1]!, b = e.points[i]!;
        this.seg.set([a[0], a[1], b[0], b[1], half], s * 5);
        this.segEdge[s] = ei;
        const pad = half + reach;
        const cx0 = Math.floor((Math.min(a[0], b[0]) - pad) / CELL_M), cx1 = Math.floor((Math.max(a[0], b[0]) + pad) / CELL_M);
        const cz0 = Math.floor((Math.min(a[1], b[1]) - pad) / CELL_M), cz1 = Math.floor((Math.max(a[1], b[1]) + pad) / CELL_M);
        for (let cx = cx0; cx <= cx1; cx++) {
          for (let cz = cz0; cz <= cz1; cz++) {
            const k = key(cx, cz);
            let l = this.cells.get(k);
            if (!l) this.cells.set(k, (l = []));
            l.push(s);
          }
        }
        s++;
      }
    });
  }

  /** Distance from (x, z) to the nearest road ribbon's edge (negative inside it), with that road. */
  nearest(x: number, z: number): { clearance: number; edge: RoadEdge | null } {
    const list = this.cells.get(key(Math.floor(x / CELL_M), Math.floor(z / CELL_M)));
    let best = Infinity;
    let bestEdge = -1;
    if (list) {
      const g = this.seg;
      for (const s of list) {
        const o = s * 5;
        const ax = g[o]!, az = g[o + 1]!, ex = g[o + 2]! - ax, ez = g[o + 3]! - az;
        const l2 = ex * ex + ez * ez;
        let t = l2 > 0 ? ((x - ax) * ex + (z - az) * ez) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const c = Math.hypot(x - (ax + ex * t), z - (az + ez * t)) - g[o + 4]!;
        const ei = this.segEdge[s]!;
        // Ties go to the lower edge index, so the reported road is deterministic.
        if (c < best - 1e-9 || (Math.abs(c - best) <= 1e-9 && ei < bestEdge)) {
          best = c;
          bestEdge = ei;
        }
      }
    }
    if (best >= this.reach) return { clearance: Infinity, edge: null };
    return { clearance: best, edge: bestEdge >= 0 ? this.edges[bestEdge]! : null };
  }

  clearance(x: number, z: number): number {
    return this.nearest(x, z).clearance;
  }
}

/** The road edges that carry traffic: everything but pedestrian-only ways. */
export const trafficEdges = (edges: readonly RoadEdge[]): RoadEdge[] => edges.filter((e) => !e.pedestrian);
