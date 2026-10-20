// Writes the dev-city test world to public/tiles/dev-city/:
//   manifest.json, roads.json, t<ix>_<iz>.collider.json for the sim, t<ix>_<iz>.glb for the
//   renderer. One land tile is left with glb: null on purpose so the renderer's
//   build-from-collider path runs in the same world as its glb path.
//
// Run: node src/render/tools/build-dev-city.ts            (writes the files)
//      node src/render/tools/build-dev-city.ts --check    (exit 1 if committed files differ)

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ORIGIN } from "../../geo/project.ts";
import { buildWorld, groundHeight } from "../../sim/world.ts";
import { mulberry32 } from "../hash.ts";
import { assignEdgesToTiles, nodeClearance, nodeDegrees, nodeHalfWidth } from "../roads.ts";
import { buildTileMeshes, drain } from "../tile-build.ts";
import { MeshBuilder, addTree, defaultGroundColor, srgb, type GroundColorFn, type MeshData, type RGB } from "../tile-geometry.ts";
import { tileBounds } from "../tile-select.ts";
import type { Manifest } from "../types.ts";
import { BOULEVARD, PARKS, TILE, WORLD, buildDevCity, inPark, inPlaza, inlandDistance, type DevCity } from "./dev-city-layout.ts";
import { encodeTileGlb } from "./glb.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const OUT = join(ROOT, "public", "tiles", WORLD);
/** The tile that ships without a glb (exercises the collider path). */
export const COLLIDER_ONLY_TILE = "t-5_1";

const GRASS: RGB = srgb(0x6f8a45);
const GRASS2: RGB = srgb(0x5f7c3e);
const PAVERS: RGB = srgb(0xb4ab9b);
const PROMENADE: RGB = srgb(0xa49d90);

const groundColor: GroundColorFn = (x, z, h, slope) => {
  if (h > 0.4 && inPark(x, z)) {
    const n = Math.sin(x * 0.11) * Math.cos(z * 0.13);
    return n > 0 ? GRASS : GRASS2;
  }
  if (inPlaza(x, z)) return PAVERS;
  if (h > 1.0 && inlandDistance(x, z, BOULEVARD) < -8) return PROMENADE;
  return defaultGroundColor(x, z, h, slope);
};

function parkTrees(city: DevCity, tileId: string, ground: (x: number, z: number) => number): MeshData | null {
  const t = city.tiles.find((q) => q.id === tileId)!;
  const [minX, minZ, maxX, maxZ] = t.bbox;
  const mb = new MeshBuilder();
  for (const p of PARKS) {
    const rnd = mulberry32(p.id.length * 7919 + Math.round(p.x) * 31 + Math.round(p.z));
    const n = Math.round((Math.PI * p.r * p.r) / 140);
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd()) * (p.r - 6);
      const x = p.x + Math.cos(a) * r;
      const z = p.z + Math.sin(a) * r;
      const s = 0.8 + rnd() * 0.6;
      const variant = rnd() < 0.3 ? 1 : 0;
      const rot = rnd() * Math.PI * 2;
      const tint = rnd();
      // Leave a clearing in the middle of each park.
      if (r < p.r * 0.25) continue;
      if (x < minX || x >= maxX || z < minZ || z >= maxZ) continue;
      addTree(mb, x, ground(x, z), z, s, rot, variant, tint);
    }
  }
  return mb.indexCount > 0 ? mb.build() : null;
}

export interface Output {
  files: Map<string, Uint8Array | string>;
}

export async function generate(): Promise<Output> {
  const city = buildDevCity();
  const files = new Map<string, Uint8Array | string>();
  const json = (v: unknown): string => JSON.stringify(v) + "\n";

  const world = buildWorld(city.tiles.map((t) => t.collider));
  const ground = (x: number, z: number): number => groundHeight(world, x, z);
  const manifestTiles: Manifest["tiles"] = [];
  const bounds = city.tiles.map((t) => tileBounds({ id: t.id, bbox: t.bbox, collider: "", glb: null }, TILE));
  const byTile = assignEdgesToTiles(city.roads.edges, bounds);
  const roadCtx = {
    ground,
    degrees: nodeDegrees(city.roads),
    nodeHalfWidth: nodeHalfWidth(city.roads),
    nodeOuter: nodeClearance(city.roads),
    step: 10,
  };

  for (const t of city.tiles) {
    const colliderName = `${t.id}.collider.json`;
    files.set(colliderName, json(t.collider));
    const glbName = t.id === COLLIDER_ONLY_TILE ? null : `${t.id}.glb`;
    manifestTiles.push({
      id: t.id,
      ix: t.ix,
      iz: t.iz,
      bbox: t.bbox,
      collider: colliderName,
      glb: glbName,
      stats: { buildings: t.collider.buildings.length, roadEdges: byTile.get(t.id)?.length ?? 0 },
    });
    if (!glbName) continue;
    const meshes = drain(
      buildTileMeshes({
        collider: t.collider,
        bounds: bounds.find((b) => b.id === t.id)!,
        roads: byTile.get(t.id) ?? [],
        roadCtx,
        groundColor,
      }),
    );
    const trees = parkTrees(city, t.id, ground);
    const parts = [
      meshes.ground && { name: "ground", material: "ground", data: meshes.ground },
      meshes.buildings && { name: "buildings", material: "building", data: meshes.buildings },
      meshes.roads && { name: "roads", material: "road", data: meshes.roads },
      trees && { name: "foliage", material: "foliage", data: trees },
    ].filter((p): p is { name: string; material: string; data: MeshData } => !!p);
    files.set(glbName, await encodeTileGlb(parts, { tile: t.id, world: WORLD }));
  }

  const manifest: Manifest = {
    version: 1,
    world: WORLD,
    origin: { lat: ORIGIN.lat, lon: ORIGIN.lon },
    tileSizeM: TILE,
    spawn: city.spawn,
    attribution: [
      "Procedural test world for the renderer (src/render/tools/build-dev-city.ts). Not real geography; street names are invented.",
    ],
    tiles: manifestTiles,
    roads: "roads.json",
  };
  files.set("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  files.set("roads.json", json(city.roads));
  return { files };
}

function same(a: Uint8Array | string, b: Buffer): boolean {
  const buf = typeof a === "string" ? Buffer.from(a, "utf8") : Buffer.from(a);
  return buf.equals(b);
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const { files } = await generate();
  if (check) {
    let bad = 0;
    for (const [name, data] of files) {
      const p = join(OUT, name);
      if (!existsSync(p) || !same(data, readFileSync(p))) {
        console.error(`differs: ${name}`);
        bad++;
      }
    }
    const extra = existsSync(OUT) ? readdirSync(OUT).filter((f) => !files.has(f)) : [];
    for (const f of extra) console.error(`not generated: ${f}`);
    if (bad || extra.length) process.exit(1);
    console.log(`dev-city up to date (${files.size} files)`);
    return;
  }
  if (existsSync(OUT)) rmSync(OUT, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  let bytes = 0;
  for (const [name, data] of files) {
    writeFileSync(join(OUT, name), data);
    bytes += typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
  }
  const manifest = JSON.parse(files.get("manifest.json") as string) as Manifest;
  const buildings = manifest.tiles.reduce((s, t) => s + (t.stats?.buildings ?? 0), 0);
  console.log(`wrote ${files.size} files, ${(bytes / 1e6).toFixed(2)} MB, ${manifest.tiles.length} tiles, ${buildings} buildings`);
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
