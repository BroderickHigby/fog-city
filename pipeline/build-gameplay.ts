// Re-index committed layers without downloading sources or rebuilding geometry.
// node pipeline/build-gameplay.ts [--world sf] [--check] [--out public/tiles/sf]
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorldConfig, type TileRef } from "./lib/config.ts";
import type { District } from "./lib/districts.ts";
import type { Fountain, Hydrant, Signal, TransitRoute, TransitStop } from "./lib/gameplay.ts";
import { buildGameplayIndex } from "./lib/gameplay-index.ts";
import { gameplayLand, gameplayMetadata } from "./lib/gameplay-context.ts";
import type { ShoreLine } from "./lib/boundary.ts";
import { jsonLines, jsonPretty } from "./lib/output.ts";
import { RoadSurface, trafficEdges } from "./lib/road-surface.ts";
import type { RoadGraph } from "./lib/roads.ts";
import type { SidewalkGraph } from "./lib/sidewalks.ts";
import { Ground } from "./lib/terrain.ts";
import { decodeWorldColliders } from "./lib/world-colliders.ts";

export function rebuildGameplay(dir: string, sourceSnapshot: string, check = false): {tiles:number;refills:number;anchors:number;territories:number} {
  const read = <T>(file: string): T => JSON.parse(readFileSync(join(dir, file), "utf8")) as T;
  const manifest = read<{ world: string; tileSizeM: number; tiles: TileRef[]; roads: string; worldColliders: string; layers: Record<string, string> }>("manifest.json");
  const layer = <T>(key: string): T => {
    const file = manifest.layers[key];
    if (!file) throw new Error(`gameplay: missing ${key} layer`);
    return read<T>(file);
  };
  const pack = decodeWorldColliders(readFileSync(join(dir, manifest.worldColliders)));
  const ground = new Ground(pack.tiles.map((t) => ({ ix: t.ix, iz: t.iz, field: t.ground })));
  const roads = read<RoadGraph>(manifest.roads);
  const surface = new RoadSurface(trafficEdges(roads.edges));
  const gameplay = buildGameplayIndex({
    world: manifest.world, sourceSnapshot,
    tileSizeM: manifest.tileSizeM, tiles: manifest.tiles, roads,
    walk: layer<SidewalkGraph>("sidewalks"), districts: manifest.layers.districts ? layer<{ districts: District[] }>("districts").districts : [],
    hydrants: layer<{ hydrants: Hydrant[] }>("hydrants").hydrants,
    fountains: layer<{ fountains: Fountain[] }>("fountains").fountains,
    signals: layer<{ signals: Signal[] }>("signals").signals,
    transit: layer<{ routes: TransitRoute[]; stops: TransitStop[] }>("transit"),
    shore: layer<{ shore: ShoreLine[] }>("boundary").shore,
    isLand: gameplayLand(manifest.tiles, manifest.tileSizeM, ground, pack.tiles.flatMap(t=>t.buildings)),
    heightAt: (x, z) => ground.heightAt(x, z), roadClearance: (x, z) => surface.clearance(x, z),
  });
  const report = read<{layers:Record<string,number>}>('report.json');
  const metadata = gameplayMetadata(manifest.layers, report.layers, gameplay);
  manifest.layers = metadata.layers; report.layers = metadata.counts;
  const files = { "gameplay.json": jsonLines({ ...gameplay }, ["refills", "anchors", "tiles", "territories"]), "manifest.json": jsonPretty(manifest), "report.json": jsonPretty(report) };
  for (const [file, contents] of Object.entries(files)) {
    if (check) {
      if (readFileSync(join(dir, file), "utf8") !== contents) throw new Error(`gameplay: ${file} is stale`);
    } else writeFileSync(join(dir, file), contents);
  }
  return {tiles:gameplay.tiles.length,refills:gameplay.refills.length,anchors:gameplay.anchors.length,territories:gameplay.territories.length};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (key:string):string|undefined => {const i=process.argv.indexOf(`--${key}`);return i<0?undefined:process.argv[i+1];};
  const root=join(import.meta.dirname,'..'),world=arg('world')??'sf';
  const cfg=loadWorldConfig(root,world), check=process.argv.includes('--check');
  const result=rebuildGameplay(arg('out')??join(root,'public/tiles',world),cfg.sources.snapshotDate??'unversioned',check);
  console.log(`gameplay ${check?'check OK':'wrote'}: ${result.tiles} tiles, ${result.refills} refills, ${result.anchors} anchors, ${result.territories} territory rows`);
}
