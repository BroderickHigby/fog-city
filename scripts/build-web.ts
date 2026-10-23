// pnpm build (= pnpm build:web): the static web build for hosting, in dist/.
//
//   node scripts/build-web.ts [--out dist] [--worlds sf] [--level 9] [--skip-vite] [--no-sourcemap]
//                             [--public <dir>] [--force-clean]
//
// 0. Clears the out directory (relative to the checkout, or absolute), but only one a build
//    could have written: new, empty, or holding nothing but a build's files (index.html,
//    assets/, assets.index.json, tiles/ and models/ of .json and .txt). Anything else (a
//    stray notes.txt, a source tree) stops the build before it deletes a thing, unless
//    --force-clean; the checkout, the public/ it reads and any directory holding either are
//    refused even then. The world's manifests are checked before the old build is deleted.
// 1. vite build (vite.config.ts: base "./", public/ not copied): index.html and the bundle,
//    every URL relative, so the page works from any sub-path.
// 2. The world and the models, in the layout src/io/assets.ts reads ("packed"):
//    - the page host serves only text-like types (no .glb, no .bin), so every binary is
//      gzip-compressed, base64-encoded and written as a .txt file;
//    - tile glbs are concatenated into packs, one per 3 x 3 block of tiles (a neighbourhood
//      the streamer needs together), the far-LOD cells into packs of their own, each pack at
//      most PACK_MAX_BYTES once encoded where its files allow (a file alone over it is a pack
//      of its own);
//    - the collider pack (world.colliders.bin) and each model are encoded on their own;
//    - any encoded file over PACK_MAX_BYTES (the citywide collider pack, 14.3 MB encoded on the
//      2026-10-21 QA world) is written as parts instead of one file: <src minus .txt>.part<N>.txt
//      (world.colliders.bin.gz.b64.part0.txt, ...part1.txt), N from 0, as few parts as fit,
//      sizes as even as whole base64 quanta allow (every cut at a multiple of 4 characters, so
//      each part is valid base64 on its own), each checked at most PACK_MAX_BYTES; the page
//      fetches them concurrently, checks each part's size, joins them in order and decodes;
//    - the world's JSON the game reads is copied as is: the manifest, the road graph and the
//      data layers in RUNTIME_LAYERS (src/io/world-load.ts); the other layers (hydrants,
//      fountains, ...) stay out until a feature reads them;
//    - per-tile collider JSONs are not shipped (the game reads the collider pack);
//    - assets.index.json maps every binary's logical path to {src, offset, length} and, for a
//      src written in parts, lists them under parts[src] as [{src, bytes}] in join order. An
//      index with parts is version 2, one without stays version 1 (the shape builds wrote before
//      parts existed), so a page too old to know parts refuses a split build by its version.
// 3. Checks the host's limits (files, total size, per-file size, extensions; every part is a
//    file of its own) and fails the build when one is broken, then prints a summary that names
//    each file written in parts.
//
// The bundle's source map ships by default (handy on a private page); --no-sourcemap leaves it
// out, for a public release. --public builds the world and models from another public/
// directory (a pipeline branch's world, before it merges).
//
// Republishing to a page that already holds an earlier build: the host keeps any file an
// update leaves out, so remove every path the earlier build had and this one lacks (the whole
// world.colliders.bin.gz.b64.txt once that is written in parts, a pack name that is gone).
// The page never reads them, but they count against the host's file and size totals.
//
// Deterministic: the same inputs give byte-identical outputs (gzip with no timestamp, sorted
// inputs, part names and cuts fixed by the encoded text), so a rebuild that changes nothing
// republishes nothing new.

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { ASSET_INDEX, type AssetIndex, type AssetIndexEntry, type AssetPart } from "../src/io/assets.ts";
import { RUNTIME_LAYERS } from "../src/io/world-load.ts";

