// Street props a car can hit (impacts.ts): street trees and lamp posts where the renderer puts
// them (src/render/roads.ts streetTreeSpots / streetlightSpots, the same arithmetic on the same
// road graph and the same per-edge hashes, so every prop the player sees is here at its drawn
// spot), and fire hydrants at the gameplay refill points. Each has a stable id ("tree:<edge>:<k>",
// "lamp:<edge>:<i>", "hydrant:<refill id>"), so a knocked prop's state survives saves, replays and
// a fresh client. Built once per world (a WeakMap), queried by cell. Pure and deterministic.
//
// What a hit does depends on the prop (PROP_SPECS): a sapling cannot stop a car (it snaps), a
// young tree, a lamp post or a hydrant breaks when hit fast enough and is a wall below that, and
// a mature tree is always a wall. Props placed from real data join through `world.props` with the
// same specs: propsFromStreetDetail reads the World detail stream's street-trees.json (SF's street
// tree inventory, ids tree:<treeid>, sized by their height), street-furniture.json (signal poles,
// stop signs) and street-signs.json (corner blade posts, kerbside signs), keeping their ids. When
// real trees are given, they replace the road-graph trees (the renderer draws them instead).

import type { World } from "./world.ts";
import { cellKey } from "./world.ts";

export type PropKind = "tree" | "lamp" | "hydrant" | "sign" | "signal" | "bin" | "fence" | "newsbox";

/** A tree's size class: "sapling" snaps, "young" breaks at speed, "mature" is solid. */
export type TreeSize = "sapling" | "young" | "mature";

export interface Prop {
  id: string;
  kind: PropKind;
  x: number;
  z: number;
  /** Collision radius, metres (the trunk, the pole, the hydrant's body). */
  r: number;
  /** Height, metres (how far it reaches when it falls). */
  height: number;
  /** Mass a car exchanges momentum with when it breaks it, kg. */
  mass: number;
  /** Closing speed at or above which a hit breaks it, m/s; below that it is a wall. Infinity: never breaks. */
  breakSpeed: number;
  /** A tree's size class (absent for other props). */
  size?: TreeSize;
}

/** A prop from external data (World detail): position, kind and stable id; the rest from PROP_SPECS. */
export interface PropPlacement {
  id: string;
  kind: PropKind;
  x: number;
  z: number;
  /** A tree's height, metres (its size class and trunk follow from it). */
  height?: number;
}

/** Per-kind physics (all values tune). Trees by size class. */
export const PROP_SPECS: Readonly<Record<Exclude<PropKind, "tree">, Pick<Prop, "r" | "height" | "mass" | "breakSpeed">>> = {
  lamp: { r: 0.12, height: 7.2, mass: 180, breakSpeed: 6 },
  hydrant: { r: 0.22, height: 0.8, mass: 120, breakSpeed: 4 },
  sign: { r: 0.06, height: 3, mass: 25, breakSpeed: 2 },
  signal: { r: 0.15, height: 5, mass: 220, breakSpeed: 7 },
  bin: { r: 0.35, height: 1.1, mass: 40, breakSpeed: 1.5 },
  fence: { r: 0.08, height: 1.2, mass: 20, breakSpeed: 1.5 },
  newsbox: { r: 0.3, height: 1.1, mass: 45, breakSpeed: 1.5 },
};

/** A real tree's size class from its height: saplings under 4 m snap, trees from 9 m never break. */
export function treeSizeOfHeight(h: number): TreeSize {
  return h < 4 ? "sapling" : h < 9 ? "young" : "mature";
}

/** A real street tree's prop (World detail): a height-sized trunk. */
export function realTreeProp(id: string, x: number, z: number, height: number): Prop {
  const size = treeSizeOfHeight(height);
  return { id, kind: "tree", x, z, r: size === "sapling" ? 0.08 : 0.1 + 0.02 * height, height, mass: size === "sapling" ? 15 : 260, breakSpeed: size === "sapling" ? 0 : size === "young" ? 7 : Infinity, size };
}

/** The World detail stream's files, as far as props are concerned (render-only today: public/tiles/sf/street-*.json). */
export interface StreetDetailFiles {
  trees?: { classes: readonly string[]; trees: ReadonlyArray<readonly [number, number, number, number, number]> } | null;
  furniture?: { signals?: ReadonlyArray<{ id: string; x: number; z: number }>; stopSigns?: ReadonlyArray<{ id: string; x: number; z: number }> } | null;
  signs?: { corners?: ReadonlyArray<{ id: string; x: number; z: number }>; curb?: ReadonlyArray<{ id: string; x: number; z: number }> } | null;
}

/** World detail's trees, signal poles, stop signs and sign posts as props, with their own ids (set them as `world.props`). */
export function propsFromStreetDetail(files: StreetDetailFiles): PropPlacement[] {
  const out: PropPlacement[] = [];
  for (const [id, x, z, , h] of files.trees?.trees ?? []) out.push({ id: `tree:${id}`, kind: "tree", x, z, height: h });
  for (const p of files.furniture?.signals ?? []) out.push({ id: p.id, kind: "signal", x: p.x, z: p.z });
  for (const p of files.furniture?.stopSigns ?? []) out.push({ id: p.id, kind: "sign", x: p.x, z: p.z });
  for (const p of files.signs?.corners ?? []) out.push({ id: p.id, kind: "sign", x: p.x, z: p.z });
  for (const p of files.signs?.curb ?? []) out.push({ id: p.id, kind: "sign", x: p.x, z: p.z });
  return out;
}

