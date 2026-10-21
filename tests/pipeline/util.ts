// Shared helpers for the pipeline tests. No network: everything reads committed files or
// builds in memory.

import { NodeIO } from "@gltf-transform/core";
import { EXTMeshoptCompression, KHRMeshQuantization } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";
import { createRequire } from "node:module";
import type { Group } from "three";
import type { Deck, Movable, Tunnel } from "../../pipeline/lib/structures.ts";
import { Ground } from "../../pipeline/lib/terrain.ts";
import { createTileLoader } from "../../src/render/gltf-loader.ts";
import { readJson } from "../helpers.ts";

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
