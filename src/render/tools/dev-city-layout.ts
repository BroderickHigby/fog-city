// dev-city: a procedural test world for the renderer. Not real geography, but laid out
// like the north-east of San Francisco so landmarks placed by real lat/lon land somewhere
// sensible: the origin plaza on the east waterfront (where the Ferry Building goes), the
// Bay to the east and north, a diagonal avenue running south-west from the plaza that
// splits two street grids, steep hills to the west, piers along the shore.
//
// Pure and deterministic: the same code always yields the same world. build-dev-city.ts
// writes it to public/tiles/dev-city/; tests/render/dev-city.test.ts checks the committed
// files against a fresh run.

import type { BuildingCollider, Heightfield, TileCollider } from "../../sim/world.ts";
import { mulberry32 } from "../hash.ts";
import { roadHalfWidth, sidewalkWidth } from "../roads.ts";
import type { RoadEdge, RoadGraph, RoadKind, RoadNode } from "../types.ts";

export const WORLD = "dev-city";
export const TILE = 500;
export const IX = [-5, 0] as const; // inclusive
export const IZ = [-3, 1] as const;
export const CELL = 10;
export const SPAWN = { x: -55, z: 300, heading: 0 };

type P = [number, number];

// ---------------------------------------------------------------------------------------
// Coast and terrain

/** The shoreline, land on the left when walking it (south to north, then west). */
export const COAST: P[] = [
  [-10, 1150],
  [-10, 160],
  [60, 150],
  [60, -150],
  [-10, -160],
  [-30, -500],
  [-150, -820],
  [-450, -1080],
  [-900, -1220],
  [-1500, -1290],
  [-2650, -1330],
];

/** Coast without the plaza bump, used to lay the waterfront boulevard. */
const COAST_SMOOTH: P[] = COAST.filter((_, i) => i < 1 || i > 4);

export const BOULEVARD_OFFSET = 45;

/** Signed distance to a polyline: positive on its left (land), negative on its right (water). */
export function inlandDistance(x: number, z: number, line: readonly P[] = COAST): number {
  let best = Infinity;
  let sign = 1;
  for (let i = 1; i < line.length; i++) {
    const [ax, az] = line[i - 1]!;
    const [bx, bz] = line[i]!;
    const ex = bx - ax;
    const ez = bz - az;
    const l2 = ex * ex + ez * ez;
    let t = ((x - ax) * ex + (z - az) * ez) / l2;
    t = Math.max(0, Math.min(1, t));
    const px = ax + ex * t;
    const pz = az + ez * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best - 1e-9) {
      best = d;
      // Left normal of (ex, ez) as seen from above is (ez, -ex).
      const s = (x - px) * ez + (z - pz) * -ex;
      sign = s >= 0 ? 1 : -1;
      if (t <= 0 || t >= 1) {
        // At a vertex use the bisector side test against both neighbours.
        const s2 = (x - ax) * ez - (z - az) * ex;
        sign = s2 >= 0 ? 1 : -1;
      }
    }
  }
  return best * sign;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

const HILLS: Array<{ x: number; z: number; h: number; r: number }> = [
  { x: -1066, z: -766, h: 82, r: 210 }, // like Telegraph Hill
  { x: -1950, z: 260, h: 96, r: 380 }, // like Nob Hill
  { x: -2300, z: -640, h: 84, r: 300 }, // like Russian Hill
  { x: -1500, z: 900, h: 22, r: 500 },
];

export function terrainHeight(x: number, z: number): number {
  const d = inlandDistance(x, z);
  if (d < 0) return Math.max(-9, 1.6 + d * 0.35);
  let h = 1.6 + Math.min(d, 600) * 0.004;
  let hills = 0;
  for (const k of HILLS) {
    const r2 = (x - k.x) * (x - k.x) + (z - k.z) * (z - k.z);
    hills += k.h * Math.exp(-r2 / (2 * k.r * k.r));
  }
  h += hills * smoothstep(0, 80, d);
  return h;
}

// ---------------------------------------------------------------------------------------
// Streets

