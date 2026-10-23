// Grass, fences/walls/hedges and piers from the pipeline's street-landcover.json (DataSF) and
// street-osm.json (OpenStreetMap, ODbL) (pipeline/lib/landcover.ts), per street-detail cell.
// Render-only.
//
// Grass is a terrain-following sheet just above the ground (below the road ribbons), split so
// no triangle edge is longer than GRASS_STEP_M. Barriers are instanced boxes per straight piece
// (fence posts and a see-through mesh panel, wall and hedge blocks, a low guard rail). Piers
// are decks a little above the sea (or the ground, where the deck stands over land).

import * as THREE from "three";
import { MeshBuilder, srgb, type MeshData, type RGB } from "./tile-geometry.ts";
import type { GroundFn } from "./types.ts";

export type GrassKind = "lawn" | "meadow" | "pitch" | "natural";
export type BarrierKind = "fence" | "wall" | "hedge" | "rail";

export interface GrassRecord {
  id: string;
  kind: GrassKind;
  rings: number[][];
}

/** One straight piece of a barrier. */
export interface BarrierPiece {
  id: string;
  kind: BarrierKind;
  h: number;
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

export interface PierRecord {
  id: string;
  ring?: number[];
  line?: number[];
  width?: number;
  floating: boolean;
}

export const GRASS_LIFT_M = 0.06;
const GRASS_STEP_M = 4;
const PIECE_MAX_M = 4;

const GRASS_RGB: Record<GrassKind, RGB> = {
  lawn: srgb(0x5f8a3c),
  meadow: srgb(0x7b8f46),
  pitch: srgb(0x4f8a39),
  natural: srgb(0x7a8a4a),
};

/** Low-frequency brightness variation (patchy turf), deterministic in x, z. */
function patch(x: number, z: number): number {
  return 0.88 + 0.08 * Math.sin(x * 0.11 + Math.sin(z * 0.07) * 2) + 0.06 * Math.sin(z * 0.13 + x * 0.05);
}

/** Split a triangle until every edge is at most `step` metres; calls `emit` for each piece. */
function subdivide(a: number[], b: number[], c: number[], step: number, emit: (a: number[], b: number[], c: number[]) => void, depth = 0): void {
  const ab = Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!), bc = Math.hypot(b[0]! - c[0]!, b[1]! - c[1]!), ca = Math.hypot(c[0]! - a[0]!, c[1]! - a[1]!);
  const m = Math.max(ab, bc, ca);
  if (m <= step || depth > 12) {
    emit(a, b, c);
    return;
  }
  // Split the longest edge.
  if (m === ab) {
    const p = [(a[0]! + b[0]!) / 2, (a[1]! + b[1]!) / 2];
    subdivide(a, p, c, step, emit, depth + 1);
    subdivide(p, b, c, step, emit, depth + 1);
  } else if (m === bc) {
    const p = [(b[0]! + c[0]!) / 2, (b[1]! + c[1]!) / 2];
    subdivide(a, b, p, step, emit, depth + 1);
    subdivide(a, p, c, step, emit, depth + 1);
  } else {
    const p = [(c[0]! + a[0]!) / 2, (c[1]! + a[1]!) / 2];
    subdivide(a, b, p, step, emit, depth + 1);
    subdivide(p, b, c, step, emit, depth + 1);
  }
}

/** Grass sheets for a set of pieces. */
export function buildGrass(pieces: readonly GrassRecord[], ground: GroundFn): MeshData {
  const mb = new MeshBuilder();
  for (const g of pieces) {
    const toV2 = (r: number[]): THREE.Vector2[] => {
      const out: THREE.Vector2[] = [];
      for (let i = 0; i + 1 < r.length; i += 2) out.push(new THREE.Vector2(r[i]!, r[i + 1]!));
      return out;
    };
    const outer = toV2(g.rings[0] ?? []);
    if (outer.length < 3) continue;
    const holes = g.rings.slice(1).map(toV2).filter((h) => h.length >= 3);
    const all = [...outer, ...holes.flat()];
    const tris = THREE.ShapeUtils.triangulateShape(outer, holes);
    const base = GRASS_RGB[g.kind] ?? GRASS_RGB.lawn;
    for (const [i, j, k] of tris) {
      const p = (n: number): number[] => [all[n]!.x, all[n]!.y];
      subdivide(p(i!), p(j!), p(k!), GRASS_STEP_M, (a, b, c) => {
        const ids = [a, b, c].map(([x, z]) => {
          const y = ground(x!, z!) + GRASS_LIFT_M;
          const s = patch(x!, z!);
          return mb.v(x!, y, z!, 0, 1, 0, [base[0] * s, base[1] * s, base[2] * s]);
        });
        mb.triFacing(ids[0]!, ids[1]!, ids[2]!, 0, 1, 0);
      });
    }
  }
  return mb.build();
}

