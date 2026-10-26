// Downloads (through the cache) of every raw input the world is built from.
// Only columns the pipeline uses are requested; business names are never requested.

import { TILE_SIZE_M } from "../../src/geo/project.ts";
import { areaTileRect, candidateTiles, demBlocks, q6, rectLatLon, type TileRect, type WorldConfig } from "./config.ts";
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

type GeoPoint = { type: "Point"; coordinates: [number, number] };
type GeoLines = { type: "LineString" | "MultiLineString"; coordinates: unknown };

export interface RawNeighborhood {
  nhood: string;
  the_geom?: { type: "MultiPolygon" | "Polygon"; coordinates: unknown };
}

export interface RawFountain {
  uid: string;
  resource_type?: string;
  water_fountain?: string;
  bottle_filler?: string;
  dog_fountain?: string;
  latitude?: string;
  longitude?: string;
}

export interface RawMuniStop {
  stopid: string;
  onstreet?: string;
  atstreet?: string;
  shape?: GeoPoint;
}

export interface RawMuniRoute {
  lineabbr: string;
  route_name?: string;
  direction?: string;
  pattern_type?: string;
  shape?: GeoLines;
}

export interface RawSignal {
  cnn?: string;
  type?: string;
  ped_signal?: string;
  shape?: GeoPoint;
}

export interface RawCrosswalk {
  cnn?: string;
  continental?: string;
  shape?: GeoPoint;
}

export interface RawSweep {
  cnn?: string;
  cnnrightleft?: string;
  blockside?: string;
  weekday?: string;
  fromhour?: string;
  tohour?: string;
  week1?: string;
  week2?: string;
  week3?: string;
  week4?: string;
  week5?: string;
  holidays?: string;
  blocksweepid?: string;
}

export interface RawParking {
  objectid: string;
  regulation?: string;
  days?: string;
  hrs_begin?: string;
  hrs_end?: string;
  hrlimit?: string;
  rpparea1?: string;
  rpparea2?: string;
  shape?: GeoLines;
}

/** Citywide gameplay layers (absent for area-only worlds). */
export interface RawExtras {
  neighborhoods: RawNeighborhood[];
  fountains: RawFountain[];
  muniStops: RawMuniStop[];
  muniRoutes: RawMuniRoute[];
  signals: RawSignal[];
  crosswalks: RawCrosswalk[];
  sweeping: RawSweep[];
  parking: RawParking[];
}

export interface RawInputs {
  buildings: RawBuilding[];
  streets: RawStreet[];
  parcels: RawParcel[];
  businesses: RawBusiness[];
  /** One raster per area (areas.json order), or per DEM block (citywide), first match wins. */
  dems: Array<{ areaId: string; raster: GeoRaster }>;
  extras?: RawExtras;
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
  return demUrlForRect(areaTileRect(a));
}

