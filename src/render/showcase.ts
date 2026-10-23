// The Ferry Building showcase (high graphics tier only, gfx.ts): street detail within
// SHOWCASE.radiusM of the clock tower, built once from the road graph when the textures land.
//
//   * Paint: continental crosswalks (bars along the traffic, 0.6 m wide every 1.2 m) at the ends of
//     arterials and collectors that meet another street, ladder-free two-line crosswalks on smaller
//     streets, stop bars 1.2 m behind them across the approaching lanes. The paint's wear comes from
//     the generated "paint" set (its ORM R channel is coverage), so bars are scuffed and chipped.
//   * The paving mask: plazas, the Embarcadero's median and its waterfront promenade, rasterised
//     into a texture the ground's detail shader reads (detail.ts, third set): pavers there, concrete
//     elsewhere. Roads and buildings draw over the ground, so a generous strip costs nothing.
//   * The F-line: a concrete trackbed down the middle of the Embarcadero's median with two
//     standard-gauge tracks (rails 7 cm wide, 3 cm proud), and Canary Island date palms either side.
//
// Render-only: nothing here has a collider, nothing stands on a carriageway (tests/render/
// showcase.test.ts), and the sim never sees it. Pure geometry apart from the THREE objects it
// returns; deterministic (seeded placement).

import * as THREE from "three";
import { rand01 } from "./hash.ts";
import { roadHalfWidth } from "./roads.ts";
import type { GroundFn, RoadEdge, RoadGraph } from "./types.ts";

/** The showcase's centre (the clock tower, the world origin) and radius, metres. */
export const SHOWCASE = { x: 0, z: 0, radiusM: 800 } as const;

/** The paving mask's square, centred on the showcase, and its resolution. */
export const MASK_HALF_M = 820;
export const MASK_PX = 1024;

/** The showcase's kerb height: its sidewalks stand this far above the gutter (fading out over the last 20 m of the radius). */
export const KERB_M = 0.15;
/** The kerb-lift grid's cell, metres (what a person or a robot stands on). */
export const LIFT_CELL_M = 0.5;

/** How high the sidewalk is raised at (x, z): KERB_M inside the showcase, fading to 0 at its edge. */
export function kerbAt(x: number, z: number): number {
  const d = Math.hypot(x - SHOWCASE.x, z - SHOWCASE.z);
  return KERB_M * Math.max(0, Math.min(1, (SHOWCASE.radiusM - d) / 20));
}

/**
 * Where the raised sidewalks are (a raster of the sidewalk bands over the showcase square), so the
 * renderer stands people, robots and cars on them, not 15 cm inside. Render-only: the sim's ground
 * is unchanged.
 */
export class KerbLift {
  private readonly grid: Uint8Array;
  private readonly px: number;

  /** `bands`: sidewalks.ts sidewalkBandTriangles (raised strip, and the ramp behind it). */
  constructor(bands: { raised: ReadonlyArray<ReadonlyArray<readonly [number, number]>>; ramp: ReadonlyArray<ReadonlyArray<readonly [number, number]>> }) {
    this.px = Math.round((2 * MASK_HALF_M) / LIFT_CELL_M);
    const near = (ts: ReadonlyArray<ReadonlyArray<readonly [number, number]>>): P2[][] => ts.filter((t) => t.some(([x, z]) => inShowcase(x, z, 5))) as P2[][];
    const raised = rasterMask(near(bands.raised), MASK_HALF_M, this.px);
    const ramp = rasterMask(near(bands.ramp), MASK_HALF_M, this.px);
    this.grid = new Uint8Array(raised.length);
    for (let i = 0; i < raised.length; i++) this.grid[i] = raised[i] ? 2 : ramp[i] ? 1 : 0;
  }

  /** The lift at (x, z): kerbAt there on the raised strip, half of it on the ramp, else 0. */
  at = (x: number, z: number): number => {
    const c = Math.floor((x + MASK_HALF_M) / LIFT_CELL_M);
    const r = Math.floor((z + MASK_HALF_M) / LIFT_CELL_M);
    if (c < 0 || r < 0 || c >= this.px || r >= this.px) return 0;
    const g = this.grid[r * this.px + c]!;
    return g === 0 ? 0 : g === 2 ? kerbAt(x, z) : kerbAt(x, z) * 0.5;
  };
}

