// Where the game's files come from. One interface, two layouts:
//
//  - loose (pnpm dev, the test suites): every file at its own URL, relative to the page
//    (Vite serves public/ at the root), e.g. "tiles/sf/t3_-9.glb", "models/robotaxi.glb".
//  - packed (pnpm build, the hosted page): tile and far-cell glbs are concatenated into packs,
//    every binary is gzip-compressed, and assets.index.json maps each logical path to its pack
//    (or file), offset and length; JSON is served as is. A pack is fetched whole the first time
//    any file in it is needed, decoded once, cached, and sliced by offset (no Range requests).
//    An encoded file too big for one host file is written as parts the index lists in order
//    (`parts`): they are fetched concurrently, each checked against its listed size, joined in
//    order and decoded as one. scripts/build-web.ts writes this layout, stored one of two ways
//    (the index's `encoding`):
//     - "gzip" (index version 3, the default build): binary .gz files, each named for its
//       content (the host may cache them for good), decoded with the platform's
//       DecompressionStream. A host that answers a .gz with Content-Encoding: gzip hands the
//       page the decoded bytes already, and those are taken as they are. A src the index lists
//       under `filters` was byte-shuffled before compression (shuffleBytes) and is unshuffled
//       after.
//     - "gzip-base64" (index versions 1 and 2, `--text` builds, for a host that serves only
//       text-like types: no .glb, no .bin, no .gz): gzip, then base64, written as .txt files.
//
// Every URL is relative to the page, so a build works from any sub-path.

export interface AssetIndexEntry {
  /**
   * The file holding the bytes: a pack, or the file on its own, gzip (.gz) or gzip + base64
   * (.txt). When the index lists it under `parts`, it names the whole encoded file and its
   * parts are the files.
   */
  src: string;
  /** Byte range of the file inside the decoded src. */
  offset: number;
  length: number;
}

/** One part file of an encoded file written in parts. */
export interface AssetPart {
  /** The part's file. */
  src: string;
  /** Its size: bytes of the stored file (for base64 text, one byte a character). */
  bytes: number;
}

/** How an index's srcs are stored. */
export type AssetEncoding = "gzip" | "gzip-base64";
/** A reversible byte filter applied before compression: "shuffle4" is shuffleBytes(_, 4). */
export type AssetFilter = "shuffle4";

export interface AssetIndex {
  /**
   * 1: gzip + base64, every src one file. 2: the same, some written in parts (`parts`).
   * 3: `encoding` says how srcs are stored ("gzip": binary), with `parts` and `filters` as
   * needed. The loader reads all three.
   */
  version: 1 | 2 | 3;
  /** World opened when the page has no ?world=. */
  defaultWorld: string;
  /** Worlds this build carries. */
  worlds: string[];
  /** Logical path ("tiles/sf/t3_-9.glb") -> where its bytes are. JSON files are not listed: they are served as is. */
  files: Record<string, AssetIndexEntry>;
  /**
   * An entry's src -> its part files, in the order they join; only for the srcs too big for
   * one host file. Absent when nothing is split.
   */
  parts?: Record<string, AssetPart[]>;
  /** Version 3: how every src is stored. Versions 1 and 2 are always "gzip-base64". */
  encoding?: AssetEncoding;
  /** Version 3: a src -> the filter to undo once it is decompressed. Absent when none is. */
  filters?: Record<string, AssetFilter>;
}

/** The index versions this loader reads. */
export const ASSET_INDEX_VERSIONS: readonly number[] = [1, 2, 3];
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

function parseJsonText<T>(url: string, text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    // A dev server answers a missing file with index.html.
    throw new Error(`${url} is missing or not JSON (has this world been built?)`);
  }
}