interface StreetSpec {
  name: string;
  kind: RoadKind;
  lanes: number;
  widthM: number;
  oneway: boolean;
  pts: P[];
}

const MARKET_START: P = [-55, 20];
const MARKET_DIR: P = [-0.8191520443, 0.5735764364]; // compass bearing 235 degrees
const MARKET_N: P = [MARKET_DIR[1], -MARKET_DIR[0]]; // left normal: south-east

/** > 0 south-east of the diagonal avenue, < 0 north-west of it. */
function marketSide(x: number, z: number): number {
  return (x - MARKET_START[0]) * MARKET_N[0] + (z - MARKET_START[1]) * MARKET_N[1];
}

const X0 = IX[0] * TILE;
const X1 = (IX[1] + 1) * TILE;
const Z0 = IZ[0] * TILE;
const Z1 = (IZ[1] + 1) * TILE;

function inWorld(x: number, z: number, pad = 0): boolean {
  return x >= X0 + pad && x <= X1 - pad && z >= Z0 + pad && z <= Z1 - pad;
}

function offsetPolyline(line: readonly P[], off: number): P[] {
  const out: P[] = [];
  for (let i = 0; i < line.length; i++) {
    const prev = line[Math.max(0, i - 1)]!;
    const next = line[Math.min(line.length - 1, i + 1)]!;
    const cur = line[i]!;
    const n = (a: P, b: P): P => {
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const l = Math.hypot(dx, dz) || 1;
      return [dz / l, -dx / l];
    };
    const n1 = i > 0 ? n(prev, cur) : n(cur, next);
    const n2 = i < line.length - 1 ? n(cur, next) : n1;
    let mx = n1[0] + n2[0];
    let mz = n1[1] + n2[1];
    const ml = Math.hypot(mx, mz) || 1;
    mx /= ml;
    mz /= ml;
    const k = off / Math.max(0.5, mx * n1[0] + mz * n1[1]);
    out.push([cur[0] + mx * k, cur[1] + mz * k]);
  }
  return out;
}

export const BOULEVARD: P[] = offsetPolyline(COAST_SMOOTH, BOULEVARD_OFFSET);

/** Walk a straight line and keep the parts where keep() holds; 1 m resolution. */
function clipLine(a: P, b: P, keep: (x: number, z: number) => boolean): P[][] {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.ceil(L);
  const out: P[][] = [];
  let start: P | null = null;
  let last: P | null = null;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p: P = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    if (keep(p[0], p[1])) {
      if (!start) start = p;
      last = p;
    } else if (start && last) {
      if (Math.hypot(last[0] - start[0], last[1] - start[1]) > 20) out.push([start, last]);
      start = null;
      last = null;
    }
  }
  if (start && last && Math.hypot(last[0] - start[0], last[1] - start[1]) > 20) out.push([start, last]);
  return out;
}

const NS_NAMES = ["Seed", "Angel", "Runway", "Pivot", "Vesting", "Moat", "Hype", "Synergy", "Unicorn", "Equity", "Dilution", "Traction", "Churn", "Bootstrap", "Demo Day", "Pitch", "Lockup", "Burn Rate", "Moonshot", "Flywheel", "Stealth", "Blitz"];
const EW_NAMES = ["Term Sheet", "Cap Table", "Down Round", "Tender", "Liquidation", "Preference", "Ratchet", "Warrant", "Option Pool", "Board Seat", "Pro Rata", "Safe Note", "Convertible", "Bridge Round", "Acquihire", "Runway Ext", "Due Diligence", "Lead Investor", "Hockey Stick", "Seed Extension", "Burn Multiple", "Exit Ramp", "Up Round", "Side Letter"];
const B_PAR = ["Mission Creep", "Scope", "Roadmap", "Backlog", "Sprint", "Standup", "Retro", "Offsite"];
const B_PERP = ["First Hire", "Second Hire", "Third Hire", "Fourth Hire", "Fifth Hire", "Sixth Hire", "Seventh Hire", "Eighth Hire", "Ninth Hire", "Tenth Hire", "Eleventh Hire", "Twelfth Hire", "Thirteenth Hire"];

