// Minimal GeoTIFF reader for the one shape the USGS 3DEP ImageServer returns:
// a single-band, uncompressed, little- or big-endian float32 raster in WGS84
// (EPSG:4326), stored as strips or tiles. Anything else is rejected loudly rather
// than misread.

export interface GeoRaster {
  width: number;
  height: number;
  /** Row-major, top row first (north), heights in metres. */
  data: Float32Array;
  /** Geographic extent of the raster's outer pixel edges. */
  west: number;
  north: number;
  /** Degrees per pixel (both positive). */
  dLon: number;
  dLat: number;
  /** GDAL_NODATA tag value if present. */
  noData: number | null;
}

const TAG = {
  ImageWidth: 256,
  ImageLength: 257,
  BitsPerSample: 258,
  Compression: 259,
  PhotometricInterpretation: 262,
  StripOffsets: 273,
  SamplesPerPixel: 277,
  RowsPerStrip: 278,
  StripByteCounts: 279,
  PlanarConfiguration: 284,
  Predictor: 317,
  TileWidth: 322,
  TileLength: 323,
  TileOffsets: 324,
  TileByteCounts: 325,
  SampleFormat: 339,
  ModelPixelScale: 33550,
  ModelTiepoint: 33922,
  GeoKeyDirectory: 34735,
  GdalNoData: 42113,
} as const;

type TagValue = number[] | string;

function typeSize(t: number): number {
  switch (t) {
    case 1: case 2: case 6: case 7: return 1; // BYTE ASCII SBYTE UNDEFINED
    case 3: case 8: return 2; // SHORT SSHORT
    case 4: case 9: case 11: return 4; // LONG SLONG FLOAT
    case 5: case 10: case 12: return 8; // RATIONAL SRATIONAL DOUBLE
    case 16: case 17: return 8; // LONG8 SLONG8 (BigTIFF; unsupported below)
    default: throw new Error(`geotiff: unknown field type ${t}`);
  }
}

