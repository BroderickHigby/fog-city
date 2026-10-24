// Junction paint from the pipeline's street-markings.json (pipeline/lib/street-markings.ts):
// an asphalt patch over each junction box, crosswalks laid square across each leg and stop
// bars across the controlled approaches. Pure: records in, MeshData out (tests/render).
//
// Layering over the glb road ribbons (ground + 0.15 m, polygon offset -1/-2): the patch sits
// at PATCH_LIFT_M with the same road material, so it hides every overlapping ribbon's dashes
// and kerb shading inside the box; paint sits PAINT_LIFT_M above the ground with a stronger
// polygon offset.

import { MeshBuilder, srgb, type MeshData, type RGB } from "./tile-geometry.ts";
import type { GroundFn } from "./types.ts";

/** The street-detail index each world may carry (pipeline/build-street-detail.ts). */
export const STREET_DETAIL_INDEX = "street-detail.json";
export const PATCH_LIFT_M = 0.2;
export const PAINT_LIFT_M = 0.23;
const GUTTER_M = 0.4;
const BAR_M = 0.6;
const PITCH_M = 1.2;
const LINE_M = 0.3;
const STOP_BAR_M = 0.45;
/** Longest triangle edge in the paint and the patch (terrain following). */
const STEP_M = 3;

/** The glb ribbon colours by road kind (pipeline/lib/mesh.ts ROAD_COLOR), linear. */
const ROAD_RGB: Record<string, RGB> = {
  arterial: srgb(0x3a3c3f),
  collector: srgb(0x3d3f42),
  residential: srgb(0x404244),
  alley: srgb(0x4b4b49),
  other: srgb(0x57554f),
};
const PAINT_RGB = srgb(0xdcdad2);

export type CrosswalkCode = "c" | "s" | "";

export interface MarkingLeg {
  edge: string;
  /** The leg line: the point t metres along the leg is node + (ox, oz) + t (ux, uz). */
  ux: number;
  uz: number;
  ox: number;
  oz: number;
  half: number;
  mouth: number;
  style: CrosswalkCode;
  from: number;
  to: number;
  stopAt: number;
  stopV0: number;
  stopV1: number;
}

export interface MarkingJunction {
  id: string;
  x: number;
  z: number;
  kind: string;
  /** Patch outline, world x/z pairs. */
  ring: number[];
  legs: MarkingLeg[];
}

type RawLeg = [string, number, number, number, number, number, number, CrosswalkCode, number, number, number, number, number];

/** Decode one record of street-markings.json `junctions`; null when it is malformed. */
export function decodeJunction(r: unknown): MarkingJunction | null {
  const o = r as { id?: unknown; x?: unknown; z?: unknown; k?: unknown; ring?: unknown; legs?: unknown };
  if (!o || typeof o.id !== "string" || typeof o.x !== "number" || typeof o.z !== "number") return null;
  if (!Array.isArray(o.ring) || !Array.isArray(o.legs)) return null;
  const x = o.x, z = o.z;
  const ring = (o.ring as number[]).map((v, i) => v + (i % 2 === 0 ? x : z));
  const legs = (o.legs as RawLeg[]).filter((l) => Array.isArray(l) && l.length >= 13).map((l) => ({
    edge: l[0], ux: l[1], uz: l[2], ox: l[3], oz: l[4], half: l[5], mouth: l[6], style: l[7], from: l[8], to: l[9], stopAt: l[10], stopV0: l[11], stopV1: l[12],
  }));
  return { id: o.id, x, z, kind: typeof o.k === "string" ? o.k : "residential", ring, legs };
}

/** Normal of the ground at (x, z) from central differences. */
function normalAt(ground: GroundFn, x: number, z: number): [number, number, number] {
  const gx = ground(x + 1, z) - ground(x - 1, z);
  const gz = ground(x, z + 1) - ground(x, z - 1);
  const l = Math.hypot(gx * 0.5, 1, gz * 0.5);
  return [(-gx * 0.5) / l, 1 / l, (-gz * 0.5) / l];
}

function vertex(mb: MeshBuilder, ground: GroundFn, x: number, z: number, lift: number, col: RGB): number {
  const n = normalAt(ground, x, z);
  return mb.v(x, ground(x, z) + lift, z, n[0], n[1], n[2], col);
}

/**
 * The patch: a fan from the node to the ring, with an inner ring at half radius and the outer
 * edges split every STEP_M so the surface follows the terrain like the ribbons do.
 */
