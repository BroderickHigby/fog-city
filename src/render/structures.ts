// Tunnel bores and portals (W-02 render half), from the colliders' `tunnels` (the pack's TUNL
// section): each is a ribbon [x, road y, z, width] per vertex with a ceiling clearanceM over the
// road. The tile's glb draws the bore's road ribbon at the bore's floor, inside the hill; here:
//
//  - the bore: two walls and a ceiling along the ribbon (concrete, drawn from both sides), so
//    a car in the tunnel sees a tunnel, not the underside of the hill's ground mesh and the sky;
//  - the portals: a headwall at each end of a bore that comes out of the ground, from the
//    ceiling up PORTAL_HEADWALL_M, a little wider than the bore;
//  - the cut: the tile's ground is discarded (in its shader) over the bore wherever it lies below
//    the bore's ceiling, so the hillside no longer slices across the portal; what shows through
//    is the bore's own ceiling and walls. boreCuts() gives the shader its segments.
//
// Pure geometry, deterministic: tests/render/structures.test.ts.

/** [x, y, z, w]: centreline position, road-surface height and full width, metres. */
export type RibbonVertex = [number, number, number, number];

export interface TunnelLike {
  id: string;
  kind?: string;
  edge?: string;
  clearanceM: number;
  path: RibbonVertex[];
}

export interface StructureMesh {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}

/** The headwall rises this far over a portal's ceiling. */
export const PORTAL_HEADWALL_M = 2.4;
/** ... and reaches this far past the bore's walls on either side. */
export const PORTAL_WING_M = 1.2;
/** Most bore segments one tile's ground shader cuts (BORE_CUT_GLSL's array size). */
export const MAX_BORE_CUTS = 16;
/** The cut reaches this far past a bore's wall, and this far over its ceiling. */
export const CUT_SIDE_M = 0.6;
export const CUT_OVER_M = 0.25;

const WALL: readonly [number, number, number] = [0.3, 0.29, 0.27];
const CEILING: readonly [number, number, number] = [0.22, 0.21, 0.2];
const PORTAL: readonly [number, number, number] = [0.42, 0.4, 0.37];

class Builder {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  /** A quad a-b-c-d (a, b along the bottom; d over a, c over b) with its normal. */
  quad(a: number[], b: number[], c: number[], d: number[], n: readonly number[], color: readonly number[]): void {
    const v = this.pos.length / 3;
    this.pos.push(...a, ...b, ...c, ...d);
    for (let i = 0; i < 4; i++) {
      this.nrm.push(...n);
      this.col.push(...color);
    }
    // Wind so the front face is the one the normal points out of.
    const ux = b[0]! - a[0]!, uy = b[1]! - a[1]!, uz = b[2]! - a[2]!;
    const vx = d[0]! - a[0]!, vy = d[1]! - a[1]!, vz = d[2]! - a[2]!;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * n[0]! + cy * n[1]! + cz * n[2]! >= 0) this.idx.push(v, v + 1, v + 3, v + 1, v + 2, v + 3);
    else this.idx.push(v, v + 3, v + 1, v + 1, v + 3, v + 2);
  }
  build(): StructureMesh | null {
    if (this.idx.length === 0) return null;
    return { positions: new Float32Array(this.pos), normals: new Float32Array(this.nrm), colors: new Float32Array(this.col), indices: new Uint32Array(this.idx) };
  }
}

/**
 * Walls, ceiling and portal headwalls for a tile's bores. `ground` is the drawn ground: a path end
 * whose ceiling is not under the ground is a portal (the other ends continue in the next tile).
 */