// Grid A (north-west of the avenue): axis aligned.
const A_XS = Array.from({ length: 21 }, (_, k) => -175 - k * 115);
const A_ZS = Array.from({ length: 24 }, (_, k) => 990 - k * 95);
// Grid B (south-east of the avenue): parallel and perpendicular to it.
const B_VS = Array.from({ length: 8 }, (_, k) => 125 + k * 130);
const B_US = Array.from({ length: 13 }, (_, k) => 150 + k * 165);

function bPoint(u: number, v: number): P {
  return [MARKET_START[0] + MARKET_DIR[0] * u + MARKET_N[0] * v, MARKET_START[1] + MARKET_DIR[1] * u + MARKET_N[1] * v];
}

function landAt(x: number, z: number, minInland: number): boolean {
  return inlandDistance(x, z, BOULEVARD) >= minInland - BOULEVARD_OFFSET && inlandDistance(x, z) >= minInland;
}

function streetSpecs(): StreetSpec[] {
  const out: StreetSpec[] = [];
  const over = 2.5; // overshoot so the planariser finds the crossing; stubs are trimmed after.
  const insideA = (x: number, z: number): boolean => inWorld(x, z) && marketSide(x, z) < over && landAt(x, z, BOULEVARD_OFFSET - over);
  const insideB = (x: number, z: number): boolean => inWorld(x, z) && marketSide(x, z) > -over && landAt(x, z, BOULEVARD_OFFSET - over);
  A_XS.forEach((x, k) => {
    const major = k % 4 === 2;
    for (const seg of clipLine([x, Z1], [x, Z0], insideA)) {
      out.push({ name: `${NS_NAMES[k % NS_NAMES.length]} Street`, kind: major ? "collector" : "residential", lanes: 2, widthM: major ? 15 : 11, oneway: false, pts: seg });
    }
  });
  A_ZS.forEach((z, k) => {
    const major = k % 5 === 1;
    for (const seg of clipLine([X1, z], [X0, z], insideA)) {
      out.push({ name: `${EW_NAMES[k % EW_NAMES.length]} Street`, kind: major ? "collector" : "residential", lanes: 2, widthM: major ? 15 : 11, oneway: false, pts: seg });
    }
  });
  B_VS.forEach((v, k) => {
    const a = bPoint(-400, v);
    const b = bPoint(4000, v);
    for (const seg of clipLine(a, b, insideB)) {
      const pts = k % 2 === 0 ? seg : [seg[1]!, seg[0]!];
      out.push({ name: `${B_PAR[k % B_PAR.length]} Street`, kind: "collector", lanes: 3, widthM: 16, oneway: true, pts });
    }
  });
  B_US.forEach((u, k) => {
    const a = bPoint(u, -50);
    const b = bPoint(u, 2500);
    for (const seg of clipLine(a, b, insideB)) {
      out.push({ name: `${B_PERP[k % B_PERP.length]} Street`, kind: "residential", lanes: 2, widthM: 12, oneway: false, pts: seg });
    }
  });
  // The diagonal avenue.
  const mEnd = bPoint(4000, 0);
  for (const seg of clipLine(bPoint(-over, 0), mEnd, (x, z) => inWorld(x, z))) {
    out.push({ name: "Valuation Street", kind: "arterial", lanes: 4, widthM: 26, oneway: false, pts: seg });
  }
  // The waterfront boulevard, clipped to the world.
  const bl: P[] = [];
  for (const p of BOULEVARD) if (inWorld(p[0], p[1], -200)) bl.push(p);
  out.push({ name: "Waterfront Boulevard", kind: "arterial", lanes: 4, widthM: 22, oneway: false, pts: clipPolylineToWorld(bl) });
  return out;
}