export function parseGeoTiff(buf: Uint8Array): GeoRaster {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const order = String.fromCharCode(buf[0]!, buf[1]!);
  if (order !== "II" && order !== "MM") throw new Error("geotiff: not a TIFF (bad byte order mark)");
  const le = order === "II";
  const magic = dv.getUint16(2, le);
  if (magic === 43) throw new Error("geotiff: BigTIFF is not supported");
  if (magic !== 42) throw new Error(`geotiff: bad magic ${magic}`);
  const ifd = dv.getUint32(4, le);
  const n = dv.getUint16(ifd, le);
  const tags = new Map<number, TagValue>();
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    const tag = dv.getUint16(e, le);
    const type = dv.getUint16(e + 2, le);
    const count = dv.getUint32(e + 4, le);
    const size = typeSize(type) * count;
    const off = size <= 4 ? e + 8 : dv.getUint32(e + 8, le);
    if (off + size > buf.byteLength) throw new Error(`geotiff: tag ${tag} points outside the file`);
    if (type === 2) {
      let s = "";
      for (let k = 0; k < count; k++) {
        const c = buf[off + k]!;
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      tags.set(tag, s);
      continue;
    }
    const vals: number[] = [];
    for (let k = 0; k < count; k++) {
      const p = off + k * typeSize(type);
      switch (type) {
        case 1: case 7: vals.push(dv.getUint8(p)); break;
        case 6: vals.push(dv.getInt8(p)); break;
        case 3: vals.push(dv.getUint16(p, le)); break;
        case 8: vals.push(dv.getInt16(p, le)); break;
        case 4: vals.push(dv.getUint32(p, le)); break;
        case 9: vals.push(dv.getInt32(p, le)); break;
        case 11: vals.push(dv.getFloat32(p, le)); break;
        case 12: vals.push(dv.getFloat64(p, le)); break;
        case 5: vals.push(dv.getUint32(p, le) / dv.getUint32(p + 4, le)); break;
        case 10: vals.push(dv.getInt32(p, le) / dv.getInt32(p + 4, le)); break;
        default: throw new Error(`geotiff: unsupported field type ${type} on tag ${tag}`);
      }
    }
    tags.set(tag, vals);
  }

  const num = (t: number, dflt?: number): number => {
    const v = tags.get(t);
    if (v === undefined) {
      if (dflt === undefined) throw new Error(`geotiff: missing required tag ${t}`);
      return dflt;
    }
    if (typeof v === "string") throw new Error(`geotiff: tag ${t} is text`);
    return v[0]!;
  };
  const arr = (t: number): number[] | undefined => {
    const v = tags.get(t);
    return typeof v === "string" ? undefined : v;
  };

  const width = num(TAG.ImageWidth);
  const height = num(TAG.ImageLength);
  if (num(TAG.Compression, 1) !== 1) throw new Error("geotiff: compressed rasters are not supported (ask for an uncompressed tiff)");
  if (num(TAG.SamplesPerPixel, 1) !== 1) throw new Error("geotiff: only single-band rasters are supported");
  if (num(TAG.BitsPerSample) !== 32) throw new Error("geotiff: only 32-bit samples are supported");
  if (num(TAG.SampleFormat, 1) !== 3) throw new Error("geotiff: only IEEE float samples are supported");
  if (num(TAG.Predictor, 1) !== 1) throw new Error("geotiff: predictors are not supported");

  const data = new Float32Array(width * height);
  const readBlock = (off: number, bytes: number, x0: number, y0: number, bw: number, bh: number): void => {
    const samples = Math.floor(bytes / 4);
    for (let k = 0; k < samples; k++) {
      const bx = k % bw;
      const by = Math.floor(k / bw);
      if (by >= bh) break;
      const x = x0 + bx;
      const y = y0 + by;
      if (x >= width || y >= height) continue;
      data[y * width + x] = dv.getFloat32(off + k * 4, le);
    }
  };

  const stripOffsets = arr(TAG.StripOffsets);
  const tileOffsets = arr(TAG.TileOffsets);
  if (stripOffsets) {
    const counts = arr(TAG.StripByteCounts);
    if (!counts || counts.length !== stripOffsets.length) throw new Error("geotiff: strip byte counts missing");
    const rps = Math.min(num(TAG.RowsPerStrip, height), height);
    for (let s = 0; s < stripOffsets.length; s++) {
      readBlock(stripOffsets[s]!, counts[s]!, 0, s * rps, width, rps);
    }
  } else if (tileOffsets) {
    const counts = arr(TAG.TileByteCounts);
    if (!counts || counts.length !== tileOffsets.length) throw new Error("geotiff: tile byte counts missing");
    const tw = num(TAG.TileWidth);
    const th = num(TAG.TileLength);
    const across = Math.ceil(width / tw);
    for (let t = 0; t < tileOffsets.length; t++) {
      readBlock(tileOffsets[t]!, counts[t]!, (t % across) * tw, Math.floor(t / across) * th, tw, th);
    }
  } else {
    throw new Error("geotiff: no strips or tiles");
  }

  const scale = arr(TAG.ModelPixelScale);
  const tie = arr(TAG.ModelTiepoint);
  if (!scale || !tie || tie.length < 6) throw new Error("geotiff: missing georeferencing (ModelPixelScale/ModelTiepoint)");
  const geoKeys = arr(TAG.GeoKeyDirectory);
  if (geoKeys) {
    // Key 2048 = GeographicTypeGeoKey, 3072 = ProjectedCSTypeGeoKey; 1025 = RasterPixelIsArea(1)/Point(2).
    let geographic = 0;
    let projected = 0;
    let rasterType = 1;
    for (let k = 4; k + 3 < geoKeys.length; k += 4) {
      const id = geoKeys[k]!;
      const loc = geoKeys[k + 1]!;
      const val = geoKeys[k + 3]!;
      if (loc !== 0) continue;
      if (id === 2048) geographic = val;
      if (id === 3072) projected = val;
      if (id === 1025) rasterType = val;
    }
    if (projected !== 0 && projected !== 32767) throw new Error(`geotiff: projected CRS ${projected}; ask the server for imageSR=4326`);
    if (geographic !== 0 && geographic !== 4326 && geographic !== 4269) {
      throw new Error(`geotiff: unexpected geographic CRS ${geographic}`);
    }
    if (rasterType === 2) {
      // PixelIsPoint: the tiepoint is a pixel centre. Normalise to pixel edges.
      tie[3] = tie[3]! - scale[0]! / 2;
      tie[4] = tie[4]! + scale[1]! / 2;
    }
  }
  const dLon = scale[0]!;
  const dLat = scale[1]!;
  const west = tie[3]! - tie[0]! * dLon;
  const north = tie[4]! + tie[1]! * dLat;
  const nd = tags.get(TAG.GdalNoData);
  const noData = typeof nd === "string" && nd.trim() !== "" ? Number(nd.trim()) : null;
  return { width, height, data, west, north, dLon, dLat, noData };
}

/** True when a raster sample means "no land here": nodata, NaN or absurd values. */
export function isNoData(r: GeoRaster, v: number): boolean {
  if (!Number.isFinite(v)) return true;
  if (r.noData !== null && v === r.noData) return true;
  return v < -1000 || v > 10000;
}
