// pnpm build (= pnpm build:web): the static web build for hosting, in dist/.
//
//   node scripts/build-web.ts [--out dist] [--worlds sf] [--level 9] [--skip-vite] [--no-sourcemap]
//                             [--public <dir>] [--force-clean] [--text]
//
// 0. Clears the out directory (relative to the checkout, or absolute), but only one a build
//    could have written: new, empty, or holding nothing but a build's files (index.html,
//    assets/, assets.index.json, bin/ of .gz files and their parts, tiles/ and models/ of .json
//    and .txt). Anything else (a stray notes.txt, a source tree) stops the build before it
//    deletes a thing, unless --force-clean; the checkout, the public/ it reads and any directory
//    holding either are refused even then. The world's manifests are checked before the old
//    build is deleted.
// 1. vite build (vite.config.ts: base "./", public/ not copied): index.html and the bundle,
//    every URL relative, so the page works from any sub-path.
// 2. The world and the models, in the layout src/io/assets.ts reads ("packed"):
//    - tile glbs are concatenated into packs, one per 3 x 3 block of tiles (a neighbourhood
//      the streamer needs together), the far-LOD cells into packs of their own, each pack at
//      most PACK_MAX_BYTES once encoded where its files allow (a file alone over it is a pack
//      of its own);
//    - the collider pack (world.colliders.bin) and each model are encoded on their own;
//    - every binary is stored one of two ways (src/io/assets.ts, the index's `encoding`):
//       - binary, the default (index version 3, encoding "gzip"): gzip-compressed and written
//         as bin/<name>.<hash>.gz, the hash the first 12 hex digits of the stored file's sha256,
//         so a file's name changes whenever its bytes do and the host may cache bin/ for good
//         (vercel.json). The collider pack is byte-shuffled by 4 before compression (its int16
//         and int32 records gzip to 15% less that way; the index lists it under `filters`);
//       - text, with --text (index versions 1 and 2), for a host that serves only text-like
//         types (no .glb, no .bin, no .gz; HOST_LIMITS): gzip-compressed, base64-encoded and
//         written as <name>.gz.b64.txt beside the world's JSON, names fixed so a republish to a
//         host that keeps old files replaces them;
//    - any encoded file over PACK_MAX_BYTES (the citywide collider pack, 14.3 MB encoded as
//      text on the 2026-10-21 QA world) is written as parts instead of one file, as few as fit,
//      sizes as even as allowed, each checked at most PACK_MAX_BYTES; the page fetches them
//      concurrently, checks each part's size, joins them in order and decodes. Binary parts
//      are <src>.part<N> (a host never takes a part for a whole .gz); text parts are
//      <src minus .txt>.part<N>.txt (world.colliders.bin.gz.b64.part0.txt, ...part1.txt), every
//      cut at a multiple of 4 characters, so each part is valid base64 on its own;
//    - the world's JSON the game reads is copied as is: the manifest, the road graph and the
//      data layers in RUNTIME_LAYERS (src/io/world-load.ts); the other layers (sidewalks,
//      hydrants, ...) stay out until a feature reads them;
//    - per-tile collider JSONs are not shipped (the game reads the collider pack);
//    - public/audio/ (effects, music, voice lines and their manifests) is copied as plain
//      .ogg/.mp3/.json files: the page streams them through <audio> by URL;
//    - assets.index.json maps every binary's logical path to {src, offset, length} and, for a
//      src written in parts, lists them under parts[src] as [{src, bytes}] in join order. A
//      text index with parts is version 2, one without stays version 1 (the shape builds wrote
//      before parts existed), so a page too old to know parts refuses a split build by its
//      version; a binary index is version 3.
// 3. Checks the host's limits (files, total size, per-file size, and for a text build the
//    extensions; every part is a file of its own) and fails the build when one is broken, then
//    prints a summary that names each file written in parts.
//
// The bundle's source map ships by default (handy on a private page); --no-sourcemap leaves it
// out, for a public release. --public builds the world and models from another public/
// directory (a pipeline branch's world, before it merges).
//
// Republishing a text build to a page that already holds an earlier one: the host keeps any
// file an update leaves out, so remove every path the earlier build had and this one lacks
// (the whole world.colliders.bin.gz.b64.txt once that is written in parts, a pack name that is
// gone). The page never reads them, but they count against the host's file and size totals.
//
// Deterministic: the same inputs give byte-identical outputs (gzip with no timestamp, sorted
// inputs, names, part names and cuts fixed by the bytes), so a rebuild that changes nothing
// republishes nothing new.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { ASSET_INDEX, shuffleBytes, type AssetEncoding, type AssetFilter, type AssetIndex, type AssetIndexEntry, type AssetPart } from "../src/io/assets.ts";
import { RUNTIME_LAYERS } from "../src/io/world-load.ts";
import { STREET_DETAIL_INDEX } from "../src/render/street-markings.ts";