function clipPolylineToWorld(pts: P[]): P[] {
  const out: P[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    if (inWorld(p[0], p[1])) {
      out.push(p);
      continue;
    }
    const prev = pts[i - 1];
    const next = pts[i + 1];
    const clampTo = (q: P, r: P): P => {
      // Move r toward q until it is inside the world.
      for (let t = 0; t <= 1; t += 0.001) {
        const x = r[0] + (q[0] - r[0]) * t;
        const z = r[1] + (q[1] - r[1]) * t;
        if (inWorld(x, z)) return [x, z];
      }
      return q;
    };
    if (prev && inWorld(prev[0], prev[1])) out.push(clampTo(prev, p));
    else if (next && inWorld(next[0], next[1])) out.push(clampTo(next, p));
  }
  return out;
}

interface Seg {
  street: number;
  a: P;
  b: P;
  t0: number; // arc length of a along the street
}

function segIntersect(p: P, p2: P, q: P, q2: P): { t: number; u: number } | null {
  const rx = p2[0] - p[0];
  const rz = p2[1] - p[1];
  const sx = q2[0] - q[0];
  const sz = q2[1] - q[1];
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const qpx = q[0] - p[0];
  const qpz = q[1] - p[1];
  const t = (qpx * sz - qpz * sx) / den;
  const u = (qpx * rz - qpz * rx) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { t, u };
}

/** Split streets at every crossing into a road graph; trim overshoot stubs. */
export function buildRoadGraph(): RoadGraph {
  const streets = streetSpecs();
  const segs: Seg[] = [];
  streets.forEach((s, si) => {
    let acc = 0;
    for (let i = 1; i < s.pts.length; i++) {
      const a = s.pts[i - 1]!;
      const b = s.pts[i]!;
      segs.push({ street: si, a, b, t0: acc });
      acc += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
  });
  // Cut points per street: arc length -> point.
  const cuts: Array<Array<{ s: number; p: P }>> = streets.map((s) => {
    const L = s.pts.reduce((acc, p, i) => (i === 0 ? 0 : acc + Math.hypot(p[0] - s.pts[i - 1]![0], p[1] - s.pts[i - 1]![1])), 0);
    return [
      { s: 0, p: s.pts[0]! },
      { s: L, p: s.pts[s.pts.length - 1]! },
    ];
  });
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const A = segs[i]!;
      const B = segs[j]!;
      if (A.street === B.street) continue;
      const hit = segIntersect(A.a, A.b, B.a, B.b);
      if (!hit) continue;
      const p: P = [A.a[0] + (A.b[0] - A.a[0]) * hit.t, A.a[1] + (A.b[1] - A.a[1]) * hit.t];
      const la = Math.hypot(A.b[0] - A.a[0], A.b[1] - A.a[1]);
      const lb = Math.hypot(B.b[0] - B.a[0], B.b[1] - B.a[1]);
      cuts[A.street]!.push({ s: A.t0 + hit.t * la, p });
      cuts[B.street]!.push({ s: B.t0 + hit.u * lb, p });
    }
  }
  // Node registry with snapping.
  const nodes: RoadNode[] = [];
  const nodeAt = new Map<string, RoadNode>();
  const key = (p: P): string => `${Math.round(p[0] / 1.5)},${Math.round(p[1] / 1.5)}`;
  const getNode = (p: P): RoadNode => {
    const k = key(p);
    let n = nodeAt.get(k);
    if (!n) {
      n = { id: `n${nodes.length}`, x: round2(p[0]), z: round2(p[1]) };
      nodes.push(n);
      nodeAt.set(k, n);
    }
    return n;
  };
  let edges: RoadEdge[] = [];
  streets.forEach((s, si) => {
    const cs = cuts[si]!.sort((a, b) => a.s - b.s);
    const uniq: Array<{ s: number; p: P }> = [];
    for (const c of cs) if (!uniq.length || c.s - uniq[uniq.length - 1]!.s > 0.5) uniq.push(c);
    for (let k = 1; k < uniq.length; k++) {
      const c0 = uniq[k - 1]!;
      const c1 = uniq[k]!;
      const pts: P[] = [c0.p];
      // Interior polyline vertices between the cuts.
      let acc = 0;
      for (let i = 1; i < s.pts.length - 1; i++) {
        acc += Math.hypot(s.pts[i]![0] - s.pts[i - 1]![0], s.pts[i]![1] - s.pts[i - 1]![1]);
        if (acc > c0.s + 0.5 && acc < c1.s - 0.5) pts.push(s.pts[i]!);
      }
      pts.push(c1.p);
      const na = getNode(c0.p);
      const nb = getNode(c1.p);
      if (na === nb) continue;
      pts[0] = [na.x, na.z];
      pts[pts.length - 1] = [nb.x, nb.z];
      edges.push({
        id: "",
        a: na.id,
        b: nb.id,
        kind: s.kind,
        lanes: s.lanes,
        oneway: s.oneway,
        widthM: s.widthM,
        name: s.name,
        points: pts.map(([x, z]) => [round2(x), round2(z)] as [number, number]),
      });
    }
  });
  // Trim dangling stubs left by the overshoot, repeatedly.
  for (let pass = 0; pass < 4; pass++) {
    const deg = new Map<string, number>();
    for (const e of edges) {
      deg.set(e.a, (deg.get(e.a) ?? 0) + 1);
      deg.set(e.b, (deg.get(e.b) ?? 0) + 1);
    }
    const before = edges.length;
    edges = edges.filter((e) => {
      const L = e.points.reduce((acc, p, i) => (i === 0 ? 0 : acc + Math.hypot(p[0] - e.points[i - 1]![0], p[1] - e.points[i - 1]![1])), 0);
      const dangling = (deg.get(e.a) ?? 0) === 1 || (deg.get(e.b) ?? 0) === 1;
      return !(dangling && L < 8);
    });
    if (edges.length === before) break;
  }
  const used = new Set<string>();
  for (const e of edges) {
    used.add(e.a);
    used.add(e.b);
  }
  // Renumber compactly and deterministically.
  const keep = nodes.filter((n) => used.has(n.id));
  const rename = new Map<string, string>();
  keep.forEach((n, i) => rename.set(n.id, `n${i}`));
  const outNodes = keep.map((n) => ({ ...n, id: rename.get(n.id)!, y: undefined as number | undefined })).map(({ y: _y, ...n }) => n);
  edges.forEach((e, i) => {
    e.id = `e${i}`;
    e.a = rename.get(e.a)!;
    e.b = rename.get(e.b)!;
  });
  return { version: 1, nodes: outNodes, edges };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// ---------------------------------------------------------------------------------------
