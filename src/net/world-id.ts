import type { WorldFiles } from "../io/world-load.ts";
import { canonicalJson, SIM_VERSION } from "../sim/index.ts";
import { sha256 } from "@noble/hashes/sha256";

/** Hash the simulation inputs, not rendered models: server and browser must load the same world. */
export async function worldFingerprint(files: WorldFiles): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson({
    version: SIM_VERSION,
    spawn: files.manifest.spawn,
    tiles: files.tiles,
    roads: files.roads,
    boundary: files.boundary,
  }));
  // Web Crypto is unavailable on plain HTTP LAN origins. The same implementation works there.
  return Array.from(sha256(bytes), (n) => n.toString(16).padStart(2, "0")).join("");
}
