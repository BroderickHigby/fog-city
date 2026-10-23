// Polygon boolean operations for footprints (polygon-clipping, MIT), in the pipeline's ring
// convention: P2 rings, not closed, local metres. Results are plain arrays; every caller rounds
// to centimetres afterwards (cleanRing), so output is byte-stable.

import pc from "polygon-clipping";
import { signedArea, type P2 } from "./geom.ts";

type PcRing = Array<[number, number]>;
type PcPoly = PcRing[];
type PcMulti = PcPoly[];

export interface Poly {
  outer: P2[];
  holes: P2[][];
}

const close = (r: readonly P2[]): PcRing => {
  const out = r.map((p) => [p[0], p[1]] as [number, number]);
  if (out.length && (out[0]![0] !== out[out.length - 1]![0] || out[0]![1] !== out[out.length - 1]![1])) out.push([out[0]![0], out[0]![1]]);
  return out;
};
const open = (r: PcRing): P2[] => {
  const out = r.map((p) => [p[0], p[1]] as P2);
  if (out.length > 1 && out[0]![0] === out[out.length - 1]![0] && out[0]![1] === out[out.length - 1]![1]) out.pop();
  return out;
};

export const asPc = (rings: readonly (readonly P2[])[]): PcMulti => rings.filter((r) => r.length >= 3).map((r) => [close(r)]);
const fromPc = (m: PcMulti): Poly[] => m.map((p) => ({ outer: open(p[0]!), holes: p.slice(1).map(open) }));

/** Area of a polygon with holes (positive). */
export function polyArea(p: Poly): number {
  return Math.abs(signedArea(p.outer)) - p.holes.reduce((s, h) => s + Math.abs(signedArea(h)), 0);
}

/** Union of rings, as polygons (repairs self-intersections: a bow tie becomes two triangles). */
export function unionRings(rings: readonly (readonly P2[])[]): Poly[] {
  const g = asPc(rings);
  if (g.length === 0) return [];
  return fromPc(pc.union(g[0]!, ...g.slice(1)));
}

/** subject minus every clip ring. */
export function differenceRings(subject: readonly P2[], clips: readonly (readonly P2[])[]): Poly[] {
  const c = asPc(clips);
  if (c.length === 0) return [{ outer: subject.map((p) => [p[0], p[1]] as P2), holes: [] }];
  return fromPc(pc.difference([close(subject)], ...c));
}

/** subject minus a multipolygon. */
export function differencePolys(subject: readonly P2[], clip: readonly Poly[]): Poly[] {
  if (clip.length === 0) return [{ outer: subject.map((p) => [p[0], p[1]] as P2), holes: [] }];
  return fromPc(pc.difference([close(subject)], clip.map((p) => [close(p.outer), ...p.holes.map(close)])));
}

/** subject intersected with a multipolygon. */
export function intersectPolys(subject: readonly P2[], clip: readonly Poly[]): Poly[] {
  if (clip.length === 0) return [];
  return fromPc(pc.intersection([close(subject)], clip.map((p) => [close(p.outer), ...p.holes.map(close)])));
}

/** subject intersected with one ring. */
export function intersectRing(subject: readonly P2[], clip: readonly P2[]): Poly[] {
  return fromPc(pc.intersection([close(subject)], [close(clip)]));
}

/** Union of polygons. */
export function unionPolys(polys: readonly Poly[]): Poly[] {
  if (polys.length === 0) return [];
  const g: PcMulti = polys.map((p) => [close(p.outer), ...p.holes.map(close)]);
  return fromPc(pc.union(g[0]!, ...g.slice(1)));
}

/**
 * The region within `r` of a polyline: one rectangle per segment and a 12-gon at every vertex,
 * unioned. Good to a few centimetres at joints, which is all a clearance test needs.
 */
export function bufferPolyline(points: readonly P2[], r: number): Poly[] {
  const parts: P2[][] = [];
  const disc = (c: P2): P2[] => {
    const out: P2[] = [];
    // A 12-gon that contains the circle (circumscribed), so the buffer is never short.
    const R = r / Math.cos(Math.PI / 12);
    for (let k = 0; k < 12; k++) {
      const a = (k * Math.PI) / 6 + Math.PI / 12;
      out.push([c[0] + R * Math.cos(a), c[1] + R * Math.sin(a)]);
    }
    return out;
  };
  for (let i = 0; i < points.length; i++) {
    parts.push(disc(points[i]!));
    if (i === 0) continue;
    const a = points[i - 1]!;
    const b = points[i]!;
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-6) continue;
    const nx = (-(b[1] - a[1]) / L) * r;
    const nz = ((b[0] - a[0]) / L) * r;
    parts.push([
      [a[0] + nx, a[1] + nz],
      [b[0] + nx, b[1] + nz],
      [b[0] - nx, b[1] - nz],
      [a[0] - nx, a[1] - nz],
    ]);
  }
  return unionRings(parts);
}

/** The largest polygon (by area), or null. */
export function largest(polys: readonly Poly[]): Poly | null {
  let best: Poly | null = null;
  let bestA = -1;
  for (const p of polys) {
    const a = polyArea(p);
    if (a > bestA) {
      bestA = a;
      best = p;
    }
  }
  return best;
}
