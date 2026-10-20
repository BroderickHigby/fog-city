// Reference decoder for the humanoid vertex-animation textures (public/models/humanoid-vat.json
// and humanoid-vat-<model>-lod<n>.bin, built by assets/blender/models/humanoid.py).
//
// Pure TypeScript, no three.js: the CPU version of exactly what the shader in
// humanoid-vat-three.ts does, so tests/assets can check the bake without WebGL and the render
// track can read one place for the maths. Layout and contract: assets/blender/README.md,
// "Humanoid line".

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number]; // x, y, z, w

export interface VatSection {
  format: "RGBA16F" | "RGBA8";
  byteOffset: number;
  byteLength: number;
  /** Texture height in texels; the width is the LOD's `width`. */
  height: number;
}

export interface VatLod {
  file: string;
  mesh: string;
  vertexCount: number;
  /** Texels per row. A vertex v of frame f is texel (v % width, f * rowsPerFrame + floor(v / width)). */
  width: number;
  rowsPerFrame: number;
  frames: number;
  position: VatSection;
  rotation: VatSection;
  morph: VatSection;
  bounds: { min: Vec3; max: Vec3 };
  triangles: number;
}

export interface VatClip {
  name: string;
  startFrame: number;
  frameCount: number;
  fps: number;
  loop: boolean;
  durationS: number;
  /** dive: where the body ends up, model space metres (move the instance there when it ends). */
  rootMotion?: Vec3;
  /** walk: ground speed that keeps the planted foot still. */
  speedMps?: number;
  /** sit: the seat height the clip sits on. */
  seatHeightM?: number;
}

export interface VatVariant {
  id: string;
  label: string;
  model: string;
  child: boolean;
  weights: Record<string, number>;
  heightScale: [number, number];
  outfits: string[];
  hair?: string[];
}

export interface HumanoidVatMeta {
  version: number;
  frame: string;
  slots: string[];
  morphs: string[];
  models: Record<string, { child: boolean; lods: Record<string, VatLod> }>;
  clips: Record<string, VatClip[]>;
  variants: VatVariant[];
  palette: {
    skinTones: string[];
    hair: Record<string, string>;
    outfits: Record<string, { top: string; bottom: string; shoes: string; outer: string; accent: string; sole: string }>;
    fixed: { eyes: string; badge: string };
    slotOrder: string[];
  };
  impostor: ImpostorMeta | null;
}

export interface ImpostorMeta {
  file: string;
  width: number;
  height: number;
  columns: number;
  rows: string[];
  cell: [number, number];
  /** Model-space size one cell covers: width (x) and height (y), metres; the quad's bottom is the ground. */
  cellSizeM: [number, number];
  channels: string;
}

/** Texel coordinates of a vertex in row `row` (a frame for positions/rotations, 2k+c for morphs). */
export function vatTexel(lod: Pick<VatLod, "width" | "rowsPerFrame">, vertex: number, row: number): [number, number] {
  return [vertex % lod.width, row * lod.rowsPerFrame + Math.floor(vertex / lod.width)];
}

/** IEEE 754 half -> number. */
export function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? Number.NaN : s * Number.POSITIVE_INFINITY;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

/** The frame pair and blend for a clip `timeS` seconds after it started (rate already applied). */
export function clipFrame(clip: VatClip, timeS: number): { f0: number; f1: number; t: number } {
  const n = clip.frameCount;
  const elapsed = Math.max(timeS, 0) * clip.fps;
  const f = clip.loop ? elapsed % n : Math.min(elapsed, n - 1);
  const i0 = Math.floor(f);
  const i1 = clip.loop ? (i0 + 1) % n : Math.min(i0 + 1, n - 1);
  return { f0: clip.startFrame + i0, f1: clip.startFrame + i1, t: f - i0 };
}

export class VatData {
  readonly lod: VatLod;
  private readonly view: DataView;

  constructor(lod: VatLod, bin: ArrayBuffer | Uint8Array) {
    this.lod = lod;
    const u8 = bin instanceof Uint8Array ? bin : new Uint8Array(bin);
    const need = lod.morph.byteOffset + lod.morph.byteLength;
    if (u8.byteLength !== need) throw new Error(`${lod.file}: ${u8.byteLength} bytes, expected ${need}`);
    this.view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  }

  private half4(section: VatSection, vertex: number, row: number): [number, number, number, number] {
    const [x, y] = vatTexel(this.lod, vertex, row);
    const o = section.byteOffset + (y * this.lod.width + x) * 8;
    const v = this.view;
    return [halfToFloat(v.getUint16(o, true)), halfToFloat(v.getUint16(o + 2, true)), halfToFloat(v.getUint16(o + 4, true)), halfToFloat(v.getUint16(o + 6, true))];
  }

  position(vertex: number, frame: number): Vec3 {
    const [x, y, z] = this.half4(this.lod.position, vertex, frame);
    return [x, y, z];
  }

