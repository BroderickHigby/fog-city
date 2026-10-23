// Shared helpers for the pipeline tests. No network: everything reads committed files or
// builds in memory.

import { NodeIO } from "@gltf-transform/core";
import { EXTMeshoptCompression, KHRMeshQuantization } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";
import { createRequire } from "node:module";
import type { Group } from "three";
import type { Deck, Movable, Tunnel } from "../../pipeline/lib/structures.ts";
import { Ground } from "../../pipeline/lib/terrain.ts";
import { decodeWorldColliders, PackGroundIndex, type PackBuilding, type WorldColliders } from "../../pipeline/lib/world-colliders.ts";
import { createTileLoader } from "../../src/render/gltf-loader.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readJson, ROOT } from "../helpers.ts";

const require = createRequire(import.meta.url);

interface ValidatorReport {
  issues: { numErrors: number; numWarnings: number; messages: Array<{ code: string; message: string; severity: number; pointer?: string }> };
}
const validator = require("gltf-validator") as { validateBytes(data: Uint8Array, opts?: { maxIssues?: number }): Promise<ValidatorReport> };

/** Khronos glTF-Validator: errors and warnings (info-level notes are ignored). */
export async function validateGlb(bytes: Uint8Array): Promise<{ errors: number; warnings: number; messages: string[] }> {
  const r = await validator.validateBytes(bytes, { maxIssues: 100 });
  return {
    errors: r.issues.numErrors,
    warnings: r.issues.numWarnings,
    messages: r.issues.messages.filter((m) => m.severity <= 1).map((m) => `${m.code} ${m.pointer ?? ""} ${m.message}`),
  };
}

/** Decode meshopt compression (gltf-transform + meshoptimizer) and re-write the glb uncompressed (still quantised). */
export async function decodeGlb(bytes: Uint8Array): Promise<Uint8Array> {
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ "meshopt.decoder": MeshoptDecoder });
  const doc = await io.readBinary(bytes);
  for (const e of doc.getRoot().listExtensionsUsed()) if (e.extensionName === "EXT_meshopt_compression") e.dispose();
  return io.writeBinary(doc);
}

/** Parse a GLB with three.js's own GLTFLoader, set up as the renderer must (meshopt decoder). */
export function loadGlbWithThree(bytes: Uint8Array): Promise<Group> {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Promise((resolve, reject) => createTileLoader().parse(ab, "", (g) => resolve(g.scene), reject));
}

export interface SfManifest {
  version: number;
  world: string;
  origin: { lat: number; lon: number };
  tileSizeM: number;
  spawn: { x: number; z: number; heading: number };
  attribution: string[];
  tiles: Array<{ id: string; ix: number; iz: number; bbox: [number, number, number, number]; collider: string; glb: string; stats: Record<string, number> }>;
  roads: string;
  water: { y: number; bbox: [number, number, number, number]; tiles: string[] };
  outside: { description?: string; tiles: Array<{ id: string; area: string }> };
  worldColliders: string;
  farCellSizeM: number;
  far: Array<{ id: string; cx: number; cz: number; bbox: [number, number, number, number]; glb: string; stats: Record<string, number> }>;
  layers: Record<string, string>;
}

export interface SfBuilding {
  id: string;
  footprint: Array<[number, number]>;
  baseY: number;
  topY: number;
  underY?: number;
  meta: {
    footY: number;
    heightM: number;
    heightSource: string;
    lidarM: [number, number];
    parcel?: string;
    year?: number;
    use?: string;
    stories?: number;
    units?: number;
    condo?: boolean;
    towerOf?: string;
    podiumTopY?: number;
    tower?: string;
    pieceOf?: string;
    piece?: "strip" | "span";
    outline?: "parcel" | "override";
    streetY?: number;
  };
}

export interface SfCollider {
  tileId: string;
  buildings: SfBuilding[];
  decks?: Deck[];
  tunnels?: Tunnel[];
  movable?: Movable[];
  ground: { x0: number; z0: number; cellSizeM: number; nx: number; nz: number; heights: number[]; water: number[] };
}

