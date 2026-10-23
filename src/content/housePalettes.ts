// House colours by era and district (content/house-palettes.json; house kit K3, world QA W-37).
//
// assignHouseColours picks every house's body, trim and (Marina) roof-edge colour for a whole
// world at once: the first rule matching the assessor year and the house's DataSF Analysis
// Neighborhood picks the palette, a hash of the building id picks the body, and a body already
// worn by a touching neighbour is skipped, so no two adjacent houses on a block face share a
// colour. Overrides (the Painted Ladies) are hand colours by building id and win over the rules.
//
// Pure and deterministic: the result depends only on the lots passed in (sorted by id inside),
// never on their order, the clock or Math.random. The pipeline calls it once per world with one
// lot per drawn house (a podium record; its tower and any terrace pieces wear the podium's
// colours: see colourKey) and bakes the colours into the tile GLBs; the renderer's collider
// fallback can call it on the tiles it has.

import palettesJson from "../../content/house-palettes.json" with { type: "json" };
import { contrastRatio } from "./billboards.ts";
import { hashString } from "./prng.ts";

export type Hex = string;

export interface HouseScheme {
  id: string;
  bodies: Hex[];
  trims: Hex[];
}

export interface HousePalette {
  label: string;
  /** Added to the facade's glazing share (more glass on modern houses). */
  glazingDelta: number;
  /** Roof-edge tile colours (the Marina's red tile); absent when the roof edge is the roof. */
  roofEdges?: Hex[];
  schemes: HouseScheme[];
}

export interface HousePaletteRule {
  id: string;
  palette: string;
  minYear?: number;
  maxYear?: number;
  /** DataSF Analysis Neighborhood ids (public/tiles/sf/districts.json); any district when absent. */
  districts?: string[];
  note?: string;
}

export interface HouseOverrideRecord {
  id: string;
  parcel: string;
  body: Hex;
  trim: Hex;
  accent: Hex;
}

export interface HouseOverride {
  id: string;
  label: string;
  note?: string;
  records: HouseOverrideRecord[];
}

export interface HousePalettesFile {
  version: 1;
  maxGapM: number;
  rules: HousePaletteRule[];
  palettes: Record<string, HousePalette>;
  overrides: HouseOverride[];
}

export const HOUSE_PALETTES = palettesJson as unknown as HousePalettesFile;

/** One house to colour: a podium record's id and footprint (local metres), its year and district. */
export interface HouseLot {
  id: string;
  footprint: ReadonlyArray<readonly [number, number]>;
  year?: number | null;
  district?: string | null;
}

export interface HouseColours {
  body: Hex;
  trim: Hex;
  /** Door and sash accent: the override's, else null (the renderer derives one from the trim). */
  accent: Hex | null;
  roofEdge: Hex | null;
  glazingDelta: number;
  /** The rule id that picked the palette, or "override". */
  rule: string;
  palette: string;
  scheme: string;
  /** The override id (e.g. "postcard-row") when a hand palette applies. */
  override: string | null;
}

// ---------------------------------------------------------------- colour maths

