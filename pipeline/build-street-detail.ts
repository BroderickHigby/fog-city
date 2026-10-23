// Street-detail layers for a built world: junction paint (crosswalks, stop bars, junction
// patches) from the committed road graph and signals plus pinned DataSF snapshots
// (pipeline/lib/street-detail-sources.ts). Writes public/tiles/<world>/street-detail.json
// (the index the renderer reads) and the layer files it lists. Render-only data: nothing
// here is a collider, so the sim is untouched.
//
//   node pipeline/build-street-detail.ts [--world sf]            download (cached) + write
//   node pipeline/build-street-detail.ts --offline                from pipeline/.cache only
//   node pipeline/build-street-detail.ts --check                  exit 1 unless the files are byte-identical
//   node pipeline/build-street-detail.ts --refresh                re-download and move the pinned snapshot
// Flags: --cache <dir>, --out <dir>.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jsonLines, jsonPretty } from "./lib/output.ts";
import type { RoadGraph } from "./lib/roads.ts";
import { downloadStreetDetail, streetDetailAttribution, writeSnapshot } from "./lib/street-detail-sources.ts";
import { buildFurniture } from "./lib/street-furniture.ts";
import { buildTrees, TREE_CLASSES, type TreeRow } from "./lib/street-trees.ts";
import { buildStreetSigns, type SignRow } from "./lib/street-signs.ts";
import { buildMarkings, stopApproaches, type Junction, type MarkingStats } from "./lib/street-markings.ts";
import { Ground } from "./lib/terrain.ts";
import { STREET_DETAIL_INDEX } from "../src/render/street-markings.ts";
import { decodeWorldColliders } from "./lib/world-colliders.ts";

export const MARKINGS_FILE = "street-markings.json";
export const FURNITURE_FILE = "street-furniture.json";
export const SIGNS_FILE = "street-signs.json";
export const TREES_FILE = "street-trees.json";

const STYLE_CODE = { continental: "c", standard: "s" } as const;

/** One junction as one compact record: ring relative to the node, legs as fixed-order arrays. */
export function encodeJunction(j: Junction): Record<string, unknown> {
  const rel = (v: number): number => Math.round(v * 100) / 100;
  return {
    id: j.id,
    x: j.x,
    z: j.z,
    k: j.kind,
    ring: j.ring.flatMap(([x, z]) => [rel(x - j.x), rel(z - j.z)]),
    legs: j.legs.map((l) => [
      l.edge, l.ux, l.uz, l.ox, l.oz, l.half, l.mouth,
      l.crosswalk ? STYLE_CODE[l.crosswalk.style] : "", l.crosswalk?.from ?? 0, l.crosswalk?.to ?? 0,
      l.stop?.at ?? 0, l.stop?.v0 ?? 0, l.stop?.v1 ?? 0,
    ]),
  };
}

export interface StreetDetailOutput {
  files: Record<string, string>;
  stats: MarkingStats & { stopSigns: { matched: number; unmatched: number }; furniture: { signals: number; stopSigns: number }; signs: ReturnType<typeof buildStreetSigns>["stats"] & { posts: number } };
}

