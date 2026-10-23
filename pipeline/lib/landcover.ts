// Ground cover (world QA W-11, W-18, W-34): a class for every 10 m lattice sample, the inland
// lakes (water at their own level), and the trees of the foliage nodes.
//
// Classes, one character per lattice sample (the tile collider's ground.cover, row-major like
// heights):
//   u  urban or bare ground (the default)
//   g  grass: park land (Rec and Park properties, the National Park Service units)
//   f  forest: tree canopy over park land, or a wood (canopy over most of the window around it)
//   s  sand: a beach (land near the open water, low enough, inside a named beach box)
//   w  the Bay or the ocean (the heightfield's water flag: sea level)
//   0-9 an inland lake: the index into the tile's ground.lakes, whose y is its level. The sample's
//      height is the lake's level (the lattice is flattened across every lake).
// Everything is a pure function of the inputs and the sample's position, so neighbouring tiles
// agree on their shared border samples.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toLocal } from "../../src/geo/project.ts";
import type { TileRef } from "./config.ts";
import { hash32, pointInRing, r2, type P2 } from "./geom.ts";
import type { RawCanopy, RawFeature, RawLandcover, RawPark } from "./sources.ts";
import { GROUND_CELL_M, type Heightfield } from "./terrain.ts";

export interface LandcoverConfig {
  lakes: { minSamples: number; bankM: number; include: Array<{ nhd: string; name: string }>; grow: { toleranceM: number; reachM: number } };
  parks: { recParkTypes: string[]; lawnPlazas: string[] };
  forest: { cellM: number; minCover: number; minDensity: number; windowM: number };
  beaches: { list: Array<{ name: string; north: number; south: number; west: number; east: number; shoreM: number; maxY: number }> };
  foliage: { minCover: number; roadClearM: number; height: [number, number]; forestHeight: [number, number] };
}

export function loadLandcoverConfig(root: string): LandcoverConfig {
  return JSON.parse(readFileSync(join(root, "pipeline/landcover.json"), "utf8")) as LandcoverConfig;
}

export type CoverClass = "u" | "g" | "f" | "s" | "w";

/** A polygon in local metres: outer ring then holes, with its bounding box. */
export interface LocalPoly {
  rings: P2[][];
  box: [number, number, number, number];
}

/** The polygons of a GeoJSON Polygon / MultiPolygon in lon/lat, in local metres. */
export function geoPolys(geom: { type: string; coordinates: unknown } | null | undefined): LocalPoly[] {
  if (!geom) return [];
  const polys: Array<Array<Array<[number, number]>>> =
    geom.type === "Polygon" ? [geom.coordinates as Array<Array<[number, number]>>] : geom.type === "MultiPolygon" ? (geom.coordinates as Array<Array<Array<[number, number]>>>) : [];
  const out: LocalPoly[] = [];
  for (const poly of polys) {
    const rings = poly
      .map((r) =>
        r.map(([lon, lat]) => {
          const p = toLocal(lat, lon);
          return [p.x, p.z] as P2;
        }),
      )
      .filter((r) => r.length >= 3);
    if (rings.length === 0) continue;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [x, z] of rings[0]!) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    out.push({ rings, box: [x0, z0, x1, z1] });
  }
  return out;
}

export function inPoly(x: number, z: number, p: LocalPoly): boolean {
  const b = p.box;
  if (x < b[0] || x > b[2] || z < b[1] || z > b[3]) return false;
  if (!pointInRing(x, z, p.rings[0]!)) return false;
  for (let i = 1; i < p.rings.length; i++) if (pointInRing(x, z, p.rings[i]!)) return false;
  return true;
}