export const ROOT = join(import.meta.dirname, "..");
/** The page host's limits (measured; anything else is refused at publish). */
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
 * A pack's encoded size stays under this, and an encoded file over it is written in parts of at
 * most this (the host's per-file limit, with room to spare).
 */
export const PACK_MAX_BYTES = 14_000_000;
/** Tiles per pack side: a 3 x 3 block of 500 m tiles. */
export const PACK_BLOCK_TILES = 3;
export const ENCODED_SUFFIX = ".gz.b64.txt";

/** assets.index.json, as the loader (src/io/assets.ts) reads it. */
export type WebIndex = AssetIndex;
export type IndexEntry = AssetIndexEntry;
export type IndexPart = AssetPart;

export function encode(bytes: Uint8Array, level = 9): string {
  return gzipSync(bytes, { level }).toString("base64");
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

interface PackItem {
  path: string;
  bytes: Uint8Array;
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
  const out: Array<{ src: string; text: string; entries: Record<string, IndexEntry> }> = [];
  const flush = (key: string, items: readonly PackItem[]): void => {
    if (items.length === 0) return;
    const total = items.reduce((s, i) => s + i.bytes.byteLength, 0);
    const buf = new Uint8Array(total);
    const entries: Record<string, IndexEntry> = {};
    const src = name(out.length, key);
    let off = 0;
    for (const it of items) {
      buf.set(it.bytes, off);
      entries[it.path] = { src, offset: off, length: it.bytes.byteLength };
      off += it.bytes.byteLength;
    }
    const text = encode(buf, level);
    if (text.length > maxEncoded && items.length > 1) {
      const half = Math.ceil(items.length / 2);
      flush(key, items.slice(0, half));
      flush(key, items.slice(half));
      return;
    }
    out.push({ src, text, entries });
  };
  for (const g of groups) flush(g.key, g.items);
  return out;
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
}

export interface BuildReport {
  files: number;
  totalBytes: number;
  largest: { path: string; bytes: number };
  packs: number;
  /** The encoded files written in parts: each src and its parts' sizes, in order. */
  split: Array<{ src: string; parts: number[] }>;
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

/** Check a built directory against the host's limits; returns the problems (empty when fine). */
export function checkHostLimits(dir: string): { problems: string[]; files: number; totalBytes: number; largest: { path: string; bytes: number } } {
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
    if (!(HOST_LIMITS.extensions as readonly string[]).includes(ext)) problems.push(`${rel}: extension "${ext}" is not served by the host`);
    if (bytes > HOST_LIMITS.maxFileBytes) problems.push(`${rel}: ${bytes} bytes, over ${HOST_LIMITS.maxFileBytes}`);
  }
  if (files.length > HOST_LIMITS.maxFiles) problems.push(`${files.length} files, over ${HOST_LIMITS.maxFiles}`);
  if (total > HOST_LIMITS.maxTotalBytes) problems.push(`${total} bytes in all, over ${HOST_LIMITS.maxTotalBytes}`);
  return { problems, files: files.length, totalBytes: total, largest };
}

/** The top-level names a build writes into its out directory. */
const BUILD_ENTRIES: ReadonlySet<string> = new Set(["index.html", "assets", ASSET_INDEX, "tiles", "models"]);

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
 * a build's files (index.html and assets/ from vite, assets.index.json, tiles/ and models/ of
 * .json and .txt files), whole or left half-written by a build that stopped. Anything else is
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
      if (!BUILD_ENTRIES.has(e.name) || isDir !== (e.name === "assets" || e.name === "tiles" || e.name === "models")) stray.push(e.name);
      else if (e.name === "assets") look(join(out, e.name), e.name, served);
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
  const files: WebIndex["files"] = {};
  const parts: Record<string, IndexPart[]> = {};
  const split: BuildReport["split"] = [];
  let rawBinaryBytes = 0;
  let encodedBinaryBytes = 0;
  let jsonBytes = 0;
  let packs = 0;
  const written = new Set<string>();

  /** Write one encoded src: one file, or its parts when it is over partMax. */
  const emit = (src: string, text: string): void => {
    const layout = layoutEncoded(src, text, partMax);
    for (const f of layout.files) {
      if (written.has(f.path)) throw new Error(`${f.path} would be written twice`);
      written.add(f.path);
      write(join(out, f.path), f.text);
    }
    if (layout.parts) {
      parts[src] = layout.parts;
      split.push({ src, parts: layout.parts.map((p) => p.bytes) });
    }
    encodedBinaryBytes += text.length;
  };

  const single = (logical: string, bytes: Uint8Array): void => {
    const src = logical + ENCODED_SUFFIX;
    emit(src, encode(bytes, opts.level));
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
    const jsonFiles = [...new Set(["manifest.json", manifest.roads, ...RUNTIME_LAYERS.map((l) => manifest.layers?.[l])])]
      .filter((f): f is string => typeof f === "string" && f.length > 0)
      .sort();
    for (const f of jsonFiles) {
      if (!present.has(f)) throw new Error(`world ${world}: ${f} is named by the manifest but missing`);
      const bytes = readFileSync(join(dir, f));
      write(join(out, prefix + f), bytes);
      jsonBytes += bytes.byteLength;
    }
    single(prefix + manifest.worldColliders, new Uint8Array(readFileSync(join(dir, manifest.worldColliders))));

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
    const tilePacks = packItems(groups, (n) => `${prefix}packs/tiles-${String(n).padStart(3, "0")}.pack${ENCODED_SUFFIX}`, opts.level);
    const farPacks = packItems([{ key: "far", items: far }], (n) => `${prefix}packs/far-${String(n).padStart(2, "0")}.pack${ENCODED_SUFFIX}`, opts.level);
    for (const p of [...tilePacks, ...farPacks]) {
      emit(p.src, p.text);
      Object.assign(files, p.entries);
      for (const e of Object.values(p.entries)) rawBinaryBytes += e.length;
      packs++;
    }
  }

  // Models: each its own file (a handful, loaded at boot). The material textures under
  // models/textures/ (WebP, and their index textures.json, read by the high graphics tier
  // through the same bytes() call) are packed the same way.
  const modelsDir = join(pub, "models");
  // The crowd's vertex-animation textures (humanoid-vat-*.bin) and their humanoid-vat.json too.
  for (const f of walk(modelsDir).filter((p) => /\.(glb|webp|bin)$/i.test(p) || /[\\/](textures[\\/]textures|humanoid-vat)\.json$/.test(p))) {
    single(relative(pub, f).split("\\").join("/"), new Uint8Array(readFileSync(f)));
  }

  const byKey = <T>(r: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(r).sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0)));
  // Version 1 when nothing is split: the same index builds wrote before parts existed.
  const index: WebIndex =
    split.length === 0
      ? { version: 1, defaultWorld: opts.worlds[0]!, worlds: opts.worlds, files: byKey(files) }
      : { version: 2, defaultWorld: opts.worlds[0]!, worlds: opts.worlds, files: byKey(files), parts: byKey(parts) };
  write(join(out, "assets.index.json"), JSON.stringify(index));

  const check = checkHostLimits(out);
  if (check.problems.length > 0) throw new Error(`the build breaks the host's limits:\n  ${check.problems.join("\n  ")}`);
  return {
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
    ...(arg("--public") ? { publicDir: resolve(ROOT, arg("--public")!) } : {}),
  });
  const mb = (n: number): string => `${(n / 1e6).toFixed(1)} MB`;
  console.log(
    `web build: ${report.files} files, ${mb(report.totalBytes)} (limits ${HOST_LIMITS.maxFiles} files, ${mb(HOST_LIMITS.maxTotalBytes)}); ` +
      `largest ${report.largest.path} ${mb(report.largest.bytes)}; ${report.packs} packs; ` +
      `${report.split.length} in parts${report.split.map((s) => ` (${s.src}: ${s.parts.length} parts, ${s.parts.map(mb).join(" + ")})`).join("")}; ` +
      `binaries ${mb(report.rawBinaryBytes)} raw -> ${mb(report.encodedBinaryBytes)} gzip+base64; JSON ${mb(report.jsonBytes)}; ` +
      `bundle ${mb(report.bundleBytes)}; ${((performance.now() - t0) / 1000).toFixed(1)} s`,
  );
}
