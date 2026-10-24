import type { WorldFiles } from "../io/world-load.ts";
import { hashState, SIM_VERSION } from "../sim/index.ts";

/**
 * A cheap identity of the simulation inputs a match depends on, identical in Node and every
 * browser (the sim's own FNV hash over canonical JSON). It catches a client and relay built from
 * different world data or sim versions; it is not a security boundary. Rendered models are left
 * out: they never reach the sim.
 */
export function worldFingerprint(files: Pick<WorldFiles, "manifest" | "boundary" | "gameplay" | "sidewalks" | "streetProps">): string {
  const manifest = files.manifest;
  const tiles = manifest.tiles as ReadonlyArray<{ id: string; stats?: unknown }>;
  return hashState({
    sim: SIM_VERSION,
    spawn: manifest.spawn,
    tiles: tiles.map((t) => [t.id, t.stats ?? null]),
    boundary: files.boundary ?? null,
    refills: files.gameplay?.refills ?? [],
    source: files.gameplay?.sourceSnapshot ?? "",
    sidewalks: files.sidewalks ? [files.sidewalks.nodes.length, files.sidewalks.edges.length] : null,
    // Street props a car can hit (src/sim/props.ts); left out when absent, so older ids hold.
    ...(files.streetProps ? { streetProps: files.streetProps.length } : {}),
  });
}
