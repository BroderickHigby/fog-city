// Topology-preserving footprint simplification (W-36: row houses that touch in DataSF must still
// touch in the world, with no 5-60 cm cracks between them).
//
// Simplifying each ring on its own (Douglas-Peucker) moves the two sides of a party wall
// differently. Instead:
//   1. Snap: vertices of footprints within SNAP_M of each other become one point.
//   2. T-junctions: a vertex 5 to 12 cm (TEE_MIN_M to TEE_M) from the interior of another
//      footprint's wall is inserted into that wall (the nearest one only; never into a wall its
//      own footprint shares, nor near the wall's ends, where it is a corner and not a T), so walls
//      that nearly touch (DataSF draws some party walls up to ~10 cm apart) run through the same
//      points; nearer than that they already touch.
//   3. Fixed vertices: every vertex another footprint uses is kept exactly. A vertex ending a
//      wall any point of which lies within NEAR_M of another footprint's wall may only go where it
//      lies within NEAR_TOL_M of the simplified line. The stretches that face no neighbour
//      (fronts, rears, bays away from the party walls) are simplified at the full tolerance, each
//      as an open chain between fixed vertices; a wall shared by two footprints is simplified once.
//   4. Weld: a vertex left within WELD_M of a neighbour's wall that one of its own walls runs
//      along moves onto that wall, closing the wedge between walls that nearly touch.
// So a party wall is the same polyline in both footprints, and simplification never moves a
// wall toward or away from a neighbour. Rings with no neighbour are simplified as before
// (simplifyRing). Pure and deterministic: every loop runs in input order.

import { simplifyRing, type P2 } from "./geom.ts";

/** Vertices closer than this are one point. */
export const SNAP_M = 0.05;
/** A vertex this close to another footprint's wall is inserted into it. */
export const TEE_M = 0.12;
/** ...unless it is already within this distance of the wall (touching; no vertex needed). */
export const TEE_MIN_M = 0.05;
/** Vertices this close to another footprint's wall (the crack range's upper end)... */
export const NEAR_M = 0.6;
/** ...are simplified with this tolerance only, so no wall moves toward or away from a neighbour by a crack's width. */
export const NEAR_TOL_M = 0.03;

/** A vertex this close to a neighbour's wall that one of its walls runs along is welded onto it. */
export const WELD_M = 0.12;
/** ...walls within this angle run along each other... */
const WELD_ANGLE = (10 * Math.PI) / 180;
/** ...and a vertex this close to any neighbour's wall is on it already. */
const WELD_ON_M = 0.005;

const VCELL = 1;
/** The largest reach a neighbour query needs (NEAR_M). */
const REACH = NEAR_M;

/**
 * Simplify every ring with tolerance `tol`, keeping walls that rings share identical.
 * Input rings: local metres, not closed, any winding. Output: same order and winding, not
 * closed, at least 3 vertices (a ring that would fall below 3 keeps its input).
 */