export function addPatch(mb: MeshBuilder, j: MarkingJunction, ground: GroundFn): void {
  const col = ROAD_RGB[j.kind] ?? ROAD_RGB.residential!;
  const pts: Array<[number, number]> = [];
  const n = j.ring.length / 2;
  if (n < 3) return;
  for (let i = 0; i < n; i++) {
    const ax = j.ring[i * 2]!, az = j.ring[i * 2 + 1]!;
    const bx = j.ring[((i + 1) % n) * 2]!, bz = j.ring[((i + 1) % n) * 2 + 1]!;
    const k = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / STEP_M));
    for (let s = 0; s < k; s++) pts.push([ax + ((bx - ax) * s) / k, az + ((bz - az) * s) / k]);
  }
  const c = vertex(mb, ground, j.x, j.z, PATCH_LIFT_M, col);
  const mid = pts.map(([x, z]) => vertex(mb, ground, (x + j.x) / 2, (z + j.z) / 2, PATCH_LIFT_M, col));
  const out = pts.map(([x, z]) => vertex(mb, ground, x, z, PATCH_LIFT_M, col));
  for (let i = 0; i < pts.length; i++) {
    const i1 = (i + 1) % pts.length;
    mb.triFacing(c, mid[i]!, mid[i1]!, 0, 1, 0);
    mb.triFacing(mid[i]!, out[i]!, out[i1]!, 0, 1, 0);
    mb.triFacing(mid[i]!, out[i1]!, mid[i1]!, 0, 1, 0);
  }
}

/** A painted rectangle on leg `l`: t (along the leg, from the node) by v (across it). */
function quad(mb: MeshBuilder, j: MarkingJunction, l: MarkingLeg, t0: number, t1: number, v0: number, v1: number, ground: GroundFn, col: RGB): void {
  const nt = Math.max(1, Math.ceil((t1 - t0) / STEP_M));
  const nv = Math.max(1, Math.ceil((v1 - v0) / STEP_M));
  const rx = -l.uz, rz = l.ux;
  const base: number[] = [];
  for (let a = 0; a <= nt; a++) {
    const t = t0 + ((t1 - t0) * a) / nt;
    for (let b = 0; b <= nv; b++) {
      const v = v0 + ((v1 - v0) * b) / nv;
      base.push(vertex(mb, ground, j.x + l.ox + l.ux * t + rx * v, j.z + l.oz + l.uz * t + rz * v, PAINT_LIFT_M, col));
    }
  }
  for (let a = 0; a < nt; a++) {
    for (let b = 0; b < nv; b++) {
      const p = base[a * (nv + 1) + b]!, q = base[a * (nv + 1) + b + 1]!;
      const r = base[(a + 1) * (nv + 1) + b]!, s = base[(a + 1) * (nv + 1) + b + 1]!;
      mb.triFacing(p, r, q, 0, 1, 0);
      mb.triFacing(q, r, s, 0, 1, 0);
    }
  }
}

/** Bar centres of a continental crosswalk across a carriageway of half-width `half`. */
export function continentalBars(half: number): number[] {
  const span = 2 * (half - GUTTER_M);
  const count = Math.max(1, Math.floor((span - BAR_M) / PITCH_M) + 1);
  const used = (count - 1) * PITCH_M;
  return Array.from({ length: count }, (_, k) => -used / 2 + k * PITCH_M);
}

/** Crosswalks and stop bars for one junction. Returns how many of each it painted. */
export function addPaint(mb: MeshBuilder, j: MarkingJunction, ground: GroundFn): { crosswalks: number; stopBars: number } {
  let crosswalks = 0, stopBars = 0;
  for (const l of j.legs) {
    // A little wear: each crosswalk's paint is a shade off the next.
    const wear = 0.9 + 0.1 * (((l.edge.length * 7 + j.id.length * 13) % 10) / 10);
    const col: RGB = [PAINT_RGB[0] * wear, PAINT_RGB[1] * wear, PAINT_RGB[2] * wear];
    const inner = l.half - GUTTER_M;
    if (l.style === "c" && l.to > l.from) {
      for (const c of continentalBars(l.half)) quad(mb, j, l, l.from, l.to, c - BAR_M / 2, c + BAR_M / 2, ground, col);
      crosswalks++;
    } else if (l.style === "s" && l.to > l.from) {
      quad(mb, j, l, l.from, l.from + LINE_M, -inner, inner, ground, col);
      quad(mb, j, l, l.to - LINE_M, l.to, -inner, inner, ground, col);
      crosswalks++;
    }
    if (l.stopAt > 0 && l.stopV1 > l.stopV0) {
      quad(mb, j, l, l.stopAt, l.stopAt + STOP_BAR_M, l.stopV0, l.stopV1, ground, col);
      stopBars++;
    }
  }
  return { crosswalks, stopBars };
}

/** Patch and paint meshes for a set of junctions. */
export function buildMarkingMeshes(junctions: readonly MarkingJunction[], ground: GroundFn): { patch: MeshData; paint: MeshData; crosswalks: number; stopBars: number } {
  const patch = new MeshBuilder();
  const paint = new MeshBuilder();
  let crosswalks = 0, stopBars = 0;
  for (const j of junctions) {
    addPatch(patch, j, ground);
    const n = addPaint(paint, j, ground);
    crosswalks += n.crosswalks;
    stopBars += n.stopBars;
  }
  return { patch: patch.build(), paint: paint.build(), crosswalks, stopBars };
}
