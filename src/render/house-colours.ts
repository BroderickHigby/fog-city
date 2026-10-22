// House colours at runtime (house kit K3, world QA W-37): the body, trim and door colours of every
// house, picked from Content's era and district palettes (content/house-palettes.json through
// src/content/housePalettes.ts) and the Painted Ladies' hand colours.
//
// The tiles still carry the pipeline's one pastel class, so the renderer picks the colours itself
// when a tile loads. It has every footprint (the collider pack) but a house's year only from its
// own tile's glb, so touching houses are kept apart by a colour SLOT that needs footprints alone:
//   * houses are grouped into rows: records whose footprints come within maxGapM (0.6 m) of each
//     other, chained (a terraced house's strips and a tower travel with their parent id);
//   * each row is coloured greedily in id order: a house takes the smallest slot no touching
//     house already holds;
//   * a house's body is entry (start + slot) of its palette's bodies, start hashed from the row.
// Touching houses on the same palette therefore never share a body (their slots differ and slot
// counts stay below every palette's size), and houses on different palettes never do either,
// because no body appears in two palettes (checked in tests/render/house-colours.test.ts). The
// result depends only on the footprints, the house's own year and district and the ids: never on
// which tile loaded first.

import type { TileCollider } from "../sim/world.ts";
import { HOUSE_PALETTES, houseOverrideFor, paletteRuleFor, type HousePalettesFile, type Hex } from "../content/housePalettes.ts";
import { landmarkMaterialFor } from "../content/landmarkTags.ts";
import { hashString } from "./hash.ts";
import { BF_LANDMARK, BF_PALETTE, BF_RED_TILE, defaultLook, MAT_STONE, MAT_STUCCO, type LookFn } from "./house-kit.ts";

export interface DistrictsLike {
  districts: ReadonlyArray<{ id: string; polygons: ReadonlyArray<ReadonlyArray<ReadonlyArray<readonly [number, number] | readonly number[]>>> }>;
}

export interface HouseLook {
  body: Hex;
  trim: Hex;
  /** Door colour. */
  accent: Hex;
  /** Marina red tile at the roof edge, else null. */
  roofEdge: Hex | null;
  /** Content's extra glazing for modern palettes. */
  glazingDelta: number;
  palette: string;
  /** The row slot (0 for a house touching nothing). */
  slot: number;
  override: string | null;
}

/**
 * The id a record's colours are keyed by: a tower (`-tower`), a terrace strip (`-s<n>`) or a span
 * piece (`-b<n>`) wears its parent's colours (Content's colourKey, read from the id because the
 * collider pack carries no meta).
 */
export function parentKey(id: string): string {
  return id.replace(/(?:-tower|-s\d+|-b\d+)+$/, "");
}

type Ring = ReadonlyArray<readonly [number, number]>;

function segDist2(ax: number, az: number, bx: number, bz: number, px: number, pz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx - px;
  const qz = az + t * dz - pz;
  return qx * qx + qz * qz;
}

function inRing(x: number, z: number, ring: Ring): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i]!;
    const [xj, zj] = ring[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}

/** Do two rings come within d of each other (vertex-to-edge distances, or one inside the other)? */
export function ringsWithin(a: Ring, b: Ring, d: number): boolean {
  const d2 = d * d;
  for (let i = 0; i < a.length; i++) {
    const [ax, az] = a[i]!;
    const [bx, bz] = a[(i + 1) % a.length]!;
    for (let j = 0; j < b.length; j++) {
      const [cx, cz] = b[j]!;
      const [dx, dz] = b[(j + 1) % b.length]!;
      if (segDist2(ax, az, bx, bz, cx, cz) <= d2 || segDist2(cx, cz, dx, dz, ax, az) <= d2) return true;
    }
  }
  return a.length > 0 && b.length > 0 && (inRing(a[0]![0], a[0]![1], b) || inRing(b[0]![0], b[0]![1], a));
}

interface Lot {
  key: string;
  rings: Ring[];
  box: [number, number, number, number];
  cx: number;
  cz: number;
}

const CELL = 25;

/**
 * Body, trim and door colours for every house of a world, computed lazily per row of touching
 * houses. Construct once per world with every tile's colliders (the pack).
 */
export class HouseColours {
  private readonly lots = new Map<string, Lot>();
  private readonly grid = new Map<number, Lot[]>();
  private readonly slots = new Map<string, { slot: number; row: string }>();
  private readonly districts: Array<{ id: string; box: [number, number, number, number]; rings: Ring[] }>;
  private readonly file: HousePalettesFile;
  private readonly gap: number;