export function simplifySharedRings(rings: readonly (readonly P2[])[], tol: number): P2[][] {
  // Small-integer keys (under 2^30) hash fast in a Map; cells are at most 32 km from the origin.
  const key = (cx: number, cz: number): number => (cx + 16384) * 32768 + (cz + 16384);

  // ---- 1. Vertex snapping (first come, first served, in input order).
  const px: number[] = [];
  const pz: number[] = [];
  const vgrid = new Map<number, number[]>();
  const vertexId = (x: number, z: number): number => {
    let best = -1;
    let bestD = SNAP_M;
    // Only the cells within SNAP_M of the point (usually just its own).
    const cx0 = Math.floor((x - SNAP_M) / VCELL), cx1 = Math.floor((x + SNAP_M) / VCELL);
    const cz0 = Math.floor((z - SNAP_M) / VCELL), cz1 = Math.floor((z + SNAP_M) / VCELL);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const l = vgrid.get(key(cx, cz));
        if (!l) continue;
        for (let q = 0; q < l.length; q++) {
          const id = l[q]!;
          const d = Math.hypot(px[id]! - x, pz[id]! - z);
          if (d < bestD || (d === bestD && best >= 0 && id < best)) {
            bestD = d;
            best = id;
          }
        }
      }
    }
    if (best >= 0) return best;
    const id = px.length;
    px.push(x);
    pz.push(z);
    const k = key(Math.floor(x / VCELL), Math.floor(z / VCELL));
    const l = vgrid.get(k);
    if (l) l.push(id);
    else vgrid.set(k, [id]);
    return id;
  };
  const rs: number[][] = rings.map((r) => {
    const v: number[] = [];
    for (const [x, z] of r) {
      const id = vertexId(x, z);
      if (v.length === 0 || v[v.length - 1] !== id) v.push(id);
    }
    while (v.length > 1 && v[0] === v[v.length - 1]) v.pop();
    return v;
  });

  // ---- Neighbours: rings whose bounding boxes, grown by REACH, overlap (a 20 m grid of boxes).
  const NCELL = 20;
  const box = new Float64Array(rs.length * 4);
  rs.forEach((v, ri) => {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const id of v) {
      const x = px[id]!, z = pz[id]!;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    box[ri * 4] = x0 - REACH;
    box[ri * 4 + 1] = z0 - REACH;
    box[ri * 4 + 2] = x1 + REACH;
    box[ri * 4 + 3] = z1 + REACH;
  });
  const ngrid = new Map<number, number[]>();
  rs.forEach((v, ri) => {
    if (v.length < 2) return;
    for (let cx = Math.floor(box[ri * 4]! / NCELL); cx <= Math.floor(box[ri * 4 + 2]! / NCELL); cx++) {
      for (let cz = Math.floor(box[ri * 4 + 1]! / NCELL); cz <= Math.floor(box[ri * 4 + 3]! / NCELL); cz++) {
        const k = key(cx, cz);
        const l = ngrid.get(k);
        if (l) l.push(ri);
        else ngrid.set(k, [ri]);
      }
    }
  });
  const stamp = new Int32Array(rs.length).fill(-1);
  const neighbours = (ri: number): number[] => {
    const out: number[] = [];
    stamp[ri] = ri;
    for (let cx = Math.floor(box[ri * 4]! / NCELL); cx <= Math.floor(box[ri * 4 + 2]! / NCELL); cx++) {
      for (let cz = Math.floor(box[ri * 4 + 1]! / NCELL); cz <= Math.floor(box[ri * 4 + 3]! / NCELL); cz++) {
        for (const o of ngrid.get(key(cx, cz)) ?? []) {
          if (stamp[o] === ri) continue;
          stamp[o] = ri;
          if (box[o * 4]! > box[ri * 4 + 2]! || box[o * 4 + 2]! < box[ri * 4]! || box[o * 4 + 1]! > box[ri * 4 + 3]! || box[o * 4 + 3]! < box[ri * 4 + 1]!) continue;
          out.push(o);
        }
      }
    }
    return out.sort((a, b) => a - b);
  };
  /** For every edge of `o` within `reach` of (x, z): fn(edge index, t). Stops when fn returns true. */
  const nearEdgesOf = (o: number, x: number, z: number, reach: number, fn: (ei: number, t: number) => boolean | void): boolean => {
    if (x < box[o * 4]! || x > box[o * 4 + 2]! || z < box[o * 4 + 1]! || z > box[o * 4 + 3]!) return false;
    const v = rs[o]!;
    const m = v.length;
    for (let i = 0; i < m; i++) {
      const a = v[i]!;
      const b = v[(i + 1) % m]!;
      const ax = px[a]!, az = pz[a]!, bx = px[b]!, bz = pz[b]!;
      if (x < (ax < bx ? ax : bx) - reach || x > (ax > bx ? ax : bx) + reach || z < (az < bz ? az : bz) - reach || z > (az > bz ? az : bz) + reach) continue;
      const ex = bx - ax, ez = bz - az;
      const L2 = ex * ex + ez * ez;
      let t = L2 > 0 ? ((x - ax) * ex + (z - az) * ez) / L2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - (ax + ex * t);
      const dz = z - (az + ez * t);
      if (dx * dx + dz * dz < reach * reach && fn(i, t) === true) return true;
    }
    return false;
  };
  const near: number[][] = rs.map((_, ri) => neighbours(ri));

  // ---- 2. T-junctions: insert a vertex lying within TEE_M of another ring's edge interior
  // (into the nearest such edge only), unless it is that close to the edge's end (a corner, not
  // a T: inserting it would fold the wall back on itself).
  {
    const inserts = new Map<number, Map<number, Array<{ id: number; t: number }>>>();
    rs.forEach((v, ri) => {
      for (const o of near[ri]!) {
        const ov = rs[o]!;
        // ri's own edges (a vertex is never inserted into a wall its own ring shares with o).
        const own = new Set<string>();
        for (let i = 0; i < v.length; i++) {
          const a = v[i]!;
          const b = v[(i + 1) % v.length]!;
          own.add(a < b ? `${a},${b}` : `${b},${a}`);
        }
        for (const id of v) {
          if (ov.includes(id)) continue;
          let best = -1;
          let bestT = 0;
          let bestD = TEE_M;
          nearEdgesOf(o, px[id]!, pz[id]!, TEE_M, (ei, t) => {
            if (t <= 0 || t >= 1) return;
            const a = ov[ei]!;
            const b = ov[(ei + 1) % ov.length]!;
            if (own.has(a < b ? `${a},${b}` : `${b},${a}`)) return;
            if (Math.hypot(px[id]! - px[a]!, pz[id]! - pz[a]!) < TEE_M || Math.hypot(px[id]! - px[b]!, pz[id]! - pz[b]!) < TEE_M) return;
            const ex = px[b]! - px[a]!;
            const ez = pz[b]! - pz[a]!;
            const d = Math.abs((px[id]! - px[a]!) * ez - (pz[id]! - pz[a]!) * ex) / Math.hypot(ex, ez);
            if (d < TEE_MIN_M || d >= bestD) return;
            bestD = d;
            best = ei;
            bestT = t;
          });
          if (best < 0) continue;
          let m = inserts.get(o);
          if (!m) inserts.set(o, (m = new Map()));
          let l = m.get(best);
          if (!l) m.set(best, (l = []));
          if (!l.some((q) => q.id === id)) l.push({ id, t: bestT });
        }
      }
    });
    for (const ri of [...inserts.keys()].sort((a, b) => a - b)) {
      const m = inserts.get(ri)!;
      const v = rs[ri]!;
      const out: number[] = [];
      for (let i = 0; i < v.length; i++) {
        out.push(v[i]!);
        const l = m.get(i);
        if (l) for (const q of l.sort((p, o) => p.t - o.t || p.id - o.id)) out.push(q.id);
      }
      const clean = out.filter((id, i) => i === 0 || id !== out[i - 1]);
      while (clean.length > 1 && clean[0] === clean[clean.length - 1]) clean.pop();
      rs[ri] = clean;
    }
  }

  // ---- 3. Fixed vertices (used by another ring) and near ones (within NEAR_M of another ring's wall).
  const fixed = new Uint8Array(px.length);
  const nearV = new Uint8Array(px.length);
  {
    const first = new Int32Array(px.length).fill(-1);
    rs.forEach((v, ri) => {
      for (const id of v) {
        if (first[id] === -1) first[id] = ri;
        else if (first[id] !== ri) fixed[id] = 1;
      }
    });
    // A vertex is near when it, or the inside of a wall it ends (sampled at its quarters), is
    // within NEAR_M of a neighbour's wall: keeping both ends of a wall that runs along a
    // neighbour keeps the whole wall in place.
    rs.forEach((v, ri) => {
      for (const id of v) {
        if (fixed[id] || nearV[id]) continue;
        for (const o of near[ri]!) {
          if (nearEdgesOf(o, px[id]!, pz[id]!, NEAR_M, () => true)) {
            nearV[id] = 1;
            break;
          }
        }
      }
      const n = v.length;
      for (let i = 0; i < n; i++) {
        const a = v[i]!;
        const b = v[(i + 1) % n]!;
        if (nearV[a] && nearV[b]) continue;
        let hit = false;
        for (let q = 1; q <= 3 && !hit; q++) {
          const x = px[a]! + ((px[b]! - px[a]!) * q) / 4;
          const z = pz[a]! + ((pz[b]! - pz[a]!) * q) / 4;
          for (const o of near[ri]!) {
            if (nearEdgesOf(o, x, z, NEAR_M, () => true)) {
              hit = true;
              break;
            }
          }
        }
        if (hit) {
          nearV[a] = 1;
          nearV[b] = 1;
        }
      }
    });
  }

  // ---- 4. Simplify each ring's stretches between fixed vertices: Douglas-Peucker with a
  // per-vertex tolerance, NEAR_TOL_M for vertices facing a neighbour, `tol` elsewhere.
  const simplifyChain = (ids: number[]): number[] => {
    const keep = new Uint8Array(ids.length);
    keep[0] = 1;
    keep[ids.length - 1] = 1;
    const stack: Array<[number, number]> = [[0, ids.length - 1]];
    while (stack.length) {
      const [i0, i1] = stack.pop()!;
      const a = ids[i0]!;
      const b = ids[i1]!;
      const ax = px[a]!, az = pz[a]!;
      const ex = px[b]! - ax, ez = pz[b]! - az;
      const L2 = ex * ex + ez * ez;
      let best = -1;
      let bestR = 1;
      for (let i = i0 + 1; i < i1; i++) {
        const id = ids[i]!;
        let t = L2 > 0 ? ((px[id]! - ax) * ex + (pz[id]! - az) * ez) / L2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(px[id]! - (ax + ex * t), pz[id]! - (az + ez * t));
        const r = d / (nearV[id] && !fixed[id] ? NEAR_TOL_M : tol);
        if (r > bestR) {
          bestR = r;
          best = i;
        }
      }
      if (best >= 0) {
        keep[best] = 1;
        stack.push([i0, best], [best, i1]);
      }
    }
    return ids.filter((_, i) => keep[i] === 1);
  };
  // Shared walls: an undirected edge used by two rings is shared; a vertex inside a run of edges
  // shared with the same ring (and used by no third) is interior to a shared wall, which is
  // simplified once, the same for both rings. Every other vertex another ring uses is a cut.
  const ekey = (a: number, b: number): string => (a < b ? `${a},${b}` : `${b},${a}`);
  const edgeUse = new Map<string, number>();
  const vertexUse = new Uint16Array(px.length);
  rs.forEach((v) => {
    const n = v.length;
    if (n < 3) return;
    const seen = new Set<number>();
    for (let i = 0; i < n; i++) {
      if (!seen.has(v[i]!)) {
        seen.add(v[i]!);
        vertexUse[v[i]!]!++;
      }
      const k = ekey(v[i]!, v[(i + 1) % n]!);
      edgeUse.set(k, (edgeUse.get(k) ?? 0) + 1);
    }
  });
  const sharedEdge = (a: number, b: number): boolean => (edgeUse.get(ekey(a, b)) ?? 0) >= 2;
  const chainCache = new Map<string, number[]>();
  const sharedChain = (ids: number[]): number[] => {
    const rev = ids[0]! > ids[ids.length - 1]! || (ids[0] === ids[ids.length - 1] && ids[1]! > ids[ids.length - 2]!);
    const c = rev ? [...ids].reverse() : ids;
    const k = c.join(",");
    let kept = chainCache.get(k);
    if (!kept) {
      kept = simplifyChain(c);
      chainCache.set(k, kept);
    }
    return rev ? [...kept].reverse() : kept;
  };
  // Per ring: the kept vertex ids, or the finished ring (no neighbour, or fell below 3 vertices).
  const kept: Array<number[] | P2[]> = rs.map((v, ri) => {
    const original = rings[ri]!;
    const n = v.length;
    if (n < 3) return original.map((p) => [p[0], p[1]] as P2);
    const cuts = new Uint8Array(n);
    let any = false;
    for (let i = 0; i < n; i++) {
      const id = v[i]!;
      if (!fixed[id]) continue;
      const prevShared = sharedEdge(v[(i - 1 + n) % n]!, id);
      const nextShared = sharedEdge(id, v[(i + 1) % n]!);
      if (!(prevShared && nextShared && vertexUse[id] === 2)) {
        cuts[i] = 1;
        any = true;
      }
    }
    if (!any && !v.some((id) => nearV[id] === 1 || fixed[id] === 1)) {
      const out = simplifyRing(v.map((id) => [px[id]!, pz[id]!] as P2), tol);
      return out.length < 3 ? original.map((p) => [p[0], p[1]] as P2) : out;
    }
    {
      // With no cut (a ring shared all round, or one with near vertices only), cut where
      // simplifyRing does: the first vertex and the one farthest from it.
      let s0 = cuts.indexOf(1);
      if (s0 < 0) {
        s0 = 0;
        let far = 0;
        let farD = -1;
        for (let i = 1; i < n; i++) {
          const d = Math.hypot(px[v[i]!]! - px[v[0]!]!, pz[v[i]!]! - pz[v[0]!]!);
          if (d > farD) {
            farD = d;
            far = i;
          }
        }
        cuts[0] = 1;
        cuts[far] = 1;
      }
      const out: number[] = [];
      let chain: number[] = [v[s0]!];
      for (let s = 1; s <= n; s++) {
        const i = (s0 + s) % n;
        chain.push(v[i]!);
        if (cuts[i]) {
          const shared = chain.length > 2 && sharedEdge(chain[0]!, chain[1]!);
          const kept = chain.length <= 2 ? chain : shared ? sharedChain(chain) : simplifyChain(chain);
          for (let k = 0; k < kept.length - 1; k++) out.push(kept[k]!);
          chain = [v[i]!];
        }
      }
      return out.length < 3 ? original.map((p) => [p[0], p[1]] as P2) : out;
    }
  });

  // ---- 5. Weld: a vertex of one footprint left within WELD_M of a neighbour's wall that one of
  // its own walls runs along (within WELD_ANGLE) moves onto that wall, closing the wedge between
  // two walls that nearly touch. Each vertex moves at most once (in every ring that uses it, so
  // the walls it already shares stay shared), ring by ring in input order against the
  // neighbours' current walls (so two walls never swap sides).
  const isIds = (k: number[] | P2[]): k is number[] => k.length > 0 && typeof k[0] === "number";
  const sinW = Math.sin(WELD_ANGLE);
  const moved = new Uint8Array(px.length);
  kept.forEach((k, ri) => {
    if (!isIds(k)) return;
    const n = k.length;
    for (let i = 0; i < n; i++) {
      const id = k[i]!;
      if (moved[id]) continue;
      const x = px[id]!, z = pz[id]!;
      // Unit directions of the vertex's own walls.
      const dirs: Array<[number, number]> = [];
      for (const j of [k[(i - 1 + n) % n]!, k[(i + 1) % n]!]) {
        const L = Math.hypot(px[j]! - x, pz[j]! - z);
        if (L > 0.1) dirs.push([(px[j]! - x) / L, (pz[j]! - z) / L]);
      }
      let bestD = WELD_M;
      let bx = 0, bz = 0;
      let on = false;
      for (const o of near[ri]!) {
        const ok = kept[o]!;
        // A neighbour that uses the vertex itself shares a wall with it already.
        if (!isIds(ok) || ok.includes(id)) continue;
        const m = ok.length;
        for (let e = 0; e < m && !on; e++) {
          const a = ok[e]!;
          const b = ok[(e + 1) % m]!;
          if (a === id || b === id) continue;
          const ax = px[a]!, az = pz[a]!, ex = px[b]! - ax, ez = pz[b]! - az;
          if (x < Math.min(ax, ax + ex) - WELD_M || x > Math.max(ax, ax + ex) + WELD_M || z < Math.min(az, az + ez) - WELD_M || z > Math.max(az, az + ez) + WELD_M) continue;
          const L2 = ex * ex + ez * ez;
          if (L2 === 0) continue;
          const t = ((x - ax) * ex + (z - az) * ez) / L2;
          if (t <= 0 || t >= 1) continue;
          const qx = ax + ex * t, qz = az + ez * t;
          const d = Math.hypot(x - qx, z - qz);
          if (d < WELD_ON_M) on = true;
          else if (d < bestD) {
            const L = Math.sqrt(L2);
            if (dirs.some(([ux, uz]) => Math.abs(ux * (ez / L) - uz * (ex / L)) < sinW)) {
              bestD = d;
              bx = qx;
              bz = qz;
            }
          }
        }
        if (on) break;
      }
      if (on || bestD === WELD_M) continue;
      px[id] = bx;
      pz[id] = bz;
      moved[id] = 1;
    }
  });
  return kept.map((k) => (isIds(k) ? k.map((id) => [px[id]!, pz[id]!] as P2) : k));
}
