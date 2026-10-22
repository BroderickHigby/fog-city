// The house kit's geometry (house-kit-spec K5 to K8; world QA W-38, W-47, W-49, W-50): bay windows,
// stoops, cornices and parapet copings on the house fronts the tiles list (extras.fronts), rooftop
// water tanks, stair penthouses and mechanical boxes on the taller flat roofs, and a shopfront
// (awning, empty sign slot, icon) at every storefront anchor. Pure: it plans placements and merges
// them into one vertex-coloured mesh per tile (one draw call for the houses' kit, one for the
// shops'), from the Assets prototypes (public/models/house-kit/, layout maths in
// assets/blender/runtime/house-kit.ts) and the Content storefront kit (src/content/storefronts.ts).
// Cosmetic only: nothing here touches the sim or its colliders.

import { bayLayout, rooflineLayout, roofLayout, stoopLayout, type Instance, type KitDoc } from "../../assets/blender/runtime/house-kit.ts";
import type { StorefrontType } from "../content/storefronts.ts";
import { hashString, unit } from "./hash.ts";
import { BF_LANDMARK, BF_ROW, facadeFeatures, FRONT_BAY, FRONT_ROOFLINE, FRONT_SHOP, FRONT_STOOP, hexToLinear, type BuildingKit, type FrontRow } from "./house-kit.ts";

/** The prototypes' contract (public/models/house-kit/house-kit.json), as the layout maths reads it. */
export type { KitDoc };

/** A house-kit.json that names every prototype the kit uses, else null. */
export function parseKitDoc(doc: unknown): KitDoc | null {
  const d = doc as KitDoc | null;
  if (!d || typeof d !== "object" || !d.prototypes || !d.rules || typeof d.storeyM !== "number") return null;
  return KIT_PROTOS.every((k) => d.prototypes[k]) ? d : null;
}

/** One prototype node's triangles, in the prototype's frame. */
export interface ProtoNode {
  positions: Float32Array;
  normals: Float32Array;
  /** Colour slot per vertex (house-kit.json slots: 0 body, 1 trim, 2 glass, 3 roof, 4 stone, 5 dark). */
  slots: Uint8Array;
  indices: Uint32Array;
}

/** Prototype key ("bay-italianate", ...) -> node name ("storey", "cap", ...) -> triangles. */
export type ProtoLib = ReadonlyMap<string, ReadonlyMap<string, ProtoNode>>;

/** The prototype files the kit uses (house-kit.json prototypes, keyed as there). */
export const KIT_PROTOS = ["bay-italianate", "bay-queen-anne", "bay-edwardian", "stoop", "cornice-italianate", "cornice-edwardian", "parapet-coping", "roof-water-tank", "roof-mech-box", "roof-penthouse"] as const;

export interface Placement {
  proto: string;
  node: string;
  /** World matrix, column-major. */
  matrix: number[];
  /** Linear colours for slots 0 (body) and 1 (trim). */
  body: readonly [number, number, number];
  trim: readonly [number, number, number];
}

export interface KitStats {
  bays: number;
  stoops: number;
  rooflines: number;
  roofProps: number;
  /** Fronts rows with a bay flag whose footprint already draws the bay (skinned, not added). */
  skinnedBays: number;
  entryStoreys: number;
}

const mul = (a: readonly number[], b: readonly number[]): number[] => {
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r]! += a[k * 4 + r]! * b[c * 4 + k]!;
  return o;
};

/** The facade frame (house-kit.ts frames): origin at the facade's middle at street level, +x its right, -z out. */
export function facadeFrame(f: FrontRow): number[] {
  const h = (f.headingDeg * Math.PI) / 180;
  const c = Math.cos(h);
  const s = Math.sin(h);
  // Columns: local +x -> (cos h, 0, sin h); +y -> up; +z -> (-sin h, 0, cos h) (so -z faces the heading).
  return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, f.x, f.streetY, f.z, 1];
}

/** The bay prototype for a house's year (and a hash, where eras overlap). */
export function bayProto(year: number | null, h: number): string {
  if (year === null) return "bay-edwardian";
  if (year <= 1885) return "bay-italianate";
  if (year <= 1899) return h % 3 === 0 ? "bay-italianate" : "bay-queen-anne";
  if (year <= 1905) return h % 2 === 0 ? "bay-queen-anne" : "bay-edwardian";
  return "bay-edwardian";
}