async function parseJson<T>(url: string, r: Response): Promise<T> {
  return parseJsonText<T>(url, await r.text());
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

/** Starts with gzip's magic number. */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * Byte planes: byte k of every `stride`-byte word is written together, plane after plane (the
 * last byteLength % stride bytes stay at the end as they are). Records of int16 and int32
 * values compress far better this way: each plane holds bytes of one kind (the citywide
 * collider pack: 9.18 MB gzip as it is, 7.79 MB shuffled by 4). unshuffleBytes undoes it.
 */
export function shuffleBytes(bytes: Uint8Array, stride: number): Uint8Array {
  const words = Math.floor(bytes.byteLength / stride);
  const out = new Uint8Array(bytes.byteLength);
  for (let k = 0; k < stride; k++) {
    const plane = k * words;
    for (let i = 0; i < words; i++) out[plane + i] = bytes[i * stride + k]!;
  }
  out.set(bytes.subarray(words * stride), words * stride);
  return out;
}

/** shuffleBytes undone: the bytes as they were before it. */
export function unshuffleBytes(bytes: Uint8Array, stride: number): Uint8Array {
  const words = Math.floor(bytes.byteLength / stride);
  const out = new Uint8Array(bytes.byteLength);
  for (let k = 0; k < stride; k++) {
    const plane = k * words;
    for (let i = 0; i < words; i++) out[i * stride + k] = bytes[plane + i]!;
  }
  out.set(bytes.subarray(words * stride), words * stride);
  return out;
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

/**
 * Decoded packs kept in memory; older ones are dropped (the browser's HTTP cache still has
 * them). Only packs count: a file stored on its own never pushes a pack out.
 */
const MAX_CACHED_PACKS = 12;
/** Decoded files stored on their own (a model, a motion bank) kept for the next request, the most recently used. */
const MAX_CACHED_SINGLES = 8;
/**
 * A file stored on its own and bigger than this (the collider pack, the player's body) is
 * handed to its caller and not kept: it is read once, and a copy kept would only hold memory.
 */
const KEEP_SINGLE_MAX_BYTES = 1_000_000;

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The stored bytes of one src: its file, or, when the index lists parts for it, every part
 * fetched concurrently, each checked against the size the index gives it, joined in index order.
 * A part that fails or is the wrong size fails the whole src, naming the part by the number in
 * its file's name (from 0: ".part1" is "part 1 of parts 0..n-1") and the file itself. Base64
 * text ("gzip-base64") ignores whitespace and comes back as its characters' bytes.
 */
async function fetchStored(base: string, src: string, parts: readonly AssetPart[] | undefined, text: boolean): Promise<Uint8Array | string> {
  const read = async (r: Response): Promise<Uint8Array | string> => (text ? (await r.text()).replace(/\s+/g, "") : new Uint8Array(await r.arrayBuffer()));
  if (!parts) return read(await fetchOk(base + src));
  if (parts.length === 0) throw new Error(`${src}: the index lists no parts`);
  const pieces = await Promise.all(
    parts.map(async (part, i) => {
      const what = `part ${i} of parts 0..${parts.length - 1} (${part.src})`;
      let piece: Uint8Array | string;
      try {
        const r = await fetch(base + part.src);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        piece = await read(r);
      } catch (err) {
        throw new Error(`${what}: ${message(err)}`);
      }
      const size = typeof piece === "string" ? piece.length : piece.byteLength;
      if (size !== part.bytes) throw new Error(`${what} is ${size} bytes, the index says ${part.bytes}`);
      return piece;
    }),
  );
  if (text) return (pieces as string[]).join("");
  const all = new Uint8Array(pieces.reduce((s, p) => s + (p as Uint8Array).byteLength, 0));
  let at = 0;
  for (const p of pieces as Uint8Array[]) {
    all.set(p, at);
    at += p.byteLength;
  }
  return all;
}

/**
 * Stored bytes to the file's bytes: gzip decompressed; bytes the host already decoded (a .gz
 * answered with Content-Encoding: gzip) taken as they are, when they are the length the index
 * expects; then the src's filter undone.
 */
async function decodeStored(stored: Uint8Array | string, want: number | undefined, filter: AssetFilter | undefined): Promise<Uint8Array> {
  let all: Uint8Array;
  if (typeof stored === "string") all = await decodeGzBase64(stored);
  else if (!isGzip(stored) && stored.byteLength === want) all = stored;
  else all = await gunzip(stored);
  return filter === "shuffle4" ? unshuffleBytes(all, 4) : all;
}

/** Packed layout from an index already fetched. Exported for tests. */
export function packedAssets(index: AssetIndex, base = ""): Assets {
  const text = (index.encoding ?? "gzip-base64") === "gzip-base64";
  // Each src decodes to exactly the bytes its entries cover (a pack's files back to back, or
  // one file): anything else is a truncated or mismatched file, never sliced silently.
  const srcBytes = new Map<string, number>();
  const srcFiles = new Map<string, number>();
  for (const e of Object.values(index.files)) {
    srcBytes.set(e.src, Math.max(srcBytes.get(e.src) ?? 0, e.offset + e.length));
    srcFiles.set(e.src, (srcFiles.get(e.src) ?? 0) + 1);
  }
  const packs = new Map<string, Promise<Uint8Array>>();
  const singles = new Map<string, Promise<Uint8Array>>();
  /** Requests for a big single file still waiting on its one fetch. */
  const flights = new Map<string, { promise: Promise<Uint8Array>; waiting: number }>();
  const decode = (src: string): Promise<Uint8Array> =>
    fetchStored(base, src, index.parts?.[src], text).then(async (stored) => {
      const want = srcBytes.get(src);
      let all: Uint8Array;
      try {
        all = await decodeStored(stored, want, index.filters?.[src]);
      } catch (err) {
        throw new Error(`${src} does not decode: ${message(err)}`);
      }
      if (all.byteLength !== want) throw new Error(`${src} decodes to ${all.byteLength} bytes, the index says ${String(want)}`);
      return all;
    });
  /** Through a most-recently-used cache of at most `max` srcs. */
  const cached = (cache: Map<string, Promise<Uint8Array>>, max: number, src: string): Promise<Uint8Array> => {
    let p = cache.get(src);
    if (p) {
      // Most recently used last.
      cache.delete(src);
      cache.set(src, p);
      return p;
    }
    p = decode(src);
    // A failed load is not cached: the next request tries again.
    p.catch(() => cache.delete(src));
    cache.set(src, p);
    while (cache.size > max) cache.delete(cache.keys().next().value!);
    return p;
  };
  /**
   * A big single file: one fetch for every request made while it is in flight, kept by no one
   * after. Each waiter but the last gets a copy, the last the decoded bytes themselves (copies
   * are made before it runs, so none sees bytes another caller has handed on).
   */
  const handOver = async (src: string): Promise<Uint8Array> => {
    let flight = flights.get(src);
    if (!flight) {
      const promise = decode(src);
      const f = { promise, waiting: 0 };
      flights.set(src, (flight = f));
      void promise.then(
        () => { if (flights.get(src) === f) flights.delete(src); },
        () => { if (flights.get(src) === f) flights.delete(src); },
      );
    }
    flight.waiting++;
    try {
      const all = await flight.promise;
      return --flight.waiting === 0 ? all : all.slice();
    } catch (err) {
      flight.waiting--;
      throw err;
    }
  };
  return {
    mode: "packed",
    defaultWorld: index.defaultWorld,
    worlds: index.worlds,
    async bytes(path) {
      const e = index.files[path];
      if (!e) throw new Error(`${path} is not in this build (${ASSET_INDEX})`);
      try {
        if ((srcFiles.get(e.src) ?? 0) > 1) {
          // A copy: callers may hand the buffer to a parser that keeps or transfers it.
          const all = await cached(packs, MAX_CACHED_PACKS, e.src);
          return all.slice(e.offset, e.offset + e.length);
        }
        if ((srcBytes.get(e.src) ?? 0) <= KEEP_SINGLE_MAX_BYTES) return (await cached(singles, MAX_CACHED_SINGLES, e.src)).slice();
        return await handOver(e.src);
      } catch (err) {
        throw new Error(`${path}: ${message(err)}`);
      }
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
 * the page (or under `base`); the dev server serves loose files.
 */
export async function openAssets(packed: boolean, base = ""): Promise<Assets> {
  if (!packed) return looseAssets(base);
  const url = base + ASSET_INDEX;
  const index = await parseJson<AssetIndex>(url, await fetchOk(url));
  if (!ASSET_INDEX_VERSIONS.includes(index.version)) {
    throw new Error(`${ASSET_INDEX}: unsupported version ${String(index.version)} (this page reads ${ASSET_INDEX_VERSIONS.join(", ")})`);
  }
  if (index.version === 3 && index.encoding !== "gzip" && index.encoding !== "gzip-base64") {
    throw new Error(`${ASSET_INDEX}: unsupported encoding ${String(index.encoding)}`);
  }
  return packedAssets(index, base);
}

/** Assets for the boot, and the call that ends it. */
export interface BootAssets {
  readonly assets: Assets;
  /** The game is playable: release the held-back files and drop the boot's JSON texts. */
  ready(): void;
}

/**
 * Assets as the boot uses them, over `inner` (whose files are under `base`):
 *  - a binary for which `later(path)` holds is not fetched until ready(): files the first
 *    frame does not need (the crowd's skinned people, drawn as procedural people until they
 *    load) leave the network and the main thread to the files it does;
 *  - until ready(), each JSON file is fetched once however many readers ask for it (the sim
 *    and the renderer both read street detail's layers), and every reader parses its own copy
 *    from the one text, so no reader sees another's changes. ready() drops the texts.
 */
export function bootAssets(inner: Assets, later: (path: string) => boolean, base = ""): BootAssets {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  let booting = true;
  const texts = new Map<string, Promise<string>>();
  const assets: Assets = {
    mode: inner.mode,
    defaultWorld: inner.defaultWorld,
    worlds: inner.worlds,
    has: (path) => inner.has(path),
    async bytes(path) {
      if (booting && later(path)) await opened;
      return inner.bytes(path);
    },
    async json<T>(path: string) {
      if (!booting) return inner.json<T>(path);
      const url = base + path;
      let text = texts.get(path);
      if (!text) {
        text = fetchOk(url).then((r) => r.text());
        // A failed fetch is not kept: the next reader tries again.
        text.catch(() => texts.delete(path));
        texts.set(path, text);
      }
      return parseJsonText<T>(url, await text);
    },
  };
  return {
    assets,
    ready() {
      if (!booting) return;
      booting = false;
      texts.clear();
      open();
    },
  };
}
