// Shared test helpers (Node side). Used by unit tests (Vitest) and by the Playwright
// process that drives the browser (tests/e2e). Never touches the network: worlds are read
// from the committed files under public/tiles/<world>/.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assembleWorldFiles } from "../src/io/world-load.ts";
import { buildWorld, type BoundaryFile, type RoadsFile, type TileCollider, type World } from "../src/sim/index.ts";

export const ROOT = join(import.meta.dirname, "..");

export function readJson<T = unknown>(rel: string): T {
  const text = readFileSync(join(ROOT, rel), "utf8");
  // Tiles live in plain git (docs/design.md, 2026-10-20). A Git LFS pointer here means a fork or
  // a tool moved them: say so, rather than "Unexpected token v in JSON".
  if (text.startsWith("version https://git-lfs.github.com/spec/")) {
    throw new Error(`${rel} is a Git LFS pointer, not the file: tiles live in plain git; if this checkout moved them to LFS, run \`git lfs pull\``);
  }
  return JSON.parse(text) as T;
}

/** True when `rel` (relative to the repo root) exists. */
export function fileExists(rel: string): boolean {
  return existsSync(join(ROOT, rel));
}

/** Parsed JSON, or null when the file is absent. A file that exists but is not JSON still throws. */
export function readJsonIfExists<T = unknown>(rel: string): T | null {
  return fileExists(rel) ? readJson<T>(rel) : null;
}

/** public/tiles/<world>/manifest.json (schemas/tile-manifest.schema.json). */
export interface WorldManifest {
  version: number;
  world: string;
  origin: { lat: number; lon: number };
  tileSizeM: number;
  spawn: { x: number; z: number; heading: number };
  attribution?: string[];
  tiles: Array<{
    id: string;
    collider: string;
    glb: string | null;
    ix?: number;
    iz?: number;
    bbox?: number[];
    stats?: Record<string, number>;
  }>;
  roads?: string | null;
  /** The citywide collider pack (schemas/world-colliders.md), when the world has one. */
  worldColliders?: string;
  /** Data layers by name (boundary, districts, sidewalks, ...). */
  layers?: Record<string, string>;
}

/** schemas/roads.schema.json, the parts tests read. */
export interface RoadGraphFile {
  version: number;
  nodes: Array<{ id: string; x: number; z: number; y?: number }>;
  edges: Array<{
    id: string;
    a: string;
    b: string;
    kind: string;
    lanes: number;
    oneway: boolean;
    widthM?: number;
    name?: string;
    points: Array<[number, number]>;
  }>;
}

/** True when public/tiles/<name>/manifest.json is committed on this checkout. */
export function worldExists(name: string): boolean {
  return fileExists(`public/tiles/${name}/manifest.json`);
}

export interface WorldFilesNode {
  manifest: WorldManifest;
  /** Every tile collider, in manifest order. */
  tiles: TileCollider[];
  roads: RoadGraphFile | null;
  /** boundary.json (manifest.layers.boundary), or null. */
  boundary: BoundaryFile | null;
  /** Where the colliders came from: the collider pack (when the manifest names one) or per-tile JSON. */
  colliders: "pack" | "json";
}

const worldFilesCache = new Map<string, WorldFilesNode>();

/**
 * The files a world's sim is built from, read from disk exactly as the game reads them
 * (src/io/world-load.ts): the collider pack when the manifest names one, else every tile's
 * collider JSON; the road graph and the boundary when the manifest names them. Cached per world
 * (the data is never mutated).
 */
export function loadWorldFiles(name: string): WorldFilesNode {
  const hit = worldFilesCache.get(name);
  if (hit) return hit;
  const dir = `public/tiles/${name}`;
  const manifest = readJson<WorldManifest>(`${dir}/manifest.json`);
  const colliders = manifest.worldColliders
    ? { pack: new Uint8Array(readFileSync(join(ROOT, dir, manifest.worldColliders))) }
    : { json: manifest.tiles.map((t) => readJson<TileCollider>(`${dir}/${t.collider}`)) };
  const roads = manifest.roads ? readJsonIfExists<RoadGraphFile>(`${dir}/${manifest.roads}`) : null;
  const boundaryFile = manifest.layers?.boundary;
  const boundary = boundaryFile ? readJson<BoundaryFile>(`${dir}/${boundaryFile}`) : null;
  const files = assembleWorldFiles(manifest, colliders, roads as RoadsFile | null, boundary);
  const out: WorldFilesNode = { manifest, tiles: files.tiles, roads, boundary, colliders: files.colliders };
  worldFilesCache.set(name, out);
  return out;
}

/** buildWorld(tiles, roads, boundary): the world as a manifest describes it. */
export function buildWorldWithRoads(tiles: readonly TileCollider[], roads: unknown, boundary: BoundaryFile | null = null): World {
  return buildWorld(tiles, (roads ?? null) as RoadsFile | null, boundary);
}

/**
 * The sim world for a committed world directory. By default colliders only (no road graph, so
 * no ambient traffic, and no boundary walls): what the unit tests have always used, and
 * tests/sim relies on it. Pass { roads: true } for the world exactly as its manifest describes
 * it (road graph and boundary included), as the game builds it.
 */
export function loadWorld(
  name: string,
  opts: { roads?: boolean } = {},
): { world: World; manifest: WorldManifest; roads: RoadGraphFile | null } {
  const { manifest, tiles, roads, boundary } = loadWorldFiles(name);
  const world = opts.roads ? buildWorldWithRoads(tiles, roads, boundary) : buildWorld(tiles);
  return { world, manifest, roads };
}

/** Recursively freeze, so any mutation inside step() throws in strict mode. */
export function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}
