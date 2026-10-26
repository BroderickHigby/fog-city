// Load the files a world's sim needs, the same way in the game, the browser half of the
// determinism tests (tests/e2e/sim-lab.ts) and, through assembleWorldFiles, Node
// (tests/helpers.ts): every client must build an identical World, or they desync.
//
//  - Colliders: the citywide collider pack (manifest.worldColliders, one file for the whole
//    city, and growing, decoded by src/sim/pack.ts; the static build serves it in parts once it
//    is too big for one host file, and src/io/assets.ts joins them) when the manifest names
//    one; otherwise every tile's *.collider.json (the small hand-made dev worlds).
//  - The road graph (manifest.roads) and the world's edge and shore (manifest.layers.boundary).
//    A file the manifest names that cannot be loaded fails the load: a client must never run a
//    roadless or wall-less world beside its peers.
//  - Street props from World detail's street-detail.json (real street trees, signal poles, stop
//    signs and sign posts), which a car can hit and break (src/sim/props.ts). Absent (the dev
//    worlds), the sim places its street trees where the renderer's road-graph trees stand.

import { decodeColliderPack, type BoundaryFile, type RoadsFile, type TileCollider } from "../sim/index.ts";
import type { Assets } from "./assets.ts";
import type { GameplayWorldData } from "../sim/gameplay-world.ts";
import { navigationFromPipeline, type PipelineSidewalks } from "../sim/agents/pipeline-navigation.ts";
import type { TransitLayer } from "../sim/agents/transit-runtime.ts";
import { buildWorld, type World } from "../sim/world.ts";
import type { ParkingLayer, StreetCleaningLayer } from "../sim/parking-data.ts";
import { propsFromStreetDetail, type PropPlacement, type StreetDetailFiles } from "../sim/props.ts";
import { replaceLandmarkWorld, type LandmarkWorldReplacement } from "./landmark-world.ts";
import { buildTrafficSignals, type TrafficSignalFile } from "../sim/traffic-signals.ts";

/**
 * The manifest's data layers (manifest.layers) the game loads: boundary (loadWorldFiles) and
 * districts (main.ts, the park tint). The static build (scripts/build-web.ts) ships only these
 * of the world's layers; tests/io/assets.test.ts checks that every layer read under src/ is
 * listed here, so a feature that starts reading another layer gets it into the build.
 */
export const RUNTIME_LAYERS: readonly string[] = ["boundary", "districts", "gameplay", "sidewalks", "transit", "parking", "streetCleaning", "signals"];

/** The manifest fields the loaders read (schemas/tile-manifest.schema.json). */
export interface WorldManifestLike {
  world?: string;
  spawn: { x: number; z: number; heading: number };
  tiles: ReadonlyArray<{ id: string; collider: string }>;
  roads?: string | null;
  worldColliders?: string;
  layers?: { boundary?: string } & Record<string, string | undefined>;
}

export interface WorldFiles<M extends WorldManifestLike = WorldManifestLike> {
  manifest: M;
  /** In manifest order. */
  tiles: TileCollider[];
  roads: RoadsFile | null;
  boundary: BoundaryFile | null;
  gameplay?: GameplayWorldData | null;
  sidewalks?: PipelineSidewalks | null;
  transit?: TransitLayer | null;
  parking?: ParkingLayer | null;
  streetCleaning?: StreetCleaningLayer | null;
  signals?: TrafficSignalFile | null;
  /** World detail's street props (street-detail.json), when the world has them. */
  streetProps?: PropPlacement[] | null;
  /** Where the colliders came from. */
  colliders: "pack" | "json";
  /** Authored open-air architecture replacing solid footprint extrusions. */
  landmarkReplacements?: LandmarkWorldReplacement[];
}

/**
 * Put the loaded files together: decode the pack (when given) and check it holds exactly the
 * manifest's tiles, in order. Pure apart from the decoding; Node and the browser share it.
 */
export function assembleWorldFiles<M extends WorldManifestLike>(
  manifest: M,
  colliders: { pack: Uint8Array } | { json: TileCollider[] },
  roads: RoadsFile | null,
  boundary: BoundaryFile | null,
  layers:Pick<WorldFiles,"gameplay"|"sidewalks"|"transit"|"parking"|"streetCleaning"|"streetProps"|"signals">={},
): WorldFiles<M> {
  if ("pack" in colliders) {
    const pack = decodeColliderPack(colliders.pack);
    const ids = pack.tiles.map((t) => t.tileId);
    const want = manifest.tiles.map((t) => t.id);
    if (ids.length !== want.length || ids.some((id, i) => id !== want[i])) {
      throw new Error(`collider pack ${manifest.worldColliders}: its ${ids.length} tiles are not the manifest's ${want.length}`);
    }
    return { manifest, ...replaceLandmarkWorld(pack.tiles,manifest.world), roads, boundary, colliders: "pack", ...layers };
  }
  return { manifest, ...replaceLandmarkWorld(colliders.json,manifest.world), roads, boundary, colliders: "json", ...layers };
}