/** Split barrier polylines into straight pieces of at most PIECE_MAX_M. */
export function barrierPieces(b: { id: string; kind: BarrierKind; h: number; pts: number[] }): BarrierPiece[] {
  const out: BarrierPiece[] = [];
  for (let i = 0; i + 3 < b.pts.length; i += 2) {
    const ax = b.pts[i]!, az = b.pts[i + 1]!, bx = b.pts[i + 2]!, bz = b.pts[i + 3]!;
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / PIECE_MAX_M));
    for (let k = 0; k < n; k++) {
      out.push({
        id: b.id, kind: b.kind, h: b.h,
        ax: ax + ((bx - ax) * k) / n, az: az + ((bz - az) * k) / n,
        bx: ax + ((bx - ax) * (k + 1)) / n, bz: az + ((bz - az) * (k + 1)) / n,
      });
    }
  }
  return out;
}

interface Protos {
  box: THREE.BufferGeometry;
  panel: THREE.BufferGeometry;
  post: THREE.MeshStandardMaterial;
  mesh: THREE.MeshStandardMaterial;
  wall: THREE.MeshStandardMaterial;
  hedge: THREE.MeshStandardMaterial;
  rail: THREE.MeshStandardMaterial;
  deck: THREE.MeshStandardMaterial;
  grass: THREE.MeshStandardMaterial;
}

let protos: Protos | null = null;

function chainLink(): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  ctx.clearRect(0, 0, 64, 64);
  ctx.strokeStyle = "rgba(170,175,172,1)";
  ctx.lineWidth = 3;
  for (let k = -64; k <= 64; k += 16) {
    ctx.beginPath();
    ctx.moveTo(k, 0);
    ctx.lineTo(k + 64, 64);
    ctx.moveTo(k + 64, 0);
    ctx.lineTo(k, 64);
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function getProtos(): Protos {
  if (protos) return protos;
  const link = chainLink();
  protos = {
    // A unit box standing on y = 0, centred on x and z.
    box: new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
    // A unit panel in the xy plane, standing on y = 0; UVs repeat per metre (set per cell).
    panel: new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0),
    post: new THREE.MeshStandardMaterial({ color: 0x8a8f8c, roughness: 0.5, metalness: 0.6, name: "fc:fence-post" }),
    mesh: new THREE.MeshStandardMaterial({
      color: link ? 0xffffff : 0x9aa09c, map: link, transparent: !link, opacity: link ? 1 : 0.35, alphaTest: link ? 0.4 : 0,
      side: THREE.DoubleSide, roughness: 0.6, metalness: 0.5, name: "fc:fence-mesh",
    }),
    wall: new THREE.MeshStandardMaterial({ color: 0xb9ab95, roughness: 0.9, name: "fc:wall" }),
    hedge: new THREE.MeshStandardMaterial({ color: 0x3f6230, roughness: 1, name: "fc:hedge" }),
    rail: new THREE.MeshStandardMaterial({ color: 0xb4b8b6, roughness: 0.4, metalness: 0.7, name: "fc:guard-rail" }),
    deck: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, name: "fc:pier-deck" }),
    grass: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.97, name: "fc:grass" }),
  };
  protos.grass.polygonOffset = true;
  protos.grass.polygonOffsetFactor = -1;
  protos.grass.polygonOffsetUnits = -1;
  return protos;
}

export function grassMaterial(): THREE.MeshStandardMaterial {
  return getProtos().grass;
}

const DECK_WOOD = srgb(0x7d6a55);
const DECK_CONCRETE = srgb(0x9c9a94);

