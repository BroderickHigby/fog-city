// The pipeline's own GeoTIFF reader, against TIFFs built byte by byte here.
import { describe, expect, it } from "vitest";
import { isNoData, parseGeoTiff } from "../../pipeline/lib/geotiff.ts";

interface Opts {
  le?: boolean;
  tiled?: { tw: number; th: number };
  rowsPerStrip?: number;
  compression?: number;
  pixelIsPoint?: boolean;
  noData?: string;
  sampleFormat?: number;
}

/** Build a minimal single-band float32 GeoTIFF (EPSG:4326). */
function makeTiff(w: number, h: number, values: (x: number, y: number) => number, geo: { west: number; north: number; d: number }, o: Opts = {}): Uint8Array {
  const le = o.le ?? true;
  // Pixel blocks.
  const blocks: Uint8Array[] = [];
  const blockBytes = (bw: number, bh: number, x0: number, y0: number): Uint8Array => {
    const b = new Uint8Array(bw * bh * 4);
    const dv = new DataView(b.buffer);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const v = x0 + x < w && y0 + y < h ? values(x0 + x, y0 + y) : 0;
      dv.setFloat32((y * bw + x) * 4, v, le);
    }
    return b;
  };
  if (o.tiled) {
    for (let ty = 0; ty < Math.ceil(h / o.tiled.th); ty++)
      for (let tx = 0; tx < Math.ceil(w / o.tiled.tw); tx++) blocks.push(blockBytes(o.tiled.tw, o.tiled.th, tx * o.tiled.tw, ty * o.tiled.th));
  } else {
    const rps = o.rowsPerStrip ?? h;
    for (let y = 0; y < h; y += rps) blocks.push(blockBytes(w, Math.min(rps, h - y), 0, y));
  }
  // Tags: [tag, type, values]
  type Tag = [number, number, number[] | string];
  const rasterType = o.pixelIsPoint ? 2 : 1;
  const tags: Tag[] = [
    [256, 4, [w]],
    [257, 4, [h]],
    [258, 3, [32]],
    [259, 3, [o.compression ?? 1]],
    [262, 3, [1]],
    [277, 3, [1]],
    [284, 3, [1]],
    [339, 3, [o.sampleFormat ?? 3]],
    [33550, 12, [geo.d, geo.d, 0]],
    [33922, 12, [0, 0, 0, geo.west, geo.north, 0]],
    [34735, 3, [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, rasterType, 2048, 0, 1, 4326]],
  ];
  if (o.noData !== undefined) tags.push([42113, 2, o.noData]);
  // Layout: header(8) | blocks | IFD | out-of-line tag data
  const blockOffsets: number[] = [];
  let off = 8;
  for (const b of blocks) {
    blockOffsets.push(off);
    off += b.length;
  }
  if (o.tiled) {
    tags.push([322, 3, [o.tiled.tw]], [323, 3, [o.tiled.th]], [324, 4, blockOffsets], [325, 4, blocks.map((b) => b.length)]);
  } else {
    tags.push([273, 4, blockOffsets], [278, 4, [o.rowsPerStrip ?? h]], [279, 4, blocks.map((b) => b.length)]);
  }
  tags.sort((a, b) => a[0] - b[0]);
  const ifdOff = off;
  const ifdSize = 2 + tags.length * 12 + 4;
  let dataOff = ifdOff + ifdSize;
  const size = (t: number) => ({ 2: 1, 3: 2, 4: 4, 12: 8 })[t]!;
  const extra: Array<{ at: number; tag: Tag }> = [];
  for (const t of tags) {
    const count = typeof t[2] === "string" ? t[2].length + 1 : t[2].length;
    if (count * size(t[1]) > 4) {
      extra.push({ at: dataOff, tag: t });
      dataOff += count * size(t[1]);
    }
  }
  const out = new Uint8Array(dataOff);
  const dv = new DataView(out.buffer);
  out[0] = out[1] = le ? 0x49 : 0x4d;
  dv.setUint16(2, 42, le);
  dv.setUint32(4, ifdOff, le);
  blocks.forEach((b, i) => out.set(b, blockOffsets[i]!));
  dv.setUint16(ifdOff, tags.length, le);
  const writeVals = (p: number, t: Tag): void => {
    if (typeof t[2] === "string") {
      for (let i = 0; i < t[2].length; i++) out[p + i] = t[2].charCodeAt(i);
      return;
    }
    t[2].forEach((v, i) => {
      const q = p + i * size(t[1]);
      if (t[1] === 3) dv.setUint16(q, v, le);
      else if (t[1] === 4) dv.setUint32(q, v, le);
      else if (t[1] === 12) dv.setFloat64(q, v, le);
    });
  };
  tags.forEach((t, i) => {
    const e = ifdOff + 2 + i * 12;
    const count = typeof t[2] === "string" ? t[2].length + 1 : t[2].length;
    dv.setUint16(e, t[0], le);
    dv.setUint16(e + 2, t[1], le);
    dv.setUint32(e + 4, count, le);
    const x = extra.find((q) => q.tag === t);
    if (x) {
      dv.setUint32(e + 8, x.at, le);
      writeVals(x.at, t);
    } else writeVals(e + 8, t);
  });
  return out;
}

