// pnpm build (= pnpm build:web): the static web build for hosting, in dist/.
//
//   node scripts/build-web.ts [--out dist] [--worlds sf] [--level 9] [--skip-vite] [--no-sourcemap]
//
// 1. vite build (vite.config.ts: base "./", public/ not copied): index.html and the bundle,
//    every URL relative, so the page works from any sub-path.
// 2. The world and the models, in the layout src/io/assets.ts reads ("packed"):
//    - the page host serves only text-like types (no .glb, no .bin), so every binary is
//      gzip-compressed, base64-encoded and written as a .txt file;
//    - tile glbs are concatenated into packs, one per 3 x 3 block of tiles (a neighbourhood
//      the streamer needs together), the far-LOD cells into packs of their own, each pack at
//      most PACK_MAX_BYTES once encoded;
//    - the collider pack (world.colliders.bin) and each model are one .txt file each;
//    - the world's JSON the game reads is copied as is: the manifest, the road graph and the
//      data layers in RUNTIME_LAYERS (src/io/world-load.ts); the other layers (sidewalks,
//      hydrants, ...) stay out until a feature reads them;
//    - per-tile collider JSONs are not shipped (the game reads the collider pack);
//    - assets.index.json maps every binary's logical path to {src, offset, length}.
// 3. Checks the host's limits (files, total size, per-file size, extensions) and fails the
//    build when one is broken, then prints a summary.
//
// The bundle's source map ships by default (handy on a private page); --no-sourcemap leaves it
// out, for a public release.
//
// Deterministic: the same inputs give byte-identical outputs (gzip with no timestamp, sorted
// inputs), so a rebuild that changes nothing republishes nothing new.

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
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
/** A pack's encoded size stays under this (the host's per-file limit, with room to spare). */
export const PACK_MAX_BYTES = 14_000_000;
/** Tiles per pack side: a 3 x 3 block of 500 m tiles. */
export const PACK_BLOCK_TILES = 3;
export const ENCODED_SUFFIX = ".gz.b64.txt";

export interface IndexEntry {
  src: string;
  offset: number;
  length: number;
}

export interface WebIndex {
  version: 1;
  defaultWorld: string;
  worlds: string[];
  files: Record<string, IndexEntry>;
}

export function encode(bytes: Uint8Array, level = 9): string {
  return gzipSync(bytes, { level }).toString("base64");
}

interface PackItem {
  path: string;
  bytes: Uint8Array;
}

/**
 * Concatenate items into packs (in the given order, a new pack per group key), splitting a
 * group whenever a pack's encoded size would pass maxEncoded. Returns each pack's encoded text
 * and its index entries.
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
    if (text.length > maxEncoded) {
      if (items.length === 1) throw new Error(`${items[0]!.path} alone encodes to ${text.length} bytes, over ${maxEncoded}`);
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
}

export interface BuildReport {
  files: number;
  totalBytes: number;
  largest: { path: string; bytes: number };
  packs: number;
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

export async function buildWeb(opts: BuildOptions): Promise<BuildReport> {
  const out = opts.out;
  const pub = opts.publicDir ?? join(ROOT, "public");
  rmSync(out, { recursive: true, force: true });
  if (!opts.skipVite) {
    const { build } = await import("vite");
    await build({ root: ROOT, logLevel: "warn", build: { outDir: out, emptyOutDir: true, sourcemap: opts.sourcemap ?? true } });
  } else {
    mkdirSync(out, { recursive: true });
  }
  const bundleBytes = walk(out).reduce((s, f) => s + statSync(f).size, 0);
  const index: WebIndex = { version: 1, defaultWorld: opts.worlds[0]!, worlds: opts.worlds, files: {} };
  let rawBinaryBytes = 0;
  let encodedBinaryBytes = 0;
  let jsonBytes = 0;
  let packs = 0;

  const single = (logical: string, bytes: Uint8Array): void => {
    const src = logical + ENCODED_SUFFIX;
    const text = encode(bytes, opts.level);
    if (text.length > PACK_MAX_BYTES) throw new Error(`${logical} encodes to ${text.length} bytes, over ${PACK_MAX_BYTES}`);
    write(join(out, src), text);
    index.files[logical] = { src, offset: 0, length: bytes.byteLength };
    rawBinaryBytes += bytes.byteLength;
    encodedBinaryBytes += text.length;
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
      write(join(out, p.src), p.text);
      Object.assign(index.files, p.entries);
      encodedBinaryBytes += p.text.length;
      for (const e of Object.values(p.entries)) rawBinaryBytes += e.length;
      packs++;
    }
  }

  // Models: each its own file (a handful, loaded at boot).
  const modelsDir = join(pub, "models");
  for (const f of walk(modelsDir).filter((p) => p.toLowerCase().endsWith(".glb"))) {
    single(relative(pub, f).split("\\").join("/"), new Uint8Array(readFileSync(f)));
  }

  const sorted: WebIndex = { ...index, files: Object.fromEntries(Object.entries(index.files).sort((p, q) => (p[0] < q[0] ? -1 : 1))) };
  write(join(out, "assets.index.json"), JSON.stringify(sorted));

  const check = checkHostLimits(out);
  if (check.problems.length > 0) throw new Error(`the build breaks the host's limits:\n  ${check.problems.join("\n  ")}`);
  return {
    files: check.files,
    totalBytes: check.totalBytes,
    largest: check.largest,
    packs,
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
    out: join(ROOT, arg("--out") ?? "dist"),
    worlds: (arg("--worlds") ?? "sf").split(",").filter(Boolean),
    level: Number(arg("--level") ?? 9),
    skipVite: process.argv.includes("--skip-vite"),
    sourcemap: !process.argv.includes("--no-sourcemap"),
  });
  const mb = (n: number): string => `${(n / 1e6).toFixed(1)} MB`;
  console.log(
    `web build: ${report.files} files, ${mb(report.totalBytes)} (limits ${HOST_LIMITS.maxFiles} files, ${mb(HOST_LIMITS.maxTotalBytes)}); ` +
      `largest ${report.largest.path} ${mb(report.largest.bytes)}; ${report.packs} packs; ` +
      `binaries ${mb(report.rawBinaryBytes)} raw -> ${mb(report.encodedBinaryBytes)} gzip+base64; JSON ${mb(report.jsonBytes)}; ` +
      `bundle ${mb(report.bundleBytes)}; ${((performance.now() - t0) / 1000).toFixed(1)} s`,
  );
}
