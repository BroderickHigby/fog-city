// Shared test helpers (Node side). Used by unit tests (Vitest) and by the Playwright
// process that drives the browser (tests/e2e). Never touches the network: worlds are read
// from the committed files under public/tiles/<world>/.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildWorld, type TileCollider, type World } from "../src/sim/index.ts";

export const ROOT = join(import.meta.dirname, "..");

export function readJson<T = unknown>(rel: string): T {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf8")) as T;
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

/** The raw files of a world: manifest, every tile collider in manifest order, and the road graph (or null). */
export function loadWorldFiles(name: string): { manifest: WorldManifest; tiles: TileCollider[]; roads: RoadGraphFile | null } {
  const dir = `public/tiles/${name}`;
  const manifest = readJson<WorldManifest>(`${dir}/manifest.json`);
  const tiles = manifest.tiles.map((t) => readJson<TileCollider>(`${dir}/${t.collider}`));
  const roads = manifest.roads ? readJsonIfExists<RoadGraphFile>(`${dir}/${manifest.roads}`) : null;
  return { manifest, tiles, roads };
}

/**
 * buildWorld(tiles, roads). The road graph argument is additive in sim v2; a sim that does not
 * take it ignores it, so harness code calls through this one place and works on either.
 */
export function buildWorldWithRoads(tiles: readonly TileCollider[], roads: unknown): World {
  return (buildWorld as unknown as (t: readonly TileCollider[], r?: unknown) => World)(tiles, roads ?? null);
}

/**
 * The sim world for a committed world directory. By default without the road graph (so no
 * ambient traffic): what the unit tests have always used, and tests/sim relies on it. Pass
 * { roads: true } for the world exactly as its manifest describes it.
 */
export function loadWorld(
  name: string,
  opts: { roads?: boolean } = {},
): { world: World; manifest: WorldManifest; roads: RoadGraphFile | null } {
  const { manifest, tiles, roads } = loadWorldFiles(name);
  const world = opts.roads ? buildWorldWithRoads(tiles, roads) : buildWorld(tiles);
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
