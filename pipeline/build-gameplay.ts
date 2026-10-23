// Re-index committed layers without downloading sources or rebuilding geometry.
// node pipeline/build-gameplay.ts [--world sf] [--check] [--out public/tiles/sf]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadWorldConfig, type TileRef } from "./lib/config.ts";
import type { District } from "./lib/districts.ts";
import type { Fountain, Hydrant, Signal, TransitRoute, TransitStop } from "./lib/gameplay.ts";
import { buildGameplayIndex } from "./lib/gameplay-index.ts";
import { pointInRing } from "./lib/geom.ts";
import type { ShoreLine } from "./lib/boundary.ts";
import { jsonLines, jsonPretty } from "./lib/output.ts";
import { RoadSurface, trafficEdges } from "./lib/road-surface.ts";
import type { RoadGraph } from "./lib/roads.ts";
import type { SidewalkGraph } from "./lib/sidewalks.ts";
import { Ground } from "./lib/terrain.ts";
import { decodeWorldColliders, type PackBuilding } from "./lib/world-colliders.ts";

const arg = (key: string): string | undefined => {
  const i = process.argv.indexOf(`--${key}`);
  return i < 0 ? undefined : process.argv[i + 1];
};
const root = join(import.meta.dirname, "..");
const world = arg("world") ?? "sf";
const dir = arg("out") ?? join(root, "public/tiles", world);
const read = <T>(file: string): T => JSON.parse(readFileSync(join(dir, file), "utf8")) as T;
const manifest = read<{ world: string; tileSizeM: number; tiles: TileRef[]; roads: string; worldColliders: string; layers: Record<string, string> }>("manifest.json");
const layer = <T>(key: string): T => {
  const file = manifest.layers[key];
  if (!file) throw new Error(`gameplay: missing ${key} layer`);
  return read<T>(file);
};
const pack = decodeWorldColliders(readFileSync(join(dir, manifest.worldColliders)));
const ground = new Ground(pack.tiles.map((t) => ({ ix: t.ix, iz: t.iz, field: t.ground })));
// Footprints can straddle tile boundaries, so hash their bounds, not only their owner tile.
const cells = new Map<string, PackBuilding[]>();
for (const t of pack.tiles) for (const b of t.buildings) {
  const xs = b.footprint.map((p) => p[0]), zs = b.footprint.map((p) => p[1]);
  for (let ix = Math.floor(Math.min(...xs) / 50); ix <= Math.floor(Math.max(...xs) / 50); ix++) {
    for (let iz = Math.floor(Math.min(...zs) / 50); iz <= Math.floor(Math.max(...zs) / 50); iz++) {
      const key = `${ix},${iz}`, list = cells.get(key) ?? [];
      list.push(b); cells.set(key, list);
    }
  }
}
const roads = read<RoadGraph>(manifest.roads);
const surface = new RoadSurface(trafficEdges(roads.edges));
const cfg = loadWorldConfig(root, world);
const gameplay = buildGameplayIndex({
  world: manifest.world, sourceSnapshot: cfg.sources.snapshotDate ?? "unversioned",
  tileSizeM: manifest.tileSizeM, tiles: manifest.tiles, roads,
  walk: layer<SidewalkGraph>("sidewalks"), districts: layer<{ districts: District[] }>("districts").districts,
  hydrants: layer<{ hydrants: Hydrant[] }>("hydrants").hydrants,
  fountains: layer<{ fountains: Fountain[] }>("fountains").fountains,
  signals: layer<{ signals: Signal[] }>("signals").signals,
  transit: layer<{ routes: TransitRoute[]; stops: TransitStop[] }>("transit"),
  shore: layer<{ shore: ShoreLine[] }>("boundary").shore,
  isLand: (x, z) => ground.heightAt(x, z) !== null && !ground.waterAt(x, z) && !(cells.get(`${Math.floor(x / 50)},${Math.floor(z / 50)}`) ?? []).some((b) => pointInRing(x, z, b.footprint)),
  heightAt: (x, z) => ground.heightAt(x, z), roadClearance: (x, z) => surface.clearance(x, z),
});
manifest.layers.gameplay = "gameplay.json";
const files = { "gameplay.json": jsonLines({ ...gameplay }, ["refills", "anchors", "tiles", "territories"]), "manifest.json": jsonPretty(manifest) };
for (const [file, contents] of Object.entries(files)) {
  if (process.argv.includes("--check")) {
    if (readFileSync(join(dir, file), "utf8") !== contents) throw new Error(`gameplay: ${file} is stale`);
  } else writeFileSync(join(dir, file), contents);
}
console.log(`gameplay ${process.argv.includes("--check") ? "check OK" : "wrote"}: ${gameplay.tiles.length} tiles, ${gameplay.refills.length} refills, ${gameplay.anchors.length} anchors, ${gameplay.territories.length} territory rows`);