/** A street tree's size class from its 0..1 variation (the renderer draws it at scale 0.75 + 0.55 v). */
export function treeSize(v: number): TreeSize {
  return v < 0.25 ? "sapling" : v < 0.7 ? "young" : "mature";
}

/** A street tree's prop: trunk radius and height grow with its scale; saplings snap at any speed, young trees at 7 m/s. */
export function treeProp(id: string, x: number, z: number, v: number): Prop {
  const s = 0.75 + v * 0.55;
  const size = treeSize(v);
  return {
    id,
    kind: "tree",
    x,
    z,
    r: size === "sapling" ? 0.08 : 0.12 + 0.12 * s,
    height: 7 * s,
    mass: size === "sapling" ? 15 : 260,
    breakSpeed: size === "sapling" ? 0 : size === "young" ? 7 : Infinity,
    size,
  };
}

// ---------------------------------------------------------------- the renderer's placement, in sim form

/** FNV-1a over a string (src/render/hash.ts hashString). */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Murmur3 finaliser (src/render/hash.ts mix32). */
function mix32(h: number, v: number): number {
  let x = (h ^ Math.imul(v | 0, 0x9e3779b1)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

/** src/render/hash.ts rand01. */
function rand01(seed: string, n = 0): number {
  return (mix32(hashString(seed), n + 1) >>> 0) / 4294967296;
}

const LANE_M = 3.3;

interface RawEdge {
  id: string;
  a: string;
  b: string;
  kind: string;
  lanes: number;
  widthM: number;
  points: ReadonlyArray<readonly [number, number]>;
}

function roadHalfWidth(e: RawEdge): number {
  if (e.widthM > 0) return e.widthM / 2;
  const lanes = Math.max(1, e.lanes | 0);
  const parking = e.kind === "residential" || e.kind === "collector" || e.kind === "arterial" ? 2 * 2.4 : 0;
  return (lanes * LANE_M + parking) / 2;
}

function sidewalkWidth(kind: string): number {
  return kind === "freeway" || kind === "ramp" ? 0 : kind === "alley" ? 0.8 : kind === "arterial" ? 4 : 3;
}

function polylineLength(pts: RawEdge["points"]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i]![0] - pts[i - 1]![0];
    const dz = pts[i]![1] - pts[i - 1]![1];
    L += Math.sqrt(dx * dx + dz * dz);
  }
  return L;
}

function pointAt(pts: RawEdge["points"], s: number): { x: number; z: number; dx: number; dz: number } {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const len = Math.sqrt((b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]));
    if (len <= 1e-9) continue;
    if (acc + len >= s || i === pts.length - 1) {
      const t = Math.max(0, Math.min(1, (s - acc) / len));
      return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, dx: (b[0] - a[0]) / len, dz: (b[1] - a[1]) / len };
    }
    acc += len;
  }
  const p = pts[0] ?? [0, 0];
  return { x: p[0], z: p[1], dx: 0, dz: -1 };
}

/** src/render/roads.ts nodeClearance. */
function nodeClearance(edges: readonly RawEdge[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of edges) {
    const w = roadHalfWidth(e) + sidewalkWidth(e.kind);
    out.set(e.a, Math.max(out.get(e.a) ?? 0, w));
    out.set(e.b, Math.max(out.get(e.b) ?? 0, w));
  }
  return out;
}

/** Lamp posts: src/render/roads.ts streetlightSpots (spacing 34 m). */
export function lampProps(edges: readonly RawEdge[], clearance: ReadonlyMap<string, number>, spacing = 34): Prop[] {
  const out: Prop[] = [];
  for (const e of edges) {
    if (e.kind === "freeway" || e.kind === "ramp" || e.kind === "alley") continue;
    const L = polylineLength(e.points);
    const s0 = (clearance.get(e.a) ?? 0) + 3;
    const s1 = L - (clearance.get(e.b) ?? 0) - 3;
    if (s1 <= s0) continue;
    const off = roadHalfWidth(e) + 0.7;
    const n = Math.max(1, Math.floor((s1 - s0) / spacing) + 1);
    const step = n > 1 ? (s1 - s0) / (n - 1) : 0;
    for (let i = 0; i < n; i++) {
      const s = n > 1 ? s0 + i * step : (s0 + s1) / 2;
      const p = pointAt(e.points, s);
      const side = (i + (rand01(e.id) < 0.5 ? 0 : 1)) % 2 === 0 ? 1 : -1;
      out.push({ id: `lamp:${e.id}:${i}`, kind: "lamp", x: p.x - p.dz * side * off, z: p.z + p.dx * side * off, ...PROP_SPECS.lamp });
    }
  }
  return out;
}