/** The roofline moulding for a front (K8): cornices on the old rows, a parapet coping on the rest. */
export function rooflineProto(year: number | null): string {
  if (year !== null && year <= 1895) return "cornice-italianate";
  if (year !== null && year < 1930) return "cornice-edwardian";
  return "parapet-coping";
}

const GREY: readonly [number, number, number] = [0.45, 0.44, 0.42];

/**
 * Plan a tile's house-kit placements: per fronts row (with its building's kit values from
 * prepareFacades), bays, a stoop up to the door, a cornice or coping along the roofline; and roof
 * props on flat roofs of 4 storeys or more (`roofs`: each building's footprint and roof height).
 */
export function planHouseKit(
  KIT: KitDoc,
  fronts: readonly FrontRow[],
  frontWalls: readonly number[],
  buildings: readonly BuildingKit[],
  roofs: ReadonlyMap<string, { footprint: ReadonlyArray<readonly [number, number]>; topY: number; baseY: number }> = new Map(),
): { placements: Placement[]; stats: KitStats } {
  const out: Placement[] = [];
  const stats: KitStats = { bays: 0, stoops: 0, rooflines: 0, roofProps: 0, skinnedBays: 0, entryStoreys: 0 };
  const push = (frame: number[], list: readonly Instance[], b: BuildingKit, trim: readonly [number, number, number]): void => {
    for (const i of list) out.push({ proto: i.proto, node: i.node, matrix: mul(frame, i.matrix), body: b.wall, trim });
  };
  fronts.forEach((f, fi) => {
    const b = buildings[f.record];
    if (!b || b.flags & BF_LANDMARK) return;
    const seed = hashString(b.id);
    const trim = hexToLinear(b.trim);
    const frame = facadeFrame(f);
    const roofM = b.topM;
    let dropM = 0;
    // Roofline (K8): old rows get their cornice, every other row front a parapet coping.
    const roofline = f.flags & FRONT_ROOFLINE || b.flags & BF_ROW ? rooflineProto(b.year) : null;
    if (roofline && !(f.flags & FRONT_SHOP && b.glazing >= 0.3) && roofM > 2.5) {
      const p = KIT.prototypes[roofline]!;
      dropM = p.dropM as number;
      push(frame, rooflineLayout(KIT, roofline, f.lengthM, roofM), b, trim);
      stats.rooflines++;
    }
    // Bays (K6): none where the footprint already draws one (three or more front walls).
    if (f.flags & FRONT_BAY) {
      if ((frontWalls[fi] ?? 0) >= 3) stats.skinnedBays++;
      else {
        const bays = bayLayout(KIT, { proto: bayProto(b.year, seed), frontM: f.lengthM, storeys: f.storeys, storeyM: f.storeyM, roofM, floorM: f.floorM, rooflineDropM: dropM });
        if (bays.length > 0) stats.bays++;
        push(frame, bays, b, trim);
      }
    }
    // Stoop (K7): straight up to the front door; the door itself is the facade shader's.
    if (f.flags & FRONT_STOOP) {
      const feat = facadeFeatures(f, seed);
      if (feat.door !== null) {
        const plan = stoopLayout(KIT, { riseM: f.floorM, x: feat.door, rails: b.year !== null && b.year <= 1915 });
        if (plan.entryStorey) stats.entryStoreys++;
        else {
          stats.stoops++;
          push(frame, plan.instances.filter((i) => i.node !== "door"), b, trim);
        }
      }
    }
  });
  // Roof props on the flat roofs of 4 storeys and more.
  for (const b of buildings) {
    const r = roofs.get(b.id);
    if (!r || b.flags & BF_LANDMARK) continue;
    const storeys = Math.round((r.topY - r.baseY) / b.storeyM);
    if (storeys < 4) continue;
    const list = roofLayout({ footprint: r.footprint, roofM: r.topY, storeys, year: b.year ?? undefined, use: b.glazing >= 0.3 ? "commercial" : "residential", hash: unit(hashString(b.id)) });
    stats.roofProps += list.length;
    const ident = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    for (const i of list) out.push({ proto: i.proto, node: i.node, matrix: mul(ident, i.matrix), body: GREY, trim: GREY });
  }
  return { placements: out, stats };
}