  constructor(colliders: Iterable<TileCollider>, districts?: DistrictsLike | null, file: HousePalettesFile = HOUSE_PALETTES) {
    this.file = file;
    this.gap = file.maxGapM;
    for (const t of colliders) {
      for (const b of t.buildings) {
        const key = parentKey(b.id);
        let lot = this.lots.get(key);
        if (!lot) {
          lot = { key, rings: [], box: [Infinity, Infinity, -Infinity, -Infinity], cx: 0, cz: 0 };
          this.lots.set(key, lot);
        }
        lot.rings.push(b.footprint);
        for (const [x, z] of b.footprint) {
          lot.box[0] = Math.min(lot.box[0], x);
          lot.box[1] = Math.min(lot.box[1], z);
          lot.box[2] = Math.max(lot.box[2], x);
          lot.box[3] = Math.max(lot.box[3], z);
        }
      }
    }
    for (const lot of this.lots.values()) {
      lot.cx = (lot.box[0] + lot.box[2]) / 2;
      lot.cz = (lot.box[1] + lot.box[3]) / 2;
      const g = this.gap;
      for (let cx = Math.floor((lot.box[0] - g) / CELL); cx <= Math.floor((lot.box[2] + g) / CELL); cx++) {
        for (let cz = Math.floor((lot.box[1] - g) / CELL); cz <= Math.floor((lot.box[3] + g) / CELL); cz++) {
          const k = (cx + 32768) * 65536 + cz + 32768;
          const l = this.grid.get(k);
          if (l) l.push(lot);
          else this.grid.set(k, [lot]);
        }
      }
    }
    this.districts = (districts?.districts ?? []).map((d) => {
      const rings: Ring[] = [];
      const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const poly of d.polygons) {
        const outer = poly[0];
        if (!outer) continue;
        const ring = outer.map((p) => [p[0]!, p[1]!] as const);
        rings.push(ring);
        for (const [x, z] of ring) {
          box[0] = Math.min(box[0], x);
          box[1] = Math.min(box[1], z);
          box[2] = Math.max(box[2], x);
          box[3] = Math.max(box[3], z);
        }
      }
      return { id: d.id, box, rings };
    });
  }

  /** The DataSF Analysis Neighborhood holding a point, or null. */
  districtAt(x: number, z: number): string | null {
    for (const d of this.districts) {
      if (x < d.box[0] || x > d.box[2] || z < d.box[1] || z > d.box[3]) continue;
      if (d.rings.some((r) => inRing(x, z, r))) return d.id;
    }
    return null;
  }

  /** The houses touching a house (within maxGapM), sorted by key. */
  neighbours(key: string): string[] {
    const lot = this.lots.get(key);
    if (!lot) return [];
    const g = this.gap;
    const out = new Set<string>();
    for (let cx = Math.floor((lot.box[0] - g) / CELL); cx <= Math.floor((lot.box[2] + g) / CELL); cx++) {
      for (let cz = Math.floor((lot.box[1] - g) / CELL); cz <= Math.floor((lot.box[3] + g) / CELL); cz++) {
        for (const o of this.grid.get((cx + 32768) * 65536 + cz + 32768) ?? []) {
          if (o === lot || out.has(o.key)) continue;
          if (o.box[0] > lot.box[2] + g || lot.box[0] > o.box[2] + g || o.box[1] > lot.box[3] + g || lot.box[1] > o.box[3] + g) continue;
          if (lot.rings.some((a) => o.rings.some((b) => ringsWithin(a, b, g)))) out.add(o.key);
        }
      }
    }
    return [...out].sort();
  }

  /** Colour one row (every house chained to `key` by touching): slots in id order. */
  private colourRow(key: string): void {
    const row: string[] = [];
    const adj = new Map<string, string[]>();
    const seen = new Set<string>([key]);
    const queue = [key];
    while (queue.length > 0) {
      const k = queue.pop()!;
      row.push(k);
      const n = this.neighbours(k);
      adj.set(k, n);
      for (const m of n) {
        if (seen.has(m)) continue;
        seen.add(m);
        queue.push(m);
      }
    }
    row.sort();
    const rowId = row[0]!;
    for (const k of row) {
      const taken = new Set<number>();
      for (const m of adj.get(k) ?? []) {
        const s = this.slots.get(m);
        if (s) taken.add(s.slot);
      }
      let slot = 0;
      while (taken.has(slot)) slot++;
      this.slots.set(k, { slot, row: rowId });
    }
  }

  /** The row slot of a house (by any record id). */
  slotOf(id: string): { slot: number; row: string } {
    const key = parentKey(id);
    if (!this.lots.has(key)) return { slot: 0, row: key };
    if (!this.slots.has(key)) this.colourRow(key);
    return this.slots.get(key)!;
  }

  /** A house's colours, from its year (null when unknown) and its own place. */
  lookFor(id: string, year: number | null): HouseLook {
    const key = parentKey(id);
    const o = houseOverrideFor(key, this.file);
    const { slot, row } = this.slotOf(key);
    if (o) {
      return { body: o.record.body, trim: o.record.trim, accent: o.record.accent, roofEdge: null, glazingDelta: 0, palette: "override", slot, override: o.override.id };
    }
    const lot = this.lots.get(key);
    const district = lot ? this.districtAt(lot.cx, lot.cz) : null;
    const rule = paletteRuleFor(year, district, this.file);
    const pal = this.file.palettes[rule.palette]!;
    const bodies = pal.schemes.flatMap((s) => s.bodies.map((body) => ({ body, scheme: s })));
    const n = bodies.length;
    const pick = bodies[(hashString(`${row}#row`) + slot) % n]!;
    // More touching houses than bodies (never in the shipped palettes): a darker shade instead.
    const body = slot < n ? pick.body : shade(pick.body, 0.9 - 0.05 * Math.floor(slot / n));
    const trim = pick.scheme.trims[hashString(`${key}#trim`) % pick.scheme.trims.length]!;
    const roofEdge = pal.roofEdges && pal.roofEdges.length > 0 ? pal.roofEdges[hashString(`${key}#roof`) % pal.roofEdges.length]! : null;
    return { body, trim, accent: doorColour(key, trim, body), roofEdge, glazingDelta: pal.glazingDelta, palette: rule.palette, slot, override: null };
  }
}