// Parks, plazas and buildings

export interface Park {
  id: string;
  /** Circle parks keep things simple and read well from the street. */
  x: number;
  z: number;
  r: number;
}

export const PARKS: Park[] = [
  { id: "hilltop-park", x: -1066, z: -766, r: 95 },
  { id: "nob-park", x: -1950, z: 255, r: 55 },
  { id: "russian-park", x: -2300, z: -650, r: 70 },
  { id: "dogpatch-green", x: -900, z: 820, r: 75 },
  { id: "waterfront-green", x: -420, z: -720, r: 45 },
];

export function inPark(x: number, z: number, pad = 0): Park | null {
  for (const p of PARKS) if ((x - p.x) * (x - p.x) + (z - p.z) * (z - p.z) < (p.r + pad) * (p.r + pad)) return p;
  return null;
}

/** The open plaza at the origin (where a Ferry Building landmark goes). */
export function inPlaza(x: number, z: number, pad = 0): boolean {
  return x > -32 - pad && x < 70 + pad && z > -135 - pad && z < 135 + pad;
}

interface Lot {
  id: string;
  pts: P[];
  H: number;
  meta: Record<string, unknown>;
}

/** Clearance from a point to every street of the graph: true when no carriageway or sidewalk is closer than `pad`. */
function makeRoadClearance(g: RoadGraph): (pts: readonly P[], pad: number) => boolean {
  const CELLR = 60;
  const grid = new Map<string, Array<{ a: P; b: P; w: number }>>();
  for (const e of g.edges) {
    const w = roadHalfWidth(e) + sidewalkWidth(e);
    for (let i = 1; i < e.points.length; i++) {
      const a = e.points[i - 1]! as P;
      const b = e.points[i]! as P;
      const minX = Math.min(a[0], b[0]) - w - 30;
      const maxX = Math.max(a[0], b[0]) + w + 30;
      const minZ = Math.min(a[1], b[1]) - w - 30;
      const maxZ = Math.max(a[1], b[1]) + w + 30;
      for (let cx = Math.floor(minX / CELLR); cx <= Math.floor(maxX / CELLR); cx++) {
        for (let cz = Math.floor(minZ / CELLR); cz <= Math.floor(maxZ / CELLR); cz++) {
          const k = `${cx},${cz}`;
          let l = grid.get(k);
          if (!l) grid.set(k, (l = []));
          l.push({ a, b, w });
        }
      }
    }
  }
  const dSeg = (x: number, z: number, a: P, b: P): number => {
    const ex = b[0] - a[0];
    const ez = b[1] - a[1];
    const l2 = ex * ex + ez * ez || 1;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / l2));
    return Math.hypot(x - (a[0] + ex * t), z - (a[1] + ez * t));
  };
  return (pts, pad) => {
    // Test corners, edge midpoints and the centre.
    const probes: P[] = [...pts];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      probes.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    }
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const cz = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    probes.push([cx, cz]);
    for (const [x, z] of probes) {
      for (const s of grid.get(`${Math.floor(x / CELLR)},${Math.floor(z / CELLR)}`) ?? []) {
        if (dSeg(x, z, s.a, s.b) < s.w + pad) return false;
      }
    }
    return true;
  };
}