export const ROOT = join(import.meta.dirname, "..");
/** What a host takes: files, total and per-file bytes, and the extensions it serves (null: any). */
export interface HostLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  extensions: readonly string[] | null;
}
/** The text-only page host's limits (measured; anything else is refused at publish): a --text build. */
export const HOST_LIMITS = {
  maxFiles: 450,
  maxTotalBytes: 240_000_000,
  maxFileBytes: 15_000_000,
  extensions: [
    ".html", ".css", ".js", ".mjs", ".wasm", ".json", ".map", ".geojson", ".webmanifest", ".txt", ".md", ".csv", ".xml",
    ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".woff", ".woff2", ".ttf", ".otf", ".mp3", ".wav",
    ".ogg", ".mp4", ".webm", ".pdf",
  ],
} as const;
/**
 * A binary build's limits: the host (Vercel) serves every type, and the build keeps the same
 * per-file size as the text host's, so no single download is huge.
 */
export const BINARY_LIMITS: HostLimits = { maxFiles: 5000, maxTotalBytes: 1_000_000_000, maxFileBytes: HOST_LIMITS.maxFileBytes, extensions: null };
/**
 * A pack's encoded size stays under this, and an encoded file over it is written in parts of at
 * most this (the host's per-file limit, with room to spare).
 */
export const PACK_MAX_BYTES = 14_000_000;
/** Tiles per pack side: a 3 x 3 block of 500 m tiles. */
export const PACK_BLOCK_TILES = 3;
export const ENCODED_SUFFIX = ".gz.b64.txt";
/** Where a binary build writes its content-named .gz files (the host may cache them for good). */
export const BINARY_DIR = "bin";

/** assets.index.json, as the loader (src/io/assets.ts) reads it. */
export type WebIndex = AssetIndex;
export type IndexEntry = AssetIndexEntry;
export type IndexPart = AssetPart;

export function encode(bytes: Uint8Array, level = 9): string {
  return gzipSync(bytes, { level }).toString("base64");
}

/** gzip bytes, no timestamp (deterministic). */
export function compress(bytes: Uint8Array, level = 9): Uint8Array {
  return new Uint8Array(gzipSync(bytes, { level }));
}

/** A binary src's name: bin/<name>.<first 12 hex digits of the stored bytes' sha256>.gz. */
export function binaryName(name: string, stored: Uint8Array): string {
  return `${BINARY_DIR}/${name}.${createHash("sha256").update(stored).digest("hex").slice(0, 12)}.gz`;
}

/** Cut stored bytes into as few even parts of at most maxBytes as fit (bytes within the limit are one part). */
export function splitBytes(bytes: Uint8Array, maxBytes = PACK_MAX_BYTES): Uint8Array[] {
  if (bytes.byteLength <= maxBytes) return [bytes];
  if (maxBytes <= 0) throw new Error(`a part of at most ${maxBytes} bytes holds nothing`);
  const count = Math.ceil(bytes.byteLength / maxBytes);
  const size = Math.ceil(bytes.byteLength / count);
  const parts: Uint8Array[] = [];
  for (let at = 0; at < bytes.byteLength; at += size) parts.push(bytes.subarray(at, at + size));
  for (const [i, part] of parts.entries()) {
    if (part.byteLength > maxBytes || part.byteLength === 0) throw new Error(`part ${i} of ${parts.length} is ${part.byteLength} bytes, outside 1..${maxBytes}`);
  }
  return parts;
}

/** The name of part n (from 0) of an encoded file: "a/b.bin.gz.b64.txt" -> "a/b.bin.gz.b64.part0.txt". */
export function partName(src: string, n: number): string {
  if (!src.endsWith(".txt")) throw new Error(`${src}: an encoded file's name ends in .txt`);
  return `${src.slice(0, -".txt".length)}.part${n}.txt`;
}

