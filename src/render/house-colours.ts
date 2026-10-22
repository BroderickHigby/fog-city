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
/** The tile grid of the tile ids (t<x>_<z>, 500 m). */
const TILE_M = 500;

/**
 * Body, trim and door colours for every house of a world, computed lazily per row of touching
 * houses. Construct once per world with every tile's colliders (the pack).
 */
export class HouseColours {
  private readonly lots = new Map<string, Lot>();
  private readonly tiles = new Map<string, TileCollider>();
  private readonly indexed = new Set<string>();
  private readonly tileOf = new Map<string, string>();
  private readonly grid = new Map<number, Lot[]>();
  private readonly slots = new Map<string, { slot: number; row: string }>();
  private readonly districts: Array<{ id: string; box: [number, number, number, number]; rings: Ring[] }>;
  private readonly file: HousePalettesFile;
  private readonly gap: number;

  constructor(colliders: Iterable<TileCollider>, districts?: DistrictsLike | null, file: HousePalettesFile = HOUSE_PALETTES) {
    this.file = file;
    this.gap = file.maxGapM;
    // Lots are indexed a tile at a time, when a house near it is first coloured: the whole city
    // eagerly cost about a second and 120 MB at boot. Only which tile holds each house is kept.
    for (const t of colliders) {
      const m = /^t(-?\d+)_(-?\d+)$/.exec(t.tileId);
      const key = m ? `${m[1]},${m[2]}` : `id:${t.tileId}`;
      this.tiles.set(key, t);
      for (const b of t.buildings) {
        const k = parentKey(b.id);
        if (!this.tileOf.has(k)) this.tileOf.set(k, key);
      }
      // A tile named off the 500 m grid (a hand-made world) is indexed at once.
      if (!m) this.indexTile(key);
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

  /** Add one tile's records to the lots and the grid (each ring under the cells its box covers). */
  private indexTile(key: string): void {
    if (this.indexed.has(key)) return;
    this.indexed.add(key);
    const t = this.tiles.get(key);
    if (!t) return;
    const g = this.gap;
    for (const b of t.buildings) {
      const k = parentKey(b.id);
      let lot = this.lots.get(k);
      if (!lot) {
        lot = { key: k, rings: [], box: [Infinity, Infinity, -Infinity, -Infinity], cx: 0, cz: 0 };
        this.lots.set(k, lot);
      }
      lot.rings.push(b.footprint);
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const [x, z] of b.footprint) {
        x0 = Math.min(x0, x);
        z0 = Math.min(z0, z);
        x1 = Math.max(x1, x);
        z1 = Math.max(z1, z);
      }
      lot.box = [Math.min(lot.box[0], x0), Math.min(lot.box[1], z0), Math.max(lot.box[2], x1), Math.max(lot.box[3], z1)];
      lot.cx = (lot.box[0] + lot.box[2]) / 2;
      lot.cz = (lot.box[1] + lot.box[3]) / 2;
      for (let cx = Math.floor((x0 - g) / CELL); cx <= Math.floor((x1 + g) / CELL); cx++) {
        for (let cz = Math.floor((z0 - g) / CELL); cz <= Math.floor((z1 + g) / CELL); cz++) {
          const ck = (cx + 32768) * 65536 + cz + 32768;
          const l = this.grid.get(ck);
          if (!l) this.grid.set(ck, [lot]);
          else if (!l.includes(lot)) l.push(lot);
        }
      }
    }
  }

  /** Index every grid tile a box (plus a margin) touches. */
  private ensureBox(x0: number, z0: number, x1: number, z1: number): void {
    const m = 2;
    for (let tx = Math.floor((x0 - m) / TILE_M); tx <= Math.floor((x1 + m) / TILE_M); tx++) {
      for (let tz = Math.floor((z0 - m) / TILE_M); tz <= Math.floor((z1 + m) / TILE_M); tz++) this.indexTile(`${tx},${tz}`);
    }
  }

  /** A house's lot with every record of it and of its touching neighbours indexed. */
  private lotReady(key: string): Lot | undefined {
    const t = this.tileOf.get(key);
    if (t === undefined) return undefined;
    this.indexTile(t);
    let lot = this.lots.get(key);
    for (let i = 0; lot && i < 4; i++) {
      const before = lot.box.join(",");
      this.ensureBox(lot.box[0], lot.box[1], lot.box[2], lot.box[3]);
      lot = this.lots.get(key);
      if (lot && lot.box.join(",") === before) break;
    }
    return lot;
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
    const lot = this.lotReady(key);
    if (!lot) return [];
    const g = this.gap;
    const out = new Set<string>();
    for (let cx = Math.floor((lot.box[0] - g) / CELL); cx <= Math.floor((lot.box[2] + g) / CELL); cx++) {
      for (let cz = Math.floor((lot.box[1] - g) / CELL); cz <= Math.floor((lot.box[3] + g) / CELL); cz++) {
        for (const o of this.grid.get((cx + 32768) * 65536 + cz + 32768) ?? []) {
          if (o === lot || out.has(o.key)) continue;
          if (o.box[0] > lot.box[2] + g || lot.box[0] > o.box[2] + g || o.box[1] > lot.box[3] + g || lot.box[1] > o.box[3] + g) continue;
          if (lot.rings.some((a) => o.rings.some((b) => ringsWithin(a, b, g)))) {
            // The neighbour's own records may run on into a tile not indexed yet.
            this.lotReady(o.key);
            out.add(o.key);
          }
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
    if (!this.lotReady(key)) return { slot: 0, row: key };
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
    const lot = this.lotReady(key);
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
