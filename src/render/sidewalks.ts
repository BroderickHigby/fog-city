// Sidewalks for the pipeline's tiles (W-45). The tile glbs carry carriageway ribbons only, so
// walkers walked on bare ground beside the kerb. The pipeline's sidewalk graph
// (public/tiles/<world>/sidewalks.json, docs/data-sources.md "Sidewalk graph") has a walk line on
// each side of every street, cut where it would run onto another road; each `sidewalk` edge is
// drawn here as a paved band from its street's kerb out to 1.5 m past the walk line, draped on the
// ground as the tiles draw it, sampled every 2 m. Crossings are the carriageway's (the road ribbon
// is drawn over them). The band sits a hair over the ground and under the road ribbons (which are
// 2 cm up), so where a band's cut end touches another road the road wins.
//
// Pure geometry, deterministic: tests/render/sidewalks.test.ts.

import { tileId } from "../geo/project.ts";
import { roadHalfWidth } from "./roads.ts";
import type { GroundFn, RoadEdge } from "./types.ts";

export interface SidewalkGraph {
  nodes: Array<{ id: string; x: number; z: number; y?: number }>;
  edges: Array<{ id: string; a: string; b: string; kind: string; road?: string; points?: Array<[number, number]> }>;
}

/** One drawn sidewalk: its walk line and the street it runs beside. */
export interface SidewalkLine {
  id: string;
  road: string | null;
  points: Array<[number, number]>;
}

/** The band reaches this far past the walk line, away from the street. */
export const SIDEWALK_OUTER_M = 1.5;
/** Where the street is unknown, the band reaches this far towards it. */
export const SIDEWALK_INNER_DEFAULT_M = 1.5;
/** ... and never further than this towards it. */
const SIDEWALK_INNER_MAX_M = 3;
/** Samples along the walk line at most this far apart. */
export const SIDEWALK_STEP_M = 2;
/** Over the drawn ground (the road ribbons are 2 cm over it). */
export const SIDEWALK_LIFT_M = 0.012;

/** sRGB concrete, as linear RGB (the shared materials use vertex colours in linear space). */
const CONCRETE: readonly [number, number, number] = [0.33, 0.32, 0.3];

/** The graph's sidewalks (not its crossings) as polylines, by the tile their midpoint is in. */
export function sidewalksByTile(g: SidewalkGraph, tileSizeM = 500): Map<string, SidewalkLine[]> {
  const nodes = new Map(g.nodes.map((n) => [n.id, n]));
  const out = new Map<string, SidewalkLine[]>();
  for (const e of g.edges) {
    if (e.kind !== "sidewalk") continue;
    const a = nodes.get(e.a);
    const b = nodes.get(e.b);
    if (!a || !b) continue;
    const points: Array<[number, number]> = [[a.x, a.z], ...(e.points ?? []), [b.x, b.z]];
    // Midpoint by length.
    let L = 0;
    for (let i = 1; i < points.length; i++) L += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
    let acc = 0;
    let mid = points[0]!;
    for (let i = 1; i < points.length; i++) {
      const p = points[i - 1]!;
      const q = points[i]!;
      const s = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (acc + s >= L / 2 && s > 0) {
        const t = (L / 2 - acc) / s;
        mid = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
        break;
      }
      acc += s;
    }
    const id = tileId(Math.floor(mid[0] / tileSizeM), Math.floor(mid[1] / tileSizeM));
    let l = out.get(id);
    if (!l) out.set(id, (l = []));
    l.push({ id: e.id, road: e.road ?? null, points });
  }
  return out;
}

/** The nearest point of a polyline to (x, z) and its distance. */
function nearestOn(pts: ReadonlyArray<readonly [number, number]>, x: number, z: number): { x: number; z: number; d: number } {
  let best = { x: pts[0]![0], z: pts[0]![1], d: Infinity };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const L2 = dx * dx + dz * dz;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / L2)) : 0;
    const px = a[0] + dx * t;
    const pz = a[1] + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best.d) best = { x: px, z: pz, d };
  }
  return best;
}