/**
 * Cut encoded text into as few parts of at most maxBytes as fit (text within the limit is one
 * part, itself). Every cut falls on a multiple of 4 characters, so each part is whole base64
 * quanta (valid base64 on its own), and the parts are as even as that allows. The loader joins
 * them before decoding, so the cut points only have to be fixed: they depend on the text alone.
 */
export function splitEncoded(text: string, maxBytes = PACK_MAX_BYTES): string[] {
  if (text.length <= maxBytes) return [text];
  const quantaMax = maxBytes - (maxBytes % 4);
  if (quantaMax <= 0) throw new Error(`a part of at most ${maxBytes} bytes holds no base64 quantum`);
  const count = Math.ceil(text.length / quantaMax);
  const size = Math.ceil(text.length / count / 4) * 4;
  const parts: string[] = [];
  for (let at = 0; at < text.length; at += size) parts.push(text.slice(at, at + size));
  for (const [i, part] of parts.entries()) {
    if (part.length > maxBytes || part.length === 0) throw new Error(`part ${i} of ${parts.length} is ${part.length} bytes, outside 1..${maxBytes}`);
  }
  if (parts.join("") !== text) throw new Error("the parts do not join back to the text");
  return parts;
}

/** The files an encoded src is written as: itself, or (over maxBytes) its parts, which the index lists. */
export function layoutEncoded(src: string, text: string, maxBytes = PACK_MAX_BYTES): { files: Array<{ path: string; text: string }>; parts: IndexPart[] | null } {
  const pieces = splitEncoded(text, maxBytes);
  if (pieces.length === 1) return { files: [{ path: src, text }], parts: null };
  const files = pieces.map((t, n) => ({ path: partName(src, n), text: t }));
  return { files, parts: files.map((f) => ({ src: f.path, bytes: f.text.length })) };
}

/** The name of part n (from 0) of a binary src: "bin/a.bin.0123456789ab.gz" -> "bin/a.bin.0123456789ab.gz.part0". */
export function binaryPartName(src: string, n: number): string {
  return `${src}.part${n}`;
}

/** The files a binary src is written as: itself, or (over maxBytes) its parts, which the index lists. */
export function layoutBinary(src: string, stored: Uint8Array, maxBytes = PACK_MAX_BYTES): { files: Array<{ path: string; bytes: Uint8Array }>; parts: IndexPart[] | null } {
  const pieces = splitBytes(stored, maxBytes);
  if (pieces.length === 1) return { files: [{ path: src, bytes: stored }], parts: null };
  const files = pieces.map((b, n) => ({ path: binaryPartName(src, n), bytes: b }));
  return { files, parts: files.map((f) => ({ src: f.path, bytes: f.bytes.byteLength })) };
}

interface PackItem {
  path: string;
  bytes: Uint8Array;
}

/**
 * Concatenate items into packs (in the given order, a new pack per group key), splitting a
 * group whenever a pack's stored size (`store`) would pass maxStored. An item that alone is
 * over maxStored is a pack of its own. Returns each pack's group key, stored form and files.
 */
function packStored<S extends { size: number }>(
  groups: ReadonlyArray<{ key: string; items: readonly PackItem[] }>,
  store: (bytes: Uint8Array) => S,
  maxStored: number,
): Array<{ key: string; stored: S; files: Array<{ path: string; offset: number; length: number }>; bytes: number }> {
  const out: Array<{ key: string; stored: S; files: Array<{ path: string; offset: number; length: number }>; bytes: number }> = [];
  const flush = (key: string, items: readonly PackItem[]): void => {
    if (items.length === 0) return;
    const total = items.reduce((s, i) => s + i.bytes.byteLength, 0);
    const buf = new Uint8Array(total);
    const files: Array<{ path: string; offset: number; length: number }> = [];
    let off = 0;
    for (const it of items) {
      buf.set(it.bytes, off);
      files.push({ path: it.path, offset: off, length: it.bytes.byteLength });
      off += it.bytes.byteLength;
    }
    const stored = store(buf);
    if (stored.size > maxStored && items.length > 1) {
      const half = Math.ceil(items.length / 2);
      flush(key, items.slice(0, half));
      flush(key, items.slice(half));
      return;
    }
    out.push({ key, stored, files, bytes: total });
  };
  for (const g of groups) flush(g.key, g.items);
  return out;
}

