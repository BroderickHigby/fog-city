import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { assembleWorldFiles, type WorldManifestLike } from "../../src/io/world-load.ts";
import { worldFingerprint } from "../../src/net/world-id.ts";
import type { WorldName } from "../../src/net/protocol.ts";
import { buildWorld, type BoundaryFile, type RoadsFile, type Spawn, type TileCollider, type World } from "../../src/sim/index.ts";

export interface WorldBundle { name: WorldName; fingerprint: string; world: World; spawn: Spawn }

/** Reuse one immutable world per name across rooms. Nothing requested by a peer becomes a path. */
export function worldLoader(publicRoot: string): (name: WorldName) => Promise<WorldBundle> {
  const cached = new Map<WorldName, Promise<WorldBundle>>();
  return (name) => {
    let found = cached.get(name);
    if (found) return found;
    found = (async () => {
      const root = resolve(publicRoot, "tiles", name);
      const file = (part: string): string => {
        const path = resolve(root, part);
        if (!path.startsWith(root + sep)) throw new Error("invalid world asset path");
        return path;
      };
      const json = async <T>(part: string): Promise<T> => JSON.parse(await readFile(file(part), "utf8")) as T;
      const manifest = await json<WorldManifestLike>("manifest.json");
      const colliders = manifest.worldColliders
        ? { pack: new Uint8Array(await readFile(file(manifest.worldColliders))) }
        : { json: await Promise.all(manifest.tiles.map((t) => json<TileCollider>(t.collider))) };
      const files = assembleWorldFiles(manifest, colliders,
        manifest.roads ? await json<RoadsFile>(manifest.roads) : null,
        manifest.layers?.boundary ? await json<BoundaryFile>(manifest.layers.boundary) : null);
      const fingerprint = await worldFingerprint(files);
      return { name, fingerprint, world: buildWorld(files.tiles, files.roads, files.boundary), spawn: manifest.spawn };
    })();
    cached.set(name, found);
    found.catch(() => cached.delete(name));
    return found;
  };
}