/** Polygons bucketed by a coarse grid, for point queries. */
class PolyIndex {
  private cells = new Map<number, number[]>();
  readonly polys: readonly LocalPoly[];
  private readonly cell: number;
  constructor(polys: readonly LocalPoly[], cell = 250) {
    this.polys = polys;
    this.cell = cell;
    polys.forEach((p, i) => {
      for (let cx = Math.floor(p.box[0] / cell); cx <= Math.floor(p.box[2] / cell); cx++) {
        for (let cz = Math.floor(p.box[1] / cell); cz <= Math.floor(p.box[3] / cell); cz++) {
          const k = (cx + 4096) * 8192 + cz + 4096;
          (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push(i);
        }
      }
    });
  }
  /** Index of the first polygon containing the point, or -1. */
  find(x: number, z: number): number {
    const l = this.cells.get((Math.floor(x / this.cell) + 4096) * 8192 + Math.floor(z / this.cell) + 4096);
    if (!l) return -1;
    for (const i of l) if (inPoly(x, z, this.polys[i]!)) return i;
    return -1;
  }
}

/** A raster of tree canopy over a rectangle: 1 where a canopy polygon covers the cell's centre. */
export class CanopyRaster {
  readonly x0: number;
  readonly z0: number;
  readonly nx: number;
  readonly nz: number;
  readonly data: Uint8Array;
  readonly cell: number;
  constructor(polys: readonly LocalPoly[], bounds: readonly [number, number, number, number], cell: number) {
    this.cell = cell;
    this.x0 = Math.floor(bounds[0] / cell) * cell;
    this.z0 = Math.floor(bounds[1] / cell) * cell;
    this.nx = Math.ceil((bounds[2] - this.x0) / cell);
    this.nz = Math.ceil((bounds[3] - this.z0) / cell);
    this.data = new Uint8Array(this.nx * this.nz);
    const xs: number[] = [];
    for (const p of polys) {
      const k0 = Math.max(0, Math.floor((p.box[1] - this.z0) / cell));
      const k1 = Math.min(this.nz - 1, Math.ceil((p.box[3] - this.z0) / cell));
      for (let k = k0; k <= k1; k++) {
        const z = this.z0 + (k + 0.5) * cell;
        // Even-odd scanline over every ring (holes included).
        xs.length = 0;
        for (const r of p.rings) {
          for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
            const [xi, zi] = r[i]!;
            const [xj, zj] = r[j]!;
            if (zi > z !== zj > z) xs.push(xi + ((z - zi) * (xj - xi)) / (zj - zi));
          }
        }
        xs.sort((a, b) => a - b);
        for (let q = 0; q + 1 < xs.length; q += 2) {
          const i0 = Math.max(0, Math.ceil((xs[q]! - this.x0) / cell - 0.5));
          const i1 = Math.min(this.nx - 1, Math.floor((xs[q + 1]! - this.x0) / cell - 0.5));
          for (let i = i0; i <= i1; i++) this.data[k * this.nx + i] = 1;
        }
      }
    }
  }
  /** Share of the raster cells inside the square [x - h, x + h] x [z - h, z + h] that are canopy. */
  cover(x: number, z: number, h: number): number {
    const c = this.cell;
    const i0 = Math.max(0, Math.round((x - h - this.x0) / c));
    const i1 = Math.min(this.nx, Math.round((x + h - this.x0) / c));
    const k0 = Math.max(0, Math.round((z - h - this.z0) / c));
    const k1 = Math.min(this.nz, Math.round((z + h - this.z0) / c));
    const total = Math.max(1, Math.round((2 * h) / c) ** 2);
    let n = 0;
    for (let k = k0; k < k1; k++) for (let i = i0; i < i1; i++) n += this.data[k * this.nx + i]!;
    return n / total;
  }
  /** Centroid of the canopy cells inside the square, or null when there are none. */
  centroid(x: number, z: number, h: number): P2 | null {
    const c = this.cell;
    const i0 = Math.max(0, Math.round((x - h - this.x0) / c));
    const i1 = Math.min(this.nx, Math.round((x + h - this.x0) / c));
    const k0 = Math.max(0, Math.round((z - h - this.z0) / c));
    const k1 = Math.min(this.nz, Math.round((z + h - this.z0) / c));
    let n = 0, sx = 0, sz = 0;
    for (let k = k0; k < k1; k++) {
      for (let i = i0; i < i1; i++) {
        if (!this.data[k * this.nx + i]) continue;
        n++;
        sx += this.x0 + (i + 0.5) * c;
        sz += this.z0 + (k + 0.5) * c;
      }
    }
    return n ? [sx / n, sz / n] : null;
  }
}

export interface Lake {
  /** NHD permanent identifier. */
  id: string;
  name: string;
  /** Water level, metres (the flattened lattice's height). */
  y: number;
  polys: LocalPoly[];
  /** Lattice samples it covers (after growing), and its outline's samples. */
  samples: number;
}

/** A tile's lakes as its collider lists them. */
export interface TileLake {
  id: string;
  name: string;
  y: number;
}

export interface LandcoverStats {
  lakes: Array<{ id: string; name: string; y: number; samples: number; flattenedMaxM: number }>;
  samples: Record<string, number>;
  parks: number;
  federal: number;
  canopyPolygons: number;
  trees: number;
}

const featureId = (f: RawFeature): string => String(f.properties.permanent_identifier ?? f.properties.PERMANENT_IDENTIFIER ?? "");

