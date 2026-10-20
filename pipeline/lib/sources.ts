// Downloads (through the cache) of every raw input the world is built from.
// Only columns the pipeline uses are requested; business names are never requested.

import { TILE_SIZE_M } from "../../src/geo/project.ts";
import { areaTileRect, q6, rectLatLon, type WorldConfig } from "./config.ts";
import { cachedGet, socrataAll, type FetchOptions } from "./fetch.ts";
import { parseGeoTiff, type GeoRaster } from "./geotiff.ts";

export interface RawBuilding {
  sf16_bldgid: string;
  mblr?: string;
  gnd_mincm?: string;
  gnd_maxcm?: string;
  gnd_meancm?: string;
  gnd_mediancm?: string;
  hgt_mincm?: string;
  hgt_maxcm?: string;
  hgt_meancm?: string;
  hgt_mediancm?: string;
  hgt_stdcm?: string;
  shape?: { type: "MultiPolygon" | "Polygon"; coordinates: unknown };
}

export interface RawStreet {
  cnn: string;
  street?: string;
  st_type?: string;
  streetname?: string;
  f_node_cnn?: string;
  t_node_cnn?: string;
  classcode?: string;
  layer?: string;
  oneway?: string;
  line?: { type: "LineString" | "MultiLineString"; coordinates: unknown };
}

export interface RawParcel {
  parcel_number?: string;
  block?: string;
  lot?: string;
  year_property_built?: string;
  use_code?: string;
  use_definition?: string;
  number_of_stories?: string;
  number_of_units?: string;
  the_geom?: { type: "Point"; coordinates: [number, number] };
}

export interface RawBusiness {
  uniqueid: string;
  self_reported_naics_code?: string;
  location?: { type: "Point"; coordinates: [number, number] };
}

export interface DemRequest {
  areaId: string;
  url: string;
}

export interface RawInputs {
  buildings: RawBuilding[];
  streets: RawStreet[];
  parcels: RawParcel[];
  businesses: RawBusiness[];
  /** One raster per area, in areas.json order. */
  dems: Array<{ areaId: string; raster: GeoRaster }>;
}

/** Padding around each area's tile rectangle for queries, metres. */
const QUERY_PAD_M = 120;
/** DEM pixel size in degrees (square in degrees: the ImageServer forces it). ~4.0 m E-W, ~5.0 m N-S. */
const DEM_DEG = 0.000045;
const DEM_PAD_M = 150;

function wktBox(b: { north: number; west: number; south: number; east: number }): string {
  const { north: n, west: w, south: s, east: e } = b;
  return `POLYGON((${q6(w)} ${q6(s)}, ${q6(e)} ${q6(s)}, ${q6(e)} ${q6(n)}, ${q6(w)} ${q6(n)}, ${q6(w)} ${q6(s)}))`;
}

function withinBox(field: string, b: { north: number; west: number; south: number; east: number }): string {
  return `within_box(${field}, ${q6(b.north)}, ${q6(b.west)}, ${q6(b.south)}, ${q6(b.east)})`;
}

/** The DEM request for one area: its tile rectangle plus a margin, square-degree pixels. */
export function demUrl(cfg: WorldConfig, areaId: string): string {
  const a = cfg.areas.find((x) => x.id === areaId)!;
  const b = rectLatLon(areaTileRect(a), DEM_PAD_M);
  const w = Math.ceil((b.east - b.west) / DEM_DEG);
  const h = Math.ceil((b.north - b.south) / DEM_DEG);
  // Snap the box to whole pixels so the server does not stretch it.
  const west = Math.floor(b.west / DEM_DEG) * DEM_DEG;
  const north = Math.ceil(b.north / DEM_DEG) * DEM_DEG;
  const east = west + w * DEM_DEG;
  const south = north - h * DEM_DEG;
  const bbox = [west, south, east, north].map((v) => v.toFixed(7)).join(",");
  return (
    "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage" +
    `?bbox=${bbox}&bboxSR=4326&imageSR=4326&size=${w},${h}&format=tiff&pixelType=F32` +
    "&interpolation=RSP_BilinearInterpolation&f=image"
  );
}