/** Pier decks: flat at `waterY + deck height`, never below the ground under them. */
export function buildPiers(piers: readonly PierRecord[], ground: GroundFn, waterY: number): MeshData {
  const mb = new MeshBuilder();
  for (const p of piers) {
    const deckY = waterY + (p.floating ? 0.45 : 1.4);
    const col = p.floating ? DECK_WOOD : DECK_CONCRETE;
    const quads: number[][] = [];
    if (p.line && p.width) {
      const hw = p.width / 2;
      for (let i = 0; i + 3 < p.line.length; i += 2) {
        const ax = p.line[i]!, az = p.line[i + 1]!, bx = p.line[i + 2]!, bz = p.line[i + 3]!;
        const l = Math.hypot(bx - ax, bz - az) || 1;
        const nx = (-(bz - az) / l) * hw, nz = ((bx - ax) / l) * hw;
        quads.push([ax + nx, az + nz, bx + nx, bz + nz, bx - nx, bz - nz, ax - nx, az - nz]);
      }
    } else if (p.ring && p.ring.length >= 6) quads.push(p.ring);
    for (const ring of quads) {
      const pts: THREE.Vector2[] = [];
      for (let i = 0; i + 1 < ring.length; i += 2) pts.push(new THREE.Vector2(ring[i]!, ring[i + 1]!));
      for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(pts, [])) {
        const v = (n: number): number[] => [pts[n]!.x, pts[n]!.y];
        subdivide(v(i!), v(j!), v(k!), 6, (a, b, c) => {
          const ids = [a, b, c].map(([x, z]) => mb.v(x!, Math.max(deckY, ground(x!, z!) + 0.08), z!, 0, 1, 0, col));
          mb.triFacing(ids[0]!, ids[1]!, ids[2]!, 0, 1, 0);
        });
      }
      // A skirt down to the water so the deck reads as a slab.
      for (let n = 0; n < pts.length; n++) {
        const a = pts[n]!, b = pts[(n + 1) % pts.length]!;
        const ya = Math.max(deckY, ground(a.x, a.y) + 0.08), yb = Math.max(deckY, ground(b.x, b.y) + 0.08);
        const dx = b.x - a.x, dz = b.y - a.y, l = Math.hypot(dx, dz) || 1;
        const nx = dz / l, nz = -dx / l;
        const shade: RGB = [col[0] * 0.7, col[1] * 0.7, col[2] * 0.7];
        const i0 = mb.v(a.x, ya, a.y, nx, 0, nz, shade), i1 = mb.v(b.x, yb, b.y, nx, 0, nz, shade);
        const i2 = mb.v(b.x, waterY - 0.5, b.y, nx, 0, nz, shade), i3 = mb.v(a.x, waterY - 0.5, a.y, nx, 0, nz, shade);
        mb.tri(i0, i1, i2);
        mb.tri(i0, i2, i3);
        mb.tri(i0, i2, i1);
        mb.tri(i0, i3, i2);
      }
    }
  }
  return mb.build();
}

/** One cell's barriers as instanced meshes. */
export function buildBarriers(pieces: readonly BarrierPiece[], ground: GroundFn): THREE.InstancedMesh[] {
  const p = getProtos();
  const out: THREE.InstancedMesh[] = [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), pos = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const lists = { post: [] as THREE.Matrix4[], mesh: [] as THREE.Matrix4[], wall: [] as THREE.Matrix4[], hedge: [] as THREE.Matrix4[], rail: [] as THREE.Matrix4[] };
  for (const b of pieces) {
    const dx = b.bx - b.ax, dz = b.bz - b.az, len = Math.hypot(dx, dz);
    if (len < 0.05) continue;
    const ga = ground(b.ax, b.az), gb = ground(b.bx, b.bz);
    const base = Math.min(ga, gb);
    const mx = (b.ax + b.bx) / 2, mz = (b.az + b.bz) / 2;
    // The box's x axis runs along the piece.
    q.setFromAxisAngle(up, -Math.atan2(dz, dx));
    const extra = Math.abs(ga - gb);
    if (b.kind === "fence") {
      lists.post.push(m.compose(pos.set(b.ax, ga - 0.1, b.az), q, s.set(0.06, b.h + 0.1, 0.06)).clone());
      lists.mesh.push(m.compose(pos.set(mx, base, mz), q, s.set(len, b.h + extra * 0.5, 1)).clone());
      lists.rail.push(m.compose(pos.set(mx, base + b.h + extra * 0.5 - 0.04, mz), q, s.set(len, 0.04, 0.04)).clone());
    } else if (b.kind === "wall") lists.wall.push(m.compose(pos.set(mx, base - 0.2, mz), q, s.set(len, b.h + 0.2 + extra, 0.35)).clone());
    else if (b.kind === "hedge") lists.hedge.push(m.compose(pos.set(mx, base - 0.1, mz), q, s.set(len, b.h + 0.1 + extra, 0.9)).clone());
    else lists.rail.push(m.compose(pos.set(mx, base + b.h - 0.35, mz), q, s.set(len, 0.32, 0.08)).clone());
  }
  const inst = (geo: THREE.BufferGeometry, mat: THREE.Material, mats: THREE.Matrix4[], name: string): void => {
    if (!mats.length) return;
    const im = new THREE.InstancedMesh(geo, mat, mats.length);
    mats.forEach((mm, k) => im.setMatrixAt(k, mm));
    im.computeBoundingSphere();
    im.name = name;
    im.castShadow = true;
    im.receiveShadow = true;
    im.matrixAutoUpdate = false;
    out.push(im);
  };
  inst(p.box, p.post, lists.post, "fence posts");
  inst(p.panel, p.mesh, lists.mesh, "fence mesh");
  inst(p.box, p.wall, lists.wall, "walls");
  inst(p.box, p.hedge, lists.hedge, "hedges");
  inst(p.box, p.rail, lists.rail, "rails");
  return out;
}

export function deckMaterial(): THREE.MeshStandardMaterial {
  return getProtos().deck;
}