export function buildStreetDetail(
  dir: string,
  rows: Record<string, Array<Record<string, string>>>,
  snapshotDate: string,
): StreetDetailOutput {
  const read = <T>(file: string): T => JSON.parse(readFileSync(join(dir, file), "utf8")) as T;
  const manifest = read<{ world: string; roads: string; worldColliders: string; layers: Record<string, string> }>("manifest.json");
  const roads = read<RoadGraph>(manifest.roads);
  const pack = decodeWorldColliders(readFileSync(join(dir, manifest.worldColliders)));
  const ground = new Ground(pack.tiles.map((t) => ({ ix: t.ix, iz: t.iz, field: t.ground })));
  const signalLayer = manifest.layers.signals ? read<{ signals: Array<{ node: string; kind: string; ped: boolean }> }>(manifest.layers.signals).signals : [];
  const signals = new Set(signalLayer.filter((s) => s.kind === "signal").map((s) => s.node));
  const nodeIds = new Set(roads.nodes.map((n) => n.id));
  const continental = new Set<string>();
  for (const r of rows.continental ?? []) {
    const id = `n${Math.round(Number(r.cnn))}`;
    if (nodeIds.has(id)) continental.add(id);
  }
  const stops = stopApproaches(rows.stopSigns ?? [], roads);
  const { junctions, stats } = buildMarkings(roads, { continental, signals, stopApproaches: stops.approaches }, (x, z) => ground.heightAt(x, z) ?? 0);
  const signalPed = new Map(signalLayer.filter((s) => s.kind === "signal").map((s) => [s.node, { ped: s.ped }]));
  const furniture = buildFurniture(roads, junctions, signalPed, stops.approaches);

  const attribution = [
    "Junction paint, signals, stop signs and street signs: placed by pipeline/build-street-detail.ts from the road graph (DataSF 3psu-pn9h) and traffic signals (SFMTA ybh5-27n2).",
    streetDetailAttribution(["continental", "stopSigns", "streetSigns"]),
  ];
  const markings = jsonLines(
    {
      version: 1,
      world: manifest.world,
      description:
        "Junction paint, one record per road node where three or more at-grade legs meet. ring: the asphalt patch outline over the junction, [dx, dz, ...] metres from the node, clockwise on the map. legs (clockwise): [edge, ux, uz, ox, oz (the leg line: the point t metres along the leg is node + (ox, oz) + t (ux, uz), u pointing away from the node), half (half the carriageway), mouth (patch reach along the leg), crosswalk style ('c' continental, 's' standard, '' none), crosswalk from, to (metres from the node), stop bar at, v0, v1 (metres from the node; lateral offsets along (-uz, ux)), all 0 when there is none].",
      snapshotDate,
      attribution: attribution.join(" "),
      junctions: junctions.map(encodeJunction),
    },
    ["junctions"],
  );
  const furnitureFile = jsonLines(
    {
      version: 1,
      world: manifest.world,
      description:
        "Traffic signal poles and stop signs at junctions (render-only). heading: compass bearing (radians clockwise from north) the head or sign faces, toward the approaching traffic. group: signal phase group (0/1, one per axis). arm: mast-arm length over the lanes (m, 0 = none). ped: bearing of the pedestrian head, or null. allWay: every approach into the node is stop-controlled.",
      snapshotDate,
      attribution: attribution.join(" "),
      signals: furniture.signals,
      stopSigns: furniture.stopSigns,
    },
    ["signals", "stopSigns"],
  );
  const signs = buildStreetSigns(roads, junctions, (rows.streetSigns ?? []) as SignRow[]);
  const signsFile = jsonLines(
    {
      version: 1,
      world: manifest.world,
      description:
        "Street signs (render-only). corners: one post per junction corner with street-name blades (name as signed, heading: compass bearing the blade lies along, in [0, pi)) and one-way signs (bearing the arrow points); inferred: placed from the road names where SFMTA lists no blade. curb: kerbside regulation signs on their block's sidewalk, heading = bearing along the street, kind: cleaning | permit | time | noParking | tow (generic faces; legends are not reproduced).",
      snapshotDate,
      attribution: [attribution[0], streetDetailAttribution(["streetSigns"])].join(" "),
      corners: signs.corners,
      curb: signs.curb,
    },
    ["corners", "curb"],
  );
  // Trees on land inside the world: on a tile with ground and above the sea.
  const tileIds = new Set(pack.tiles.map((t) => `${t.ix},${t.iz}`));
  const trees = buildTrees((rows.trees ?? []) as TreeRow[], (x, z) => tileIds.has(`${Math.floor(x / 500)},${Math.floor(z / 500)}`) && (ground.heightAt(x, z) ?? -1) > 0.2);
  const treesFile = jsonLines(
    {
      version: 1,
      world: manifest.world,
      description:
        "Street trees (render-only), one per line: [treeid, x, z, class, height m]. class indexes `classes`. Placed from San Francisco Public Works' Street Tree Inventory; height from trunk diameter (pipeline/lib/street-trees.ts). Ids for knockable props: tree:<treeid>.",
      snapshotDate,
      attribution: streetDetailAttribution(["trees"]),
      classes: [...TREE_CLASSES],
      trees: trees.trees,
    },
    ["trees"],
  );
  const index = jsonPretty({
    version: 1,
    world: manifest.world,
    description: "Street-detail layers (render-only): see docs/data-sources.md, Street detail.",
    snapshotDate,
    attribution: [...attribution, streetDetailAttribution(["trees"])],
    layers: { markings: MARKINGS_FILE, furniture: FURNITURE_FILE, signs: SIGNS_FILE, trees: TREES_FILE, ...(existsSync(join(dir, "storefronts.json")) ? { storefronts: "storefronts.json" } : {}) },
    counts: {
      junctions: stats.junctions,
      continentalCrosswalks: stats.crosswalks.continental,
      standardCrosswalks: stats.crosswalks.standard,
      stopBars: stats.stopBars,
      signalPoles: furniture.signals.length,
      stopSigns: furniture.stopSigns.length,
      signPosts: signs.corners.length,
      curbSigns: signs.curb.length,
      trees: trees.trees.length,
    },
  });
  return { files: { [STREET_DETAIL_INDEX]: index, [MARKINGS_FILE]: markings, [FURNITURE_FILE]: furnitureFile, [SIGNS_FILE]: signsFile, [TREES_FILE]: treesFile }, stats: { ...stats, stopSigns: { matched: stops.matched, unmatched: stops.unmatched }, furniture: { signals: furniture.signals.length, stopSigns: furniture.stopSigns.length }, signs: { ...signs.stats, posts: signs.corners.length } } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (key: string): string | undefined => {
    const i = process.argv.indexOf(`--${key}`);
    return i < 0 ? undefined : process.argv[i + 1];
  };
  const flag = (key: string): boolean => process.argv.includes(`--${key}`);
  const root = join(import.meta.dirname, "..");
  const world = arg("world") ?? "sf";
  const out = arg("out") ?? join(root, "public/tiles", world);
  const snapshotFile = join(root, "pipeline", "street-detail-snapshot.json");
  const t0 = Date.now();
  const { rows, snapshot, changed } = await downloadStreetDetail({
    cacheDir: arg("cache") ?? join(root, "pipeline", ".cache"),
    offline: flag("offline") || flag("check"),
    refresh: flag("refresh"),
    snapshotFile,
    log: (m) => console.log(m),
  });
  const result = buildStreetDetail(out, rows, snapshot.snapshotDate);
  if (flag("check")) {
    const stale = Object.entries(result.files).filter(([f, s]) => {
      try {
        return readFileSync(join(out, f), "utf8") !== s;
      } catch {
        return true;
      }
    });
    if (stale.length || changed) {
      console.error(`street detail: stale ${stale.map(([f]) => f).join(", ")}${changed ? " (snapshot changed)" : ""}`);
      process.exit(1);
    }
  } else {
    for (const [f, s] of Object.entries(result.files)) writeFileSync(join(out, f), s);
    if (changed) writeSnapshot(snapshotFile, snapshot);
  }
  const s = result.stats;
  console.log(
    `street detail ${flag("check") ? "check OK" : "wrote"} (${((Date.now() - t0) / 1000).toFixed(1)} s): ${s.junctions} junctions, ` +
      `${s.crosswalks.continental} continental + ${s.crosswalks.standard} standard crosswalks, ${s.stopBars} stop bars, ` +
      `${s.furniture.signals} signal poles, ${s.furniture.stopSigns} stop signs, ${s.signs.posts} sign posts (${s.signs.inferred} inferred), ${s.signs.curbRows} curb signs (${s.signs.unplaced} sign rows unplaced); ` +
      `stop signs ${s.stopSigns.matched} matched, ${s.stopSigns.unmatched} unmatched; skipped ${s.skipped.freeway} freeway, ${s.skipped.deck} deck nodes`,
  );
}
