// A minimal OpenStreetMap PBF reader (https://wiki.openstreetmap.org/wiki/PBF_Format): no
// dependencies, enough for the street-detail producers. It reads every node's position, and
// the ways (with tags and node refs) and relations (with tags and members) that a filter keeps.
// Blobs must be raw or zlib (osmium's default); others are refused.

import { inflateSync } from "node:zlib";

export interface OsmWay {
  id: number;
  tags: Record<string, string>;
  refs: number[];
}

export interface OsmRelation {
  id: number;
  tags: Record<string, string>;
  members: Array<{ type: "node" | "way" | "relation"; ref: number; role: string }>;
}

export interface OsmData {
  /** Node id -> [lon, lat] for nodes that ways or relations kept by the filter use (or all when keepAllNodes). */
  nodes: Map<number, [number, number]>;
  /** Tagged nodes the node filter keeps. */
  taggedNodes: Array<{ id: number; lon: number; lat: number; tags: Record<string, string> }>;
  ways: OsmWay[];
  relations: OsmRelation[];
}

class Reader {
  pos: number;
  readonly buf: Uint8Array;
  readonly end: number;
  constructor(buf: Uint8Array, start = 0, end = buf.length) {
    this.buf = buf;
    this.pos = start;
    this.end = end;
  }
  get done(): boolean {
    return this.pos >= this.end;
  }
  varint(): number {
    let result = 0, shift = 0, b: number;
    do {
      b = this.buf[this.pos++]!;
      result += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    return result;
  }
  svarint(): number {
    const v = this.varint();
    return v % 2 === 1 ? -(v + 1) / 2 : v / 2;
  }
  /** A field key: [field number, wire type]. */
  key(): [number, number] {
    const k = this.varint();
    return [Math.floor(k / 8), k & 7];
  }
  bytes(): Reader {
    const len = this.varint();
    const r = new Reader(this.buf, this.pos, this.pos + len);
    this.pos += len;
    return r;
  }
  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) {
      const len = this.varint();
      this.pos += len;
    }
    else if (wire === 5) this.pos += 4;
    else throw new Error(`osm-pbf: unsupported wire type ${wire}`);
  }
  packed(signed: boolean): number[] {
    const r = this.bytes();
    const out: number[] = [];
    while (!r.done) out.push(signed ? r.svarint() : r.varint());
    return out;
  }
  string(): string {
    const r = this.bytes();
    return new TextDecoder().decode(r.buf.subarray(r.pos, r.end));
  }
}

function blobData(blob: Reader): Uint8Array {
  let raw: Uint8Array | null = null, zlib: Uint8Array | null = null;
  while (!blob.done) {
    const [f, w] = blob.key();
    if (f === 1 && w === 2) {
      const r = blob.bytes();
      raw = r.buf.subarray(r.pos, r.end);
    } else if (f === 3 && w === 2) {
      const r = blob.bytes();
      zlib = r.buf.subarray(r.pos, r.end);
    } else blob.skip(w);
  }
  if (raw) return raw;
  if (zlib) return new Uint8Array(inflateSync(zlib));
  throw new Error("osm-pbf: unsupported blob compression");
}

export interface OsmFilter {
  way?: (tags: Record<string, string>) => boolean;
  relation?: (tags: Record<string, string>) => boolean;
  node?: (tags: Record<string, string>) => boolean;
}

/** Read a PBF file's bytes, keeping the ways, relations and tagged nodes the filter accepts. */
export function readOsmPbf(file: Uint8Array, filter: OsmFilter): OsmData {
  const allNodes = new Map<number, [number, number]>();
  const taggedNodes: OsmData["taggedNodes"] = [];
  const ways: OsmWay[] = [];
  const relations: OsmRelation[] = [];
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let p = 0;
  while (p < file.length) {
    const hlen = dv.getUint32(p);
    p += 4;
    const header = new Reader(file, p, p + hlen);
    p += hlen;
    let type = "", size = 0;
    while (!header.done) {
      const [f, w] = header.key();
      if (f === 1) type = header.string();
      else if (f === 3) size = header.varint();
      else header.skip(w);
    }
    const blob = new Reader(file, p, p + size);
    p += size;
    if (type !== "OSMData") continue;
    readBlock(blobData(blob), filter, allNodes, taggedNodes, ways, relations);
  }
  // Keep only the node positions something kept uses.
  const used = new Set<number>();
  for (const w of ways) for (const r of w.refs) used.add(r);
  const nodes = new Map<number, [number, number]>();
  for (const id of used) {
    const n = allNodes.get(id);
    if (n) nodes.set(id, n);
  }
  return { nodes, taggedNodes, ways, relations };
}