/** Street trees: src/render/roads.ts streetTreeSpots (spacing 15 m, density 0.6). */
export function treeProps(edges: readonly RawEdge[], clearance: ReadonlyMap<string, number>, spacing = 15, density = 0.6): Prop[] {
  const out: Prop[] = [];
  for (const e of edges) {
    if (e.kind !== "residential" && e.kind !== "collector") continue;
    const sw = sidewalkWidth(e.kind);
    if (sw < 2) continue;
    const L = polylineLength(e.points);
    const s0 = (clearance.get(e.a) ?? 0) + 6;
    const s1 = L - (clearance.get(e.b) ?? 0) - 6;
    if (s1 <= s0) continue;
    const off = roadHalfWidth(e) + sw * 0.55;
    let k = 0;
    for (let s = s0 + spacing * 0.5; s <= s1; s += spacing) {
      for (const side of [1, -1]) {
        k++;
        if (rand01(e.id, 1000 + k) > density) continue;
        const p = pointAt(e.points, s + (rand01(e.id, 2000 + k) - 0.5) * 3);
        out.push(treeProp(`tree:${e.id}:${k}`, p.x - p.dz * side * off, p.z + p.dx * side * off, rand01(e.id, 4000 + k)));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- the index

export interface PropIndex {
  /** Every prop, in a fixed order (by id). */
  list: readonly Prop[];
  byId: ReadonlyMap<string, Prop>;
  /** Prop indices by cell (PROP_CELL_M). */
  cells: ReadonlyMap<number, readonly number[]>;
}

export const PROP_CELL_M = 16;

const indexes = new WeakMap<World, PropIndex>();

/** The road edges as the renderer reads roads.json: ids, node ids, kind, widths and the centreline. */
function rawEdges(world: World): RawEdge[] {
  const g = world.roads;
  if (!g) return [];
  return g.edges.map((e) => ({
    id: e.id,
    a: g.nodes[e.a]!.id,
    b: g.nodes[e.b]!.id,
    kind: e.kind,
    lanes: e.lanes,
    widthM: e.widthM,
    points: e.center.xs.map((x, i) => [x, e.center.zs[i]!] as const),
  }));
}

const EMPTY: PropIndex = { list: [], byId: new Map(), cells: new Map() };

/**
 * The same world with no street props at all (a flag on a shallow copy): for tests whose subject
 * is something else on a clear sidewalk (the dodge), written before props existed.
 */
export function withoutStreetProps(world: World): World {
  return Object.assign(Object.create(Object.getPrototypeOf(world) as object) as World, world, { streetProps: false });
}

/** Every prop in the world (built on first use). */
export function propIndex(world: World): PropIndex {
  if ((world as World & { streetProps?: boolean }).streetProps === false) return EMPTY;
  let idx = indexes.get(world);
  if (idx) return idx;
  const edges = rawEdges(world);
  const clearance = nodeClearance(edges);
  const extra = (world as World & { props?: readonly PropPlacement[] }).props ?? [];
  const realTrees = extra.some((p) => p.kind === "tree");
  const list: Prop[] = [...(realTrees ? [] : treeProps(edges, clearance)), ...lampProps(edges, clearance)];
  for (const r of world.gameplay?.refills ?? []) if (r.kind === "hydrant") list.push({ id: `hydrant:${r.id}`, kind: "hydrant", x: r.x, z: r.z, ...PROP_SPECS.hydrant });
  for (const p of extra) {
    if (p.kind === "tree") list.push(realTreeProp(p.id, p.x, p.z, p.height ?? 6));
    else list.push({ id: p.id, kind: p.kind, x: p.x, z: p.z, ...PROP_SPECS[p.kind] });
  }
  list.sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  const byId = new Map<string, Prop>();
  const cells = new Map<number, number[]>();
  list.forEach((p, i) => {
    if (byId.has(p.id)) return;
    byId.set(p.id, p);
    const k = cellKey(Math.floor(p.x / PROP_CELL_M), Math.floor(p.z / PROP_CELL_M));
    let l = cells.get(k);
    if (!l) cells.set(k, (l = []));
    l.push(i);
  });
  idx = { list, byId, cells };
  indexes.set(world, idx);
  return idx;
}

/** Props within `r` of (x, z) (their centres), in id order. */
export function propsNear(world: World, x: number, z: number, r: number): Prop[] {
  const idx = propIndex(world);
  const out: number[] = [];
  for (let cx = Math.floor((x - r) / PROP_CELL_M); cx <= Math.floor((x + r) / PROP_CELL_M); cx++) {
    for (let cz = Math.floor((z - r) / PROP_CELL_M); cz <= Math.floor((z + r) / PROP_CELL_M); cz++) {
      for (const i of idx.cells.get(cellKey(cx, cz)) ?? []) {
        const p = idx.list[i]!;
        if ((p.x - x) * (p.x - x) + (p.z - z) * (p.z - z) <= r * r) out.push(i);
      }
    }
  }
  out.sort((a, b) => a - b);
  return out.map((i) => idx.list[i]!);
}