/** Lattice key of a sample on the global 10 m lattice. */
const latticeKey = (gx: number, gz: number): number => (gx + 4096) * 8192 + gz + 4096;

export class Landcover {
  readonly cfg: LandcoverConfig;
  readonly lakes: Lake[] = [];
  private readonly parks: PolyIndex;
  private readonly federal: PolyIndex;
  private readonly beaches: Array<LandcoverConfig["beaches"]["list"][number] & { box: [number, number, number, number] }>;
  readonly canopy: CanopyRaster;
  /** Global lattice samples (latticeKey) that are lake water, with the lake's index in `lakes`. */
  private readonly lakeAt = new Map<number, number>();
  readonly stats: LandcoverStats;

  constructor(raw: RawLandcover, cfg: LandcoverConfig, bounds: readonly [number, number, number, number]) {
    this.cfg = cfg;
    const types = new Set(cfg.parks.recParkTypes);
    const lawns = new Set(cfg.parks.lawnPlazas);
    const green = (p: RawPark): boolean => types.has(p.propertytype ?? "") || lawns.has(p.property_name ?? "");
    const parkPolys = raw.parks.filter(green).flatMap((p) => geoPolys(p.shape ?? null));
    this.parks = new PolyIndex(parkPolys);
    const fedPolys = raw.federal.flatMap((f) => geoPolys(f.geometry));
    this.federal = new PolyIndex(fedPolys, 500);
    this.beaches = cfg.beaches.list.map((b) => {
      const nw = toLocal(b.north, b.west);
      const se = toLocal(b.south, b.east);
      return { ...b, box: [nw.x, nw.z, se.x, se.z] as [number, number, number, number] };
    });
    const canopyPolys = raw.canopy.flatMap((c: RawCanopy) => geoPolys(c.g ?? null));
    this.canopy = new CanopyRaster(canopyPolys, bounds, cfg.forest.cellM);
    const byId = new Map(raw.waterbodies.map((f) => [featureId(f), f]));
    for (const l of cfg.lakes.include) {
      const f = byId.get(l.nhd);
      if (!f) throw new Error(`landcover.json: lake ${l.name} (${l.nhd}) is not among the NHD waterbodies`);
      this.lakes.push({ id: l.nhd, name: l.name, y: 0, polys: geoPolys(f.geometry), samples: 0 });
    }
    this.stats = { lakes: [], samples: {}, parks: parkPolys.length, federal: fedPolys.length, canopyPolygons: canopyPolys.length, trees: 0 };
  }

  /** Is (x, z) park land (a green Rec and Park property or a National Park Service unit)? */
  park(x: number, z: number): boolean {
    return this.parks.find(x, z) >= 0 || this.federal.find(x, z) >= 0;
  }