function readBlock(
  data: Uint8Array,
  filter: OsmFilter,
  allNodes: Map<number, [number, number]>,
  taggedNodes: OsmData["taggedNodes"],
  ways: OsmWay[],
  relations: OsmRelation[],
): void {
  const r = new Reader(data);
  const strings: string[] = [];
  const groups: Reader[] = [];
  let granularity = 100, latOff = 0, lonOff = 0;
  while (!r.done) {
    const [f, w] = r.key();
    if (f === 1) {
      const st = r.bytes();
      while (!st.done) {
        const [sf, sw] = st.key();
        if (sf === 1) strings.push(st.string());
        else st.skip(sw);
      }
    } else if (f === 2) groups.push(r.bytes());
    else if (f === 17) granularity = r.varint();
    else if (f === 19) latOff = r.varint();
    else if (f === 20) lonOff = r.varint();
    else r.skip(w);
  }
  const deg = (v: number, off: number): number => (off + granularity * v) * 1e-9;
  const tagsOf = (keys: number[], vals: number[]): Record<string, string> => {
    const t: Record<string, string> = {};
    for (let i = 0; i < keys.length; i++) t[strings[keys[i]!]!] = strings[vals[i]!]!;
    return t;
  };
  for (const g of groups) {
    while (!g.done) {
      const [f, w] = g.key();
      if (f === 2) {
        // DenseNodes
        const d = g.bytes();
        let ids: number[] = [], lats: number[] = [], lons: number[] = [], kv: number[] = [];
        while (!d.done) {
          const [df, dw] = d.key();
          if (df === 1) ids = d.packed(true);
          else if (df === 8) lats = d.packed(true);
          else if (df === 9) lons = d.packed(true);
          else if (df === 10) kv = d.packed(false);
          else d.skip(dw);
        }
        let id = 0, lat = 0, lon = 0, k = 0;
        for (let i = 0; i < ids.length; i++) {
          id += ids[i]!;
          lat += lats[i]!;
          lon += lons[i]!;
          const x = deg(lon, lonOff), y = deg(lat, latOff);
          allNodes.set(id, [x, y]);
          if (kv.length) {
            const t: Record<string, string> = {};
            let any = false;
            while (k < kv.length && kv[k] !== 0) {
              t[strings[kv[k]!]!] = strings[kv[k + 1]!]!;
              k += 2;
              any = true;
            }
            k++;
            if (any && filter.node?.(t)) taggedNodes.push({ id, lon: x, lat: y, tags: t });
          }
        }
      } else if (f === 3) {
        const wr = g.bytes();
        let id = 0, keys: number[] = [], vals: number[] = [], refs: number[] = [];
        while (!wr.done) {
          const [wf, ww] = wr.key();
          if (wf === 1) id = wr.varint();
          else if (wf === 2) keys = wr.packed(false);
          else if (wf === 3) vals = wr.packed(false);
          else if (wf === 8) refs = wr.packed(true);
          else wr.skip(ww);
        }
        const tags = tagsOf(keys, vals);
        if (filter.way?.(tags)) {
          let ref = 0;
          ways.push({ id, tags, refs: refs.map((d) => (ref += d)) });
        }
      } else if (f === 4) {
        const rr = g.bytes();
        let id = 0, keys: number[] = [], vals: number[] = [], roles: number[] = [], mids: number[] = [], types: number[] = [];
        while (!rr.done) {
          const [rf, rw] = rr.key();
          if (rf === 1) id = rr.varint();
          else if (rf === 2) keys = rr.packed(false);
          else if (rf === 3) vals = rr.packed(false);
          else if (rf === 8) roles = rr.packed(false);
          else if (rf === 9) mids = rr.packed(true);
          else if (rf === 10) types = rr.packed(false);
          else rr.skip(rw);
        }
        const tags = tagsOf(keys, vals);
        if (filter.relation?.(tags)) {
          let ref = 0;
          relations.push({
            id,
            tags,
            members: mids.map((d, i) => ({ type: (["node", "way", "relation"] as const)[types[i]!]!, ref: (ref += d), role: strings[roles[i]!]! })),
          });
        }
      } else g.skip(w);
    }
  }
}
