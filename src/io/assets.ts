// Where the game's files come from. One interface, two layouts:
//
//  - loose (pnpm dev, the test suites): every file at its own URL, relative to the page
//    (Vite serves public/ at the root), e.g. "tiles/sf/t3_-9.glb", "models/robotaxi.glb".
//  - packed (pnpm build, the hosted page): the page host serves only text-like types (no .glb,
//    no .bin), so every binary is gzip-compressed, base64-encoded and written as a .txt file;
//    tile and far-cell glbs are concatenated into packs of at most 15 MB. assets.index.json
//    maps each logical path to its pack (or file), offset and length; JSON is served as is.
//    A pack is fetched whole the first time any file in it is needed, decoded once, cached,
//    and sliced by offset (no Range requests). scripts/build-web.ts writes this layout.
//
// Every URL is relative to the page, so a build works from any sub-path.

export interface AssetIndexEntry {
  /** The .txt file (gzip + base64) holding the bytes: a pack, or the file on its own. */
  src: string;
  /** Byte range of the file inside the decoded src. */
  offset: number;
  length: number;
}

export interface AssetIndex {
  version: 1;
  /** World opened when the page has no ?world=. */
  defaultWorld: string;
  /** Worlds this build carries. */
  worlds: string[];
  /** Logical path ("tiles/sf/t3_-9.glb") -> where its bytes are. JSON files are not listed: they are served as is. */
  files: Record<string, AssetIndexEntry>;
}

export const ASSET_INDEX = "assets.index.json";

export interface Assets {
  readonly mode: "loose" | "packed";
  /** World to open when the page names none (packed builds), else null. */
  readonly defaultWorld: string | null;
  /** Worlds a packed build carries; null when unknown (loose). */
  readonly worlds: readonly string[] | null;
  /** The raw bytes of a binary file (a glb, the collider pack). */
  bytes(path: string): Promise<Uint8Array>;
  /** A JSON file, parsed. */
  json<T>(path: string): Promise<T>;
  /** Packed: whether the build carries this binary. Loose: true (a missing file fails on fetch). */
  has(path: string): boolean;
}

async function fetchOk(url: string): Promise<Response> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r;
}

async function parseJson<T>(url: string, r: Response): Promise<T> {
  const text = await r.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    // A dev server answers a missing file with index.html.
    throw new Error(`${url} is missing or not JSON (has this world been built?)`);
  }
}

/** Base64 text to bytes (whitespace ignored). */
export function base64ToBytes(text: string): Uint8Array {
  const bin = atob(text.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** gzip bytes to the bytes they hold, with the platform's DecompressionStream. */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The text of a .gz.b64.txt file to the bytes it encodes. */
export async function decodeGzBase64(text: string): Promise<Uint8Array> {
  return gunzip(base64ToBytes(text));
}

/** Files at their own URLs under `base` (relative to the page; "" = the page's directory). */
export function looseAssets(base = ""): Assets {
  return {
    mode: "loose",
    defaultWorld: null,
    worlds: null,
    async bytes(path) {
      const r = await fetchOk(base + path);
      const type = r.headers.get("content-type") ?? "";
      // A dev server answers a missing file with index.html (status 200).
      if (type.includes("text/html")) throw new Error(`${base + path} is missing`);
      return new Uint8Array(await r.arrayBuffer());
    },
    async json<T>(path: string) {
      const url = base + path;
      return parseJson<T>(url, await fetchOk(url));
    },
    has: () => true,
  };
}

/** Decoded packs kept in memory; older ones are dropped (the browser's HTTP cache still has them). */
const MAX_CACHED_PACKS = 12;

/** Packed layout from an index already fetched. Exported for tests. */
export function packedAssets(index: AssetIndex, base = ""): Assets {
  const cache = new Map<string, Promise<Uint8Array>>();
  const load = (src: string): Promise<Uint8Array> => {
    let p = cache.get(src);
    if (p) {
      // Most recently used last.
      cache.delete(src);
      cache.set(src, p);
      return p;
    }
    p = fetchOk(base + src)
      .then((r) => r.text())
      .then(decodeGzBase64);
    p.catch(() => cache.delete(src));
    cache.set(src, p);
    while (cache.size > MAX_CACHED_PACKS) cache.delete(cache.keys().next().value!);
    return p;
  };
  return {
    mode: "packed",
    defaultWorld: index.defaultWorld,
    worlds: index.worlds,
    async bytes(path) {
      const e = index.files[path];
      if (!e) throw new Error(`${path} is not in this build (${ASSET_INDEX})`);
      const all = await load(e.src);
      if (e.offset + e.length > all.byteLength) throw new Error(`${path}: ${e.src} is shorter than its index says`);
      // A copy: callers may hand the buffer to a parser that keeps or transfers it.
      return all.slice(e.offset, e.offset + e.length);
    },
    async json<T>(path: string) {
      const url = base + path;
      return parseJson<T>(url, await fetchOk(url));
    },
    has: (path) => index.files[path] !== undefined,
  };
}

/**
 * The layout of this build: a production build (pnpm build) reads assets.index.json beside
 * the page; the dev server serves loose files.
 */
export async function openAssets(packed: boolean): Promise<Assets> {
  if (!packed) return looseAssets();
  const r = await fetchOk(ASSET_INDEX);
  const index = await parseJson<AssetIndex>(ASSET_INDEX, r);
  if (index.version !== 1) throw new Error(`${ASSET_INDEX}: unsupported version ${String(index.version)}`);
  return packedAssets(index);
}