/** Browser, server and replay tools must build the same immutable world metadata. */
export function buildLoadedWorld(files:WorldFiles):World {
  const world=buildWorld(files.tiles,files.roads,files.boundary,files.gameplay??undefined);
  if(files.sidewalks)world.sidewalks=navigationFromPipeline(files.sidewalks).graph;
  if(files.transit)world.transit=files.transit;
  if(files.parking)world.parking=files.parking;
  if(files.streetCleaning)world.streetCleaning=files.streetCleaning;
  if(files.signals&&world.roads)world.signals=buildTrafficSignals(world.roads,files.signals);
  if(files.streetProps)(world as World&{props?:readonly PropPlacement[]}).props=files.streetProps;
  return world;
}

function named(what: string, file: string, err: unknown): Error {
  return new Error(`${what} ${file}: ${err instanceof Error ? err.message : String(err)}`);
}

/** Fetch and assemble public/tiles/<name>/ through `assets`. */
export async function loadWorldFiles<M extends WorldManifestLike = WorldManifestLike>(assets: Assets, name: string): Promise<WorldFiles<M>> {
  const base = `tiles/${name}/`;
  const manifest = await assets.json<M>(`${base}manifest.json`);
  const packFile = manifest.worldColliders;
  const roadsFile = manifest.roads ?? null;
  const boundaryFile = manifest.layers?.boundary ?? null;
  const gameplayFile=manifest.layers?.gameplay;
  const sidewalksFile=manifest.layers?.sidewalks,transitFile=manifest.layers?.transit;
  const parkingFile=manifest.layers?.parking,cleaningFile=manifest.layers?.streetCleaning;
  const signalsFile=manifest.layers?.signals;
  const [colliders, roads, boundary, gameplay,sidewalks,transit,parking,streetCleaning,signals] = await Promise.all([
    packFile
      ? assets.bytes(base + packFile).then(
          (pack) => ({ pack }),
          (err: unknown) => {
            throw named("collider pack", packFile, err);
          },
        )
      : Promise.all(manifest.tiles.map((t) => assets.json<TileCollider>(base + t.collider))).then((json) => ({ json })),
    roadsFile
      ? assets.json<RoadsFile>(base + roadsFile).catch((err: unknown) => {
          throw named("road graph", roadsFile, err);
        })
      : Promise.resolve(null),
    boundaryFile
      ? assets.json<BoundaryFile>(base + boundaryFile).catch((err: unknown) => {
          throw named("boundary", boundaryFile, err);
        })
      : Promise.resolve(null),
    gameplayFile?assets.json<GameplayWorldData>(base+gameplayFile).catch((err:unknown)=>{throw named("gameplay layer",gameplayFile,err);}):Promise.resolve(null),
    sidewalksFile?assets.json<PipelineSidewalks>(base+sidewalksFile).catch((err:unknown)=>{throw named("sidewalk layer",sidewalksFile,err);}):Promise.resolve(null),
    transitFile?assets.json<TransitLayer>(base+transitFile).catch((err:unknown)=>{throw named("transit layer",transitFile,err);}):Promise.resolve(null),
    parkingFile?assets.json<ParkingLayer>(base+parkingFile).catch((err:unknown)=>{throw named("parking layer",parkingFile,err);}):Promise.resolve(null),
    cleaningFile?assets.json<StreetCleaningLayer>(base+cleaningFile).catch((err:unknown)=>{throw named("street-cleaning layer",cleaningFile,err);}):Promise.resolve(null),
    signalsFile?assets.json<TrafficSignalFile>(base+signalsFile).catch((err:unknown)=>{throw named("traffic-signals layer",signalsFile,err);}):Promise.resolve(null),
  ]);
  const streetProps=await loadStreetProps(assets,base);
  return assembleWorldFiles(manifest,colliders,roads,boundary,{gameplay,sidewalks,transit,parking,streetCleaning,streetProps,signals});
}

/** The street-detail.json index's layers a car can hit. */
export interface StreetDetailIndex { layers?: { trees?: string; furniture?: string; signs?: string } }

/**
 * World detail's street props. No street-detail.json (the dev worlds): null. Once the index is
 * there, a layer it names that cannot be loaded fails the load, as the other layers do.
 */
export async function loadStreetProps(assets: Assets, base: string): Promise<PropPlacement[] | null> {
  const index = await assets.json<StreetDetailIndex>(`${base}street-detail.json`).catch(() => null);
  if (!index?.layers) return null;
  const layer = <K extends keyof StreetDetailFiles>(file: string | undefined): Promise<StreetDetailFiles[K] | null> =>
    file ? assets.json<NonNullable<StreetDetailFiles[K]>>(base + file).catch((err: unknown) => { throw named("street-detail layer", file, err); }) : Promise.resolve(null);
  const [trees, furniture, signs] = await Promise.all([layer<"trees">(index.layers.trees), layer<"furniture">(index.layers.furniture), layer<"signs">(index.layers.signs)]);
  return propsFromStreetDetail({ trees, furniture, signs });
}