/**
 * Concatenate items into packs (in the given order, a new pack per group key), splitting a
 * group whenever a pack's encoded size would pass maxEncoded. An item that alone encodes over
 * maxEncoded is a pack of its own (the build writes it in parts, layoutEncoded). Returns each
 * pack's encoded text and its index entries.
 */
export function packItems(
  groups: ReadonlyArray<{ key: string; items: readonly PackItem[] }>,
  name: (n: number, key: string) => string,
  level = 9,
  maxEncoded = PACK_MAX_BYTES,
): Array<{ src: string; text: string; entries: Record<string, IndexEntry> }> {
  return packStored(groups, (b) => { const text = encode(b, level); return { text, size: text.length }; }, maxEncoded).map((p, n) => {
    const src = name(n, p.key);
    return { src, text: p.stored.text, entries: Object.fromEntries(p.files.map((f) => [f.path, { src, offset: f.offset, length: f.length }])) };
  });
}

/**
 * packItems for a binary build: each pack gzip-compressed, its src binaryName(name(n, key)).
 * Returns each pack's src, stored bytes and index entries.
 */
export function packBinary(
  groups: ReadonlyArray<{ key: string; items: readonly PackItem[] }>,
  name: (n: number, key: string) => string,
  level = 9,
  maxStored = PACK_MAX_BYTES,
): Array<{ src: string; stored: Uint8Array; entries: Record<string, IndexEntry> }> {
  return packStored(groups, (b) => { const stored = compress(b, level); return { stored, size: stored.byteLength }; }, maxStored).map((p, n) => {
    const src = binaryName(name(n, p.key), p.stored.stored);
    return { src, stored: p.stored.stored, entries: Object.fromEntries(p.files.map((f) => [f.path, { src, offset: f.offset, length: f.length }])) };
  });
}

interface Manifest {
  world: string;
  tiles: Array<{ id: string; ix?: number; iz?: number; glb: string | null; collider: string }>;
  far?: Array<{ id: string; cx?: number; cz?: number; glb: string }>;
  roads?: string | null;
  worldColliders?: string;
  layers?: Record<string, string>;
}

function tileXZ(t: Manifest["tiles"][number]): [number, number] {
  if (t.ix !== undefined && t.iz !== undefined) return [t.ix, t.iz];
  const m = /^t(-?\d+)_(-?\d+)$/.exec(t.id);
  if (!m) throw new Error(`tile ${t.id}: no ix/iz`);
  return [Number(m[1]), Number(m[2])];
}

export interface BuildOptions {
  out: string;
  worlds: string[];
  level: number;
  skipVite: boolean;
  /** Ship the bundle's source map (default true). */
  sourcemap?: boolean;
  /** Where public/ is (tests point it elsewhere). */
  publicDir?: string;
  /** Write an encoded file over this many bytes in parts (default PACK_MAX_BYTES; tests lower it). */
  partMaxBytes?: number;
  /** Clear `out` even when it holds files a build does not write (--force-clean; outDirRefusal). */
  forceClean?: boolean;
  /**
   * How binaries are stored (src/io/assets.ts): "gzip", binary .gz files (the default), or
   * "gzip-base64", .txt text for a host that serves only text-like types (--text).
   */
  encoding?: AssetEncoding;
}

export interface BuildReport {
  files: number;
  totalBytes: number;
  largest: { path: string; bytes: number };
  packs: number;
  /** The encoded files written in parts: each src and its parts' sizes, in order. */
  split: Array<{ src: string; parts: number[] }>;
  /** How the binaries are stored. */
  encoding: AssetEncoding;
  /** Raw (decoded) bytes of every binary, and their encoded size. */
  rawBinaryBytes: number;
  encodedBinaryBytes: number;
  jsonBytes: number;
  bundleBytes: number;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out.sort();
}