function channels(hex: Hex): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function toHex(r: number, g: number, b: number): Hex {
  const c = (x: number): string => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** HSV saturation of an sRGB hex colour, (max - min) / max, 0 for black. */
export function hsvSaturation(hex: Hex): number {
  const [r, g, b] = channels(hex);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  return mx === 0 ? 0 : (mx - mn) / mx;
}

/** Every channel times k (k < 1 darkens). Keeps the HSV hue and, up to rounding, the saturation. */
export function scaleHex(hex: Hex, k: number): Hex {
  const [r, g, b] = channels(hex);
  return toHex(r * k, g * k, b * k);
}

// ---------------------------------------------------------------- rules

/** The first rule matching a year and district (the file always ends with a catch-all). */
export function paletteRuleFor(year: number | null | undefined, district: string | null | undefined, file: HousePalettesFile = HOUSE_PALETTES): HousePaletteRule {
  for (const r of file.rules) {
    if (r.minYear !== undefined && (year === null || year === undefined || year < r.minYear)) continue;
    if (r.maxYear !== undefined && (year === null || year === undefined || year > r.maxYear)) continue;
    if (r.districts !== undefined && (!district || !r.districts.includes(district))) continue;
    return r;
  }
  throw new Error(`house-palettes: no rule matches year ${year ?? "none"} in ${district ?? "no district"} (the last rule must be a catch-all)`);
}

const OVERRIDE_INDEX = new Map<string, { override: HouseOverride; record: HouseOverrideRecord }>();
for (const o of HOUSE_PALETTES.overrides) for (const r of o.records) OVERRIDE_INDEX.set(r.id, { override: o, record: r });

/** The hand palette for a building id, if a named row lists it. */
export function houseOverrideFor(id: string, file: HousePalettesFile = HOUSE_PALETTES): { override: HouseOverride; record: HouseOverrideRecord } | null {
  if (file === HOUSE_PALETTES) return OVERRIDE_INDEX.get(id) ?? null;
  for (const o of file.overrides) for (const r of o.records) if (r.id === id) return { override: o, record: r };
  return null;
}

/**
 * The id a record's colours are looked up by: a tower wears its podium's colours and a terrace
 * or span piece its parent's (collider meta towerOf / pieceOf).
 */
export function colourKey(record: { id: string; meta?: { towerOf?: string; pieceOf?: string } | null }): string {
  return record.meta?.towerOf ?? record.meta?.pieceOf ?? record.id;
}

// ---------------------------------------------------------------- adjacency

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

function segmentsCross(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): boolean {
  const o = (px: number, pz: number, qx: number, qz: number, rx: number, rz: number): number => (qx - px) * (rz - pz) - (qz - pz) * (rx - px);
  const d1 = o(cx, cz, dx, dz, ax, az);
  const d2 = o(cx, cz, dx, dz, bx, bz);
  const d3 = o(ax, az, bx, bz, cx, cz);
  const d4 = o(ax, az, bx, bz, dx, dz);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function pointInRing(x: number, z: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i]!;
    const [xj, zj] = ring[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** The smallest distance between two footprint rings (0 when they cross or one holds the other). */
export function ringGap(a: Ring, b: Ring): number {
  let best = Infinity;
  for (let i = 0; i < a.length; i++) {
    const [ax, az] = a[i]!;
    const [bx, bz] = a[(i + 1) % a.length]!;
    for (let j = 0; j < b.length; j++) {
      const [cx, cz] = b[j]!;
      const [dx, dz] = b[(j + 1) % b.length]!;
      if (segmentsCross(ax, az, bx, bz, cx, cz, dx, dz)) return 0;
      best = Math.min(best, segDist2(ax, az, bx, bz, cx, cz), segDist2(ax, az, bx, bz, dx, dz), segDist2(cx, cz, dx, dz, ax, az), segDist2(cx, cz, dx, dz, bx, bz));
    }
  }
  if (a.length > 0 && b.length > 0 && (pointInRing(a[0]![0], a[0]![1], b) || pointInRing(b[0]![0], b[0]![1], a))) return 0;
  return Math.sqrt(best);
}

/**
 * Touching houses: every pair of lots whose footprints come within maxGapM of each other (row
 * houses share a wall, or stand a crack of up to 60 cm apart in the data). Neighbour lists are
 * sorted by id.
 */
export function houseAdjacency(lots: readonly HouseLot[], maxGapM: number = HOUSE_PALETTES.maxGapM): Map<string, string[]> {
  const CELL = 25;
  const boxes = lots.map((l) => {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [x, z] of l.footprint) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    return { x0: x0 - maxGapM, z0: z0 - maxGapM, x1: x1 + maxGapM, z1: z1 + maxGapM };
  });
  const grid = new Map<string, number[]>();
  boxes.forEach((b, i) => {
    for (let cx = Math.floor(b.x0 / CELL); cx <= Math.floor(b.x1 / CELL); cx++) {
      for (let cz = Math.floor(b.z0 / CELL); cz <= Math.floor(b.z1 / CELL); cz++) {
        const k = `${cx},${cz}`;
        const l = grid.get(k);
        if (l) l.push(i);
        else grid.set(k, [i]);
      }
    }
  });
  const out = new Map<string, Set<string>>(lots.map((l) => [l.id, new Set<string>()]));
  for (let i = 0; i < lots.length; i++) {
    const a = boxes[i]!;
    const cands = new Set<number>();
    for (let cx = Math.floor(a.x0 / CELL); cx <= Math.floor(a.x1 / CELL); cx++) {
      for (let cz = Math.floor(a.z0 / CELL); cz <= Math.floor(a.z1 / CELL); cz++) {
        for (const j of grid.get(`${cx},${cz}`) ?? []) if (j > i) cands.add(j);
      }
    }
    for (const j of cands) {
      const b = boxes[j]!;
      // Both boxes carry the gap, so this keeps every pair within 2 x maxGapM; ringGap decides.
      if (a.x1 < b.x0 || b.x1 < a.x0 || a.z1 < b.z0 || b.z1 < a.z0) continue;
      if (lots[i]!.id === lots[j]!.id) continue;
      if (ringGap(lots[i]!.footprint, lots[j]!.footprint) <= maxGapM) {
        out.get(lots[i]!.id)!.add(lots[j]!.id);
        out.get(lots[j]!.id)!.add(lots[i]!.id);
      }
    }
  }
  return new Map([...out].map(([id, s]) => [id, [...s].sort()]));
}

// ---------------------------------------------------------------- assignment

/** Darker first, then lighter: the shades tried when every body in a palette is taken next door. */
const SHADES = [0.93, 1.07, 0.86, 1.14, 0.8, 0.74, 0.68, 0.62];

/**
 * Colours for every lot. Lots are coloured in id order; a lot never takes a body that an
 * already-coloured neighbour wears (overrides are coloured first, so their neighbours avoid
 * them). When every body of the palette is taken next door, a darker or lighter shade of the
 * hashed body is used instead.
 */
export function assignHouseColours(lots: readonly HouseLot[], file: HousePalettesFile = HOUSE_PALETTES, adjacency?: Map<string, string[]>): Map<string, HouseColours> {
  const sorted = [...lots].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const adj = adjacency ?? houseAdjacency(sorted, file.maxGapM);
  const out = new Map<string, HouseColours>();
  for (const lot of sorted) {
    const o = houseOverrideFor(lot.id, file);
    if (!o) continue;
    out.set(lot.id, { body: o.record.body, trim: o.record.trim, accent: o.record.accent, roofEdge: null, glazingDelta: 0, rule: "override", palette: "override", scheme: o.override.id, override: o.override.id });
  }
  for (const lot of sorted) {
    if (out.has(lot.id)) continue;
    const rule = paletteRuleFor(lot.year, lot.district, file);
    const pal = file.palettes[rule.palette];
    if (!pal) throw new Error(`house-palettes: rule ${rule.id} names missing palette ${rule.palette}`);
    const bodies: Array<{ body: Hex; scheme: HouseScheme }> = pal.schemes.flatMap((s) => s.bodies.map((body) => ({ body, scheme: s })));
    const taken = new Set<string>();
    for (const n of adj.get(lot.id) ?? []) {
      const c = out.get(n);
      if (c) taken.add(c.body);
    }
    const h = hashString(lot.id);
    const start = h % bodies.length;
    let pick: { body: Hex; scheme: HouseScheme } | null = null;
    for (let i = 0; i < bodies.length && !pick; i++) {
      const cand = bodies[(start + i) % bodies.length]!;
      if (!taken.has(cand.body)) pick = cand;
    }
    if (!pick) {
      const base = bodies[start]!;
      for (const k of SHADES) {
        const shade = scaleHex(base.body, k);
        if (!taken.has(shade)) {
          pick = { body: shade, scheme: base.scheme };
          break;
        }
      }
      if (!pick) throw new Error(`house-palettes: ${lot.id} has more neighbours than colours (${taken.size})`);
    }
    const trim = pick.scheme.trims[hashString(`${lot.id}#trim`) % pick.scheme.trims.length]!;
    const roofEdge = pal.roofEdges && pal.roofEdges.length > 0 ? pal.roofEdges[hashString(`${lot.id}#roof`) % pal.roofEdges.length]! : null;
    out.set(lot.id, { body: pick.body, trim, accent: null, roofEdge, glazingDelta: pal.glazingDelta, rule: rule.id, palette: rule.palette, scheme: pick.scheme.id, override: null });
  }
  return out;
}

// ---------------------------------------------------------------- checks

/** Victorian bodies in the saturated schemes, and the trim contrast every scheme must keep. */
export const VICTORIAN_SATURATION: readonly [number, number] = [0.3, 0.6];
export const MIN_TRIM_CONTRAST = 1.5;

/**
 * Rules beyond the schema: every rule names a palette, the last rule is a catch-all, bodies are
 * unique within a palette, the Victorian deep and light schemes are saturated (0.3 to 0.6), every
 * Victorian trim contrasts with every body of its scheme (no trim is ever its own body), override
 * records are unique, keep a contrasting trim, and neighbours in a row never share a body.
 */
export function checkHousePalettes(file: HousePalettesFile = HOUSE_PALETTES): string[] {
  const errs: string[] = [];
  const ruleIds = new Set<string>();
  for (const r of file.rules) {
    if (ruleIds.has(r.id)) errs.push(`rule ${r.id}: duplicate id`);
    ruleIds.add(r.id);
    if (!file.palettes[r.palette]) errs.push(`rule ${r.id}: palette ${r.palette} does not exist`);
    if (r.minYear !== undefined && r.maxYear !== undefined && r.minYear > r.maxYear) errs.push(`rule ${r.id}: minYear > maxYear`);
  }
  const last = file.rules[file.rules.length - 1];
  if (!last || last.minYear !== undefined || last.maxYear !== undefined || last.districts !== undefined) errs.push("the last rule must be a catch-all (no year or district bounds)");
  for (const [id, p] of Object.entries(file.palettes)) {
    const seen = new Set<string>();
    for (const s of p.schemes) {
      for (const b of s.bodies) {
        if (seen.has(b)) errs.push(`palette ${id}: body ${b} listed twice`);
        seen.add(b);
        for (const t of s.trims) {
          // Victorian trim contrasts (K3); later palettes may run white trim on a pale body, but never the body itself.
          if (t === b) errs.push(`palette ${id}.${s.id}: trim ${t} is a body colour`);
          else if (id === "victorian" && contrastRatio(b, t) < MIN_TRIM_CONTRAST) errs.push(`palette ${id}.${s.id}: trim ${t} on body ${b} has contrast ${contrastRatio(b, t).toFixed(2)} < ${MIN_TRIM_CONTRAST}`);
        }
      }
      if (id === "victorian" && s.id !== "muted") {
        for (const b of s.bodies) {
          const sat = hsvSaturation(b);
          if (sat < VICTORIAN_SATURATION[0] || sat > VICTORIAN_SATURATION[1]) errs.push(`palette victorian.${s.id}: body ${b} saturation ${sat.toFixed(3)} outside ${VICTORIAN_SATURATION.join("-")}`);
        }
      }
    }
  }
  const ids = new Set<string>();
  for (const o of file.overrides) {
    o.records.forEach((r, i) => {
      if (ids.has(r.id)) errs.push(`override ${o.id}: ${r.id} listed twice`);
      ids.add(r.id);
      if (contrastRatio(r.body, r.trim) < MIN_TRIM_CONTRAST) errs.push(`override ${o.id}: ${r.id} trim contrast ${contrastRatio(r.body, r.trim).toFixed(2)}`);
      const prev = o.records[i - 1];
      if (prev && prev.body === r.body) errs.push(`override ${o.id}: neighbours ${prev.id} and ${r.id} share body ${r.body}`);
    });
  }
  return errs;
}