  /**
   * Lakes (W-11): each listed lake's level from the lattice samples inside its outline (the
   * median where the DEM is hydro-flattened, else the 10th percentile), the samples inside it
   * and the flat samples next to it (grow) flattened to that level. Mutates the heightfields;
   * call before anything reads the ground.
   */
  applyLakes(fields: ReadonlyMap<string, Heightfield>, tiles: readonly TileRef[]): void {
    const c = GROUND_CELL_M;
    const fieldAt = (gx: number, gz: number): { f: Heightfield; i: number } | null => {
      const x = gx * c, z = gz * c;
      for (const [dx, dz] of [[0, 0], [-1, 0], [0, -1], [-1, -1]] as const) {
        const ix = Math.floor(x / 500) + dx, iz = Math.floor(z / 500) + dz;
        const f = fields.get(`t${ix}_${iz}`);
        if (!f) continue;
        const i = Math.round((x - f.x0) / c), k = Math.round((z - f.z0) / c);
        if (i >= 0 && i < f.nx && k >= 0 && k < f.nz) return { f, i: k * f.nx + i };
      }
      return null;
    };
    // Every copy of a sample (a border sample is in up to four tiles).
    const copies = (gx: number, gz: number): Array<{ f: Heightfield; i: number }> => {
      const out: Array<{ f: Heightfield; i: number }> = [];
      const x = gx * c, z = gz * c;
      for (const t of tiles) {
        if (x < t.bbox[0] || x > t.bbox[2] || z < t.bbox[1] || z > t.bbox[3]) continue;
        const f = fields.get(t.id);
        if (!f) continue;
        out.push({ f, i: Math.round((z - f.z0) / c) * f.nx + Math.round((x - f.x0) / c) });
      }
      return out;
    };
    this.lakes.forEach((lake, li) => {
      const inside: Array<[number, number]> = [];
      for (const p of lake.polys) {
        for (let gx = Math.ceil(p.box[0] / c); gx * c <= p.box[2]; gx++) {
          for (let gz = Math.ceil(p.box[1] / c); gz * c <= p.box[3]; gz++) {
            if (!inPoly(gx * c, gz * c, p)) continue;
            const s = fieldAt(gx, gz);
            if (!s || s.f.water[s.i] === 1) continue;
            inside.push([gx, gz]);
          }
        }
      }
      if (inside.length < this.cfg.lakes.minSamples) {
        lake.samples = 0;
        return;
      }
      const hs = inside.map(([gx, gz]) => {
        const s = fieldAt(gx, gz)!;
        return s.f.heights[s.i]!;
      }).sort((a, b) => a - b);
      const med = hs[Math.floor(hs.length / 2)]!;
      const flat = hs.filter((h) => Math.abs(h - med) <= 0.05).length / hs.length;
      lake.y = r2(flat >= 0.6 ? med : hs[Math.floor(hs.length / 10)]!);
      // Samples inside the outline but standing well over the water are its bank (the outline
      // is a few metres off the DEM in places): land, not lake.
      const wet = inside.filter(([gx, gz]) => {
        const s = fieldAt(gx, gz)!;
        return s.f.heights[s.i]! <= lake.y + this.cfg.lakes.bankM;
      });
      // Grow over the flat samples next to it, at most reachM beyond the outline.
      const take = new Set<number>();
      const queue: Array<[number, number, number]> = [];
      for (const [gx, gz] of wet) {
        take.add(latticeKey(gx, gz));
        queue.push([gx, gz, 0]);
      }
      const maxSteps = Math.floor(this.cfg.lakes.grow.reachM / c);
      for (let qi = 0; qi < queue.length; qi++) {
        const [gx, gz, d] = queue[qi]!;
        if (d >= maxSteps) continue;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = gx + dx, nz = gz + dz;
          const k = latticeKey(nx, nz);
          if (take.has(k) || this.lakeAt.has(k)) continue;
          const s = fieldAt(nx, nz);
          if (!s || s.f.water[s.i] === 1) continue;
          if (Math.abs(s.f.heights[s.i]! - lake.y) > this.cfg.lakes.grow.toleranceM) continue;
          take.add(k);
          queue.push([nx, nz, d + 1]);
        }
      }
      let flattened = 0;
      for (const k of [...take].sort((a, b) => a - b)) {
        if (this.lakeAt.has(k)) continue;
        this.lakeAt.set(k, li);
        const gx = Math.floor(k / 8192) - 4096, gz = (k % 8192) - 4096;
        for (const s of copies(gx, gz)) {
          flattened = Math.max(flattened, Math.abs(s.f.heights[s.i]! - lake.y));
          s.f.heights[s.i] = lake.y;
        }
      }
      lake.samples = take.size;
      this.stats.lakes.push({ id: lake.id, name: lake.name, y: lake.y, samples: take.size, flattenedMaxM: r2(flattened) });
    });
  }

  /** The lake index at a lattice sample, or -1. */
  lakeIndexAt(x: number, z: number): number {
    const c = GROUND_CELL_M;
    const gx = Math.round(x / c), gz = Math.round(z / c);
    if (Math.abs(gx * c - x) > 1e-6 || Math.abs(gz * c - z) > 1e-6) return -1;
    return this.lakeAt.get(latticeKey(gx, gz)) ?? -1;
  }

  /** Is (x, z) within `d` metres of open water, by the lattice's water flags (water(x, z)). */
  private nearWater(x: number, z: number, d: number, water: (x: number, z: number) => boolean | null): boolean {
    const c = GROUND_CELL_M;
    const n = Math.ceil(d / c);
    for (let i = -n; i <= n; i++) {
      for (let k = -n; k <= n; k++) {
        if ((i * i + k * k) * c * c > d * d) continue;
        if (water(x + i * c, z + k * c) === true) return true;
      }
    }
    return false;
  }

  /**
   * The class of a land sample (not sea, not lake) at (x, z) with height h. `water` answers
   * whether a lattice sample is open water (null where unknown).
   */
  landClass(x: number, z: number, h: number, water: (x: number, z: number) => boolean | null): "u" | "g" | "f" | "s" {
    for (const b of this.beaches) {
      if (x < b.box[0] || x > b.box[2] || z < b.box[1] || z > b.box[3] || h > b.maxY) continue;
      if (this.nearWater(x, z, b.shoreM, water)) return "s";
    }
    const park = this.park(x, z);
    const f = this.cfg.forest;
    const cover = this.canopy.cover(x, z, GROUND_CELL_M / 2);
    if (cover >= f.minCover && (park || this.canopy.cover(x, z, f.windowM / 2) >= f.minDensity)) return "f";
    return park ? "g" : "u";
  }

  /**
   * A tile's cover string (one character per lattice sample, row-major) and its lakes (the
   * digits index them). `water(x, z)` is the lattice water flag anywhere (null outside the tiles).
   */
  tileCover(field: Heightfield, water: (x: number, z: number) => boolean | null): { cover: string; lakes: TileLake[] } {
    const out: string[] = [];
    const lakes: TileLake[] = [];
    const lakeIdx = new Map<number, number>();
    for (let k = 0; k < field.nz; k++) {
      for (let i = 0; i < field.nx; i++) {
        const idx = k * field.nx + i;
        const x = field.x0 + i * field.cellSizeM, z = field.z0 + k * field.cellSizeM;
        if (field.water[idx] === 1) {
          out.push("w");
          continue;
        }
        const li = this.lakeIndexAt(x, z);
        if (li >= 0) {
          let t = lakeIdx.get(li);
          if (t === undefined) {
            t = lakes.length;
            if (t > 9) throw new Error(`landcover: more than 10 lakes in the tile at ${field.x0}, ${field.z0}`);
            lakeIdx.set(li, t);
            const l = this.lakes[li]!;
            lakes.push({ id: l.id, name: l.name, y: l.y });
          }
          out.push(String(t));
          continue;
        }
        out.push(this.landClass(x, z, field.heights[idx]!, water));
      }
    }
    const cover = out.join("");
    for (const ch of out) this.stats.samples[/[0-9]/.test(ch) ? "lake" : ch] = (this.stats.samples[/[0-9]/.test(ch) ? "lake" : ch] ?? 0) + 1;
    return { cover, lakes };
  }
}

