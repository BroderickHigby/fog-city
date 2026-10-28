// Street-name blades, one-way signs and kerbside parking signs from the pipeline's
// street-signs.json (pipeline/lib/street-signs.ts), per street-detail cell. Render-only.
//
// Blades are SF's white-on-green street-name signs with the real names. Names are drawn once
// into shared atlas pages (rows of BLADE_W x BLADE_H pixels, reference-counted, the least
// recently released row reused first); a cell merges its blades into one mesh per page it uses.
// The pages' materials are shared by every cell, so a new cell builds no new shaders (a
// material per cell cost one shader build per cell). Posts and the generic sign faces are
// instanced. Without a DOM (tests) the blades are plain green. Models face -z; the renderer
// sets rotation.y = -heading.

import * as THREE from "three";
import { LocalInstances, type InstanceBlock, type InstanceSink } from "./instance-pool.ts";

export interface CornerRecord {
  id: string;
  x: number;
  z: number;
  blades: Array<{ name: string; heading: number }>;
  oneWay: number[];
}

export type CurbKind = "cleaning" | "permit" | "time" | "noParking" | "tow";

export interface CurbRecord {
  id: string;
  x: number;
  z: number;
  heading: number;
  kind: CurbKind;
}

/** Blade size (36 x 8 in), metres, and its first height above the ground. */
export const BLADE_W_M = 0.92;
export const BLADE_H_M = 0.2;
const BLADE_Y = 2.75;
const BLADE_GAP_M = 0.24;
const ONE_WAY_Y = 2.25;
const CURB_Y = 2.0;
const ATLAS_W = 512;
const ROW_H = 112;
const ROWS = 18;
/** Rows in one shared atlas page, and the most pages: ~133 names are within 700 m at most. */
export const PAGE_ROWS = 16;
export const MAX_PAGES = 12;

/** The atlas rows a cell needs: one per distinct name, in first-seen order. */
export function bladeNames(corners: readonly CornerRecord[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of corners) for (const b of c.blades) if (!seen.has(b.name)) {
    seen.add(b.name);
    out.push(b.name);
  }
  return out;
}

/** Title-ish SF style: the name in capitals, the suffix smaller ("CHESTNUT" + "ST"). */
function splitName(name: string): [string, string] {
  const m = /^(.*?)\s+(ST|AVE|BLVD|WAY|DR|PL|TER|CT|LN|RD|ALY|HWY|CIR|PLZ|WALK|ROW|STPS|PATH)$/.exec(name);
  return m ? [m[1]!, m[2]!] : [name, ""];
}

/** One name in its row of an atlas canvas, top at `y`. */
function drawBladeRow(ctx: CanvasRenderingContext2D, name: string, y: number): void {
  ctx.fillStyle = "#0b6a3b";
  ctx.fillRect(0, y, ATLAS_W, ROW_H);
  ctx.strokeStyle = "#f4f4ee";
  ctx.lineWidth = 6;
  ctx.strokeRect(7, y + 7, ATLAS_W - 14, ROW_H - 14);
  const [main, suffix] = splitName(name);
  ctx.fillStyle = "#f4f4ee";
  ctx.textBaseline = "middle";
  let size = 72;
  ctx.font = `bold ${size}px Arial, Helvetica, sans-serif`;
  const sw = suffix ? ctx.measureText(` ${suffix}`).width * 0.6 : 0;
  while (size > 24 && ctx.measureText(main).width + sw > ATLAS_W - 48) {
    size -= 4;
    ctx.font = `bold ${size}px Arial, Helvetica, sans-serif`;
  }
  const mw = ctx.measureText(main).width;
  ctx.font = `bold ${size}px Arial, Helvetica, sans-serif`;
  const total = mw + (suffix ? ctx.measureText(` ${suffix}`).width * 0.6 : 0);
  let x = (ATLAS_W - total) / 2;
  ctx.fillText(main, x, y + ROW_H / 2 + 3);
  x += mw;
  if (suffix) {
    ctx.font = `bold ${Math.round(size * 0.6)}px Arial, Helvetica, sans-serif`;
    ctx.fillText(` ${suffix}`, x, y + ROW_H / 2 - size * 0.12);
  }
}

/** A name's row in the shared atlas. */
export interface BladeSlot {
  readonly page: number;
  readonly row: number;
  readonly name: string;
  refs: number;
  /** When it was last released (a clock tick): the oldest free row is reused first. */
  released: number;
}