const GEO = { west: -122.41, north: 37.81, d: 0.0001 };
const f = (x: number, y: number) => x * 10 + y * 0.5 - 1;

describe("parseGeoTiff", () => {
  for (const variant of [
    { name: "little-endian, one strip", o: {} },
    { name: "big-endian, one strip", o: { le: false } },
    { name: "little-endian, 3-row strips", o: { rowsPerStrip: 3 } },
    { name: "big-endian, 4x4 tiles (partial edge tiles)", o: { le: false, tiled: { tw: 4, th: 4 } } },
  ]) {
    it(`reads values and georeferencing: ${variant.name}`, () => {
      const r = parseGeoTiff(makeTiff(7, 5, f, GEO, variant.o));
      expect([r.width, r.height]).toEqual([7, 5]);
      expect(r.west).toBeCloseTo(GEO.west, 12);
      expect(r.north).toBeCloseTo(GEO.north, 12);
      expect(r.dLon).toBeCloseTo(GEO.d, 12);
      expect(r.dLat).toBeCloseTo(GEO.d, 12);
      for (let y = 0; y < 5; y++) for (let x = 0; x < 7; x++) expect(r.data[y * 7 + x]).toBeCloseTo(f(x, y), 5);
    });
  }

  it("normalises PixelIsPoint tiepoints to pixel edges", () => {
    const r = parseGeoTiff(makeTiff(3, 3, f, GEO, { pixelIsPoint: true }));
    expect(r.west).toBeCloseTo(GEO.west - GEO.d / 2, 12);
    expect(r.north).toBeCloseTo(GEO.north + GEO.d / 2, 12);
  });

  it("reads GDAL_NODATA and flags nodata, NaN and absurd values", () => {
    const r = parseGeoTiff(makeTiff(2, 2, () => -9999, GEO, { noData: "-9999" }));
    expect(r.noData).toBe(-9999);
    expect(isNoData(r, -9999)).toBe(true);
    expect(isNoData(r, Number.NaN)).toBe(true);
    expect(isNoData(r, -3.4e38)).toBe(true);
    expect(isNoData(r, 12.5)).toBe(false);
  });

  it("rejects what it cannot read correctly", () => {
    expect(() => parseGeoTiff(makeTiff(2, 2, f, GEO, { compression: 5 }))).toThrow(/compressed/);
    expect(() => parseGeoTiff(makeTiff(2, 2, f, GEO, { sampleFormat: 1 }))).toThrow(/float/);
    expect(() => parseGeoTiff(new TextEncoder().encode("<html>nope</html>"))).toThrow(/not a TIFF/);
  });
});