  /** The vertex's blended bone rotation at a frame (unit quaternion, x y z w). */
  rotation(vertex: number, frame: number): Quat {
    const [x, y] = vatTexel(this.lod, vertex, frame);
    const o = this.lod.rotation.byteOffset + (y * this.lod.width + x) * 4;
    const q: Quat = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) q[i] = (this.view.getUint8(o + i) / 255) * 2 - 1;
    return normalize4(q);
  }

  /** Shape key k's position delta (c = 0) or normal delta (c = 1), rest pose, model space. */
  morph(key: number, vertex: number, c: 0 | 1): Vec3 {
    const [x, y, z] = this.half4(this.lod.morph, vertex, 2 * key + c);
    return [x, y, z];
  }

  /**
   * What the shader computes for one vertex: the baked position at the clip time, plus the
   * variant's rest-pose deltas turned by the vertex's bone rotation.
   */
  decode(clip: VatClip, timeS: number, weights: ArrayLike<number>, vertex: number): { position: Vec3; rotation: Quat } {
    const { f0, f1, t } = clipFrame(clip, timeS);
    return this.decodeFrames(f0, f1, t, weights, vertex);
  }

  decodeFrames(f0: number, f1: number, t: number, weights: ArrayLike<number>, vertex: number): { position: Vec3; rotation: Quat } {
    const p0 = this.position(vertex, f0);
    const p1 = this.position(vertex, f1);
    const q0 = this.rotation(vertex, f0);
    let q1 = this.rotation(vertex, f1);
    if (dot4(q0, q1) < 0) q1 = [-q1[0], -q1[1], -q1[2], -q1[3]];
    const q = normalize4([lerp(q0[0], q1[0], t), lerp(q0[1], q1[1], t), lerp(q0[2], q1[2], t), lerp(q0[3], q1[3], t)]);
    const d: Vec3 = [0, 0, 0];
    for (let k = 0; k < weights.length; k++) {
      const w = weights[k]!;
      if (!w) continue;
      const m = this.morph(k, vertex, 0);
      d[0] += w * m[0];
      d[1] += w * m[1];
      d[2] += w * m[2];
    }
    const r = quatRotate(q, d);
    return { position: [lerp(p0[0], p1[0], t) + r[0], lerp(p0[1], p1[1], t) + r[1], lerp(p0[2], p1[2], t) + r[2]], rotation: q };
  }
}

/** A variant's shape-key weights in `meta.morphs` order. */
export function variantWeights(meta: HumanoidVatMeta, variant: VatVariant | string): Float32Array {
  const v = typeof variant === "string" ? meta.variants.find((x) => x.id === variant) : variant;
  if (!v) throw new Error(`no variant ${String(variant)}`);
  return Float32Array.from(meta.morphs, (k) => v.weights[k] ?? 0);
}

export function quatRotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const t: Vec3 = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [v[0] + w * t[0] + (y * t[2] - z * t[1]), v[1] + w * t[1] + (z * t[0] - x * t[2]), v[2] + w * t[2] + (x * t[1] - y * t[0])];
}

function normalize4(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

function dot4(a: Quat, b: Quat): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ------------------------------------------------------------------------------- palettes

/** The palette rows: one per (outfit, hair, skin) combination, slots in `meta.slots` order. */
export interface PaletteTable {
  outfits: string[];
  hair: string[];
  skins: number;
  /** sRGB hex per row per slot. */
  rows: string[][];
  /** Row index for a look. */
  rowOf(outfit: string, hair: string, skin: number): number;
}

export function paletteTable(meta: HumanoidVatMeta): PaletteTable {
  const outfits = Object.keys(meta.palette.outfits);
  const hair = Object.keys(meta.palette.hair);
  const skins = meta.palette.skinTones.length;
  const rows: string[][] = [];
  for (const o of outfits) {
    const of = meta.palette.outfits[o]!;
    for (const h of hair) {
      for (let s = 0; s < skins; s++) {
        const bySlot: Record<string, string> = {
          skin: meta.palette.skinTones[s]!,
          hair: meta.palette.hair[h]!,
          top: of.top,
          bottom: of.bottom,
          shoes: of.shoes,
          outer: of.outer,
          accent: of.accent,
          sole: of.sole,
          eyes: meta.palette.fixed.eyes,
          badge: meta.palette.fixed.badge,
        };
        rows.push(meta.slots.map((slot) => bySlot[slot]!));
      }
    }
  }
  return {
    outfits,
    hair,
    skins,
    rows,
    rowOf(outfit, hairName, skin) {
      const oi = outfits.indexOf(outfit);
      const hi = hair.indexOf(hairName);
      if (oi < 0 || hi < 0 || skin < 0 || skin >= skins) throw new Error(`no palette row for ${outfit}/${hairName}/${skin}`);
      return (oi * hair.length + hi) * skins + skin;
    },
  };
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