/** Fixed slot colours (linear) for glass, roof, stone and the dark parts. */
const SLOT_FIXED: ReadonlyArray<readonly [number, number, number] | null> = [null, null, hexToLinear("#36434c"), hexToLinear("#5b5e60"), hexToLinear("#bcb6aa"), hexToLinear("#3a2f2a")];

export interface KitMesh {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  triangles: number;
}

/** Merge placements into one mesh (vertex colours by slot). Placements whose prototype is missing are skipped. */
export function mergePlacements(lib: ProtoLib, placements: readonly Placement[]): KitMesh {
  let nv = 0;
  let ni = 0;
  for (const p of placements) {
    const n = lib.get(p.proto)?.get(p.node);
    if (!n) continue;
    nv += n.positions.length / 3;
    ni += n.indices.length;
  }
  const positions = new Float32Array(nv * 3);
  const normals = new Float32Array(nv * 3);
  const colors = new Float32Array(nv * 3);
  const indices = new Uint32Array(ni);
  let v0 = 0;
  let i0 = 0;
  for (const p of placements) {
    const n = lib.get(p.proto)?.get(p.node);
    if (!n) continue;
    const m = p.matrix;
    // Normals: the inverse transpose of the upper 3x3 (shears and non-uniform scales).
    const a = m[0]!, b = m[4]!, c = m[8]!, d = m[1]!, e = m[5]!, f = m[9]!, g = m[2]!, h = m[6]!, k = m[10]!;
    const A = e * k - f * h, B = -(d * k - f * g), C = d * h - e * g;
    const D = -(b * k - c * h), E = a * k - c * g, F = -(a * h - b * g);
    const G = b * f - c * e, H = -(a * f - c * d), K = a * e - b * d;
    const count = n.positions.length / 3;
    for (let j = 0; j < count; j++) {
      const x = n.positions[3 * j]!, y = n.positions[3 * j + 1]!, z = n.positions[3 * j + 2]!;
      const o = 3 * (v0 + j);
      positions[o] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
      positions[o + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
      positions[o + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
      const nx = n.normals[3 * j]!, ny = n.normals[3 * j + 1]!, nz = n.normals[3 * j + 2]!;
      let tx = A * nx + B * ny + C * nz;
      let ty = D * nx + E * ny + F * nz;
      let tz = G * nx + H * ny + K * nz;
      const l = Math.hypot(tx, ty, tz) || 1;
      tx /= l;
      ty /= l;
      tz /= l;
      normals[o] = tx;
      normals[o + 1] = ty;
      normals[o + 2] = tz;
      const slot = n.slots[j]!;
      const col = slot === 0 ? p.body : slot === 1 ? p.trim : (SLOT_FIXED[slot] ?? p.trim);
      colors[o] = col[0];
      colors[o + 1] = col[1];
      colors[o + 2] = col[2];
    }
    for (let j = 0; j < n.indices.length; j++) indices[i0 + j] = n.indices[j]! + v0;
    v0 += count;
    i0 += n.indices.length;
  }
  return { positions, normals, colors, indices, triangles: ni / 3 };
}

// ------------------------------------------------------------------------- shopfronts

export interface StorefrontAnchor {
  id: string;
  x: number;
  y: number;
  z: number;
  /** Compass bearing the shop faces, radians. */
  heading: number;
  naics: string;
  category?: string;
  buildingId: string;
}

/** Shopfront plan for an anchor (src/content/storefronts.ts shopfrontFor), as the renderer reads it. */
export interface ShopPlan {
  kit: StorefrontType;
  awningColour: string | null;
  frameColour: string;
}

class MeshAcc {
  p: number[] = [];
  n: number[] = [];
  c: number[] = [];
  i: number[] = [];
  /** A quad a-b-c-d (counter-clockwise seen from its front), flat-shaded. */
  quad(a: readonly number[], b: readonly number[], c: readonly number[], d: readonly number[], col: readonly number[]): void {
    const ux = b[0]! - a[0]!, uy = b[1]! - a[1]!, uz = b[2]! - a[2]!;
    const vx = d[0]! - a[0]!, vy = d[1]! - a[1]!, vz = d[2]! - a[2]!;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const base = this.p.length / 3;
    for (const q of [a, b, c, d]) {
      this.p.push(q[0]!, q[1]!, q[2]!);
      this.n.push(nx, ny, nz);
      this.c.push(col[0]!, col[1]!, col[2]!);
    }
    this.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  /** An axis-aligned box in a local frame (x right, y up, z out of the wall), through `to` (local -> world). */
  box(to: (x: number, y: number, z: number) => number[], x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, col: readonly number[]): void {
    const P = (x: number, y: number, z: number): number[] => to(x, y, z);
    this.quad(P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1), col); // front (out)
    this.quad(P(x1, y0, z0), P(x0, y0, z0), P(x0, y1, z0), P(x1, y1, z0), col); // back
    this.quad(P(x0, y1, z1), P(x1, y1, z1), P(x1, y1, z0), P(x0, y1, z0), col); // top
    this.quad(P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1), col); // bottom
    this.quad(P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1), P(x0, y1, z0), col); // left
    this.quad(P(x1, y0, z1), P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), col); // right
  }
  mesh(): KitMesh {
    return { positions: new Float32Array(this.p), normals: new Float32Array(this.n), colors: new Float32Array(this.c), indices: new Uint32Array(this.i), triangles: this.i.length / 3 };
  }
}