export interface SfRoads {
  version: number;
  nodes: Array<{ id: string; x: number; z: number; y: number }>;
  edges: Array<{
    id: string; a: string; b: string; kind: string; lanes: number; oneway: boolean; widthM: number;
    speedLimitMps: number; name: string; points: Array<[number, number]>; cnn: string; pedestrian?: boolean;
    gradeSeparated?: boolean; bridge?: boolean; deck?: boolean; tunnel?: boolean; stairs?: boolean; classcode?: number | null;
  }>;
}

export interface SfStorefronts {
  version: number;
  storefronts: Array<{ id: string; x: number; z: number; y: number; heading: number; naics: string; category: string; buildingId: string }>;
}

/** The ground the sim sees, looked up by tile index (the sim's own lookup scans every tile). */
export function groundIndex(colliders: readonly SfCollider[]): (x: number, z: number) => number {
  const g = new Ground(colliders.map((c) => ({ ix: Math.round(c.ground.x0 / 500), iz: Math.round(c.ground.z0 / 500), field: c.ground })));
  return (x, z) => g.heightAt(x, z) ?? 0;
}

export function loadSf(): { manifest: SfManifest; colliders: SfCollider[]; roads: SfRoads; storefronts: SfStorefronts } {
  const manifest = readJson<SfManifest>("public/tiles/sf/manifest.json");
  const colliders = manifest.tiles.map((t) => readJson<SfCollider>(`public/tiles/sf/${t.collider}`));
  return {
    manifest,
    colliders,
    roads: readJson<SfRoads>("public/tiles/sf/roads.json"),
    storefronts: readJson<SfStorefronts>("public/tiles/sf/storefronts.json"),
  };
}

export interface SfPack {
  manifest: SfManifest;
  pack: WorldColliders;
  roads: SfRoads;
  /** Every building record of the world, tile by tile (the pack's order). */
  buildings: PackBuilding[];
  /** The sim's ground (bilinear on the tile lattice). */
  heightAt: (x: number, z: number) => number;
  /** True where (x, z) lies in a tile of the world. */
  inside: (x: number, z: number) => boolean;
}

/**
 * The committed sf world through its collider pack (world.colliders.bin, ~15 MB, which
 * tests/pipeline/world-colliders.test.ts proves equal to the per-tile JSON colliders) and its
 * road graph: lighter than loadSf() for the whole-city checks that need no building meta.
 */
export function loadSfPack(): SfPack {
  const manifest = readJson<SfManifest>("public/tiles/sf/manifest.json");
  const pack = decodeWorldColliders(new Uint8Array(readFileSync(join(ROOT, "public/tiles/sf", manifest.worldColliders))));
  const g = new PackGroundIndex(pack);
  const tiles = new Set(pack.tiles.map((t) => `${t.ix},${t.iz}`));
  return {
    manifest,
    pack,
    roads: readJson<SfRoads>(`public/tiles/sf/${manifest.roads}`),
    buildings: pack.tiles.flatMap((t) => t.buildings),
    heightAt: (x, z) => g.heightAt(x, z),
    inside: (x, z) => tiles.has(`${Math.floor(x / pack.tileSizeM)},${Math.floor(z / pack.tileSizeM)}`),
  };
}

/** The base DataSF id of a record: without its part, tower and piece suffixes. */
export const baseId = (id: string): string => id.slice(0, 14);

/** A far cell's triangles in world metres: terrain first (node extras.terrainTriangles), then hulls. */
export interface FarTriangles {
  /** 9 numbers per triangle: x, y, z of each corner. */
  terrain: Float64Array;
  hulls: Float64Array;
}

