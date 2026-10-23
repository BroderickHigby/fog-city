// Shared fixture for the house-kit tests: sf tiles prepared exactly as the tile streamer
// prepares them (applyHouseKit on the glb's buildings node), with the world's house colours.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BufferGeometry, Group, Mesh } from "three";
import { createTileLoader } from "../../src/render/gltf-loader.ts";
import { HouseColours, houseLookFn, type DistrictsLike } from "../../src/render/house-colours.ts";
import { decodeFronts, type FacadeMeshOut, type FrontRow } from "../../src/render/house-kit.ts";
import { applyHouseKit } from "../../src/render/house-kit-mesh.ts";
import type { TileCollider } from "../../src/sim/world.ts";
import { ROOT } from "../helpers.ts";

export const SF = join(ROOT, "public/tiles/sf");
export const HAS_SF = existsSync(join(SF, "manifest.json"));

export interface SfManifestLite {
  tiles: Array<{ id: string; glb: string; collider: string; bbox: [number, number, number, number] }>;
}

export interface MetaBuilding {
  id: string;
  footprint: Array<[number, number]>;
  baseY: number;
  topY: number;
  meta: { year?: number; use?: string; stories?: number; towerOf?: string; pieceOf?: string; streetY?: number };
}

export interface PreparedTile {
  id: string;
  bbox: [number, number, number, number];
  geometry: BufferGeometry;
  fronts: FrontRow[];
  prep: FacadeMeshOut;
  ranges: Array<[string, number, number]>;
  buildings: Map<string, MetaBuilding>;
}

export function manifest(): SfManifestLite {
  return JSON.parse(readFileSync(join(SF, "manifest.json"), "utf8")) as SfManifestLite;
}

export function collider(file: string): { tileId: string; buildings: MetaBuilding[] } {
  return JSON.parse(readFileSync(join(SF, file), "utf8")) as { tileId: string; buildings: MetaBuilding[] };
}

export function loadGlb(bytes: Uint8Array): Promise<Group> {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Promise((resolve, reject) => createTileLoader().parse(ab, "", (g) => resolve(g.scene), reject));
}

/** Tile ids around a centre tile (the centre and its eight neighbours) that exist in the manifest. */
export function around(m: SfManifestLite, id: string): string[] {
  const [, a, b] = /^t(-?\d+)_(-?\d+)$/.exec(id)!;
  const out: string[] = [];
  const ids = new Set(m.tiles.map((t) => t.id));
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const k = `t${Number(a) + dx}_${Number(b) + dz}`;
    if (ids.has(k)) out.push(k);
  }
  return out;
}

/**
 * Prepare `ids` with the house look built over `colourTiles` (their colliders: rows of touching
 * houses that cross a tile border are coloured whole when the neighbours are in the set).
 */
export async function prepareTiles(ids: readonly string[], colourTiles: readonly string[]): Promise<{ tiles: Map<string, PreparedTile>; colours: HouseColours }> {
  const m = manifest();
  const byId = new Map(m.tiles.map((t) => [t.id, t]));
  const districts = JSON.parse(readFileSync(join(SF, "districts.json"), "utf8")) as DistrictsLike;
  const cols = new Map<string, { tileId: string; buildings: MetaBuilding[] }>();
  for (const id of new Set([...ids, ...colourTiles])) {
    const t = byId.get(id);
    if (t) cols.set(id, collider(t.collider));
  }
  const colours = new HouseColours([...cols.values()] as unknown as TileCollider[], districts);
  const look = houseLookFn(colours);
  const anchors = (JSON.parse(readFileSync(join(SF, "storefronts.json"), "utf8")) as { storefronts: Array<{ x: number; z: number; buildingId: string }> }).storefronts;
  const tiles = new Map<string, PreparedTile>();
  for (const id of ids) {
    const t = byId.get(id);
    if (!t) continue;
    const scene = await loadGlb(new Uint8Array(readFileSync(join(SF, t.glb))));
    scene.updateMatrixWorld(true);
    const node = scene.getObjectByName("buildings") as Mesh<BufferGeometry> | undefined;
    if (!node) continue;
    const ranges = node.userData.buildings as Array<[string, number, number]>;
    const fronts = decodeFronts(node.userData.fronts, t.bbox[0], t.bbox[1]);
    // As the tile streamer offers them: every anchor within 2 m of the tile.
    const shops = anchors.filter((a) => a.x >= t.bbox[0] - 2 && a.x <= t.bbox[2] + 2 && a.z >= t.bbox[1] - 2 && a.z <= t.bbox[3] + 2);
    const prep = applyHouseKit(node.geometry, node.matrixWorld, ranges, fronts, look, shops)!;
    tiles.set(id, { id, bbox: t.bbox, geometry: node.geometry, fronts, prep, ranges, buildings: new Map(cols.get(id)!.buildings.map((b) => [b.id, b])) });
  }
  return { tiles, colours };
}