function heightFor(x: number, z: number, rnd: () => number): { H: number; zone: string } {
  // Downtown north-west of the avenue near the water; a second cluster just south-east of it.
  const dA = Math.hypot(x + 430, z + 120);
  const dB = Math.hypot(x + 330, z - 330);
  const core = Math.max(Math.exp(-(dA * dA) / (2 * 330 * 330)), 0.8 * Math.exp(-(dB * dB) / (2 * 260 * 260)));
  if (core > 0.25) {
    const r = rnd();
    const H = 22 + core * (40 + 170 * r * r);
    return { H: Math.round(H / 4) * 4, zone: "downtown" };
  }
  const near = Math.exp(-(dA * dA) / (2 * 700 * 700));
  if (near > 0.3 && rnd() < 0.5) return { H: Math.round(14 + 30 * rnd() * near), zone: "midrise" };
  const r = rnd();
  if (r < 0.08) return { H: Math.round(20 + 18 * rnd()), zone: "apartments" };
  return { H: Math.round(8 + 8 * rnd()), zone: "rowhouse" };
}

/** Lay lots along both long faces of every block of a grid. frame maps (a, b) grid coordinates to the world. */
function lotsForGrid(
  as: readonly number[],
  bs: readonly number[],
  frame: (a: number, b: number) => P,
  prefix: string,
  rnd: () => number,
  ok: (pts: P[]) => boolean,
  out: Lot[],
): void {
  const sortedA = [...as].sort((p, q) => p - q);
  const sortedB = [...bs].sort((p, q) => p - q);
  for (let i = 0; i < sortedA.length - 1; i++) {
    for (let j = 0; j < sortedB.length - 1; j++) {
      const a0 = sortedA[i]! + 13;
      const a1 = sortedA[i + 1]! - 13;
      const b0 = sortedB[j]! + 13;
      const b1 = sortedB[j + 1]! - 13;
      if (a1 - a0 < 20 || b1 - b0 < 20) continue;
      const ctr = frame((a0 + a1) / 2, (b0 + b1) / 2);
      const { zone } = heightFor(ctr[0], ctr[1], rnd);
      const downtown = zone === "downtown";
      const depth = downtown ? (b1 - b0) / 2 - 1 : Math.min(30, (b1 - b0) / 2 - 3);
      for (const face of [0, 1]) {
        let a = a0;
        let n = 0;
        while (a < a1 - 6) {
          const w = downtown ? 22 + rnd() * 26 : 12 + rnd() * (zone === "apartments" ? 24 : 12);
          const aEnd = Math.min(a1, a + w);
          // Absorb a sliver at the end of the row into the last lot.
          const e = a1 - aEnd < 6 ? a1 : aEnd;
          const bA = face === 0 ? b0 : b1 - depth;
          const bB = face === 0 ? b0 + depth : b1;
          const pts: P[] = [frame(a, bA), frame(e, bA), frame(e, bB), frame(a, bB)].map(([x, z]) => [round2(x), round2(z)] as P);
          const c = frame((a + e) / 2, (bA + bB) / 2);
          const hz = heightFor(c[0], c[1], rnd);
          if (ok(pts)) out.push({ id: `${prefix}-${i}-${j}-${face}-${n}`, pts, H: hz.H, meta: { zone: hz.zone } });
          n++;
          a = e + (downtown ? 1.5 : 0.25);
        }
      }
    }
  }
}

