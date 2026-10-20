// Shared helpers for the pipeline tests. No network: everything reads committed files or
// builds in memory.

import { createRequire } from "node:module";
import type { Group } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
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

/** Parse a GLB with three.js's own GLTFLoader (what the renderer uses). */
export function loadGlbWithThree(bytes: Uint8Array): Promise<Group> {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Promise((resolve, reject) => new GLTFLoader().parse(ab, "", (g) => resolve(g.scene), reject));
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
}

export interface SfBuilding {
  id: string;
  footprint: Array<[number, number]>;
  baseY: number;
  topY: number;
  meta: {
    footY: number;
    heightM: number;
    heightSource: string;
    lidarM: [number, number];
    parcel?: string;
    year?: number;
    use?: string;
    stories?: number;
    towerOf?: string;
    podiumTopY?: number;
    tower?: string;
  };
}

export interface SfCollider {
  tileId: string;
  buildings: SfBuilding[];
  ground: { x0: number; z0: number; cellSizeM: number; nx: number; nz: number; heights: number[]; water: number[] };
}

export interface SfRoads {
  version: number;
  nodes: Array<{ id: string; x: number; z: number; y: number }>;
  edges: Array<{
    id: string; a: string; b: string; kind: string; lanes: number; oneway: boolean; widthM: number;
    speedLimitMps: number; name: string; points: Array<[number, number]>; cnn: string; pedestrian?: boolean;
  }>;
}

export interface SfStorefronts {
  version: number;
  storefronts: Array<{ id: string; x: number; z: number; y: number; heading: number; naics: string; category: string; buildingId: string }>;
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
