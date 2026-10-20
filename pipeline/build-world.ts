// Build a world's committed tiles from open data.
//
//   node pipeline/build-world.ts --world sf            download (cached) + build + write public/tiles/sf/
//   node pipeline/build-world.ts --world sf --offline  build from pipeline/.cache only; fail on a cache miss
//   node pipeline/build-world.ts --world sf --check    rebuild in memory, compare with the committed files
//   node pipeline/build-world.ts --world sf --refresh  re-download everything (inputs change daily)
//
// See docs/data-sources.md for sources, licences and every modelling decision.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildWorldFiles } from "./lib/build.ts";
import type { Override } from "./lib/buildings.ts";
import { loadWorldConfig } from "./lib/config.ts";
import { downloadAll } from "./lib/sources.ts";

const ROOT = join(import.meta.dirname, "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const world = arg("world") ?? "sf";
  const outDir = arg("out") ?? join(ROOT, "public/tiles", world);
  const cacheDir = join(ROOT, "pipeline/.cache");
  const t0 = Date.now();
  const log = (m: string): void => console.log(m);

  const cfg = loadWorldConfig(ROOT, world);
  const overrides = (JSON.parse(readFileSync(join(ROOT, "pipeline/overrides.json"), "utf8")) as { buildings: Override[] }).buildings;
  log(`world ${world}: ${cfg.areas.length} areas (${cfg.areas.map((a) => a.id).join(", ")})`);
  const raw = await downloadAll(cfg, { cacheDir, offline: flag("offline"), refresh: flag("refresh"), log });
  log(`inputs: ${raw.buildings.length} footprints, ${raw.streets.length} street segments, ${raw.parcels.length} parcels, ${raw.businesses.length} businesses, ${raw.dems.length} DEMs (${((Date.now() - t0) / 1000).toFixed(1)} s)`);

  const { files, report } = await buildWorldFiles(cfg, raw, overrides);
  let total = 0;
  for (const b of files.values()) total += b.byteLength;
  log(`built ${files.size} files, ${(total / 1e6).toFixed(2)} MB (${((Date.now() - t0) / 1000).toFixed(1)} s)`);

  if (flag("check")) {
    const differ: string[] = [];
    for (const [rel, bytes] of files) {
      const p = join(outDir, rel);
      if (!existsSync(p) || !Buffer.from(bytes).equals(readFileSync(p))) differ.push(rel);
    }
    const stale = existsSync(outDir) ? readdirSync(outDir).filter((f) => !files.has(f)) : [];
    if (differ.length || stale.length) {
      console.error(`check FAILED: ${differ.length} files differ, ${stale.length} stale`);
      for (const f of [...differ, ...stale].slice(0, 20)) console.error(`  ${f}`);
      process.exit(1);
    }
    log(`check OK: all ${files.size} files byte-identical to ${outDir}`);
    return;
  }

  mkdirSync(outDir, { recursive: true });
  for (const f of readdirSync(outDir)) if (!files.has(f)) rmSync(join(outDir, f));
  for (const [rel, bytes] of files) writeFileSync(join(outDir, rel), bytes);
  log(`wrote ${outDir}`);
  const b = report.buildings;
  log(
    `buildings: ${b.kept} kept of ${b.parts} footprint parts (${b.droppedSmall} tiny, ${b.droppedLow} not standing in the LiDAR, ${b.droppedOutside} outside); ` +
      `assessor join ${(((b.joinMblr + b.joinPoint) / b.kept) * 100).toFixed(1)}% (${b.joinMblr} block/lot, ${b.joinPoint} point-in-footprint); ` +
      `heights: ${b.heightLidar} LiDAR, ${b.heightStories} storeys, ${b.heightOverride} override; ${b.twoTier} two-tier`,
  );
  log(`roads: ${report.roads.edges} edges, ${report.roads.nodes} nodes, ${report.roads.components} components (largest ${report.roads.largestComponentNodes} nodes)`);
  log(`storefronts: ${report.storefronts.kept} (${report.storefronts.noBuilding} no building, ${report.storefronts.noFrontage} no frontage)`);
  log(`spawn: ${JSON.stringify(report.spawn)}`);
  log(`tallest: ${report.tallest.slice(0, 3).map((t) => `${t.id} ${t.heightM} m (${t.source})`).join(", ")}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