function lots(g: RoadGraph): Lot[] {
  const rnd = mulberry32(20261020);
  const clear = makeRoadClearance(g);
  const out: Lot[] = [];
  const okFor = (side: number) => (pts: P[]): boolean =>
    pts.every(([x, z]) => inWorld(x, z, 2) && inlandDistance(x, z) > BOULEVARD_OFFSET + 18 && Math.sign(marketSide(x, z)) === side && !inPark(x, z, 4) && !inPlaza(x, z, 6)) &&
    clear(pts, 1.5);
  lotsForGrid(A_XS, A_ZS, (a, b) => [a, b], "a", rnd, okFor(-1), out);
  lotsForGrid(B_US, B_VS, (u, v) => bPoint(u, v), "b", rnd, okFor(1), out);
  return out;
}

/** Piers: a deck and a long shed reaching into the Bay. */
function piers(): Array<{ id: string; pts: P[]; base: number; top: number; kind: string }> {
  const out: Array<{ id: string; pts: P[]; base: number; top: number; kind: string }> = [];
  const east = [-560, -330, 330, 560, 790, 1000];
  east.forEach((z, k) => {
    const x0 = -6;
    const len = 150 + (k % 3) * 25;
    out.push({ id: `pier-${k}-deck`, pts: [[x0, z - 26], [x0 + len, z - 26], [x0 + len, z + 26], [x0, z + 26]], base: 0, top: 1.8, kind: "plain" });
    out.push({ id: `pier-${k}-shed`, pts: [[x0 + 8, z - 20], [x0 + len - 10, z - 20], [x0 + len - 10, z + 20], [x0 + 8, z + 20]], base: 1.8, top: 14 + (k % 2) * 3, kind: "pier" });
  });
  const north = [-700, -1250, -1900];
  north.forEach((x, k) => {
    // Find the shore below this x and build northward from it.
    let z0 = -1000;
    for (let z = -900; z > -1500; z -= 1) {
      if (inlandDistance(x, z) < 6) {
        z0 = z;
        break;
      }
    }
    const len = 140;
    out.push({ id: `npier-${k}-deck`, pts: [[x - 24, z0 + 2], [x + 24, z0 + 2], [x + 24, z0 - len], [x - 24, z0 - len]], base: 0, top: 1.8, kind: "plain" });
    out.push({ id: `npier-${k}-shed`, pts: [[x - 18, z0 - 8], [x + 18, z0 - 8], [x + 18, z0 - len + 10], [x - 18, z0 - len + 10]], base: 1.8, top: 13, kind: "pier" });
  });
  return out;
}