/** Decode every far-LOD cell of the committed sf world into world-frame triangles. */
export async function loadFarTriangles(): Promise<FarTriangles> {
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ "meshopt.decoder": MeshoptDecoder });
  const manifest = readJson<SfManifest>("public/tiles/sf/manifest.json");
  const terrain: number[] = [];
  const hulls: number[] = [];
  for (const c of manifest.far) {
    const doc = await io.readBinary(new Uint8Array(readFileSync(join(ROOT, "public/tiles/sf", c.glb))));
    for (const node of doc.getRoot().listNodes()) {
      const mesh = node.getMesh();
      if (!mesh) continue;
      const m = node.getWorldMatrix();
      const nTerrain = Number((node.getExtras() as { terrainTriangles?: number }).terrainTriangles ?? 0);
      for (const prim of mesh.listPrimitives()) {
        const pos = prim.getAttribute("POSITION")!;
        const idx = prim.getIndices()!;
        const el = [0, 0, 0];
        const P: number[] = [];
        for (let i = 0; i < pos.getCount(); i++) {
          pos.getElement(i, el);
          P.push(m[0]! * el[0]! + m[4]! * el[1]! + m[8]! * el[2]! + m[12]!, m[1]! * el[0]! + m[5]! * el[1]! + m[9]! * el[2]! + m[13]!, m[2]! * el[0]! + m[6]! * el[1]! + m[10]! * el[2]! + m[14]!);
        }
        const n = idx.getCount() / 3;
        for (let t = 0; t < n; t++) {
          const out = t < nTerrain ? terrain : hulls;
          for (let k = 0; k < 3; k++) {
            const v = idx.getScalar(3 * t + k) * 3;
            out.push(P[v]!, P[v + 1]!, P[v + 2]!);
          }
        }
      }
    }
  }
  return { terrain: Float64Array.from(terrain), hulls: Float64Array.from(hulls) };
}

/** Point queries on a triangle soup: the highest triangle over (x, z), or null. */
export class TriangleGrid {
  private readonly cells = new Map<number, number[]>();
  private readonly tris: Float64Array;
  private readonly cell: number;
  constructor(tris: Float64Array, cell = 25) {
    this.tris = tris;
    this.cell = cell;
    for (let t = 0; t < tris.length / 9; t++) {
      const xs = [tris[9 * t]!, tris[9 * t + 3]!, tris[9 * t + 6]!];
      const zs = [tris[9 * t + 2]!, tris[9 * t + 5]!, tris[9 * t + 8]!];
      for (let cx = Math.floor(Math.min(...xs) / cell); cx <= Math.floor(Math.max(...xs) / cell); cx++) {
        for (let cz = Math.floor(Math.min(...zs) / cell); cz <= Math.floor(Math.max(...zs) / cell); cz++) {
          const k = (cx + 32768) * 65536 + cz + 32768;
          (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push(t);
        }
      }
    }
  }
  /** Highest surface over (x, z) among non-vertical triangles, or null where none covers it. */
  top(x: number, z: number): number | null {
    let best: number | null = null;
    const T = this.tris;
    for (const t of this.cells.get((Math.floor(x / this.cell) + 32768) * 65536 + Math.floor(z / this.cell) + 32768) ?? []) {
      const o = 9 * t;
      const x1 = T[o]!, y1 = T[o + 1]!, z1 = T[o + 2]!, x2 = T[o + 3]!, y2 = T[o + 4]!, z2 = T[o + 5]!, x3 = T[o + 6]!, y3 = T[o + 7]!, z3 = T[o + 8]!;
      const den = (z2 - z3) * (x1 - x3) + (x3 - x2) * (z1 - z3);
      if (Math.abs(den) < 1e-6) continue;
      const w1 = ((z2 - z3) * (x - x3) + (x3 - x2) * (z - z3)) / den;
      const w2 = ((z3 - z1) * (x - x3) + (x1 - x3) * (z - z3)) / den;
      const w3 = 1 - w1 - w2;
      if (w1 < -1e-6 || w2 < -1e-6 || w3 < -1e-6) continue;
      const y = w1 * y1 + w2 * y2 + w3 * y3;
      if (best === null || y > best) best = y;
    }
    return best;
  }
}