export function boreMesh(tunnels: readonly TunnelLike[], ground: (x: number, z: number) => number): StructureMesh | null {
  const b = new Builder();
  for (const t of tunnels) {
    const p = t.path;
    if (p.length < 2) continue;
    const h = t.clearanceM;
    const side = (i: number): { lx: number; lz: number; rx: number; rz: number; nx: number; nz: number } => {
      const a = p[Math.max(0, i - 1)]!;
      const c = p[Math.min(p.length - 1, i + 1)]!;
      const dx = c[0] - a[0];
      const dz = c[2] - a[2];
      const L = Math.hypot(dx, dz) || 1;
      // Right-hand normal of (dx, dz) in x/z is (-dz, dx).
      const nx = -dz / L;
      const nz = dx / L;
      const hw = p[i]![3] / 2;
      return { lx: p[i]![0] - nx * hw, lz: p[i]![2] - nz * hw, rx: p[i]![0] + nx * hw, rz: p[i]![2] + nz * hw, nx, nz };
    };
    for (let i = 0; i + 1 < p.length; i++) {
      const s0 = side(i);
      const s1 = side(i + 1);
      const y0 = p[i]![1];
      const y1 = p[i + 1]![1];
      // Walls face into the bore (the material draws both sides).
      b.quad([s0.lx, y0, s0.lz], [s1.lx, y1, s1.lz], [s1.lx, y1 + h, s1.lz], [s0.lx, y0 + h, s0.lz], [s0.nx, 0, s0.nz], WALL);
      b.quad([s0.rx, y0, s0.rz], [s1.rx, y1, s1.rz], [s1.rx, y1 + h, s1.rz], [s0.rx, y0 + h, s0.rz], [-s0.nx, 0, -s0.nz], WALL);
      b.quad([s0.lx, y0 + h, s0.lz], [s1.lx, y1 + h, s1.lz], [s1.rx, y1 + h, s1.rz], [s0.rx, y0 + h, s0.rz], [0, -1, 0], CEILING);
    }
    // Portals: an end whose ceiling stands over the drawn ground is where the bore comes out.
    for (const [i, j] of [
      [0, 1],
      [p.length - 1, p.length - 2],
    ] as const) {
      const v = p[i]!;
      if (ground(v[0], v[2]) > v[1] + h) continue;
      const s = side(i);
      // Outward along the path.
      const ox = v[0] - p[j]![0];
      const oz = v[2] - p[j]![2];
      const oL = Math.hypot(ox, oz) || 1;
      const wx = s.nx * PORTAL_WING_M;
      const wz = s.nz * PORTAL_WING_M;
      const y0 = v[1] + h;
      const y1 = y0 + PORTAL_HEADWALL_M;
      // The face over the opening, both wings down to the road beside it.
      b.quad([s.lx - wx, y0, s.lz - wz], [s.rx + wx, y0, s.rz + wz], [s.rx + wx, y1, s.rz + wz], [s.lx - wx, y1, s.lz - wz], [ox / oL, 0, oz / oL], PORTAL);
      b.quad([s.lx - wx, v[1] - 0.2, s.lz - wz], [s.lx, v[1] - 0.2, s.lz], [s.lx, y0, s.lz], [s.lx - wx, y0, s.lz - wz], [ox / oL, 0, oz / oL], PORTAL);
      b.quad([s.rx, v[1] - 0.2, s.rz], [s.rx + wx, v[1] - 0.2, s.rz + wz], [s.rx + wx, y0, s.rz + wz], [s.rx, y0, s.rz], [ox / oL, 0, oz / oL], PORTAL);
    }
  }
  return b.build();
}

/** One straight piece of a bore for the ground's cut: ends (x, z), half width + CUT_SIDE_M, ceiling y + CUT_OVER_M at each end. */
export interface BoreCut {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  halfW: number;
  ya: number;
  yb: number;
}

/**
 * A tile's bores as at most MAX_BORE_CUTS straight pieces (bores run straight between portals;
 * a path is simplified to 0.3 m across and in height, and the widest pieces win when a tile has more).
 */
export function boreCuts(tunnels: readonly TunnelLike[]): BoreCut[] {
  const out: BoreCut[] = [];
  for (const t of tunnels) {
    const p = t.path;
    if (p.length < 2) continue;
    const keep = simplify(p, 0.3);
    for (let i = 0; i + 1 < keep.length; i++) {
      const a = p[keep[i]!]!;
      const c = p[keep[i + 1]!]!;
      let w = 0;
      for (let k = keep[i]!; k <= keep[i + 1]!; k++) w = Math.max(w, p[k]![3]);
      out.push({ ax: a[0], az: a[2], bx: c[0], bz: c[2], halfW: w / 2 + CUT_SIDE_M, ya: a[1] + t.clearanceM + CUT_OVER_M, yb: c[1] + t.clearanceM + CUT_OVER_M });
    }
  }
  if (out.length > MAX_BORE_CUTS) {
    const len = (c: BoreCut): number => Math.hypot(c.bx - c.ax, c.bz - c.az);
    out.sort((a, b) => len(b) - len(a));
    out.length = MAX_BORE_CUTS;
  }
  return out;
}