interface AtlasPage { ctx: CanvasRenderingContext2D | null; texture: THREE.Texture | null; material: THREE.MeshStandardMaterial; rows: Array<BladeSlot | null> }

/**
 * Street names drawn once into shared pages. `canvas` makes a page's canvas (null: no DOM, the
 * pages are plain green). acquire() returns null only when every row of every page is in use;
 * those blades use blank(), a plain green blade, rather than going missing.
 */
export class BladeAtlas {
  private readonly pages: AtlasPage[] = [];
  private readonly byName = new Map<string, BladeSlot>();
  private readonly canvas: (() => HTMLCanvasElement | null) | null;
  private clock = 0;
  /** Rows drawn so far (a reused name is not drawn again). */
  drawn = 0;

  constructor(canvas: (() => HTMLCanvasElement | null) | null = typeof document === "undefined" ? null : () => document.createElement("canvas")) {
    this.canvas = canvas;
  }

  private blankMaterial: THREE.MeshStandardMaterial | null = null;

  get pageCount(): number { return this.pages.length; }
  material(page: number): THREE.MeshStandardMaterial { return this.pages[page]!.material; }
  /** The nameless blade, for names that found no free row. */
  blank(): THREE.MeshStandardMaterial {
    return (this.blankMaterial ??= new THREE.MeshStandardMaterial({ color: 0x0b6a3b, roughness: 0.5, name: "fc:street-blade" }));
  }

  /** Free every page's texture and material (the cells using them are gone). */
  dispose(): void {
    for (const p of this.pages) { p.texture?.dispose(); p.material.dispose(); }
    this.pages.length = 0;
    this.byName.clear();
    this.blankMaterial?.dispose();
    this.blankMaterial = null;
  }

  acquire(name: string): BladeSlot | null {
    const hit = this.byName.get(name);
    if (hit) { hit.refs++; return hit; }
    let page = -1, row = -1;
    // A never-used row first, then the least recently released free one, then a new page.
    for (let p = 0; p < this.pages.length && page < 0; p++) {
      const at = this.pages[p]!.rows.indexOf(null);
      if (at >= 0) { page = p; row = at; }
    }
    if (page < 0) {
      let oldest: BladeSlot | null = null;
      for (const slot of this.byName.values()) if (slot.refs === 0 && (!oldest || slot.released < oldest.released)) oldest = slot;
      if (oldest) { this.byName.delete(oldest.name); page = oldest.page; row = oldest.row; }
    }
    if (page < 0 && this.pages.length < MAX_PAGES) { page = this.addPage(); row = 0; }
    if (page < 0) return null;
    const slot: BladeSlot = { page, row, name, refs: 1, released: 0 };
    const p = this.pages[page]!;
    p.rows[row] = slot;
    this.byName.set(name, slot);
    if (p.ctx && p.texture) {
      drawBladeRow(p.ctx, name, row * ROW_H);
      p.texture.needsUpdate = true;
    }
    this.drawn++;
    return slot;
  }

  release(slot: BladeSlot): void {
    if (slot.refs > 0 && --slot.refs === 0) slot.released = ++this.clock;
  }

  private addPage(): number {
    const c = this.canvas?.() ?? null;
    let ctx: CanvasRenderingContext2D | null = null, texture: THREE.Texture | null = null;
    if (c) {
      c.width = ATLAS_W;
      c.height = ROW_H * PAGE_ROWS;
      ctx = c.getContext("2d");
      if (ctx) {
        texture = new THREE.CanvasTexture(c);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 8;
      }
    }
    const material = new THREE.MeshStandardMaterial({ color: texture ? 0xffffff : 0x0b6a3b, map: texture, roughness: 0.5, name: "fc:street-blade" });
    this.pages.push({ ctx, texture, material, rows: new Array<BladeSlot | null>(PAGE_ROWS).fill(null) });
    return this.pages.length - 1;
  }
}

let sharedAtlas: BladeAtlas | null = null;
/** The atlas a SignCell made without one shares (StreetDetailLayer gives each cell its own layer's). */
export function bladeAtlas(): BladeAtlas {
  return (sharedAtlas ??= new BladeAtlas());
}