/** A low wall along the shore so cars stay out of the Bay. Split into short pieces. */
function seawall(): Array<{ id: string; pts: P[] }> {
  const line = offsetPolyline(COAST_SMOOTH, 4);
  const out: Array<{ id: string; pts: P[] }> = [];
  let k = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.ceil(L / 60);
    const dx = (b[0] - a[0]) / L;
    const dz = (b[1] - a[1]) / L;
    const nx = dz * 0.45;
    const nz = -dx * 0.45;
    for (let s = 0; s < n; s++) {
      const p0: P = [a[0] + (b[0] - a[0]) * (s / n), a[1] + (b[1] - a[1]) * (s / n)];
      const p1: P = [a[0] + (b[0] - a[0]) * ((s + 1) / n), a[1] + (b[1] - a[1]) * ((s + 1) / n)];
      if (!inWorld(p0[0], p0[1]) && !inWorld(p1[0], p1[1])) continue;
      // Leave the plaza edge open; the plaza has its own edge.
      const mx = (p0[0] + p1[0]) / 2;
      const mz = (p0[1] + p1[1]) / 2;
      if (inPlaza(mx, mz, 20)) continue;
      out.push({
        id: `seawall-${k++}`,
        pts: [
          [round2(p0[0] - nx), round2(p0[1] - nz)],
          [round2(p1[0] - nx), round2(p1[1] - nz)],
          [round2(p1[0] + nx), round2(p1[1] + nz)],
          [round2(p0[0] + nx), round2(p0[1] + nz)],
        ],
      });
    }
  }
  return out;
}

export interface DevCityTile {
  id: string;
  ix: number;
  iz: number;
  bbox: [number, number, number, number];
  collider: TileCollider & { buildings: Array<BuildingCollider & { meta?: Record<string, unknown> }> };
  hasLand: boolean;
}

export interface DevCity {
  tiles: DevCityTile[];
  roads: RoadGraph;
  spawn: { x: number; z: number; heading: number };
}

function heightfieldFor(ix: number, iz: number): Heightfield {
  const n = TILE / CELL + 1;
  const heights: number[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) heights.push(round2(terrainHeight(ix * TILE + i * CELL, iz * TILE + j * CELL)));
  }
  return { x0: ix * TILE, z0: iz * TILE, cellSizeM: CELL, nx: n, nz: n, heights };
}

function minGround(pts: readonly P[]): number {
  let m = Infinity;
  for (const [x, z] of pts) m = Math.min(m, terrainHeight(x, z));
  return m;
}

export function buildDevCity(): DevCity {
  const roads = buildRoadGraph();
  const buildings: Array<BuildingCollider & { meta?: Record<string, unknown> }> = [];
  for (const l of lots(roads)) {
    const base = round2(minGround(l.pts));
    buildings.push({ id: l.id, footprint: l.pts, baseY: base, topY: round2(base + l.H), meta: l.meta });
  }
  for (const p of piers()) {
    buildings.push({ id: p.id, footprint: p.pts, baseY: p.base, topY: p.top, meta: { kind: p.kind } });
  }
  for (const w of seawall()) {
    const base = round2(minGround(w.pts));
    buildings.push({ id: w.id, footprint: w.pts, baseY: base, topY: round2(base + 1.4), meta: { kind: "seawall" } });
  }
  const tiles: DevCityTile[] = [];
  for (let iz = IZ[0]; iz <= IZ[1]; iz++) {
    for (let ix = IX[0]; ix <= IX[1]; ix++) {
      const id = `t${ix}_${iz}`;
      const minX = ix * TILE;
      const minZ = iz * TILE;
      const mine = buildings.filter((b) => {
        const cx = b.footprint.reduce((s, p) => s + p[0], 0) / b.footprint.length;
        const cz = b.footprint.reduce((s, p) => s + p[1], 0) / b.footprint.length;
        return cx >= minX && cx < minX + TILE && cz >= minZ && cz < minZ + TILE;
      });
      const ground = heightfieldFor(ix, iz);
      const hasLand = ground.heights.some((h) => h > 0.5);
      tiles.push({ id, ix, iz, bbox: [minX, minZ, minX + TILE, minZ + TILE], collider: { tileId: id, ground, buildings: mine }, hasLand });
    }
  }
  return { tiles: tiles.filter((t) => t.hasLand || t.collider.buildings.length > 0), roads, spawn: SPAWN };
}