/** Douglas-Peucker on the path's (x, z, y): indices of the vertices kept. */
function simplify(p: readonly RibbonVertex[], tol: number): number[] {
  const keep = new Set<number>([0, p.length - 1]);
  const stack: Array<[number, number]> = [[0, p.length - 1]];
  while (stack.length > 0) {
    const [i, j] = stack.pop()!;
    const a = p[i]!;
    const b = p[j]!;
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const L2 = dx * dx + dy * dy + dz * dz;
    let worst = -1;
    let at = -1;
    for (let k = i + 1; k < j; k++) {
      const q = p[k]!;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy + (q[2] - a[2]) * dz) / L2)) : 0;
      const d = Math.hypot(q[0] - a[0] - dx * t, q[1] - a[1] - dy * t, q[2] - a[2] - dz * t);
      if (d > worst) {
        worst = d;
        at = k;
      }
    }
    if (worst > tol && at > 0) {
      keep.add(at);
      stack.push([i, at], [at, j]);
    }
  }
  return [...keep].sort((x, y) => x - y);
}

/** Is (x, y, z) inside a cut (the ground shader's test, for tests)? */
export function inBoreCut(cuts: readonly BoreCut[], x: number, y: number, z: number): boolean {
  for (const c of cuts) {
    const dx = c.bx - c.ax;
    const dz = c.bz - c.az;
    const L2 = dx * dx + dz * dz;
    if (L2 <= 0) continue;
    // Only alongside the piece, never round its ends (past a portal the ground is the street's).
    const t = ((x - c.ax) * dx + (z - c.az) * dz) / L2;
    if (t < 0 || t > 1) continue;
    const d = Math.hypot(x - c.ax - dx * t, z - c.az - dz * t);
    if (d < c.halfW && y < c.ya + (c.yb - c.ya) * t) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------
// Quay faces (W-35 render half). The lattice slopes the land into the water across a 10 m cell,
// so a seawall or a pier deck 3 m up read as a ramp into the Bay. Along the shore lines of
// boundary.json (land on the left of travel), wherever the land just inside stands QUAY_MIN_Y or
// more over the sea, a vertical face drops from the land's height to QUAY_FOOT_Y.

/** Land at least this high just inside the shore gets a quay face. */
export const QUAY_MIN_Y = 1.5;
/** The face reaches down to here (under the sea plane). */
export const QUAY_FOOT_Y = -2;
/** The land's height is read this far inside the shore line. */
export const QUAY_INSET_M = 3;
const QUAY: readonly [number, number, number] = [0.27, 0.26, 0.24];

/** A straight piece of shore, land on the left of a -> b. */
export interface ShoreSegment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

/** The sea's shore lines (not the lakes') as segments, by the tile their midpoint is in. */
export function shoreByTile(shore: ReadonlyArray<{ closed: boolean; lake?: unknown; points: ReadonlyArray<readonly number[]> }>, tileSizeM = 500): Map<string, ShoreSegment[]> {
  const out = new Map<string, ShoreSegment[]>();
  for (const line of shore) {
    if (line.lake !== undefined) continue;
    const p = line.points;
    const n = line.closed ? p.length : p.length - 1;
    for (let i = 0; i < n; i++) {
      const a = p[i]!;
      const b = p[(i + 1) % p.length]!;
      const mx = (a[0]! + b[0]!) / 2;
      const mz = (a[1]! + b[1]!) / 2;
      const id = `t${Math.floor(mx / tileSizeM)}_${Math.floor(mz / tileSizeM)}`;
      let l = out.get(id);
      if (!l) out.set(id, (l = []));
      l.push({ ax: a[0]!, az: a[1]!, bx: b[0]!, bz: b[1]! });
    }
  }
  return out;
}

/** Quay faces along shore segments where the land inside stands QUAY_MIN_Y or more. */
export function quayFaces(segments: readonly ShoreSegment[], ground: (x: number, z: number) => number): StructureMesh | null {
  const b = new Builder();
  for (const s of segments) {
    const dx = s.bx - s.ax;
    const dz = s.bz - s.az;
    const L = Math.hypot(dx, dz);
    if (L < 1e-6) continue;
    // Left of travel (land): (uz, -ux).
    const lx = dz / L;
    const lz = -dx / L;
    const ya = ground(s.ax + lx * QUAY_INSET_M, s.az + lz * QUAY_INSET_M);
    const yb = ground(s.bx + lx * QUAY_INSET_M, s.bz + lz * QUAY_INSET_M);
    if (Math.max(ya, yb) < QUAY_MIN_Y) continue;
    const ta = Math.max(ya, 0);
    const tb = Math.max(yb, 0);
    b.quad([s.ax, QUAY_FOOT_Y, s.az], [s.bx, QUAY_FOOT_Y, s.bz], [s.bx, tb, s.bz], [s.ax, ta, s.az], [-lx, 0, -lz], QUAY);
  }
  return b.build();
}
