// Reapply road clearance to an already built inventory, offline, without fresh downloads.
// node pipeline/clear-street-trees.ts [--world sf]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ground } from "./lib/terrain.ts";
import { decodeWorldColliders } from "./lib/world-colliders.ts";
import { jsonLines, jsonPretty } from "./lib/output.ts";
import { filterStreetTrees, TREE_DESCRIPTION } from "./lib/clear-street-trees.ts";
import { decodeJunction } from "../src/render/street-markings.ts";
import type { TreeRecord } from "../src/render/street-trees.ts";
import type { RoadGraph } from "../src/render/types.ts";

const at = process.argv.indexOf("--world");
const dir = join(import.meta.dirname, "../public/tiles", at < 0 ? "sf" : process.argv[at + 1]!);
const read = <T>(file: string): T => JSON.parse(readFileSync(join(dir, file), "utf8")) as T;
const manifest = read<{ roads: string; worldColliders: string }>("manifest.json");
const index = read<{ layers: { trees: string; markings: string }; counts: { trees: number } }>("street-detail.json");
const trees = read<{ description: string; classes: string[]; trees: TreeRecord[] }>(index.layers.trees);
const marks = read<{ junctions: unknown[] }>(index.layers.markings);
const pack = decodeWorldColliders(readFileSync(join(dir, manifest.worldColliders)));
const ground = new Ground(pack.tiles.map(t => ({ ix: t.ix, iz: t.iz, field: t.ground })));
const before = trees.trees.length;
trees.trees = filterStreetTrees(trees.trees, trees.classes, read<RoadGraph>(manifest.roads), (x, z) => ground.heightAt(x, z) ?? 0,
  marks.junctions.flatMap(r => { const j = decodeJunction(r); return j ? [j] : []; }));
trees.description = TREE_DESCRIPTION;
index.counts.trees = trees.trees.length;
writeFileSync(join(dir, index.layers.trees), jsonLines(trees, ["trees"]));
writeFileSync(join(dir, "street-detail.json"), jsonPretty(index));
console.log(JSON.stringify({ before, kept: trees.trees.length, removed: before - trees.trees.length }));