/** Paint lift over the drawn ground (the road ribbons are 2 cm up). */
const PAINT_LIFT = 0.032;

type P2 = readonly [number, number];

export function inShowcase(x: number, z: number, pad = 0): boolean {
  return Math.hypot(x - SHOWCASE.x, z - SHOWCASE.z) <= SHOWCASE.radiusM + pad;
}

// ------------------------------------------------------------------ polyline helpers

function lengthOf(pts: readonly P2[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
  return L;
}

/** Point and unit tangent at arc length s along pts (clamped). */
export function at(pts: readonly P2[], s: number): { x: number; z: number; tx: number; tz: number } {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l < 1e-9) continue;
    if (acc + l >= s || i === pts.length - 1) {
      const t = Math.max(0, Math.min(1, (s - acc) / l));
      return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, tx: (b[0] - a[0]) / l, tz: (b[1] - a[1]) / l };
    }
    acc += l;
  }
  const p = pts[0]!;
  return { x: p[0], z: p[1], tx: 1, tz: 0 };
}

/** pts offset sideways by d (positive: to the left of travel, i.e. (-tz, tx)... in x/z: left = (tz, -tx) for +z south). */
function offset(pts: readonly P2[], d: number, step = 3): P2[] {
  const L = lengthOf(pts);
  const n = Math.max(1, Math.ceil(L / step));
  const out: P2[] = [];
  for (let k = 0; k <= n; k++) {
    const p = at(pts, (L * k) / n);
    // Normal (nx, nz) = (-tz, tx): rotate the tangent a quarter turn.
    out.push([p.x - p.tz * d, p.z + p.tx * d]);
  }
  return out;
}

// ------------------------------------------------------------------ mesh accumulation