function faceTexture(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, w: number, h: number): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  draw(ctx, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const text = (ctx: CanvasRenderingContext2D, s: string, x: number, y: number, px: number, color: string): void => {
  ctx.fillStyle = color;
  ctx.font = `bold ${px}px Arial, Helvetica, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(s, x, y);
};

/** Generic faces of the kerbside sign kinds (regulation layouts, no legends). */
function curbFace(kind: CurbKind): THREE.Texture | null {
  return faceTexture((ctx, w, h) => {
    ctx.fillStyle = "#f6f6f2";
    ctx.fillRect(0, 0, w, h);
    const ink = kind === "time" || kind === "permit" ? "#13703c" : "#b5121b";
    ctx.strokeStyle = ink;
    ctx.lineWidth = 6;
    ctx.strokeRect(6, 6, w - 12, h - 12);
    if (kind === "cleaning") {
      text(ctx, "NO", w / 2, 30, 30, ink);
      text(ctx, "PARKING", w / 2, 62, 26, ink);
      text(ctx, "STREET", w / 2, 102, 20, "#222");
      text(ctx, "CLEANING", w / 2, 126, 20, "#222");
    } else if (kind === "permit") {
      text(ctx, "2 HOUR", w / 2, 36, 26, ink);
      text(ctx, "PARKING", w / 2, 66, 24, ink);
      text(ctx, "EXCEPT", w / 2, 104, 18, "#222");
      text(ctx, "PERMITS", w / 2, 126, 18, "#222");
    } else if (kind === "time") {
      text(ctx, "PARKING", w / 2, 40, 26, ink);
      text(ctx, "LIMITED", w / 2, 76, 22, "#222");
      text(ctx, "HOURS", w / 2, 110, 22, "#222");
    } else if (kind === "noParking") {
      text(ctx, "NO", w / 2, 42, 34, ink);
      text(ctx, "PARKING", w / 2, 82, 26, ink);
      text(ctx, "ANY TIME", w / 2, 118, 20, ink);
    } else {
      text(ctx, "TOW", w / 2, 40, 34, ink);
      text(ctx, "AWAY", w / 2, 78, 30, ink);
      text(ctx, "NO STOPPING", w / 2, 118, 16, "#222");
    }
  }, 128, 160);
}

const oneWayFace = (): THREE.Texture | null =>
  faceTexture((ctx, w, h) => {
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#f6f6f2";
    // A right-pointing arrow carrying the words.
    ctx.beginPath();
    ctx.moveTo(12, h * 0.32);
    ctx.lineTo(w * 0.74, h * 0.32);
    ctx.lineTo(w * 0.74, h * 0.12);
    ctx.lineTo(w - 10, h / 2);
    ctx.lineTo(w * 0.74, h * 0.88);
    ctx.lineTo(w * 0.74, h * 0.68);
    ctx.lineTo(12, h * 0.68);
    ctx.closePath();
    ctx.fill();
    text(ctx, "ONE WAY", w * 0.42, h / 2 + 2, 36, "#111");
  }, 256, 86);

interface Protos {
  post: THREE.BufferGeometry;
  oneWay: THREE.BufferGeometry;
  curb: THREE.BufferGeometry;
  back: THREE.BufferGeometry;
  metal: THREE.MeshStandardMaterial;
  backMat: THREE.MeshStandardMaterial;
  oneWayMat: THREE.MeshStandardMaterial;
  curbMats: Record<CurbKind, THREE.MeshStandardMaterial>;
}

let protos: Protos | null = null;

function getProtos(): Protos {
  if (protos) return protos;
  const mat = (map: THREE.Texture | null, fallback: number, name: string): THREE.MeshStandardMaterial =>
    new THREE.MeshStandardMaterial({ color: map ? 0xffffff : fallback, map, roughness: 0.55, name, side: THREE.FrontSide });
  protos = {
    post: new THREE.CylinderGeometry(0.035, 0.035, 3.0, 6).translate(0, 1.5, 0),
    // Faces -z (toward the viewer the heading points at), double-sided where it matters.
    oneWay: new THREE.PlaneGeometry(0.9, 0.3).rotateY(Math.PI),
    curb: new THREE.PlaneGeometry(0.3, 0.38).rotateY(Math.PI),
    back: new THREE.PlaneGeometry(1, 1),
    metal: new THREE.MeshStandardMaterial({ color: 0x8c908c, roughness: 0.5, metalness: 0.6, name: "fc:sign-post" }),
    backMat: new THREE.MeshStandardMaterial({ color: 0x9a9d9a, roughness: 0.6, metalness: 0.5, name: "fc:sign-back" }),
    oneWayMat: mat(oneWayFace(), 0x111111, "fc:one-way"),
    curbMats: {
      cleaning: mat(curbFace("cleaning"), 0xf0f0ea, "fc:sign-cleaning"),
      permit: mat(curbFace("permit"), 0xf0f0ea, "fc:sign-permit"),
      time: mat(curbFace("time"), 0xf0f0ea, "fc:sign-time"),
      noParking: mat(curbFace("noParking"), 0xf0f0ea, "fc:sign-noparking"),
      tow: mat(curbFace("tow"), 0xf0f0ea, "fc:sign-tow"),
    },
  };
  return protos;
}

/**
 * The blades of a cell, one geometry per atlas bucket (`place` gives a name's bucket and its
 * v range, or undefined to leave it out): each blade is two quads back to back (readable from
 * both sides).
 */
function bladeBuckets(corners: readonly CornerRecord[], ground: (x: number, z: number) => number, place: (name: string) => { bucket: number; v0: number; v1: number } | undefined): { geometries: Map<number, THREE.BufferGeometry>; blades: number } {
  const parts = new Map<number, { pos: number[]; uv: number[]; nor: number[]; idx: number[] }>();
  let blades = 0;
  for (const c of corners) {
    const gy = ground(c.x, c.z);
    c.blades.forEach((b, k) => {
      const at = place(b.name);
      if (!at) return;
      let part = parts.get(at.bucket);
      if (!part) parts.set(at.bucket, (part = { pos: [], uv: [], nor: [], idx: [] }));
      const { pos, uv, nor, idx } = part;
      // The blade lies along the street: its long axis is the heading direction.
      const ax = Math.sin(b.heading), az = -Math.cos(b.heading);
      const nx = -az, nz = ax;
      const y0 = gy + BLADE_Y + k * BLADE_GAP_M;
      const { v0, v1 } = at;
      for (const side of [1, -1]) {
        const base = pos.length / 3;
        const hx = (ax * BLADE_W_M) / 2, hz = (az * BLADE_W_M) / 2;
        const ox = nx * 0.006 * side, oz = nz * 0.006 * side;
        // Corners: left-bottom, right-bottom, right-top, left-top as seen from the `side` normal.
        const lx = side > 0 ? -hx : hx, lz = side > 0 ? -hz : hz;
        pos.push(c.x + lx + ox, y0, c.z + lz + oz, c.x - lx + ox, y0, c.z - lz + oz, c.x - lx + ox, y0 + BLADE_H_M, c.z - lz + oz, c.x + lx + ox, y0 + BLADE_H_M, c.z + lz + oz);
        uv.push(0, v0, 1, v0, 1, v1, 0, v1);
        for (let q = 0; q < 4; q++) nor.push(nx * side, 0, nz * side);
        // Wound counter-clockwise when seen from the normal's side.
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
      blades++;
    });
  }
  const geometries = new Map<number, THREE.BufferGeometry>();
  for (const [bucket, { pos, uv, nor, idx }] of parts) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    geometries.set(bucket, g);
  }
  return { geometries, blades };
}

/**
 * The blades of a cell as one mesh with its own atlas rows (one per distinct name, at most
 * ROWS): each blade is two quads back to back (readable from both sides).
 */
export function bladeGeometry(corners: readonly CornerRecord[], ground: (x: number, z: number) => number): { geometry: THREE.BufferGeometry; names: string[]; blades: number } {
  const names = bladeNames(corners).slice(0, ROWS);
  const row = new Map(names.map((n, i) => [n, i]));
  const b = bladeBuckets(corners, ground, (name) => {
    const r = row.get(name);
    return r === undefined ? undefined : { bucket: 0, v0: 1 - (r + 1) / names.length, v1: 1 - r / names.length };
  });
  return { geometry: b.geometries.get(0) ?? new THREE.BufferGeometry(), names, blades: b.blades };
}

/** One cell's sign posts, blades, one-way signs and kerbside signs. */
export class SignCell {
  readonly group = new THREE.Group();
  readonly blades: number;
  readonly posts: number;
  readonly curbSigns: number;
  private readonly owned: Array<THREE.BufferGeometry | THREE.Material | THREE.Texture> = [];
  private readonly slots: BladeSlot[] = [];
  private readonly sink: InstanceSink;
  private readonly blocks: InstanceBlock[] = [];
  private readonly atlas: BladeAtlas;

  /**
   * `sink`: where the instanced posts and faces go; by default this cell's own meshes in `group`.
   * `atlas`: where the blade names are drawn; by default the module's shared one.
   */
  constructor(corners: readonly CornerRecord[], curb: readonly CurbRecord[], ground: (x: number, z: number) => number, sink?: InstanceSink, atlas: BladeAtlas = bladeAtlas()) {
    const p = getProtos();
    this.sink = sink ?? new LocalInstances(this.group);
    this.atlas = atlas;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3();
    const local = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    const place = (x: number, z: number, heading: number, ly = 0, lz = 0): THREE.Matrix4 => {
      q.setFromAxisAngle(up, -heading);
      local.set(0, ly, lz).applyQuaternion(q);
      pos.set(x + local.x, ground(x, z) + ly, z + local.z);
      return m.compose(pos, q, one).clone();
    };
    const inst = (geo: THREE.BufferGeometry, mat: THREE.Material, mats: THREE.Matrix4[], name: string): void => {
      const block = this.sink.add(geo, mat, mats, { name, castShadow: true, receiveShadow: true });
      if (block) this.blocks.push(block);
    };

    const posts: THREE.Matrix4[] = [], ways: THREE.Matrix4[] = [], wayBacks: THREE.Matrix4[] = [];
    for (const c of corners) {
      posts.push(place(c.x, c.z, 0));
      for (const h of c.oneWay) {
        // The plate lies along the street, its arrow (pointing right on the face) along the
        // flow: a viewer whose right is the flow looks at a face turned 90° clockwise of it.
        ways.push(place(c.x, c.z, h + Math.PI / 2, ONE_WAY_Y, -0.04));
        wayBacks.push(place(c.x, c.z, h + Math.PI / 2, ONE_WAY_Y, -0.03).multiply(new THREE.Matrix4().makeScale(0.9, 0.3, 1)));
      }
    }
    const curbPosts: THREE.Matrix4[] = [];
    const faces: Record<CurbKind, THREE.Matrix4[]> = { cleaning: [], permit: [], time: [], noParking: [], tow: [] };
    for (const s of curb) {
      curbPosts.push(place(s.x, s.z, 0));
      faces[s.kind].push(place(s.x, s.z, s.heading, CURB_Y, -0.04));
      faces[s.kind].push(place(s.x, s.z, s.heading + Math.PI, CURB_Y, -0.04));
    }
    inst(p.post, p.metal, [...posts, ...curbPosts], "sign posts");
    inst(p.oneWay, p.oneWayMat, ways, "one-way signs");
    inst(p.back, p.backMat, wayBacks, "one-way sign backs");
    for (const k of Object.keys(faces) as CurbKind[]) inst(p.curb, p.curbMats[k], faces[k], `${k} signs`);

    // Blades: rows in the shared atlas, one merged mesh per atlas page the cell uses. A name
    // with no free row (every page full) gets a blank blade (bucket -1).
    const slots = new Map<string, BladeSlot | null>();
    for (const name of bladeNames(corners)) slots.set(name, atlas.acquire(name));
    const b = bladeBuckets(corners, ground, (name) => {
      const slot = slots.get(name);
      return slot ? { bucket: slot.page, v0: 1 - (slot.row + 1) / PAGE_ROWS, v1: 1 - slot.row / PAGE_ROWS } : { bucket: -1, v0: 0, v1: 1 };
    });
    for (const [page, geometry] of b.geometries) {
      const blades = new THREE.Mesh(geometry, page < 0 ? atlas.blank() : atlas.material(page));
      blades.name = "street-name blades";
      blades.castShadow = true;
      blades.matrixAutoUpdate = false;
      this.group.add(blades);
      this.owned.push(geometry);
    }
    for (const slot of slots.values()) if (slot) this.slots.push(slot);
    this.blades = b.blades;
    this.posts = corners.length;
    this.curbSigns = curb.length;
  }

  dispose(): void {
    for (const block of this.blocks) this.sink.release(block);
    this.blocks.length = 0;
    // The atlas pages and their materials are shared; this cell only gives its rows back.
    for (const slot of this.slots) this.atlas.release(slot);
    this.slots.length = 0;
    for (const o of this.owned) o.dispose();
    this.group.clear();
  }
}