/** Icon colours for the sign shapes (iconography only: no words, names or logos). */
const ICON: Record<string, string> = {
  neonPanel: "#ff5a3c",
  cupBlade: "#f2e6d0",
  breadBlade: "#e0b26a",
  barberPole: "#c8302c",
  scissorsBlade: "#c9ced3",
  projectingCross: "#3cb371",
  hangerBlade: "#d8d2c4",
  takeoutBoxBlade: "#e8e2d4",
  bottleBlade: "#4f8a5b",
  polishBlade: "#e86a92",
  shirtBlade: "#6a8fd8",
  keyBlade: "#d4b04c",
  plugBlade: "#e8c440",
  lampBlade: "#f0d68a",
  bookBlade: "#9a5a3a",
  wheelBlade: "#2a2a2a",
};

/**
 * One tile's shopfronts (K5): per anchor, an awning in its kit's shape and colour, the sign slot
 * left blank (a framed panel on the fascia, or a blade standing out from the wall), and the kit's
 * icon shape (a barber pole, a neon panel, a coloured disc on the blade). The glazing itself is
 * the facade shader's (house-kit.ts WF_SHOP). Anchors stand 0.3 m out from their wall.
 */
export function buildShopfronts(anchors: ReadonlyArray<{ anchor: StorefrontAnchor; plan: ShopPlan }>): { mesh: KitMesh; count: number } {
  const acc = new MeshAcc();
  let count = 0;
  for (const { anchor: a, plan } of anchors) {
    const k = plan.kit;
    const h = a.heading;
    const rx = -Math.cos(h), rz = -Math.sin(h); // the shop's left, seen from inside (a right-handed frame with z out)
    const ox = Math.sin(h), oz = -Math.cos(h); // out of the wall
    // Local frame: x along the wall, y up from the sidewalk, z out of the wall from the wall's face.
    const wx = a.x - ox * 0.3, wz = a.z - oz * 0.3;
    const to = (x: number, y: number, z: number): number[] => [wx + rx * x + ox * z, a.y + y, wz + rz * x + oz * z];
    const W = k.shopfront.bayWidthM;
    const H = k.shopfront.heightM;
    const frame = hexToLinear(plan.frameColour);
    count++;
    // Awning.
    const aw = k.awning;
    if (aw.shape !== "none" && aw.depthM > 0 && plan.awningColour) {
      const col = hexToLinear(plan.awningColour);
      const stripe = aw.stripe ? hexToLinear(aw.stripe) : null;
      const top = H - 0.62;
      const d = Math.min(aw.depthM, 2.5);
      if (aw.shape === "flatCanopy" || aw.shape === "canopy" || aw.shape === "box") {
        acc.box(to, -W / 2, W / 2, top - (aw.shape === "box" ? 0.55 : 0.18), top, 0, d, col);
      } else {
        const drop = aw.shape === "quarterRound" ? 0.9 : 0.7;
        const strips = stripe ? 10 : 1;
        for (let s = 0; s < strips; s++) {
          const x0 = -W / 2 + (s * W) / strips, x1 = -W / 2 + ((s + 1) * W) / strips;
          const c = stripe && s % 2 === 1 ? stripe : col;
          if (aw.shape === "quarterRound") {
            // A quarter round in four facets.
            for (let q = 0; q < 4; q++) {
              const t0 = (q / 4) * (Math.PI / 2), t1 = ((q + 1) / 4) * (Math.PI / 2);
              const p0 = [Math.sin(t0) * d, top - drop + Math.cos(t0) * drop] as const;
              const p1 = [Math.sin(t1) * d, top - drop + Math.cos(t1) * drop] as const;
              acc.quad(to(x0, p0[1], p0[0]), to(x0, p1[1], p1[0]), to(x1, p1[1], p1[0]), to(x1, p0[1], p0[0]), c);
            }
          } else {
            acc.quad(to(x0, top - drop, d), to(x1, top - drop, d), to(x1, top, 0), to(x0, top, 0), c);
          }
          // Valance: straight, or scalloped (every other strip shorter).
          const vd = aw.shape === "scalloped" && s % 2 === 1 ? 0.16 : 0.26;
          if (aw.shape !== "quarterRound") acc.quad(to(x0, top - drop - vd, d), to(x1, top - drop - vd, d), to(x1, top - drop, d), to(x0, top - drop, d), c);
        }
      }
    }
    // Sign slot: blank, framed. Fascia signs sit flat on the wall; blades stand out from it.
    const slot = k.signSlot;
    const blank = [frame[0] * 0.4 + 0.45, frame[1] * 0.4 + 0.44, frame[2] * 0.4 + 0.41];
    const icon = hexToLinear(ICON[k.signShape] ?? "#d8d2c4");
    if (slot.mount === "blade") {
      const bx = W / 2 - 0.4;
      acc.box(to, bx - 0.03, bx + 0.03, 3.0, 3.06, 0, 0.9, frame); // bracket
      acc.box(to, bx - 0.04, bx + 0.04, 3.0 - slot.heightM, 3.0, 0.15, 0.15 + Math.min(slot.widthM, 0.9), blank);
      // The icon: a disc-like plate on both faces of the blade.
      const cz = 0.15 + Math.min(slot.widthM, 0.9) / 2;
      const cy = 3.0 - slot.heightM / 2;
      acc.box(to, bx - 0.06, bx + 0.06, cy - 0.16, cy + 0.16, cz - 0.16, cz + 0.16, icon);
    } else if (slot.mount === "pole") {
      // A barber pole: a striped column beside the door.
      const px = W / 2 - 0.3;
      const bands = 8;
      for (let s = 0; s < bands; s++) {
        const c = s % 3 === 0 ? icon : s % 3 === 1 ? [0.9, 0.9, 0.88] : [0.15, 0.25, 0.6];
        acc.box(to, px - 0.08, px + 0.08, 1.9 + (s * 0.9) / bands, 1.9 + ((s + 1) * 0.9) / bands, 0.1, 0.26, c);
      }
    } else if (slot.mount !== "window") {
      const sw = Math.min(slot.widthM, W - 0.4);
      const sh = Math.min(slot.heightM, 0.7);
      const y0 = H - 0.08 - sh;
      acc.box(to, -sw / 2 - 0.05, sw / 2 + 0.05, y0 - 0.05, y0 + sh + 0.05, 0, 0.05, frame);
      acc.box(to, -sw / 2, sw / 2, y0, y0 + sh, 0.05, 0.08, blank);
    }
    if (k.signShape === "neonPanel") {
      // A neon outline in the window (a shape, never words).
      const x0 = -W / 2 + 0.6, y0 = 1.5;
      acc.box(to, x0, x0 + 0.9, y0, y0 + 0.05, 0.02, 0.05, icon);
      acc.box(to, x0, x0 + 0.9, y0 + 0.55, y0 + 0.6, 0.02, 0.05, icon);
      acc.box(to, x0, x0 + 0.05, y0, y0 + 0.6, 0.02, 0.05, icon);
      acc.box(to, x0 + 0.85, x0 + 0.9, y0, y0 + 0.6, 0.02, 0.05, icon);
    }
  }
  return { mesh: acc.mesh(), count };
}