function write(path: string, data: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

/** Check a built directory against a host's limits (the text host's by default); returns the problems (empty when fine). */
export function checkHostLimits(dir: string, limits: HostLimits = HOST_LIMITS): { problems: string[]; files: number; totalBytes: number; largest: { path: string; bytes: number } } {
  const files = walk(dir);
  const problems: string[] = [];
  let total = 0;
  let largest = { path: "", bytes: 0 };
  for (const f of files) {
    const rel = relative(dir, f);
    const bytes = statSync(f).size;
    total += bytes;
    if (bytes > largest.bytes) largest = { path: rel, bytes };
    const ext = rel.includes(".") ? rel.slice(rel.lastIndexOf(".")).toLowerCase() : "";
    if (limits.extensions && !limits.extensions.includes(ext)) problems.push(`${rel}: extension "${ext}" is not served by the host`);
    if (bytes > limits.maxFileBytes) problems.push(`${rel}: ${bytes} bytes, over ${limits.maxFileBytes}`);
  }
  if (files.length > limits.maxFiles) problems.push(`${files.length} files, over ${limits.maxFiles}`);
  if (total > limits.maxTotalBytes) problems.push(`${total} bytes in all, over ${limits.maxTotalBytes}`);
  return { problems, files: files.length, totalBytes: total, largest };
}

/** The top-level names a build writes into its out directory. */
const BUILD_ENTRIES: ReadonlySet<string> = new Set(["index.html", "assets", ASSET_INDEX, BINARY_DIR, "tiles", "models", "textures", "audio", "third-party-notices.txt"]);
const BUILD_DIRS: ReadonlySet<string> = new Set(["assets", BINARY_DIR, "tiles", "models", "textures", "audio"]);

/** `p` itself, or a path inside it. */
function within(p: string, dir: string): boolean {
  const r = relative(dir, p);
  return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

/** Symbolic links resolved, for a path that exists; else the path, absolute. */
function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Why the build may not clear `out`, or null when it may. The build deletes its out directory
 * first, so it takes only one a build could have written: absent, empty, or holding nothing but
 * a build's files (index.html and assets/ from vite, assets.index.json, bin/ of .gz files and
 * their parts, tiles/ and models/ of .json and .txt files), whole or left half-written by a
 * build that stopped. Anything else is
 * refused unless `forceClean`; the checkout, `publicDir` (the build's input) and any directory
 * holding either, or a directory inside `publicDir`, are refused even then.
 */
export function outDirRefusal(out: string, publicDir: string, forceClean = false): string | null {
  const o = realPath(out);
  const pub = realPath(publicDir);
  if (within(realPath(ROOT), o)) return `--out ${out} is the checkout or holds it: the build deletes its out directory first`;
  if (within(pub, o) || within(o, pub)) return `--out ${out} overlaps the public directory the build reads (${publicDir}): the build deletes its out directory first`;
  if (!existsSync(out)) return null;
  const stray: string[] = [];
  if (!statSync(out).isDirectory()) {
    stray.push("(it is a file, not a directory)");
  } else {
    const look = (dir: string, rel: string, ok: (name: string) => boolean): void => {
      for (const e of readdirSync(dir, { withFileTypes: true }).sort((p, q) => (p.name < q.name ? -1 : 1))) {
        if (stray.length >= 3) return;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) look(join(dir, e.name), r, ok);
        else if (!e.isFile() || !ok(e.name)) stray.push(r);
      }
    };
    const served = (name: string): boolean => (HOST_LIMITS.extensions as readonly string[]).includes(name.slice(name.lastIndexOf(".")).toLowerCase());
    for (const e of readdirSync(out, { withFileTypes: true }).sort((p, q) => (p.name < q.name ? -1 : 1))) {
      if (stray.length >= 3) break;
      const isDir = e.isDirectory();
      if (!BUILD_ENTRIES.has(e.name) || isDir !== BUILD_DIRS.has(e.name)) stray.push(e.name);
      else if (e.name === "assets") look(join(out, e.name), e.name, served);
      else if (e.name === BINARY_DIR) look(join(out, e.name), e.name, (n) => /\.gz(\.part\d+)?$/.test(n));
      else if (e.name === "audio") look(join(out, e.name), e.name, (n) => /\.(ogg|mp3|json)$/.test(n));
      else if (isDir) look(join(out, e.name), e.name, (n) => n.endsWith(".json") || n.endsWith(".txt"));
    }
  }
  if (stray.length === 0 || forceClean) return null;
  return (
    `--out ${out} holds files a build does not write (${stray.join(", ")}), and the build deletes its out directory first: ` +
    `name a new or empty directory, or an earlier build's, or pass --force-clean (forceClean) to delete it anyway`
  );
}

export async function buildWeb(opts: BuildOptions): Promise<BuildReport> {
  const out = opts.out;
  const pub = opts.publicDir ?? join(ROOT, "public");
  const refusal = outDirRefusal(out, pub, opts.forceClean);
  if (refusal) throw new Error(refusal);
  // The inputs before the delete: a build that cannot read its worlds leaves the last one be.
  for (const world of opts.worlds) {
    const manifest = join(pub, "tiles", world, "manifest.json");
    if (!existsSync(manifest)) throw new Error(`world ${world}: ${manifest} is missing (nothing was deleted)`);
  }
  rmSync(out, { recursive: true, force: true });
  if (!opts.skipVite) {
    const { build } = await import("vite");
    await build({ root: ROOT, logLevel: "warn", build: { outDir: out, emptyOutDir: true, sourcemap: opts.sourcemap ?? true } });
  } else {
    mkdirSync(out, { recursive: true });
  }
  const bundleBytes = walk(out).reduce((s, f) => s + statSync(f).size, 0);
  const partMax = opts.partMaxBytes ?? PACK_MAX_BYTES;
  const encoding: AssetEncoding = opts.encoding ?? "gzip";
  const binary = encoding === "gzip";
  const files: WebIndex["files"] = {};
  const parts: Record<string, IndexPart[]> = {};
  const filters: Record<string, AssetFilter> = {};
  const split: BuildReport["split"] = [];
  let rawBinaryBytes = 0;
  let encodedBinaryBytes = 0;
  let jsonBytes = 0;
  let packs = 0;
  const written = new Set<string>();

  /** Write one encoded src (base64 text or gzip bytes): one file, or its parts when it is over partMax. */
  const emit = (src: string, stored: string | Uint8Array): void => {
    const layout = typeof stored === "string" ? layoutEncoded(src, stored, partMax) : layoutBinary(src, stored, partMax);
    for (const f of layout.files) {
      if (written.has(f.path)) throw new Error(`${f.path} would be written twice`);
      written.add(f.path);
      write(join(out, f.path), "text" in f ? f.text : f.bytes);
    }
    if (layout.parts) {
      parts[src] = layout.parts;
      split.push({ src, parts: layout.parts.map((p) => p.bytes) });
    }
    encodedBinaryBytes += typeof stored === "string" ? stored.length : stored.byteLength;
  };

  /** One binary on its own; `shuffle` byte-shuffles it by 4 first (binary builds; assets.ts shuffleBytes). */
  const single = (logical: string, bytes: Uint8Array, shuffle = false): void => {
    let src: string;
    if (binary) {
      const stored = compress(shuffle ? shuffleBytes(bytes, 4) : bytes, opts.level);
      src = binaryName(logical, stored);
      if (shuffle) filters[src] = "shuffle4";
      emit(src, stored);
    } else {
      src = logical + ENCODED_SUFFIX;
      emit(src, encode(bytes, opts.level));
    }
    files[logical] = { src, offset: 0, length: bytes.byteLength };
    rawBinaryBytes += bytes.byteLength;
  };

  for (const world of opts.worlds) {
    const dir = join(pub, "tiles", world);
    const prefix = `tiles/${world}/`;
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
    if (!manifest.worldColliders) throw new Error(`world ${world} has no collider pack (manifest.worldColliders): the hosted build ships no per-tile colliders`);
    // JSON as is: the manifest, the road graph and the data layers the game reads.
    const present = new Set(readdirSync(dir));
    // Render-only street detail (pipeline/build-street-detail.ts): its index and the layers it lists.
    const detail = present.has(STREET_DETAIL_INDEX)
      ? (JSON.parse(readFileSync(join(dir, STREET_DETAIL_INDEX), "utf8")) as { layers?: Record<string, string> })
      : null;
    const detailFiles = detail ? [STREET_DETAIL_INDEX, ...Object.values(detail.layers ?? {})] : [];
    const jsonFiles = [...new Set(["manifest.json", manifest.roads, ...RUNTIME_LAYERS.map((l) => manifest.layers?.[l]), ...detailFiles])]
      .filter((f): f is string => typeof f === "string" && f.length > 0)
      .sort();
    for (const f of jsonFiles) {
      if (!present.has(f)) throw new Error(`world ${world}: ${f} is named by the manifest but missing`);
      const bytes = readFileSync(join(dir, f));
      write(join(out, prefix + f), bytes);
      jsonBytes += bytes.byteLength;
    }
    // Shuffled in a binary build: 9.18 MB gzip as it is, 7.79 MB shuffled (2026-10-27 SF world).
    single(prefix + manifest.worldColliders, new Uint8Array(readFileSync(join(dir, manifest.worldColliders))), true);

    // Tile glbs, grouped by 3 x 3 blocks of tiles, blocks in (bz, bx) order, tiles in manifest order.
    const blocks = new Map<string, { bx: number; bz: number; items: PackItem[] }>();
    for (const t of manifest.tiles) {
      if (!t.glb) continue;
      const [ix, iz] = tileXZ(t);
      const bx = Math.floor(ix / PACK_BLOCK_TILES);
      const bz = Math.floor(iz / PACK_BLOCK_TILES);
      const key = `${bx},${bz}`;
      let b = blocks.get(key);
      if (!b) blocks.set(key, (b = { bx, bz, items: [] }));
      b.items.push({ path: prefix + t.glb, bytes: new Uint8Array(readFileSync(join(dir, t.glb))) });
    }
    const groups = [...blocks.entries()].sort((p, q) => p[1].bz - q[1].bz || p[1].bx - q[1].bx).map(([key, b]) => ({ key, items: b.items }));
    const far = (manifest.far ?? []).map((c) => ({ path: prefix + c.glb, bytes: new Uint8Array(readFileSync(join(dir, c.glb))) }));
    const tileName = (n: number): string => `${prefix}packs/tiles-${String(n).padStart(3, "0")}.pack`;
    const farName = (n: number): string => `${prefix}packs/far-${String(n).padStart(2, "0")}.pack`;
    const allPacks: Array<{ src: string; stored: string | Uint8Array; entries: Record<string, IndexEntry> }> = binary
      ? [...packBinary(groups, tileName, opts.level), ...packBinary([{ key: "far", items: far }], farName, opts.level)]
      : [
          ...packItems(groups, (n) => tileName(n) + ENCODED_SUFFIX, opts.level),
          ...packItems([{ key: "far", items: far }], (n) => farName(n) + ENCODED_SUFFIX, opts.level),
        ].map((p) => ({ src: p.src, stored: p.text, entries: p.entries }));
    for (const p of allPacks) {
      emit(p.src, p.stored);
      Object.assign(files, p.entries);
      for (const e of Object.values(p.entries)) rawBinaryBytes += e.length;
      packs++;
    }
  }

  // Models: each its own file (a handful, loaded at boot).
  const modelsDir = join(pub, "models");
  for (const f of walk(modelsDir).filter((p) => p.toLowerCase().endsWith(".glb"))) {
    // The retired founder likeness is retained only as source history, never shipped.
    if (relative(modelsDir, f).split("\\").join("/") === "player.glb") continue;
    single(relative(pub, f).split("\\").join("/"), new Uint8Array(readFileSync(f)));
  }

  // Retargeted motions share the byte-provider path in loose and packed builds.
  for (const motions of ["models/mixamo-motion.json", "models/anim/mixamo-dodge.json", "models/anim/mixamo-crowd.json"]) {
    if (existsSync(join(pub, motions))) single(motions, new Uint8Array(readFileSync(join(pub, motions))));
  }

  // Optional licensed surface scans use the same relative byte provider as models.
  const surfaceDir = join(pub, "textures", "surfaces");
  if (existsSync(surfaceDir)) {
    for (const f of walk(surfaceDir).filter(p => p.endsWith(".webp"))) {
      single(relative(pub, f).split("\\").join("/"), new Uint8Array(readFileSync(f)));
    }
    const sources = join(surfaceDir, "sources.json");
    if (existsSync(sources)) {
      const bytes = readFileSync(sources);
      write(join(out, "textures", "surfaces", "sources.json"), bytes);
      jsonBytes += bytes.byteLength;
    }
  }

  // Audio ships as plain files (.ogg/.mp3/.json are served as is): src/audio fetches effects and
  // the manifests by URL and streams music and voice lines through <audio> (src/audio/index.ts).
  const audioDir = join(pub, "audio");
  if (existsSync(audioDir)) {
    for (const f of walk(audioDir).filter((p) => /\.(ogg|mp3|json)$/.test(p)).sort()) {
      const bytes = readFileSync(f);
      write(join(out, relative(pub, f)), bytes);
      if (f.endsWith(".json")) jsonBytes += bytes.byteLength;
      else rawBinaryBytes += bytes.byteLength;
    }
  }

  const byKey = <T>(r: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(r).sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0)));
  // Text: version 1 when nothing is split, the same index builds wrote before parts existed.
  // Binary: version 3, with parts and filters only when there are some.
  const head = { defaultWorld: opts.worlds[0]!, worlds: opts.worlds, files: byKey(files) };
  const index: WebIndex = binary
    ? {
        version: 3,
        encoding,
        ...head,
        ...(split.length > 0 ? { parts: byKey(parts) } : {}),
        ...(Object.keys(filters).length > 0 ? { filters: byKey(filters) } : {}),
      }
    : split.length === 0
      ? { version: 1, ...head }
      : { version: 2, ...head, parts: byKey(parts) };
  write(join(out, "assets.index.json"), JSON.stringify(index));

  const notices = [
    ["Microsoft Rocketbox generic player", "assets/imports/rocketbox/LICENSE.md"],
    ["Microsoft Rocketbox pedestrian crowd", "assets/imports/rocketbox-crowd/LICENSE.md"],
    ["Slop New York rendering reference", "assets/imports/slop-new-york/LICENSE.md"],
    ["Fog City civilian car", "assets/imports/civilian-car/LICENSE.txt"],
  ].map(([label, path]) => `${label}\n${readFileSync(join(ROOT, path!), "utf8")}`).join("\n\n");
  write(join(out, "third-party-notices.txt"), notices +
    "\n\nSurface scans: Poly Haven CC0 1.0. See textures/surfaces/sources.json for sources.\n" +
    "\nPlayer movement: supplied Mixamo animations, retargeted to the existing Rocketbox rig. Adobe Mixamo terms apply. https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html\n" +
    "\nMusic: CC0 1.0 tracks from OpenGameArt.org. See audio/music/manifest.json for each title, author and source page.\n");

  const check = checkHostLimits(out, binary ? BINARY_LIMITS : HOST_LIMITS);
  if (check.problems.length > 0) throw new Error(`the build breaks the host's limits:\n  ${check.problems.join("\n  ")}`);
  return {
    encoding,
    files: check.files,
    totalBytes: check.totalBytes,
    largest: check.largest,
    packs,
    split: split.sort((p, q) => (p.src < q.src ? -1 : p.src > q.src ? 1 : 0)),
    rawBinaryBytes,
    encodedBinaryBytes,
    jsonBytes,
    bundleBytes,
  };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const t0 = performance.now();
  const report = await buildWeb({
    out: resolve(ROOT, arg("--out") ?? "dist"),
    worlds: (arg("--worlds") ?? "sf").split(",").filter(Boolean),
    level: Number(arg("--level") ?? 9),
    skipVite: process.argv.includes("--skip-vite"),
    sourcemap: !process.argv.includes("--no-sourcemap"),
    forceClean: process.argv.includes("--force-clean"),
    encoding: process.argv.includes("--text") ? "gzip-base64" : "gzip",
    ...(arg("--public") ? { publicDir: resolve(ROOT, arg("--public")!) } : {}),
  });
  const mb = (n: number): string => `${(n / 1e6).toFixed(1)} MB`;
  const limits = report.encoding === "gzip" ? BINARY_LIMITS : HOST_LIMITS;
  console.log(
    `web build (${report.encoding === "gzip" ? "binary" : "text"}): ${report.files} files, ${mb(report.totalBytes)} (limits ${limits.maxFiles} files, ${mb(limits.maxTotalBytes)}); ` +
      `largest ${report.largest.path} ${mb(report.largest.bytes)}; ${report.packs} packs; ` +
      `${report.split.length} in parts${report.split.map((s) => ` (${s.src}: ${s.parts.length} parts, ${s.parts.map(mb).join(" + ")})`).join("")}; ` +
      `binaries ${mb(report.rawBinaryBytes)} raw -> ${mb(report.encodedBinaryBytes)} ${report.encoding === "gzip" ? "gzip" : "gzip+base64"}; JSON ${mb(report.jsonBytes)}; ` +
      `bundle ${mb(report.bundleBytes)}; ${((performance.now() - t0) / 1000).toFixed(1)} s`,
  );
}