/** The DEM request for a tile rectangle plus DEM_PAD_M, on the global pixel grid. */
export function demUrlForRect(rect: TileRect): string {
  const b = rectLatLon(rect, DEM_PAD_M);
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
  if (cfg.citywide) return downloadCitywide(cfg, opts);
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

const byKeySorted = <T>(rows: T[], key: (r: T) => string): T[] => {
  const m = new Map<string, T>();
  for (const r of rows) m.set(key(r), r);
  return [...m.keys()].sort().map((k) => m.get(k)!);
};

/**
 * Citywide: every dataset paged in full (bounded by the citywide box where the dataset
 * has geometry), one DEM per block of tiles. Datasets download in parallel under the
 * fetch layer's concurrency cap; each page is cached on its own.
 */
async function downloadCitywide(cfg: WorldConfig, opts: FetchOptions): Promise<RawInputs> {
  const log = opts.log ?? (() => {});
  const cw = cfg.citywide!;
  const src = cfg.sources;
  const box = { north: cw.north, west: cw.west, south: cw.south, east: cw.east };
  const need = (id: string | undefined, name: string): string => {
    if (!id) throw new Error(`citywide world ${cfg.id}: sources.${name} is missing in areas.json`);
    return id;
  };
  const page = <T>(dataset: string, q: { where: string; select: string; order: string }, label: string, size = 5000): Promise<T[]> =>
    socrataAll<T>(dataset, q, opts, size).then((rows) => {
      log(`  ${label}: ${rows.length}`);
      return rows;
    });
  const naics = STOREFRONT_NAICS_PREFIXES.map((n) => `starts_with(self_reported_naics_code, '${n}')`).join(" OR ");

  const [buildings, streets, parcels, businesses, neighborhoods, fountains, muniStops, muniRoutes, signals, crosswalks, sweeping, parking] =
    await Promise.all([
      page<RawBuilding>(src.buildings, {
        where: `intersects(shape, '${wktBox(box)}')`,
        select: "sf16_bldgid,mblr,gnd_mincm,gnd_maxcm,gnd_meancm,gnd_mediancm,hgt_mincm,hgt_maxcm,hgt_meancm,hgt_mediancm,hgt_stdcm,shape",
        order: "sf16_bldgid",
      }, "building footprints"),
      page<RawStreet>(src.streets, {
        where: `active = true AND intersects(line, '${wktBox(box)}')`,
        select: "cnn,street,st_type,streetname,f_node_cnn,t_node_cnn,classcode,layer,oneway,line",
        order: ":id",
      }, "street segments"),
      page<RawParcel>(src.assessor, {
        where: `closed_roll_year = ${src.assessorRollYear} AND ${withinBox("the_geom", box)}`,
        select: "parcel_number,block,lot,year_property_built,use_code,use_definition,number_of_stories,number_of_units,the_geom",
        order: ":id",
      }, `assessor parcels (${src.assessorRollYear} roll)`, 10000),
      page<RawBusiness>(src.businesses, {
        where:
          `${withinBox("location", box)} AND location_end_date IS NULL AND dba_end_date IS NULL ` +
          `AND administratively_closed IS NULL AND (${naics})`,
        select: "uniqueid,self_reported_naics_code,location",
        order: ":id",
      }, "storefront-coded active businesses"),
      page<RawNeighborhood>(need(src.neighborhoods, "neighborhoods"), { where: "nhood IS NOT NULL", select: "nhood,the_geom", order: "nhood" }, "analysis neighbourhoods"),
      page<RawFountain>(need(src.fountains, "fountains"), {
        where: "resource_type = 'drinking_water'",
        select: "uid,resource_type,water_fountain,bottle_filler,dog_fountain,latitude,longitude",
        order: "uid",
      }, "drinking-water points"),
      page<RawMuniStop>(need(src.muniStops, "muniStops"), { where: `${withinBox("shape", box)}`, select: "stopid,onstreet,atstreet,shape", order: ":id" }, "transit stops"),
      page<RawMuniRoute>(need(src.muniRoutes, "muniRoutes"), {
        where: "lineabbr IS NOT NULL",
        select: "lineabbr,route_name,direction,pattern_type,shape",
        order: ":id",
      }, "transit route patterns"),
      page<RawSignal>(need(src.signals, "signals"), { where: `${withinBox("shape", box)}`, select: "cnn,type,ped_signal,shape", order: ":id" }, "traffic signals"),
      page<RawCrosswalk>(need(src.crosswalks, "crosswalks"), { where: `${withinBox("shape", box)}`, select: "cnn,continental,shape", order: ":id" }, "continental crosswalks"),
      page<RawSweep>(need(src.streetCleaning, "streetCleaning"), {
        where: "cnn IS NOT NULL",
        select: "cnn,cnnrightleft,blockside,weekday,fromhour,tohour,week1,week2,week3,week4,week5,holidays,blocksweepid",
        order: ":id",
      }, "street cleaning schedules", 10000),
      page<RawParking>(need(src.parking, "parking"), {
        where: `intersects(shape, '${wktBox(box)}')`,
        select: "objectid,regulation,days,hrs_begin,hrs_end,hrlimit,rpparea1,rpparea2,shape",
        order: ":id",
      }, "parking regulations"),
    ]);

  const blocks = demBlocks(candidateTiles(cfg), cw.demBlockTiles);
  const dems = await Promise.all(
    blocks.map(async (b) => {
      const tif = await cachedGet(demUrlForRect(b.rect), "tif", opts);
      return { areaId: b.id, raster: parseGeoTiff(new Uint8Array(tif.buffer, tif.byteOffset, tif.byteLength)) };
    }),
  );
  log(`  DEM: ${dems.length} blocks of ${cw.demBlockTiles}x${cw.demBlockTiles} tiles`);

  return {
    buildings: byKeySorted(buildings, (r) => r.sf16_bldgid),
    streets: byKeySorted(streets, (r) => r.cnn),
    parcels: byKeySorted(parcels.filter((r) => r.parcel_number), (r) => r.parcel_number!),
    businesses: byKeySorted(businesses, (r) => r.uniqueid),
    dems,
    extras: {
      neighborhoods: byKeySorted(neighborhoods, (r) => r.nhood),
      fountains: byKeySorted(fountains, (r) => r.uid),
      muniStops: byKeySorted(muniStops, (r) => r.stopid),
      muniRoutes: byKeySorted(muniRoutes, (r) => `${r.lineabbr}|${r.direction ?? ""}|${r.pattern_type ?? ""}`),
      signals: byKeySorted(signals.filter((r) => r.shape), (r) => `${r.cnn ?? ""}|${r.shape!.coordinates.join(",")}`),
      crosswalks: byKeySorted(crosswalks.filter((r) => r.shape), (r) => `${r.cnn ?? ""}|${r.shape!.coordinates.join(",")}`),
      sweeping: byKeySorted(sweeping, (r) => `${r.blocksweepid ?? ""}|${r.cnn}|${r.cnnrightleft ?? ""}|${r.weekday ?? ""}|${r.fromhour ?? ""}`),
      parking: byKeySorted(parking, (r) => r.objectid),
    },
  };
}