class Geo {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly uv: number[] = [];
  readonly col: number[] = [];
  readonly idx: number[] = [];

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, c: readonly [number, number, number] = [1, 1, 1]): number {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(c[0], c[1], c[2]);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  /** A flat quad on the ground: corners (counter-clockwise seen from above), draped. */
  groundQuad(c: readonly P2[], ground: GroundFn, lift: number): void {
    const base = this.pos.length / 3;
    for (const [x, z] of c) this.vert(x, ground(x, z) + lift, z, 0, 1, 0, x, z);
    // Seen from above (+y), x east and z south: (a, b, c) is counter-clockwise when the cross product's y > 0.
    const [a, b, d] = [c[0]!, c[1]!, c[2]!];
    const cy = (b[1] - a[1]) * (d[0] - a[0]) - (b[0] - a[0]) * (d[1] - a[1]);
    if (cy > 0) {
      this.tri(base, base + 1, base + 2);
      this.tri(base, base + 2, base + 3);
    } else {
      this.tri(base, base + 2, base + 1);
      this.tri(base, base + 3, base + 2);
    }
  }

  get empty(): boolean {
    return this.idx.length === 0;
  }

  build(colors = false): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    if (colors) g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/** A rectangle along the road: from arc s0 to s1 of pts, lateral from l0 to l1 (metres, + to the left). */
function bandAlong(pts: readonly P2[], s0: number, s1: number, l0: number, l1: number): P2[] {
  const a = at(pts, s0);
  const b = at(pts, s1);
  const nA: P2 = [-a.tz, a.tx];
  const nB: P2 = [-b.tz, b.tx];
  return [
    [a.x + nA[0] * l0, a.z + nA[1] * l0],
    [b.x + nB[0] * l0, b.z + nB[1] * l0],
    [b.x + nB[0] * l1, b.z + nB[1] * l1],
    [a.x + nA[0] * l1, a.z + nA[1] * l1],
  ];
}

// ------------------------------------------------------------------ paint

export interface PaintStats {
  crosswalks: number;
  stopBars: number;
}

/** True for streets whose crossings get continental bars. */
const busy = (e: RoadEdge): boolean => e.kind === "arterial" || e.kind === "collector";

/**
 * Crosswalks and stop bars for every street end within the showcase. `ends`: for each node, the
 * edges meeting it. Pure: returns the quads (ground-space corners).
 */
export function paintQuads(roads: RoadGraph): { quads: P2[][]; stats: PaintStats } {
  const atNode = new Map<string, RoadEdge[]>();
  for (const e of roads.edges) {
    if (e.pedestrian || e.kind === "freeway" || e.kind === "ramp" || e.gradeSeparated || !e.points || e.points.length < 2) continue;
    for (const n of [e.a, e.b]) (atNode.get(n) ?? atNode.set(n, []).get(n)!).push(e);
  }
  const quads: P2[][] = [];
  const stats: PaintStats = { crosswalks: 0, stopBars: 0 };
  for (const e of roads.edges) {
    if (e.pedestrian || e.kind === "freeway" || e.kind === "ramp" || e.kind === "alley" || e.gradeSeparated || !e.points || e.points.length < 2) continue;
    const L = lengthOf(e.points);
    for (const end of ["a", "b"] as const) {
      const node = end === "a" ? e.a : e.b;
      const meet = atNode.get(node) ?? [];
      if (meet.length < 3) continue;
      // Arc length measured from this end, along a polyline running from the node into the edge.
      const pts = end === "a" ? e.points : [...e.points].reverse();
      const p0 = pts[0]!;
      if (!inShowcase(p0[0], p0[1])) continue;
      const hw = roadHalfWidth(e);
      const nodeHalf = Math.max(...meet.map((m) => roadHalfWidth(m)));
      const s0 = nodeHalf + 1.0;
      const cw = 3.0;
      if (s0 + cw + 2 > L * 0.5) continue;
      const anyBusy = meet.some(busy);
      if (anyBusy) {
        const bars = Math.max(2, Math.floor((2 * hw - 0.6) / 1.2));
        const span = (bars - 1) * 1.2;
        for (let k = 0; k < bars; k++) {
          const c = -span / 2 + k * 1.2;
          quads.push(bandAlong(pts, s0, s0 + cw, c - 0.3, c + 0.3));
        }
      } else {
        quads.push(bandAlong(pts, s0, s0 + 0.3, -hw + 0.3, hw - 0.3));
        quads.push(bandAlong(pts, s0 + cw - 0.3, s0 + cw, -hw + 0.3, hw - 0.3));
      }
      stats.crosswalks++;
      // Stop bar across the lanes that approach the node: the pts run away from the node, so
      // traffic approaching it drives against pts; its right-hand side is our +lateral (left of pts).
      const approaches = !e.oneway || end === "b";
      if (approaches) {
        const sb = s0 + cw + 1.2;
        quads.push(e.oneway ? bandAlong(pts, sb, sb + 0.45, -hw + 0.3, hw - 0.3) : bandAlong(pts, sb, sb + 0.45, 0.2, hw - 0.3));
        stats.stopBars++;
      }
    }
  }
  return { quads, stats };
}

const PAINT_PARS = /* glsl */ `
uniform sampler2D fcPaintO;
uniform sampler2D fcPaintN;
varying vec3 fcPaintW;
`;

function paintMaterial(orm: THREE.Texture, normal: THREE.Texture): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xeeeae0, roughness: 0.85, metalness: 0, name: "fc:showcase-paint" });
  m.polygonOffset = true;
  m.polygonOffsetFactor = -3;
  m.polygonOffsetUnits = -6;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.fcPaintO = { value: orm };
    shader.uniforms.fcPaintN = { value: normal };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 fcPaintW;")
      .replace("#include <project_vertex>", "#include <project_vertex>\n  fcPaintW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${PAINT_PARS}`)
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
  vec3 fcPo = texture2D( fcPaintO, fcPaintW.xz * 0.5 ).rgb;
  if ( fcPo.r < 0.05 ) discard;
  diffuseColor.rgb *= 0.94 + 0.06 * fcPo.r;`,
      )
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n  roughnessFactor = max( 0.80, fcPo.g );");
  };
  m.customProgramCacheKey = () => "fc:showcase-paint:v2";
  return m;
}

// ------------------------------------------------------------------ paving mask

/** The Embarcadero's two carriageways beside the Ferry Building (their split and merge nodes). */
function embarcadero(roads: RoadGraph): RoadEdge[] {
  return roads.edges.filter((e) => e.name === "The Embarcadero" && e.points.some(([x, z]) => inShowcase(x, z)));
}

/** Polygons (local metres) the ground paves with pavers. */
export function pavingPolygons(roads: RoadGraph): P2[][] {
  const polys: P2[][] = [];
  const emb = embarcadero(roads);
  for (const e of emb) {
    const hw = roadHalfWidth(e);
    // Both sides, generously: the median between the carriageways, the waterfront promenade,
    // and Harry Bridges Plaza on the city side. Roads and buildings draw over the ground.
    for (const side of [1, -1]) {
      const inner = offset(e.points, side * (hw + 0.2));
      const outer = offset(e.points, side * (hw + 40));
      polys.push([...inner, ...outer.reverse()]);
    }
  }
  // Harry Bridges Plaza and the Embarcadero Plaza north-west of it: from the Embarcadero's
  // city-side carriageway to Steuart St and the foot of Market St, out to the Embarcadero Center's
  // towers (local metres, traced over the sf world's own roads and footprints).
  polys.push([
    [-81, 15],
    [-62, 46],
    [-44, 70],
    [-15, 98],
    [13, 120],
    [-20, 150],
    [-60, 172],
    [-125, 165],
    [-172, 112],
    [-175, -10],
    [-125, -45],
  ]);
  return polys;
}

/** Rasterise polygons into an R8 mask over the showcase square (even-odd per polygon, OR across polygons). */
export function rasterMask(polys: readonly P2[][], half = MASK_HALF_M, px = MASK_PX): Uint8Array {
  const out = new Uint8Array(px * px);
  const m = (2 * half) / px;
  for (const poly of polys) {
    let z0 = Infinity;
    let z1 = -Infinity;
    for (const p of poly) {
      z0 = Math.min(z0, p[1]);
      z1 = Math.max(z1, p[1]);
    }
    const r0 = Math.max(0, Math.floor((z0 + half) / m));
    const r1 = Math.min(px - 1, Math.ceil((z1 + half) / m));
    for (let r = r0; r <= r1; r++) {
      const z = -half + (r + 0.5) * m;
      const xs: number[] = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i]!;
        const b = poly[(i + 1) % poly.length]!;
        if (a[1] <= z !== b[1] <= z) xs.push(a[0] + ((z - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil((xs[k]! + half) / m - 0.5));
        const c1 = Math.min(px - 1, Math.floor((xs[k + 1]! + half) / m - 0.5));
        for (let c = c0; c <= c1; c++) out[r * px + c] = 255;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ the F-line and palms

/**
 * The median's centreline: midway between the Embarcadero's two carriageways where both run
 * 15-60 m apart, sampled every 4 m, within MEDIAN_REACH_M of the clock tower (the stretch in front
 * of the Ferry Building, not some other pair up the waterfront).
 */
export const MEDIAN_REACH_M = 450;

/** Street edges near the showcase that carry traffic (what nothing on the median may stand on). */
function carriageways(roads: RoadGraph): RoadEdge[] {
  return roads.edges.filter((e) => !e.pedestrian && e.points.length >= 2 && e.points.some(([x, z]) => inShowcase(x, z, 150)));
}

/** True when (x, z) is at least `clear` metres outside every carriageway's kerb. */
function offRoad(x: number, z: number, roads: readonly RoadEdge[], clear: number): boolean {
  for (const e of roads) {
    const hw = roadHalfWidth(e);
    for (let i = 1; i < e.points.length; i++) {
      const [ax, az] = e.points[i - 1]!;
      const [bx, bz] = e.points[i]!;
      const ex = bx - ax;
      const ez = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1)));
      if (Math.hypot(x - ax - ex * t, z - az - ez * t) < hw + clear) return false;
    }
  }
  return true;
}

export function medianLine(roads: RoadGraph): P2[] {
  const emb = embarcadero(roads).filter((e) => e.oneway);
  if (emb.length < 2) return [];
  const streets = carriageways(roads);
  // The longest pair of opposite carriageways whose centrelines stay 15-60 m apart.
  let best: P2[] = [];
  for (const a of emb) {
    for (const b of emb) {
      if (a === b) continue;
      const La = lengthOf(a.points);
      const line: P2[] = [];
      for (let s = 0; s <= La; s += 4) {
        const p = at(a.points, s);
        let bestD = Infinity;
        let q: P2 = [p.x, p.z];
        for (let t = 0, Lb = lengthOf(b.points); t <= Lb; t += 2) {
          const r = at(b.points, t);
          const d = Math.hypot(r.x - p.x, r.z - p.z);
          if (d < bestD) {
            bestD = d;
            q = [r.x, r.z];
          }
        }
        const mid: P2 = [(p.x + q[0]) / 2, (p.z + q[1]) / 2];
        if (bestD >= 15 && bestD <= 60 && Math.hypot(mid[0] - SHOWCASE.x, mid[1] - SHOWCASE.z) <= MEDIAN_REACH_M && offRoad(mid[0], mid[1], streets, 3.8)) line.push(mid);
        else if (line.length > 0) break;
      }
      if (lengthOf(line) > lengthOf(best)) best = line;
    }
  }
  return best;
}

const RAIL_GAUGE = 1.435;
const TRACK_SEP = 3.6;

function trackGeometry(line: readonly P2[], ground: GroundFn): { bed: THREE.BufferGeometry; rails: THREE.BufferGeometry } | null {
  if (line.length < 2) return null;
  const L = lengthOf(line);
  const bed = new Geo();
  const rails = new Geo();
  const step = 2;
  for (let s = 0; s + step <= L; s += step) {
    bed.groundQuad(bandAlong(line, s, s + step, -3.6, 3.6), ground, 0.03);
    for (const tc of [-TRACK_SEP / 2, TRACK_SEP / 2]) {
      for (const r of [-RAIL_GAUGE / 2, RAIL_GAUGE / 2]) {
        // A rail: top and two sides, 7 cm wide and 3 cm proud of the trackbed.
        const c = bandAlong(line, s, s + step, tc + r - 0.035, tc + r + 0.035);
        const base = rails.pos.length / 3;
        for (const [x, z] of c) rails.vert(x, ground(x, z) + 0.06, z, 0, 1, 0, 0, 0);
        for (const [x, z] of c) rails.vert(x, ground(x, z) + 0.03, z, 0, 1, 0, 0, 0);
        rails.tri(base, base + 2, base + 1);
        rails.tri(base, base + 3, base + 2);
        // Sides (the long edges 0-1 and 2-3), normals left as up: the shading reads as polished steel.
        rails.tri(base, base + 1, base + 5);
        rails.tri(base, base + 5, base + 4);
        rails.tri(base + 2, base + 3, base + 7);
        rails.tri(base + 2, base + 7, base + 6);
      }
    }
  }
  return { bed: bed.build(), rails: rails.build() };
}

/** Palm spots: both sides of the median line every 14 m, 5.5 m out, jittered a little; none within 1 m of a carriageway (with `roads`). */
export function palmSpots(line: readonly P2[], roads?: RoadGraph): Array<{ x: number; z: number; h: number; rot: number; lean: number }> {
  const streets = roads ? carriageways(roads) : [];
  const L = lengthOf(line);
  const out: Array<{ x: number; z: number; h: number; rot: number; lean: number }> = [];
  let k = 0;
  for (let s = 6; s < L - 6; s += 14) {
    const p = at(line, s);
    for (const side of [-1, 1]) {
      const j = rand01(`palm:${k}`);
      const d = side * (5.5 + (j - 0.5) * 0.6);
      const x = p.x - p.tz * d;
      const z = p.z + p.tx * d;
      if (roads && !offRoad(x, z, streets, 1.2)) {
        k++;
        continue;
      }
      out.push({ x, z, h: 10 + rand01(`palm-h:${k}`) * 4, rot: rand01(`palm-r:${k}`) * Math.PI * 2, lean: (rand01(`palm-l:${k}`) - 0.5) * 0.08 });
      k++;
    }
  }
  return out;
}

/** One Canary Island date palm, unit height (scaled per instance): trunk and crown as separate geometries. */
export function palmGeometry(): { trunk: THREE.BufferGeometry; crown: THREE.BufferGeometry } {
  const trunk = new Geo();
  const seg = 10;
  const rings = 24;
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    // A stout trunk that swells a little at the base and under the crown; leaf-scar rings in the colour.
    const r = 0.055 * (1 + 0.35 * Math.exp(-t * 9) + 0.12 * Math.exp(-(1 - t) * 12));
    const shade = 0.75 + 0.25 * Math.abs(Math.sin(t * rings * Math.PI * 1.5));
    const col: [number, number, number] = [0.22 * shade, 0.17 * shade, 0.11 * shade];
    for (let k = 0; k <= seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      trunk.vert(Math.cos(a) * r, t * 0.92, Math.sin(a) * r, Math.cos(a), 0, Math.sin(a), k / seg, t, col);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let k = 0; k < seg; k++) {
      const a = i * (seg + 1) + k;
      trunk.tri(a, a + seg + 1, a + 1);
      trunk.tri(a + 1, a + seg + 1, a + seg + 2);
    }
  }
  // Crown: 26 fronds, each an arching rachis with leaflet pairs; a pineapple-like knob at the top.
  const crown = new Geo();
  const fronds = 26;
  for (let f = 0; f < fronds; f++) {
    const yaw = (f / fronds) * Math.PI * 2 + (f % 2) * 0.12;
    const up = 0.55 - (f % 3) * 0.35; // some fronds rise, some droop
    const len = 0.36 + (f % 4) * 0.02;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const pts: Array<[number, number, number]> = [];
    const n = 9;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const along = t * len;
      const y = 0.92 + Math.sin(up) * along - 0.55 * along * along * (1.2 - Math.sin(up) * 0.3);
      const h = Math.cos(up * 0.6) * along;
      pts.push([cy * h, y, sy * h]);
    }
    const green: [number, number, number] = [0.09 + (f % 3) * 0.01, 0.16 + (f % 2) * 0.02, 0.06];
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0, z0] = pts[i - 1]!;
      const [x1, y1, z1] = pts[i]!;
      const t = i / pts.length;
      const w = 0.05 * Math.sin(Math.PI * Math.min(1, t * 1.1)) + 0.008;
      // Leaflets: a V-shaped pair either side of the rachis, drooping a little.
      for (const side of [-1, 1]) {
        const lx = -sy * w * side;
        const lz = cy * w * side;
        const a = crown.vert(x0, y0, z0, 0, 1, 0, 0, 0, green);
        const b = crown.vert(x1, y1, z1, 0, 1, 0, 0, 0, green);
        const c = crown.vert((x0 + x1) / 2 + lx, (y0 + y1) / 2 - w * 0.35, (z0 + z1) / 2 + lz, 0, 1, 0, 0, 0, green);
        crown.tri(a, b, c);
        crown.tri(a, c, b);
      }
    }
  }
  return { trunk: trunk.build(true), crown: crown.build(true) };
}

// ------------------------------------------------------------------ the showcase

export interface ShowcaseTextures {
  paint?: { orm: THREE.Texture; normal: THREE.Texture };
  concrete?: { albedo: THREE.Texture; normal: THREE.Texture; orm: THREE.Texture; sizeM: number };
}

export interface ShowcaseStats extends PaintStats {
  palms: number;
  trackM: number;
  paintQuads: number;
}

export interface Showcase {
  group: THREE.Group;
  mask: THREE.DataTexture;
  stats: ShowcaseStats;
  dispose(): void;
}

export function buildShowcase(roads: RoadGraph, ground: GroundFn, tex: ShowcaseTextures): Showcase {
  const group = new THREE.Group();
  group.name = "showcase";
  const disposables: Array<{ dispose(): void }> = [];

  const { quads, stats } = paintQuads(roads);
  if (tex.paint && quads.length > 0) {
    const g = new Geo();
    for (const q of quads) g.groundQuad(q, ground, PAINT_LIFT);
    const geo = g.build();
    const mat = paintMaterial(tex.paint.orm, tex.paint.normal);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = "showcase:paint";
    mesh.receiveShadow = true;
    group.add(mesh);
    disposables.push(geo, mat);
  }

  const line = medianLine(roads);
  const tracks = trackGeometry(line, ground);
  if (tracks) {
    // White: the concrete map is the colour (a tint would multiply it towards asphalt).
    const bedMat = new THREE.MeshStandardMaterial({ color: tex.concrete ? 0xffffff : 0x8d8a84, roughness: 0.9, metalness: 0, name: "fc:showcase-trackbed" });
    if (tex.concrete) {
      bedMat.map = tex.concrete.albedo;
      bedMat.normalMap = tex.concrete.normal;
      bedMat.roughnessMap = tex.concrete.orm;
      bedMat.aoMap = tex.concrete.orm;
      // World metres to texture repeats (the bed's uv is world x, z).
      for (const t of [tex.concrete.albedo, tex.concrete.normal, tex.concrete.orm]) t.repeat.set(1 / tex.concrete.sizeM, 1 / tex.concrete.sizeM);
    }
    bedMat.polygonOffset = true;
    bedMat.polygonOffsetFactor = -2;
    bedMat.polygonOffsetUnits = -4;
    const railMat = new THREE.MeshStandardMaterial({ color: 0x9a9894, roughness: 0.28, metalness: 0.95, name: "fc:showcase-rail" });
    const bed = new THREE.Mesh(tracks.bed, bedMat);
    bed.name = "showcase:trackbed";
    bed.receiveShadow = true;
    const rails = new THREE.Mesh(tracks.rails, railMat);
    rails.name = "showcase:rails";
    rails.receiveShadow = true;
    group.add(bed, rails);
    disposables.push(tracks.bed, tracks.rails, bedMat, railMat);
  }

  const spots = palmSpots(line, roads);
  if (spots.length > 0) {
    const { trunk, crown } = palmGeometry();
    const trunkMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, name: "fc:palm-trunk" });
    const crownMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0, side: THREE.DoubleSide, name: "fc:palm-crown" });
    const tI = new THREE.InstancedMesh(trunk, trunkMat, spots.length);
    const cI = new THREE.InstancedMesh(crown, crownMat, spots.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    spots.forEach((p, i) => {
      e.set(p.lean, p.rot, p.lean * 0.5);
      q.setFromEuler(e);
      m.compose(new THREE.Vector3(p.x, ground(p.x, p.z) - 0.1, p.z), q, new THREE.Vector3(p.h, p.h, p.h));
      tI.setMatrixAt(i, m);
      cI.setMatrixAt(i, m);
    });
    for (const im of [tI, cI]) {
      im.castShadow = true;
      im.receiveShadow = true;
      im.computeBoundingSphere();
    }
    tI.name = "showcase:palm-trunks";
    cI.name = "showcase:palm-crowns";
    group.add(tI, cI);
    disposables.push(trunk, crown, trunkMat, crownMat);
  }

  const maskData = rasterMask(pavingPolygons(roads));
  const mask = new THREE.DataTexture(maskData, MASK_PX, MASK_PX, THREE.RedFormat, THREE.UnsignedByteType);
  mask.magFilter = THREE.LinearFilter;
  mask.minFilter = THREE.LinearFilter;
  mask.needsUpdate = true;
  disposables.push(mask);

  return {
    group,
    mask,
    stats: { ...stats, palms: spots.length, trackM: Math.round(lengthOf(line)), paintQuads: quads.length },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
