// Writes the small derived fixtures the world QA tests read (tests never touch the network or
// the download cache): tests/pipeline/fixtures/world-qa/
//   parcels-newer.json  the 2025 roll's parcel points built in or after 2015 with storeys (W-04)
//   lakes.json          the NHD outlines of the lakes pipeline/landcover.json lists (W-11)
//   parks.json          the green Rec and Park properties' outlines, simplified to 1 m (W-18)
//
//   node pipeline/tools/world-qa-fixtures.ts          (offline: reads pipeline/.cache)

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toLocal } from "../../src/geo/project.ts";
import type { Override } from "../lib/buildings.ts";
import { loadWorldConfig } from "../lib/config.ts";
import { cleanRing, simplifyRing, type P2 } from "../lib/geom.ts";
import { geoPolys, loadLandcoverConfig } from "../lib/landcover.ts";
import { downloadAll } from "../lib/sources.ts";

const ROOT = join(import.meta.dirname, "../..");
const OUT = join(ROOT, "tests/pipeline/fixtures/world-qa");
const cfg = loadWorldConfig(ROOT, "sf");
const overrides = (JSON.parse(readFileSync(join(ROOT, "pipeline/overrides.json"), "utf8")) as { buildings: Override[] }).buildings;
const raw = await downloadAll(cfg, { cacheDir: join(ROOT, "pipeline/.cache"), offline: true }, overrides.filter((o) => o.add && o.parcel).map((o) => o.parcel!));
const lc = loadLandcoverConfig(ROOT);
mkdirSync(OUT, { recursive: true });
const d1 = (v: number): number => Math.round(v * 10) / 10;
const ring1 = (r: readonly P2[]): Array<[number, number]> => cleanRing(simplifyRing(r, 1)).map(([x, z]) => [d1(x), d1(z)]);

// W-04: post-2015 parcel points with storeys.
const parcels = raw.parcels
  .filter((p) => Number(p.year_property_built) >= 2015 && Number(p.number_of_stories) > 0 && p.the_geom && p.parcel_number)
  .map((p) => {
    const q = toLocal(p.the_geom!.coordinates[1], p.the_geom!.coordinates[0]);
    return [p.parcel_number!, d1(q.x), d1(q.z), Number(p.year_property_built), Number(p.number_of_stories)] as const;
  })
  .sort((a, b) => (a[0] < b[0] ? -1 : 1));
writeFileSync(
  join(OUT, "parcels-newer.json"),
  JSON.stringify({
    $comment: "The 2025 assessor roll's parcel points built in or after 2015 with storeys (DataSF wv5m-vpq2, ODC PDDL 1.0): [parcel, x, z (local m), year, storeys]. Written by pipeline/tools/world-qa-fixtures.ts.",
    parcels,
  }) + "\n",
);

// W-11: the listed lakes' NHD outlines.
const byId = new Map(raw.landcover!.waterbodies.map((f) => [String(f.properties.permanent_identifier ?? f.properties.PERMANENT_IDENTIFIER ?? ""), f]));
const lakes = lc.lakes.include.map((l) => ({ id: l.nhd, name: l.name, polygons: geoPolys(byId.get(l.nhd)!.geometry).map((p) => p.rings.map(ring1)) }));
writeFileSync(
  join(OUT, "lakes.json"),
  JSON.stringify({ $comment: "USGS NHD large-scale waterbody outlines (public domain) of the lakes pipeline/landcover.json lists, local metres, simplified to 1 m; per polygon the outer ring then holes. Written by pipeline/tools/world-qa-fixtures.ts.", lakes }) + "\n",
);

// W-18: the green Rec and Park properties.
const types = new Set(lc.parks.recParkTypes);
const lawns = new Set(lc.parks.lawnPlazas);
const parks = raw.landcover!.parks
  .filter((p) => types.has(p.propertytype ?? "") || lawns.has(p.property_name ?? ""))
  .map((p) => ({ id: p.property_id ?? "", name: p.property_name ?? "", type: p.propertytype ?? "", polygons: geoPolys(p.shape ?? null).map((q) => q.rings.map(ring1)) }))
  .filter((p) => p.polygons.length > 0);
writeFileSync(
  join(OUT, "parks.json"),
  JSON.stringify({ $comment: "DataSF Recreation and Parks Properties (gtr9-ntp6, ODC PDDL 1.0) of the green types pipeline/landcover.json lists, local metres, simplified to 1 m. Written by pipeline/tools/world-qa-fixtures.ts.", parks }) + "\n",
);
console.log(`fixtures: ${parcels.length} parcels, ${lakes.length} lakes, ${parks.length} parks -> ${OUT}`);