function channels(hex: Hex): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function toHex(c: readonly number[]): Hex {
  return `#${c.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("")}`;
}

function shade(hex: Hex, k: number): Hex {
  return toHex(channels(hex).map((c) => c * k));
}

/** Door colours: deep painted-wood tones that read against light and dark bodies alike. */
const DOORS: Hex[] = ["#5a2a22", "#23343f", "#2f4a33", "#6b4a2a", "#3b2c3f", "#7a6a55", "#1f2a2e", "#8a3b2a"];

function doorColour(key: string, trim: Hex, body: Hex): Hex {
  void trim;
  void body;
  return DOORS[hashString(`${key}#door`) % DOORS.length]!;
}

/** A landmark record's material colours (content/landmark-tags.json), or null. */
export function landmarkLook(id: string): { wall: Hex; trim: Hex; roof: Hex } | null {
  const m = landmarkMaterialFor({ id, meta: { pieceOf: parentKey(id) === id ? undefined : parentKey(id) } });
  return m ? { wall: m.wall, trim: m.trim, roof: m.roof } : null;
}

/**
 * The house kit's look per building (house-kit.ts LookFn): landmarks in their material with no
 * windows (K10, W-27 render half), houses (the pipeline's 0.25 glazing class) in their palette
 * colours (K3), everything else in the tile's colour with a material by era and use.
 */
export function houseLookFn(colours: HouseColours | null): LookFn {
  return (b) => {
    const base = defaultLook(b);
    const lm = landmarkLook(b.id);
    if (lm) return { body: lm.wall, trim: lm.trim, door: "#2a2622", material: MAT_STONE, flags: base.flags | BF_LANDMARK };
    if (!colours || b.glazing < 0.2 || b.glazing >= 0.3) return base;
    const look = colours.lookFor(b.id, b.year);
    let material = base.material;
    // The Marina's and the avenues' interwar houses are stucco.
    if ((look.palette === "marinaStucco" || look.palette === "avenues") && material !== MAT_STUCCO && hashString(`${b.id}#mat`) % 10 < 8) material = MAT_STUCCO;
    return {
      body: look.body,
      trim: look.trim,
      door: look.accent,
      material,
      flags: base.flags | BF_PALETTE | (look.roofEdge ? BF_RED_TILE : 0),
    };
  };
}