export interface SidewalkMesh {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  /** u: 0 at the street side, 1 at the outer edge; v: metres along the walk line. */
  uvs: Float32Array;
  indices: Uint32Array;
}

/**
 * The bands of some sidewalks: per sample along each walk line, a point at the street's kerb
 * (the street's centreline distance less its half width), one on the walk line and one
 * SIDEWALK_OUTER_M beyond it, each on the drawn ground plus SIDEWALK_LIFT_M. Null when empty.
 */
export function sidewalkMesh(lines: readonly SidewalkLine[], roads: ReadonlyMap<string, RoadEdge>, ground: GroundFn, kerbAt?: GroundFn): SidewalkMesh | null {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const nrm: number[] = [];
  // Kerb faces (high tier, showcase.ts): a vertical strip down from the raised band to the gutter.
  const face: { pos: number[]; nrm: number[]; uv: number[]; idx: number[] } = { pos: [], nrm: [], uv: [], idx: [] };
  for (const line of lines) {
    const road = line.road ? roads.get(line.road) : undefined;
    const hw = road ? roadHalfWidth(road) : 0;
    const pts = line.points;
    // Densify.
    const samples: Array<{ x: number; z: number; s: number; dx: number; dz: number }> = [];
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1e-6) continue;
      const n = Math.max(1, Math.ceil(len / SIDEWALK_STEP_M));
      const dx = (b[0] - a[0]) / len;
      const dz = (b[1] - a[1]) / len;
      for (let k = samples.length === 0 ? 0 : 1; k <= n; k++) {
        const t = k / n;
        samples.push({ x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, s: acc + len * t, dx, dz });
      }
      acc += len;
    }
    if (samples.length < 2) continue;
    // Which side the street is on: the side its centreline's nearest point lies, by majority.
    let sideVote = 0;
    for (const p of samples) {
      if (!road) break;
      const q = nearestOn(road.points, p.x, p.z);
      sideVote += Math.sign(-p.dz * (q.x - p.x) + p.dx * (q.z - p.z));
    }
    const toRoad = sideVote >= 0 ? 1 : -1;
    const base = pos.length / 3;
    const faceBase = face.pos.length / 3;
    for (const p of samples) {
      // Right-hand normal (-dz, dx) points to the street when toRoad is 1.
      const nx = -p.dz * toRoad;
      const nz = p.dx * toRoad;
      let inner = SIDEWALK_INNER_DEFAULT_M;
      if (road) {
        const q = nearestOn(road.points, p.x, p.z);
        inner = Math.min(SIDEWALK_INNER_MAX_M, Math.max(0, q.d - hw));
      }
      const cross: Array<[number, number]> = [
        [inner, 0],
        [0, inner / (inner + SIDEWALK_OUTER_M)],
        [-SIDEWALK_OUTER_M, 1],
      ];
      // Raised where kerbAt says (the band's kerb edge stands on the gutter line, inner metres out).
      const kx = p.x + nx * inner;
      const kz = p.z + nz * inner;
      const kerb = kerbAt ? kerbAt(kx, kz) : 0;
      for (const [off, u] of cross) {
        const x = p.x + nx * off;
        const z = p.z + nz * off;
        // The kerb to the walk line stand raised; the back of the band ramps down to the ground,
        // so it meets a plaza or a lawn level, with no floating edge.
        pos.push(x, ground(x, z) + SIDEWALK_LIFT_M + (u < 1 ? kerb : 0), z);
        nrm.push(0, 1, 0);
        uv.push(u, p.s);
      }
      if (kerbAt) {
        const g = ground(kx, kz);
        face.pos.push(kx, g + SIDEWALK_LIFT_M + kerb, kz, kx, g, kz);
        face.nrm.push(nx, 0, nz, nx, 0, nz);
        face.uv.push(0, p.s, 0, p.s);
      }
    }
    if (kerbAt) {
      for (let k = 0; k + 1 < samples.length; k++) {
        const t0 = faceBase + 2 * k;
        const b0 = t0 + 1;
        const t1 = t0 + 2;
        const b1 = t0 + 3;
        // Facing the street (+n): wind so the face's normal agrees with (nx, nz).
        const ax = face.pos[3 * t1]! - face.pos[3 * t0]!;
        const az = face.pos[3 * t1 + 2]! - face.pos[3 * t0 + 2]!;
        const fnx = face.nrm[3 * t0]!;
        const fnz = face.nrm[3 * t0 + 2]!;
        // The loop t0 -> b0 -> b1 -> t1 faces (b0 - t0) x (t1 - t0) ~ (-az, 0, ax): keep it when
        // that agrees with the street-side normal, else reverse it.
        const out = -az * fnx + ax * fnz;
        if (out > 0) face.idx.push(t0, b0, b1, t0, b1, t1);
        else face.idx.push(t0, b1, b0, t0, t1, b1);
      }
    }
    for (let k = 0; k + 1 < samples.length; k++) {
      const r0 = base + 3 * k;
      const r1 = r0 + 3;
      for (let c = 0; c < 2; c++) {
        const a = r0 + c;
        const b = r0 + c + 1;
        const d = r1 + c;
        const e = r1 + c + 1;
        // Wind each triangle to face up.
        for (const tri of [
          [a, d, b],
          [b, d, e],
        ]) {
          const [i, j, l] = tri as [number, number, number];
          const ny = (pos[3 * j + 2]! - pos[3 * i + 2]!) * (pos[3 * l]! - pos[3 * i]!) - (pos[3 * j]! - pos[3 * i]!) * (pos[3 * l + 2]! - pos[3 * i + 2]!);
          if (ny >= 0) idx.push(i, j, l);
          else idx.push(i, l, j);
        }
      }
    }
  }
  if (idx.length === 0) return null;
  // The kerb faces join the band's buffers (same material: concrete, the kerb strip's u = 0).
  const off = pos.length / 3;
  for (const v of face.idx) idx.push(v + off);
  pos.push(...face.pos);
  nrm.push(...face.nrm);
  uv.push(...face.uv);
  const n = pos.length / 3;
  const colors = new Float32Array(pos.length);
  for (let i = 0; i < n; i++) colors.set(CONCRETE, 3 * i);
  return { positions: new Float32Array(pos), normals: new Float32Array(nrm), colors, uvs: new Float32Array(uv), indices: new Uint32Array(idx) };
}

/**
 * The bands' triangles in plan (ground x, z): `raised` from the kerb to the walk line, `ramp` from
 * the walk line to the outer edge. showcase.ts rasterises them into the kerb-lift grid.
 */
export function sidewalkBandTriangles(lines: readonly SidewalkLine[], roads: ReadonlyMap<string, RoadEdge>): { raised: Array<Array<[number, number]>>; ramp: Array<Array<[number, number]>> } {
  const flat: GroundFn = () => 0;
  const mesh = sidewalkMesh(lines, roads, flat);
  const out = { raised: [] as Array<Array<[number, number]>>, ramp: [] as Array<Array<[number, number]>> };
  if (!mesh) return out;
  // sidewalkMesh emits, per sample step, two triangles from the kerb to the walk line, then two
  // from the walk line to the outer edge (no kerb faces without kerbAt).
  const p = mesh.positions;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const tri = [mesh.indices[t]!, mesh.indices[t + 1]!, mesh.indices[t + 2]!].map((i) => [p[3 * i]!, p[3 * i + 2]!] as [number, number]);
    (Math.floor(t / 6) % 2 === 0 ? out.raised : out.ramp).push(tri);
  }
  return out;
}
