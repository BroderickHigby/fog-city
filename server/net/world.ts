import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { Assets } from "../../src/io/assets.ts";
import { buildLoadedWorld, loadWorldFiles, type WorldFiles } from "../../src/io/world-load.ts";
import { worldFingerprint } from "../../src/net/world-id.ts";
import type { WorldName } from "../../src/net/protocol.ts";
import type { World } from "../../src/sim/index.ts";

export interface WorldBundle { name: WorldName; fingerprint: string; world: World; files: WorldFiles }

/** Read public/ from disk through the same loader the browser uses. Never turns peer text into a path. */
export function diskAssets(publicRoot: string): Assets {
  const root = resolve(publicRoot);
  const file = (path: string): string => {
    const full = resolve(root, path);
    if (!full.startsWith(root + sep)) throw new Error("invalid asset path");
    return full;
  };
  return {
    mode: "loose", defaultWorld: null, worlds: null,
    bytes: async (path) => new Uint8Array(await readFile(file(path))),
    json: async <T>(path: string) => JSON.parse(await readFile(file(path), "utf8")) as T,
    has: () => true,
  };
}

/** One immutable world per name, shared by every room. */
export function worldLoader(publicRoot: string): (name: WorldName) => Promise<WorldBundle> {
  const assets = diskAssets(publicRoot);
  const cached = new Map<WorldName, Promise<WorldBundle>>();
  return (name) => {
    let found = cached.get(name);
    if (found) return found;
    found = (async () => {
      const files = await loadWorldFiles(assets, name);
      return { name, fingerprint: await worldFingerprint(files), world: buildLoadedWorld(files), files };
    })();
    cached.set(name, found);
    found.catch(() => cached.delete(name));
    return found;
  };
}
