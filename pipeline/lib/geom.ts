// 2D geometry helpers in the local metric frame (x east, z south).

export type P2 = [number, number];

export function r2(v: number): number {
  // Round to centimetres; normalise -0 so output is byte-stable.
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}

/** Shoelace sum Σ(x_i z_{i+1} − x_{i+1} z_i) / 2. Negative = counter-clockwise on a north-up map. */
export function signedArea(ring: readonly P2[]): number {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    s += ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1];
  }
  return s / 2;
}

/** Area-weighted centroid of a simple polygon (falls back to the vertex mean when degenerate). */
export function centroid(ring: readonly P2[]): P2 {
  let a = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x0, z0] = ring[j]!;
    const [x1, z1] = ring[i]!;
    const f = x0 * z1 - x1 * z0;
    a += f;
    cx += (x0 + x1) * f;
    cz += (z0 + z1) * f;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0;
    let sz = 0;
    for (const [x, z] of ring) {
      sx += x;
      sz += z;
    }
    return [sx / ring.length, sz / ring.length];
  }
  return [cx / (3 * a), cz / (3 * a)];
}

export function pointInRing(x: number, z: number, ring: readonly P2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i]!;
    const [xj, zj] = ring[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function distToSegment(px: number, pz: number, a: P2, b: P2): { d: number; t: number; x: number; z: number } {
  const ex = b[0] - a[0];
  const ez = b[1] - a[1];
  const len2 = ex * ex + ez * ez;
  let t = len2 > 0 ? ((px - a[0]) * ex + (pz - a[1]) * ez) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = a[0] + ex * t;
  const z = a[1] + ez * t;
  return { d: Math.hypot(px - x, pz - z), t, x, z };
}

export function distToRing(px: number, pz: number, ring: readonly P2[]): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const d = distToSegment(px, pz, ring[j]!, ring[i]!).d;
    if (d < best) best = d;
  }
  return best;
}

/** A point guaranteed inside the polygon: the centroid if inside, else the best interior sample. */
export function interiorPoint(ring: readonly P2[]): P2 {
  const c = centroid(ring);
  if (pointInRing(c[0], c[1], ring)) return c;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const [x, z] of ring) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  let best: P2 = ring[0]!;
  let bestD = -1;
  const n = 12;
  for (let i = 0; i <= n; i++) {
    for (let k = 0; k <= n; k++) {
      const x = minX + ((maxX - minX) * i) / n;
      const z = minZ + ((maxZ - minZ) * k) / n;
      if (!pointInRing(x, z, ring)) continue;
      const d = distToRing(x, z, ring);
      if (d > bestD) {
        bestD = d;
        best = [x, z];
      }
    }
  }
  return best;
}

/** Douglas–Peucker on a closed ring (not repeating the first point). Keeps at least 3 points. */
export function simplifyRing(ring: readonly P2[], tol: number): P2[] {
  if (ring.length <= 3) return ring.slice();
  // Split at the vertex farthest from vertex 0 so the closed ring becomes two open chains.
  let far = 0;
  let farD = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = Math.hypot(ring[i]![0] - ring[0]![0], ring[i]![1] - ring[0]![1]);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const keep = new Uint8Array(ring.length);
  keep[0] = 1;
  keep[far] = 1;
  const dp = (i0: number, i1: number): void => {
    // Chain from i0 to i1 walking forward (mod n).
    const n = ring.length;
    const span = (i1 - i0 + n) % n;
    if (span < 2) return;
    let best = -1;
    let bestD = -1;
    for (let s = 1; s < span; s++) {
      const i = (i0 + s) % n;
      const d = distToSegment(ring[i]![0], ring[i]![1], ring[i0]!, ring[i1]!).d;
      if (d > bestD) {
        bestD = d;
        best = i;
      }
    }
    if (bestD > tol) {
      keep[best] = 1;
      dp(i0, best);
      dp(best, i1);
    }
  };
  dp(0, far);
  dp(far, 0);
  const out = ring.filter((_, i) => keep[i] === 1);
  return out.length >= 3 ? out : ring.slice();
}

/** Remove consecutive duplicates (after rounding) and a repeated closing point. */
export function cleanRing(ring: readonly P2[]): P2[] {
  const out: P2[] = [];
  for (const p of ring) {
    const q: P2 = [r2(p[0]), r2(p[1])];
    const last = out[out.length - 1];
    if (last && last[0] === q[0] && last[1] === q[1]) continue;
    out.push(q);
  }
  while (out.length > 1 && out[0]![0] === out[out.length - 1]![0] && out[0]![1] === out[out.length - 1]![1]) out.pop();
  return out;
}

/** Remove vertices whose neighbours are (almost) collinear with them. */
export function dropCollinear(ring: readonly P2[], eps = 0.02): P2[] {
  let cur = ring.slice();
  let changed = true;
  while (changed && cur.length > 3) {
    changed = false;
    for (let i = 0; i < cur.length && cur.length > 3; i++) {
      const a = cur[(i + cur.length - 1) % cur.length]!;
      const b = cur[i]!;
      const c = cur[(i + 1) % cur.length]!;
      if (distToSegment(b[0], b[1], a, c).d < eps) {
        cur.splice(i, 1);
        changed = true;
        i--;
      }
    }
  }
  return cur;
}

/**
 * Sutherland–Hodgman: clip a (possibly concave) ring to a convex ring. Both rings may have
 * either winding; the result keeps the subject's winding.
 */
export function clipToConvex(subject: readonly P2[], clip: readonly P2[]): P2[] {
  const sign = signedArea(clip) < 0 ? -1 : 1;
  let out: P2[] = subject.slice();
  for (let i = 0; i < clip.length && out.length > 0; i++) {
    const a = clip[i]!;
    const b = clip[(i + 1) % clip.length]!;
    // Inside = same side as the clip ring's interior.
    const side = (p: P2): number => sign * ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]));
    const input = out;
    out = [];
    for (let k = 0; k < input.length; k++) {
      const cur = input[k]!;
      const prev = input[(k + input.length - 1) % input.length]!;
      const sc = side(cur);
      const sp = side(prev);
      if (sc >= 0) {
        if (sp < 0) out.push(intersect(prev, cur, sp, sc));
        out.push(cur);
      } else if (sp >= 0) {
        out.push(intersect(prev, cur, sp, sc));
      }
    }
  }
  return out;
}

function intersect(p: P2, q: P2, sp: number, sq: number): P2 {
  const t = sp / (sp - sq);
  return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
}

/** Clip segment a→b to the axis-aligned box; returns parameter range [t0, t1] or null. */
export function clipSegment(a: P2, b: P2, box: readonly [number, number, number, number]): [number, number] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const tests: Array<[number, number]> = [
    [-dx, a[0] - box[0]],
    [dx, box[2] - a[0]],
    [-dz, a[1] - box[1]],
    [dz, box[3] - a[1]],
  ];
  for (const [p, q] of tests) {
    if (p === 0) {
      if (q < 0) return null;
    } else {
      const t = q / p;
      if (p < 0) {
        if (t > t1) return null;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return null;
        if (t < t1) t1 = t;
      }
    }
  }
  return t0 <= t1 ? [t0, t1] : null;
}

/** Compass bearing (radians clockwise from north, -z) of the direction (dx, dz), in [0, 2π). */
export function bearing(dx: number, dz: number): number {
  const h = Math.atan2(dx, -dz);
  return h < 0 ? h + 2 * Math.PI : h;
}

/** Simple string hash (FNV-1a, 32-bit) for deterministic per-building variation. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