/** One tree of a foliage node: its foot (world metres), height and crown width, and kind. */
export interface Tree {
  x: number;
  y: number;
  z: number;
  height: number;
  width: number;
  conifer: boolean;
}

/**
 * The trees of one tile (W-18): one per 10 m lattice cell whose canopy cover is at least
 * foliage.minCover, at the canopy's centroid in the cell, unless that point is in a building,
 * on a road ribbon, or on water or sand. Deterministic: sizes and kinds come from a hash of
 * the cell.
 */
export function tileTrees(
  lc: Landcover,
  tile: TileRef,
  cover: string,
  field: Heightfield,
  ground: (x: number, z: number) => number,
  blocked: (x: number, z: number) => boolean,
): Tree[] {
  const f = lc.cfg.foliage;
  const c = GROUND_CELL_M;
  const out: Tree[] = [];
  const n = field.nx - 1;
  const classAt = (i: number, k: number): string => cover[Math.min(n, Math.max(0, k)) * field.nx + Math.min(n, Math.max(0, i))]!;
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < n; i++) {
      const cx = tile.bbox[0] + (i + 0.5) * c, cz = tile.bbox[1] + (k + 0.5) * c;
      if (lc.canopy.cover(cx, cz, c / 2) < f.minCover) continue;
      const corners = [classAt(i, k), classAt(i + 1, k), classAt(i, k + 1), classAt(i + 1, k + 1)];
      if (corners.some((q) => q === "w" || q === "s" || /[0-9]/.test(q))) continue;
      const p = lc.canopy.centroid(cx, cz, c / 2);
      if (!p) continue;
      const x = Math.round(p[0] * 4) / 4, z = Math.round(p[1] * 4) / 4;
      if (blocked(x, z)) continue;
      const h = hash32(`tree:${Math.round(cx)}:${Math.round(cz)}`);
      const forest = corners.filter((q) => q === "f").length >= 2;
      const [lo, hi] = forest ? f.forestHeight : f.height;
      const height = Math.round((lo + ((h & 1023) / 1023) * (hi - lo)) * 4) / 4;
      const conifer = ((h >>> 10) & 1) === 1;
      const width = Math.round(height * (conifer ? 0.36 : 0.5 + ((h >>> 11) & 255) / 255 / 5) * 4) / 4;
      out.push({ x, y: Math.round((ground(x, z) - 0.15) * 64) / 64, z, height, width, conifer });
    }
  }
  lc.stats.trees += out.length;
  return out;
}
