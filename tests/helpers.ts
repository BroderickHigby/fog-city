import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildWorld, type TileCollider, type World } from "../src/sim/index.ts";

export const ROOT = join(import.meta.dirname, "..");

export function readJson<T = unknown>(rel: string): T {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf8")) as T;
}

export function loadWorld(name: string): { world: World; manifest: { spawn: { x: number; z: number; heading: number } } } {
  const manifest = readJson<{ spawn: { x: number; z: number; heading: number }; tiles: Array<{ collider: string }> }>(
    `public/tiles/${name}/manifest.json`,
  );
  const tiles = manifest.tiles.map((t) => readJson<TileCollider>(`public/tiles/${name}/${t.collider}`));
  return { world: buildWorld(tiles), manifest };
}

/** Recursively freeze, so any mutation inside step() throws in strict mode. */
export function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}