const STOREFRONT_NAICS_PREFIXES = ["44", "45", "722", "8121", "8123"];

export async function downloadAll(cfg: WorldConfig, opts: FetchOptions): Promise<RawInputs> {
  const log = opts.log ?? (() => {});
  const src = cfg.sources;
  const buildings = new Map<string, RawBuilding>();
  const streets = new Map<string, RawStreet>();
  const parcels = new Map<string, RawParcel>();
  const businesses = new Map<string, RawBusiness>();
  const dems: RawInputs["dems"] = [];

  for (const a of cfg.areas) {
    const rect = areaTileRect(a);
    const box = rectLatLon(rect, QUERY_PAD_M);
    const nTiles = (rect.ix1 - rect.ix0 + 1) * (rect.iz1 - rect.iz0 + 1);
    log(`area ${a.id}: ${nTiles} tiles (${(nTiles * TILE_SIZE_M * TILE_SIZE_M) / 1e6} km²)`);

    const b = await socrataAll<RawBuilding>(
      src.buildings,
      {
        where: `intersects(shape, '${wktBox(box)}')`,
        select:
          "sf16_bldgid,mblr,gnd_mincm,gnd_maxcm,gnd_meancm,gnd_mediancm,hgt_mincm,hgt_maxcm,hgt_meancm,hgt_mediancm,hgt_stdcm,shape",
        order: "sf16_bldgid",
      },
      opts,
    );
    for (const r of b) buildings.set(r.sf16_bldgid, r);
    log(`  buildings: ${b.length}`);

    const s = await socrataAll<RawStreet>(
      src.streets,
      {
        where: `active = true AND intersects(line, '${wktBox(box)}')`,
        select: "cnn,street,st_type,streetname,f_node_cnn,t_node_cnn,classcode,layer,oneway,line",
        order: ":id",
      },
      opts,
    );
    for (const r of s) streets.set(r.cnn, r);
    log(`  street segments: ${s.length}`);

    const p = await socrataAll<RawParcel>(
      src.assessor,
      {
        where: `closed_roll_year = ${src.assessorRollYear} AND ${withinBox("the_geom", box)}`,
        select: "parcel_number,block,lot,year_property_built,use_code,use_definition,number_of_stories,number_of_units,the_geom",
        order: ":id",
      },
      opts,
    );
    for (const r of p) if (r.parcel_number) parcels.set(r.parcel_number, r);
    log(`  assessor parcels (${src.assessorRollYear} roll): ${p.length}`);

    const naics = STOREFRONT_NAICS_PREFIXES.map((n) => `starts_with(self_reported_naics_code, '${n}')`).join(" OR ");
    const biz = await socrataAll<RawBusiness>(
      src.businesses,
      {
        where:
          `${withinBox("location", box)} AND location_end_date IS NULL AND dba_end_date IS NULL ` +
          `AND administratively_closed IS NULL AND (${naics})`,
        select: "uniqueid,self_reported_naics_code,location",
        order: ":id",
      },
      opts,
    );
    for (const r of biz) businesses.set(r.uniqueid, r);
    log(`  storefront-coded active businesses: ${biz.length}`);

    const url = demUrl(cfg, a.id);
    const tif = await cachedGet(url, "tif", opts);
    const raster = parseGeoTiff(new Uint8Array(tif.buffer, tif.byteOffset, tif.byteLength));
    dems.push({ areaId: a.id, raster });
    log(`  DEM: ${raster.width}x${raster.height}`);
  }

  const byKey = <T>(m: Map<string, T>): T[] => [...m.keys()].sort().map((k) => m.get(k)!);
  return {
    buildings: byKey(buildings),
    streets: byKey(streets),
    parcels: byKey(parcels),
    businesses: byKey(businesses),
    dems,
  };
}
