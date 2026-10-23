import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { assembleWorldFiles, type WorldManifestLike } from "../../src/io/world-load.ts";
import { worldFingerprint } from "../../src/net/world-id.ts";
import type { WorldName } from "../../src/net/protocol.ts";
import { buildWorld, type BoundaryFile, type RoadsFile, type Spawn, type TileCollider, type World } from "../../src/sim/index.ts";
import type { GameplayWorldData } from "../../src/sim/gameplay-world.ts";
import { navigationFromPipeline, type PipelineSidewalks } from "../../src/sim/agents/pipeline-navigation.ts";
import type { TransitLayer } from "../../src/sim/agents/transit-runtime.ts";

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
      const baseFiles = assembleWorldFiles(manifest, colliders,
        manifest.roads ? await json<RoadsFile>(manifest.roads) : null,
        manifest.layers?.boundary ? await json<BoundaryFile>(manifest.layers.boundary) : null);
      const [gameplay,sidewalks,transit]=await Promise.all([
        manifest.layers?.gameplay?json<GameplayWorldData>(manifest.layers.gameplay):null,
        manifest.layers?.sidewalks?json<PipelineSidewalks>(manifest.layers.sidewalks):null,
        manifest.layers?.transit?json<TransitLayer>(manifest.layers.transit):null,
      ]);
      const files={...baseFiles,gameplay,sidewalks,transit};
      const fingerprint = await worldFingerprint(files);
      const world=buildWorld(files.tiles,files.roads,files.boundary,gameplay??undefined);
      if(sidewalks)world.sidewalks=navigationFromPipeline(sidewalks).graph;
      if(transit)world.transit=transit;
      return { name, fingerprint, world, spawn: manifest.spawn };
    })();
    cached.set(name, found);
    found.catch(() => cached.delete(name));
    return found;
  };
}
