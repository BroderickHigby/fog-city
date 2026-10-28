// The asset layer (src/io/assets.ts) and the web build's packer (scripts/build-web.ts): files
// packed and gzip-compressed into binary .gz packs (the default build), or further
// base64-encoded into .txt packs (--text), come back byte for byte through the index (file ->
// pack, offset, length), whether the host hands the page the .gz as it is or decodes it on the
// way (Content-Encoding: gzip); a byte-shuffled src is unshuffled; a pack is fetched once
// however many files it holds and however many single files pass through between; an encoded
// file over the per-file limit is written as parts that join back in index order (a missing,
// short or reordered part fails loudly, never a truncated decode); the boot holds back what it
// is told to until ready and fetches each JSON file once for all its readers; and both layouts
// load a world's sim files the same way (src/io/world-load.ts). Served from a loopback server
// under a sub-path, as the page host does. The last block builds the real SF world both ways
// with a part limit low enough to split its collider pack, twice each, and loads the world
// from the results.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import {
  BINARY_DIR,
  BINARY_LIMITS,
  ENCODED_SUFFIX,
  HOST_LIMITS,
  PACK_MAX_BYTES,
  binaryName,
  binaryPartName,
  buildWeb,
  checkHostLimits,
  compress,
  encode,
  layoutBinary,
  layoutEncoded,
  outDirRefusal,
  packBinary,
  packItems,
  partName,
  splitBytes,
  splitEncoded,
  type WebIndex,
} from "../../scripts/build-web.ts";
import { base64ToBytes, bootAssets, decodeGzBase64, looseAssets, openAssets, packedAssets, shuffleBytes, unshuffleBytes, type Assets } from "../../src/io/assets.ts";
import { RUNTIME_LAYERS, loadWorldFiles } from "../../src/io/world-load.ts";
import { ROOT, worldExists } from "../helpers.ts";

const bytesOf = (n: number, seed: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed * 7 + ((i >> 5) & 255)) & 255);
/** Byte-for-byte equality without toEqual's element walk (slow on a megabyte, long enough for an idle socket to close). */
const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
/** Random-looking bytes, which gzip cannot shrink: their encoding is about 4/3 their size. */
const noisy = (n: number, seed: number): Uint8Array => {
  let x = seed * 2654435761 + 1;
  return Uint8Array.from({ length: n }, () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return x & 255;
  });
};

/**
 * A loopback server for `dir`, recording each request's path and the most part files in flight
 * at once. A .gz goes out as application/gzip, as it is (Vercel), or with `gzipEncoding` as
 * Content-Encoding: gzip, which the client decodes on the way (vite preview's sirv does that).
 */
async function serve(dir: string, opts: { partDelayMs?: number; gzipEncoding?: boolean } = {}): Promise<{ origin: string; hits: string[]; maxPartsInFlight: () => number; close: () => Promise<void> }> {
  const hits: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const server = createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? "/").split("?")[0]!);
    hits.push(url);
    const part = /\.part\d+(\.txt)?$/.test(url);
    if (part) maxInFlight = Math.max(maxInFlight, ++inFlight);
    const answer = (): void => {
      if (part) inFlight--;
      try {
        const body = readFileSync(join(dir, url));
        const gz = url.endsWith(".gz");
        res.writeHead(200, {
          "content-type": url.endsWith(".json") ? "application/json" : url.endsWith(".txt") ? "text/plain" : gz && !opts.gzipEncoding ? "application/gzip" : "application/octet-stream",
          ...(gz && opts.gzipEncoding ? { "content-encoding": "gzip" } : {}),
        });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end();
      }
    };
    if (part && opts.partDelayMs) setTimeout(answer, opts.partDelayMs);
    else answer();
  });
  // Idle sockets stay open past a slow step (decoding the citywide pack on a busy machine): with
  // Node's 5 s default the client may reuse a socket the server just closed ("fetch failed").
  server.keepAliveTimeout = 120_000;
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const addr = server.address();
  return {
    origin: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`,
    hits,
    maxPartsInFlight: () => maxInFlight,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

describe("packing", () => {
  it("encodes to gzip + base64 that decodes back exactly", async () => {
    const b = bytesOf(100_000, 3);
    const text = encode(b);
    expect(text).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(await decodeGzBase64(text)).toEqual(b);
    expect(base64ToBytes("AAEC/w==")).toEqual(Uint8Array.from([0, 1, 2, 255]));
  });

  it("concatenates a group's files into one pack with exact offsets, and splits a pack that would be too big", async () => {
    const items = [0, 1, 2, 3, 4].map((i) => ({ path: `tiles/w/t${i}.glb`, bytes: bytesOf(20_000 + i * 1000, i) }));
    const one = packItems([{ key: "a", items }], (n) => `p${n}${ENCODED_SUFFIX}`);
    expect(one).toHaveLength(1);
    const all = await decodeGzBase64(one[0]!.text);
    for (const it of items) {
      const e = one[0]!.entries[it.path]!;
      expect(e.src).toBe(`p0${ENCODED_SUFFIX}`);
      expect(all.slice(e.offset, e.offset + e.length)).toEqual(it.bytes);
    }
    // Random bytes do not compress: a 60 kB cap forces splits, and every file still maps to its bytes.
    const noise = [0, 1, 2, 3, 4].map((i) => ({ path: `n${i}`, bytes: noisy(20_000, i + 1) }));
    const split = packItems([{ key: "b", items: noise }], (n) => `q${n}`, 9, 60_000);
    expect(split.length).toBeGreaterThan(1);
    for (const p of split) expect(p.text.length).toBeLessThanOrEqual(60_000);
    expect(new Set(split.flatMap((p) => Object.keys(p.entries)))).toEqual(new Set(noise.map((n) => n.path)));
    // A file alone over the cap is a pack of its own (the build writes it in parts), not an error.
    const lone = packItems([{ key: "c", items: [noise[0]!] }], () => "x", 9, 1000);
    expect(lone).toHaveLength(1);
    expect(lone[0]!.text.length).toBeGreaterThan(1000);
    expect(lone[0]!.entries).toEqual({ n0: { src: "x", offset: 0, length: 20_000 } });
  });
});

describe("an encoded file over the limit, in parts", () => {
  const text = encode(noisy(30_000, 5));

  it("cuts the encoded text into as few even parts as fit, each whole base64 quanta under the limit, joining back exactly", () => {
    expect(text.length).toBeGreaterThan(36_000);
    const parts = splitEncoded(text, 12_000);
    expect(parts.length).toBe(Math.ceil(text.length / 12_000));
    expect(parts.length).toBeGreaterThanOrEqual(3);
    expect(parts.join("")).toBe(text);
    for (const p of parts) {
      expect(p.length).toBeGreaterThan(0);
      expect(p.length).toBeLessThanOrEqual(12_000);
      expect(p.length % 4, "whole base64 quanta").toBe(0);
      expect(base64ToBytes(p).length, "each part is valid base64 on its own").toBe((p.length / 4) * 3 - (p.endsWith("==") ? 2 : p.endsWith("=") ? 1 : 0));
    }
    const sizes = parts.map((p) => p.length);
    expect(Math.max(...sizes) - Math.min(...sizes), "as even as quanta allow").toBeLessThanOrEqual(4 * parts.length);
    // Deterministic: the cuts depend on the text alone.
    expect(splitEncoded(text, 12_000)).toEqual(parts);
    // A limit that is not a multiple of 4 still holds: every part stays under it.
    for (const p of splitEncoded(text, 10_001)) expect(p.length).toBeLessThanOrEqual(10_001);
    // Within the limit: one part, the text itself.
    expect(splitEncoded(text, text.length)).toEqual([text]);
    expect(splitEncoded(text)).toEqual([text]);
    expect(PACK_MAX_BYTES % 4).toBe(0);
    expect(() => splitEncoded(text, 3)).toThrow(/no base64 quantum/);
  });

  it("names the parts after the file, numbered from 0, and lists them in order with their sizes", () => {
    expect(partName("tiles/sf/world.colliders.bin.gz.b64.txt", 0)).toBe("tiles/sf/world.colliders.bin.gz.b64.part0.txt");
    expect(partName("tiles/sf/world.colliders.bin.gz.b64.txt", 12)).toBe("tiles/sf/world.colliders.bin.gz.b64.part12.txt");
    expect(() => partName("a.bin", 0)).toThrow(/\.txt/);
    const whole = layoutEncoded("w/a.bin.gz.b64.txt", text, text.length);
    expect(whole).toEqual({ files: [{ path: "w/a.bin.gz.b64.txt", text }], parts: null });
    const split = layoutEncoded("w/a.bin.gz.b64.txt", text, 12_000);
    expect(split.files.map((f) => f.path)).toEqual(split.files.map((_, n) => `w/a.bin.gz.b64.part${n}.txt`));
    expect(split.parts).toEqual(split.files.map((f) => ({ src: f.path, bytes: f.text.length })));
    expect(split.files.map((f) => f.text).join("")).toBe(text);
  });
});

describe("binary packing (the default build)", () => {
  it("gzips a pack's files with exact offsets, names it bin/<name>.<hash>.gz by its stored bytes, and splits a pack that would be too big", () => {
    const items = [0, 1, 2, 3, 4].map((i) => ({ path: `tiles/w/t${i}.glb`, bytes: bytesOf(20_000 + i * 1000, i) }));
    const [one, ...rest] = packBinary([{ key: "a", items }], (n) => `tiles/w/packs/tiles-${n}.pack`);
    expect(rest).toHaveLength(0);
    expect(one!.src).toMatch(new RegExp(`^${BINARY_DIR}/tiles/w/packs/tiles-0\\.pack\\.[0-9a-f]{12}\\.gz$`));
    expect(one!.src).toBe(binaryName("tiles/w/packs/tiles-0.pack", one!.stored));
    const all = new Uint8Array(gunzipSync(one!.stored));
    for (const it of items) {
      const e = one!.entries[it.path]!;
      expect(e.src).toBe(one!.src);
      expect(all.slice(e.offset, e.offset + e.length)).toEqual(it.bytes);
    }
    // The name follows the bytes: the same files give the same name, other files another.
    expect(packBinary([{ key: "a", items }], (n) => `tiles/w/packs/tiles-${n}.pack`)[0]!.src).toBe(one!.src);
    expect(packBinary([{ key: "a", items: items.slice(1) }], (n) => `tiles/w/packs/tiles-${n}.pack`)[0]!.src).not.toBe(one!.src);
    const noise = [0, 1, 2, 3, 4].map((i) => ({ path: `n${i}`, bytes: noisy(20_000, i + 1) }));
    const split = packBinary([{ key: "b", items: noise }], (n) => `q${n}`, 9, 45_000);
    expect(split.length).toBeGreaterThan(1);
    for (const p of split) expect(p.stored.byteLength).toBeLessThanOrEqual(45_000);
    expect(new Set(split.flatMap((p) => Object.keys(p.entries)))).toEqual(new Set(noise.map((n) => n.path)));
  });

  it("cuts stored bytes over the limit into as few even parts as fit, named <src>.part<N>, joining back exactly", () => {
    const stored = compress(noisy(30_000, 5));
    const parts = splitBytes(stored, 12_000);
    expect(parts.length).toBe(Math.ceil(stored.byteLength / 12_000));
    expect(Buffer.concat(parts).equals(Buffer.from(stored))).toBe(true);
    for (const p of parts) expect(p.byteLength).toBeLessThanOrEqual(12_000);
    expect(splitBytes(stored, stored.byteLength)).toEqual([stored]);
    expect(binaryPartName("bin/a.bin.0123456789ab.gz", 2)).toBe("bin/a.bin.0123456789ab.gz.part2");
    const layout = layoutBinary("bin/a.bin.0123456789ab.gz", stored, 12_000);
    expect(layout.files.map((f) => f.path)).toEqual(parts.map((_, n) => `bin/a.bin.0123456789ab.gz.part${n}`));
    expect(layout.parts).toEqual(layout.files.map((f) => ({ src: f.path, bytes: f.bytes.byteLength })));
    expect(layoutBinary("bin/x.gz", stored)).toEqual({ files: [{ path: "bin/x.gz", bytes: stored }], parts: null });
  });

  it("shuffles bytes into planes and back, any length, the tail kept", () => {
    for (const n of [0, 1, 3, 4, 5, 4097]) {
      const b = bytesOf(n, n);
      const s = shuffleBytes(b, 4);
      expect(s.byteLength).toBe(n);
      expect(unshuffleBytes(s, 4)).toEqual(b);
    }
    expect(shuffleBytes(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]), 4)).toEqual(Uint8Array.from([1, 5, 2, 6, 3, 7, 4, 8, 9]));
  });
});

describe("assets over HTTP, from a sub-path", () => {
  let dir: string;
  let base: string;
  let site: Awaited<ReturnType<typeof serve>>;
  const glbA = bytesOf(5000, 1);
  const glbB = bytesOf(7000, 2);
  const model = bytesOf(3000, 9);
  // Over a 12 kB part limit once encoded: written as 4 parts.
  const big = noisy(30_000, 7);
  const PART_LIMIT = 12_000;
  let bigParts: NonNullable<WebIndex["parts"]>[string];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "fogcity-assets-"));
    const root = join(dir, "sub", "path");
    const put = (rel: string, data: string | Uint8Array): void => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), data);
    };
    const [pack] = packItems([{ key: "0,0", items: [{ path: "tiles/w/a.glb", bytes: glbA }, { path: "tiles/w/b.glb", bytes: glbB }] }], () => `tiles/w/packs/tiles-000.pack${ENCODED_SUFFIX}`);
    put(pack!.src, pack!.text);
    put(`models/m.glb${ENCODED_SUFFIX}`, encode(model));
    put("tiles/w/manifest.json", JSON.stringify({ hello: "world" }));
    const modelEntry = { src: `models/m.glb${ENCODED_SUFFIX}`, offset: 0, length: model.byteLength };
    // The big file, in parts, as the build writes it.
    const bigSrc = `tiles/w/world.colliders.bin${ENCODED_SUFFIX}`;
    const bigLayout = layoutEncoded(bigSrc, encode(big), PART_LIMIT);
    for (const f of bigLayout.files) put(f.path, f.text);
    bigParts = bigLayout.parts!;
    // The same parts again under other names, each with one thing wrong: a part missing, a part
    // cut short on the host, two parts listed out of order, a length the decoded bytes miss.
    const broken = (name: string, parts: typeof bigParts, length = big.byteLength) => ({
      entry: { [`bad/${name}.bin`]: { src: `bad/${name}.bin${ENCODED_SUFFIX}`, offset: 0, length } },
      parts: { [`bad/${name}.bin${ENCODED_SUFFIX}`]: parts },
    });
    const missingLayout = layoutEncoded(`bad/missing.bin${ENCODED_SUFFIX}`, encode(big), PART_LIMIT);
    for (const f of missingLayout.files) if (!f.path.endsWith(".part1.txt")) put(f.path, f.text);
    const shortLayout = layoutEncoded(`bad/short.bin${ENCODED_SUFFIX}`, encode(big), PART_LIMIT);
    for (const f of shortLayout.files) put(f.path, f.path.endsWith(".part2.txt") ? f.text.slice(0, -8) : f.text);
    const bad = [
      broken("missing", missingLayout.parts!),
      broken("short", shortLayout.parts!),
      broken("swapped", [bigParts[1]!, bigParts[0]!, ...bigParts.slice(2)]),
      broken("long", bigParts, big.byteLength + 1),
      broken("cut", bigParts, big.byteLength - 1),
    ];
    const index: WebIndex = {
      version: 2,
      defaultWorld: "w",
      worlds: ["w"],
      files: { ...pack!.entries, "models/m.glb": modelEntry, "tiles/w/world.colliders.bin": { src: bigSrc, offset: 0, length: big.byteLength }, ...Object.assign({}, ...bad.map((b) => b.entry)) },
      parts: { [bigSrc]: bigParts, ...Object.assign({}, ...bad.map((b) => b.parts)) },
    };
    put("assets.index.json", JSON.stringify(index));
    // Today's shape (version 1, no parts), and a version this loader does not know.
    put("legacy/assets.index.json", JSON.stringify({ version: 1, defaultWorld: "w", worlds: ["w"], files: { "models/m.glb": modelEntry } }));
    put(`legacy/models/m.glb${ENCODED_SUFFIX}`, encode(model));
    put("future/assets.index.json", JSON.stringify({ version: 4, defaultWorld: "w", worlds: ["w"], files: {} }));
    // Loose files, as the dev server serves them.
    put("loose/tiles/w/a.glb", glbA);
    site = await serve(dir, { partDelayMs: 40 });
    base = `${site.origin}/sub/path/`;
  });
  afterAll(async () => {
    await site.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("packed: slices each file out of its pack, fetching the pack once", async () => {
    const a: Assets = await openAssets(true, base);
    expect(a.mode).toBe("packed");
    expect(a.defaultWorld).toBe("w");
    expect(a.has("tiles/w/a.glb")).toBe(true);
    expect(a.has("tiles/w/a.collider.json")).toBe(false);
    site.hits.length = 0;
    const [ra, rb] = await Promise.all([a.bytes("tiles/w/a.glb"), a.bytes("tiles/w/b.glb")]);
    expect(ra).toEqual(glbA);
    expect(rb).toEqual(glbB);
    expect(await a.bytes("tiles/w/a.glb")).toEqual(glbA);
    expect(site.hits.filter((h) => h.includes("tiles-000"))).toHaveLength(1);
    expect(await a.bytes("models/m.glb")).toEqual(model);
    expect(await a.json("tiles/w/manifest.json")).toEqual({ hello: "world" });
    for (const h of site.hits) expect(h.startsWith("/sub/path/"), h).toBe(true);
    await expect(a.bytes("tiles/w/missing.glb")).rejects.toThrow(/not in this build/);
  });

  it("parts: fetched concurrently, each once, joined in index order back to the exact bytes", async () => {
    expect(bigParts.length).toBeGreaterThanOrEqual(3);
    const a = await openAssets(true, base);
    site.hits.length = 0;
    const [x, y] = await Promise.all([a.bytes("tiles/w/world.colliders.bin"), a.bytes("tiles/w/world.colliders.bin")]);
    expect(x).toEqual(big);
    expect(y).toEqual(big);
    expect(await a.bytes("tiles/w/world.colliders.bin")).toEqual(big);
    expect(site.hits.filter((h) => h.includes("world.colliders")).sort()).toEqual(bigParts.map((p) => `/sub/path/${p.src}`).sort());
    expect(site.hits.some((h) => h.endsWith(`world.colliders.bin${ENCODED_SUFFIX}`)), "the whole-text name is not a file").toBe(false);
    expect(site.maxPartsInFlight(), "parts in flight at once").toBeGreaterThanOrEqual(bigParts.length);
  });

  it("parts: a missing, short or reordered part, or a length the bytes miss, fails loudly naming the file and the part", async () => {
    const a = await openAssets(true, base);
    const last = bigParts.length - 1;
    await expect(a.bytes("bad/missing.bin")).rejects.toThrow(`bad/missing.bin: part 1 of parts 0..${last} (bad/missing.bin.gz.b64.part1.txt): HTTP 404`);
    const short = bigParts[2]!.bytes;
    await expect(a.bytes("bad/short.bin")).rejects.toThrow(`bad/short.bin: part 2 of parts 0..${last} (bad/short.bin.gz.b64.part2.txt) is ${short - 8} bytes, the index says ${short}`);
    // One number per part: the one in the message is the one in the file's name.
    for (const name of ["missing", "short"]) {
      const m = /part (\d+) of parts 0\.\.\d+ \([^)]*\.part(\d+)\.txt\)/.exec(await a.bytes(`bad/${name}.bin`).then(() => "", (e: Error) => e.message));
      expect(m, name).not.toBeNull();
      expect(m![1], name).toBe(m![2]);
    }
    // Order matters: the same parts out of order are refused, never decoded into other bytes.
    await expect(a.bytes("bad/swapped.bin")).rejects.toThrow(/^bad\/swapped\.bin: bad\/swapped\.bin\.gz\.b64\.txt does not decode/);
    await expect(a.bytes("bad/long.bin")).rejects.toThrow(`bad/long.bin: bad/long.bin${ENCODED_SUFFIX} decodes to ${big.byteLength} bytes, the index says ${big.byteLength + 1}`);
    await expect(a.bytes("bad/cut.bin")).rejects.toThrow(`decodes to ${big.byteLength} bytes, the index says ${big.byteLength - 1}`);
    // A failure is not cached: the good file beside them still loads.
    expect(await a.bytes("tiles/w/world.colliders.bin")).toEqual(big);
  });

  it("an index without parts (version 1, as builds wrote before parts) still loads; an unknown version is refused", async () => {
    const legacy = await openAssets(true, `${base}legacy/`);
    expect(await legacy.bytes("models/m.glb")).toEqual(model);
    await expect(openAssets(true, `${base}future/`)).rejects.toThrow(/unsupported version 4/);
  });

  it("loose: every file at its own URL; a missing file fails with its name", async () => {
    const a = looseAssets(`${base}loose/`);
    expect(await a.bytes("tiles/w/a.glb")).toEqual(glbA);
    await expect(a.bytes("tiles/w/nope.glb")).rejects.toThrow(/HTTP 404/);
    await expect(a.json("tiles/w/nope.json")).rejects.toThrow(/HTTP 404/);
  });
});

describe("binary assets over HTTP, from a sub-path", () => {
  let dir: string;
  const glbA = bytesOf(5000, 1);
  const glbB = bytesOf(7000, 2);
  const small = bytesOf(3000, 9);
  // Over KEEP_SINGLE_MAX_BYTES (1 MB): handed to its callers, not kept.
  const big = bytesOf(1_200_000, 4);
  const shuffled = bytesOf(50_001, 6);
  const PART_LIMIT = 4_000;
  let index: WebIndex;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "fogcity-binary-"));
    const root = join(dir, "sub", "path");
    const put = (rel: string, data: string | Uint8Array): void => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), data);
    };
    const [pack] = packBinary([{ key: "0,0", items: [{ path: "tiles/w/a.glb", bytes: glbA }, { path: "tiles/w/b.glb", bytes: glbB }] }], () => "tiles/w/packs/tiles-000.pack");
    put(pack!.src, pack!.stored);
    const files: WebIndex["files"] = { ...pack!.entries };
    const parts: NonNullable<WebIndex["parts"]> = {};
    const single = (logical: string, bytes: Uint8Array, filtered = false): string => {
      const stored = compress(filtered ? shuffleBytes(bytes, 4) : bytes);
      const src = binaryName(logical, stored);
      const layout = layoutBinary(src, stored, logical.includes("parted") ? PART_LIMIT : PACK_MAX_BYTES);
      for (const f of layout.files) put(f.path, f.bytes);
      if (layout.parts) parts[src] = layout.parts;
      files[logical] = { src, offset: 0, length: bytes.byteLength };
      return src;
    };
    for (let i = 0; i < 20; i++) single(`models/m${i}.glb`, bytesOf(3000 + i, 20 + i));
    single("models/small.glb", small);
    single("models/big.glb", big);
    const colliders = single("tiles/w/world.colliders.bin", shuffled, true);
    single("tiles/w/parted.bin", noisy(10_000, 3));
    put("tiles/w/manifest.json", JSON.stringify({ hello: "world" }));
    index = { version: 3, encoding: "gzip", defaultWorld: "w", worlds: ["w"], files, parts, filters: { [colliders]: "shuffle4" } };
    put("assets.index.json", JSON.stringify(index));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  for (const gzipEncoding of [false, true]) {
    it(`reads every file back exactly, the .gz served ${gzipEncoding ? "with Content-Encoding: gzip (decoded on the way)" : "as it is (application/gzip)"}`, async () => {
      const site = await serve(dir, { gzipEncoding });
      try {
        const a = await openAssets(true, `${site.origin}/sub/path/`);
        expect(a.mode).toBe("packed");
        expect(await a.bytes("tiles/w/a.glb")).toEqual(glbA);
        expect(await a.bytes("tiles/w/b.glb")).toEqual(glbB);
        expect(await a.bytes("models/small.glb")).toEqual(small);
        expect(same(await a.bytes("models/big.glb"), big)).toBe(true);
        expect(same(await a.bytes("tiles/w/world.colliders.bin"), shuffled), "a shuffled src comes back unshuffled").toBe(true);
        expect(index.parts![index.files["tiles/w/parted.bin"]!.src]!.length).toBeGreaterThan(1);
        expect(await a.bytes("tiles/w/parted.bin")).toEqual(noisy(10_000, 3));
        expect(await a.json("tiles/w/manifest.json")).toEqual({ hello: "world" });
        for (const h of site.hits) expect(h.startsWith("/sub/path/"), h).toBe(true);
      } finally {
        await site.close();
      }
    });
  }

  it("keeps packs apart from single files: a pack is fetched once however many single files pass through between", async () => {
    const site = await serve(dir);
    try {
      const a = await openAssets(true, `${site.origin}/sub/path/`);
      expect(await a.bytes("tiles/w/a.glb")).toEqual(glbA);
      for (let i = 0; i < 20; i++) await a.bytes(`models/m${i}.glb`);
      expect(await a.bytes("tiles/w/b.glb")).toEqual(glbB);
      expect(site.hits.filter((h) => h.includes("tiles-000"))).toHaveLength(1);
    } finally {
      await site.close();
    }
  });

  it("a big single file: one fetch for the requests made while it loads, each caller its own buffer, nothing kept after", async () => {
    const site = await serve(dir);
    try {
      const a = await openAssets(true, `${site.origin}/sub/path/`);
      const [x, y, z] = await Promise.all([a.bytes("models/big.glb"), a.bytes("models/big.glb"), a.bytes("models/big.glb")]);
      for (const b of [x, y, z]) expect(same(b, big)).toBe(true);
      expect(new Set([x.buffer, y.buffer, z.buffer]).size, "no two callers share a buffer").toBe(3);
      expect(site.hits.filter((h) => h.includes("big.glb"))).toHaveLength(1);
      expect(same(await a.bytes("models/big.glb"), big)).toBe(true);
      expect(site.hits.filter((h) => h.includes("big.glb")), "not kept: fetched again later").toHaveLength(2);
      // A small one is kept for the next request.
      await a.bytes("models/small.glb");
      await a.bytes("models/small.glb");
      expect(site.hits.filter((h) => h.includes("small.glb"))).toHaveLength(1);
    } finally {
      await site.close();
    }
  });
});

describe("the boot's files (bootAssets)", () => {
  /** An Assets that records every request and serves JSON and bytes from memory. */
  const fake = (): { assets: Assets; asked: string[] } => {
    const asked: string[] = [];
    return {
      asked,
      assets: {
        mode: "packed",
        defaultWorld: "w",
        worlds: ["w"],
        has: () => true,
        async bytes(path) {
          asked.push(path);
          return bytesOf(10, path.length);
        },
        async json<T>(path: string) {
          asked.push(path);
          return { path } as T;
        },
      },
    };
  };

  it("holds back what it is told to until ready(), and fetches the rest at once", async () => {
    const { assets: inner, asked } = fake();
    const boot = bootAssets(inner, (p) => p.startsWith("models/crowd/"));
    let crowdDone = false;
    const crowd = boot.assets.bytes("models/crowd/a.glb").then((b) => ((crowdDone = true), b));
    await boot.assets.bytes("models/robotaxi.glb");
    await new Promise((r) => setTimeout(r, 20));
    expect(asked).toEqual(["models/robotaxi.glb"]);
    expect(crowdDone).toBe(false);
    boot.ready();
    expect(await crowd).toEqual(bytesOf(10, "models/crowd/a.glb".length));
    expect(asked).toEqual(["models/robotaxi.glb", "models/crowd/a.glb"]);
    await boot.assets.bytes("models/crowd/b.glb");
    expect(asked.at(-1), "after ready nothing waits").toBe("models/crowd/b.glb");
  });

  it("fetches a JSON file once for all its readers during the boot, each reader its own copy; after ready() the inner assets answer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fogcity-boot-"));
    writeFileSync(join(dir, "layer.json"), JSON.stringify({ trees: [[1, 2, 3]] }));
    const site = await serve(dir);
    try {
      const base = `${site.origin}/`;
      const boot = bootAssets(looseAssets(base), () => false, base);
      const [a, b] = await Promise.all([boot.assets.json<{ trees: number[][] }>("layer.json"), boot.assets.json<{ trees: number[][] }>("layer.json")]);
      const c = await boot.assets.json<{ trees: number[][] }>("layer.json");
      expect(site.hits).toEqual(["/layer.json"]);
      expect(a).toEqual({ trees: [[1, 2, 3]] });
      a.trees.push([9]);
      expect(b).toEqual({ trees: [[1, 2, 3]] });
      expect(c, "a later reader is untouched by an earlier one's change").toEqual({ trees: [[1, 2, 3]] });
      await expect(boot.assets.json("missing.json")).rejects.toThrow(/HTTP 404/);
      boot.ready();
      await boot.assets.json("layer.json");
      expect(site.hits.filter((h) => h === "/layer.json"), "the boot's texts are dropped at ready").toHaveLength(2);
    } finally {
      await site.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the web build's world JSON", () => {
  it("ships every data layer the game reads: each manifest.layers.<name> read under src/ is in RUNTIME_LAYERS", () => {
    const read = new Set<string>();
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ts")) for (const m of readFileSync(p, "utf8").matchAll(/\bmanifest\??\.layers\??\.([A-Za-z_]\w*)/g)) read.add(m[1]!);
      }
    };
    walk(join(ROOT, "src"));
    expect(read.size, "the game reads some layers").toBeGreaterThan(0);
    for (const name of read) expect(RUNTIME_LAYERS, `src/ reads manifest.layers.${name}`).toContain(name);
  });
});

describe("the web build's limits", () => {
  it("names every limit the host enforces, and flags files that break them", () => {
    expect(HOST_LIMITS.maxFiles).toBe(450);
    expect(HOST_LIMITS.maxTotalBytes).toBe(240_000_000);
    expect(HOST_LIMITS.maxFileBytes).toBe(15_000_000);
    expect(HOST_LIMITS.extensions).not.toContain(".glb");
    expect(HOST_LIMITS.extensions).not.toContain(".bin");
    const dir = mkdtempSync(join(tmpdir(), "fogcity-limits-"));
    try {
      writeFileSync(join(dir, "ok.txt"), "x");
      writeFileSync(join(dir, "tile.glb"), "x");
      writeFileSync(join(dir, "world.colliders.bin"), "x");
      const r = checkHostLimits(dir);
      expect(r.files).toBe(3);
      expect(r.problems).toHaveLength(2);
      expect(r.problems.join("\n")).toMatch(/tile\.glb.*not served/);
      // A binary build's host serves any type; its per-file size is the same.
      expect(BINARY_LIMITS.extensions).toBeNull();
      expect(BINARY_LIMITS.maxFileBytes).toBe(HOST_LIMITS.maxFileBytes);
      expect(checkHostLimits(dir, BINARY_LIMITS).problems).toEqual([]);
      writeFileSync(join(dir, "huge.gz"), new Uint8Array(BINARY_LIMITS.maxFileBytes + 1));
      expect(checkHostLimits(dir, BINARY_LIMITS).problems.join("\n")).toMatch(/huge\.gz: \d+ bytes, over/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the web build's out directory", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "fogcity-out-"));
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const put = (rel: string, data = "x"): void => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), data);
  };
  const pub = join(ROOT, "public");

  it("clears only a directory a build could have written; anything else is refused unless forced", () => {
    expect(outDirRefusal(join(dir, "new"), pub)).toBeNull();
    mkdirSync(join(dir, "empty"));
    expect(outDirRefusal(join(dir, "empty"), pub)).toBeNull();
    // An earlier build, or one that stopped half-way (no index yet): cleared.
    for (const f of ["index.html", "assets/index-abc.js", "assets/index-abc.js.map", "assets.index.json", "tiles/sf/manifest.json", "tiles/sf/packs/tiles-000.pack.gz.b64.txt", "tiles/sf/world.colliders.bin.gz.b64.part1.txt", "models/robotaxi.glb.gz.b64.txt"]) put(`build/${f}`);
    expect(outDirRefusal(join(dir, "build"), pub)).toBeNull();
    // A binary build: bin/ of .gz files and their parts.
    for (const f of ["index.html", "assets.index.json", "tiles/sf/manifest.json", "bin/tiles/sf/packs/tiles-000.pack.0123456789ab.gz", "bin/tiles/sf/world.colliders.bin.0123456789ab.gz.part1", "bin/models/robotaxi.glb.0123456789ab.gz"]) put(`binary/${f}`);
    expect(outDirRefusal(join(dir, "binary"), pub)).toBeNull();
    put("binary-stray/bin/notes.txt", "keep");
    expect(outDirRefusal(join(dir, "binary-stray"), pub)).toMatch(/\(bin\/notes\.txt\)/);
    put("half/index.html");
    put("half/tiles/sf/world.colliders.bin.gz.b64.part0.txt");
    expect(outDirRefusal(join(dir, "half"), pub)).toBeNull();
    // Anything a build does not write: refused, naming it; forced, cleared.
    put("precious/notes.txt", "keep");
    expect(outDirRefusal(join(dir, "precious"), pub)).toMatch(/holds files a build does not write \(notes\.txt\).*--force-clean/);
    expect(outDirRefusal(join(dir, "precious"), pub, true)).toBeNull();
    put("raw/tiles/sf/t0_0.glb");
    expect(outDirRefusal(join(dir, "raw"), pub)).toMatch(/\(tiles\/sf\/t0_0\.glb\)/);
    put("mixed/index.html");
    put("mixed/src/main.ts");
    put("mixed/assets/scene.blend");
    expect(outDirRefusal(join(dir, "mixed"), pub)).toMatch(/\(assets\/scene\.blend, src\)/);
    put("afile");
    expect(outDirRefusal(join(dir, "afile"), pub)).toMatch(/a file, not a directory/);
  });

  it("never clears the checkout, the public directory it reads, or a directory holding either, even forced", () => {
    expect(outDirRefusal(ROOT, pub, true)).toMatch(/is the checkout or holds it/);
    expect(outDirRefusal(dirname(ROOT), pub, true)).toMatch(/is the checkout or holds it/);
    expect(outDirRefusal(pub, pub, true)).toMatch(/overlaps the public directory/);
    expect(outDirRefusal(join(pub, "tiles", "sf"), pub, true)).toMatch(/overlaps the public directory/);
    put("elsewhere/public/tiles/sf/manifest.json");
    expect(outDirRefusal(join(dir, "elsewhere"), join(dir, "elsewhere", "public"), true)).toMatch(/overlaps the public directory/);
    // The default and the test builds: inside the checkout, outside public/.
    expect(outDirRefusal(join(ROOT, "dist"), pub)).toBeNull();
  });

  it("a refused or failing build deletes nothing: not a stray file, not the last good build", async () => {
    put("keep/notes.txt", "keep");
    const opts = { worlds: ["sf"], level: 1, skipVite: true };
    await expect(buildWeb({ out: join(dir, "keep"), publicDir: join(dir, "no-such-public"), ...opts })).rejects.toThrow(/holds files a build does not write \(notes\.txt\)/);
    expect(readFileSync(join(dir, "keep", "notes.txt"), "utf8")).toBe("keep");
    // A good earlier build and a public/ without the world: stops before the delete.
    put("last/assets.index.json", "{}");
    await expect(buildWeb({ out: join(dir, "last"), publicDir: join(dir, "no-such-public"), ...opts })).rejects.toThrow(/manifest\.json is missing \(nothing was deleted\)/);
    expect(readFileSync(join(dir, "last", "assets.index.json"), "utf8")).toBe("{}");
  });
});

describe("world files through the asset layer", () => {
  it("loads the dev world from its collider JSON over loose files (no pack in its manifest)", async () => {
    const server = createServer((req, res) => {
      try {
        res.end(readFileSync(join(ROOT, "public", decodeURIComponent((req.url ?? "/").split("?")[0]!))));
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const addr = server.address();
      const files = await loadWorldFiles(looseAssets(`http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/`), "dev");
      expect(files.colliders).toBe("json");
      expect(files.tiles.length).toBeGreaterThan(0);
      expect(files.roads).not.toBeNull();
      expect(files.boundary).toBeNull();
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

describe("the --text web build of the real SF world, its collider pack in parts", () => {
  // Low enough to cut the committed collider pack (12.7 MB raw, 12.3 MB encoded) into 3 or more
  // parts; the hosted build uses PACK_MAX_BYTES, which splits it once the pack passes 14 MB
  // encoded (the QA world's does: tests/e2e/web-build.spec.ts, docs/testing.md).
  const PART_LIMIT = 5_000_000;
  let dir = "";
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
  /** Every file under `root` -> its sha256. */
  const digest = (root: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out[relative(root, p)] = sha(readFileSync(p));
      }
    };
    walk(root);
    return out;
  };

  it.skipIf(!worldExists("sf"))(
    "writes the parts at their listed sizes under the limit, fits the host, rebuilds byte for byte, and the world loads back from them",
    async () => {
      dir = mkdtempSync(join(tmpdir(), "fogcity-build-"));
      const opts = { worlds: ["sf"], level: 1, skipVite: true, partMaxBytes: PART_LIMIT, encoding: "gzip-base64" as const };
      const report = await buildWeb({ out: join(dir, "a"), ...opts });
      const index = JSON.parse(readFileSync(join(dir, "a", "assets.index.json"), "utf8")) as WebIndex;
      expect(index.version).toBe(2);
      const colliderSrc = index.files["tiles/sf/world.colliders.bin"]!.src;
      expect(colliderSrc).toBe(`tiles/sf/world.colliders.bin${ENCODED_SUFFIX}`);
      const colliderParts = index.parts?.[colliderSrc] ?? [];
      expect(colliderParts.length).toBeGreaterThanOrEqual(3);
      // Every src in parts: the parts on disk at the sizes listed, named in order, each under the
      // limit; the whole-text name is not a file; the report lists the same.
      expect(report.split).toEqual(Object.entries(index.parts!).map(([src, parts]) => ({ src, parts: parts.map((p) => p.bytes) })));
      for (const [src, parts] of Object.entries(index.parts!)) {
        expect(() => statSync(join(dir, "a", src)), `${src} is not written whole`).toThrow();
        for (const [n, p] of parts.entries()) {
          expect(p.src).toBe(partName(src, n));
          expect(statSync(join(dir, "a", p.src)).size).toBe(p.bytes);
          expect(p.bytes).toBeLessThanOrEqual(PART_LIMIT);
        }
      }
      const check = checkHostLimits(join(dir, "a"));
      expect(check.problems).toEqual([]);
      expect(check.files).toBe(report.files);
      // Deterministic: a second build is byte-identical, parts and index included.
      await buildWeb({ out: join(dir, "b"), ...opts });
      const a = digest(join(dir, "a"));
      expect(Object.keys(a).filter((f) => f.includes(".part")).length).toBe(report.split.reduce((s, x) => s + x.parts.length, 0));
      expect(digest(join(dir, "b"))).toEqual(a);
      rmSync(join(dir, "b"), { recursive: true, force: true });

      // The world back from the build, over HTTP: the collider pack byte for byte from its parts.
      const site = await serve(dir);
      try {
        const assets = await openAssets(true, `${site.origin}/a/`);
        const world = await loadWorldFiles(assets, "sf");
        expect(world.colliders).toBe("pack");
        expect(world.tiles.length).toBe(world.manifest.tiles.length);
        expect(world.roads).not.toBeNull();
        // One read of the pack: each part fetched once. A file this big is not kept after its read.
        const colliderHits = site.hits.filter((h) => h.includes("world.colliders"));
        expect(colliderHits.sort()).toEqual(colliderParts.map((p) => `/a/${p.src}`).sort());
        // Compared by hash: toEqual walks a 13 MB array element by element.
        const source = readFileSync(join(ROOT, "public", "tiles", "sf", "world.colliders.bin"));
        const joined = await assets.bytes("tiles/sf/world.colliders.bin");
        expect(joined.byteLength).toBe(source.byteLength);
        expect(sha(joined)).toBe(sha(source));
        const motionPath = "models/mixamo-motion.json";
        const motionSource = readFileSync(join(ROOT, "public", motionPath));
        expect(sha(await assets.bytes(motionPath))).toBe(sha(motionSource));
        expect(Object.keys(index.files).some(path => path.endsWith(".fbx"))).toBe(false);
        const glb = Object.keys(index.files).find((f) => f.startsWith("tiles/sf/") && f.endsWith(".glb"))!;
        expect(sha(await assets.bytes(glb))).toBe(sha(readFileSync(join(ROOT, "public", glb))));
        expect(sha(await assets.bytes("models/player-car.glb"))).toBe(sha(readFileSync(join(ROOT, "public", "models", "player-car.glb"))));
      } finally {
        await site.close();
      }
    },
    120_000,
  );
});

describe("the binary web build of the real SF world (the default), its collider pack in parts", () => {
  // The shuffled collider pack gzips to about 7.8 MB: a 3 MB limit cuts it into 3 parts.
  const PART_LIMIT = 3_000_000;
  let dir = "";
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
  const digest = (root: string): Record<string, string> => {
    const out: Record<string, string> = {};
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out[relative(root, p)] = sha(readFileSync(p));
      }
    };
    walk(root);
    return out;
  };

  it.skipIf(!worldExists("sf"))(
    "names every binary bin/<name>.<hash>.gz, shuffles the collider pack, writes its parts, rebuilds byte for byte, and the world loads back",
    async () => {
      dir = mkdtempSync(join(tmpdir(), "fogcity-binary-build-"));
      const opts = { worlds: ["sf"], level: 1, skipVite: true, partMaxBytes: PART_LIMIT };
      const report = await buildWeb({ out: join(dir, "a"), ...opts });
      expect(report.encoding).toBe("gzip");
      const index = JSON.parse(readFileSync(join(dir, "a", "assets.index.json"), "utf8")) as WebIndex;
      expect(index.version).toBe(3);
      expect(index.encoding).toBe("gzip");
      for (const e of Object.values(index.files)) expect(e.src).toMatch(/^bin\/.+\.[0-9a-f]{12}\.gz$/);
      const colliderSrc = index.files["tiles/sf/world.colliders.bin"]!.src;
      expect(index.filters).toEqual({ [colliderSrc]: "shuffle4" });
      const colliderParts = index.parts?.[colliderSrc] ?? [];
      expect(colliderParts.length).toBeGreaterThanOrEqual(3);
      expect(report.split).toEqual(Object.entries(index.parts!).map(([src, parts]) => ({ src, parts: parts.map((p) => p.bytes) })));
      for (const [src, parts] of Object.entries(index.parts!)) {
        expect(() => statSync(join(dir, "a", src)), `${src} is not written whole`).toThrow();
        for (const [n, p] of parts.entries()) {
          expect(p.src).toBe(binaryPartName(src, n));
          expect(statSync(join(dir, "a", p.src)).size).toBe(p.bytes);
          expect(p.bytes).toBeLessThanOrEqual(PART_LIMIT);
        }
      }
      // A whole file's name is its stored bytes' hash.
      const glbSrc = index.files["models/player-car.glb"]!.src;
      expect(glbSrc).toBe(binaryName("models/player-car.glb", new Uint8Array(readFileSync(join(dir, "a", glbSrc)))));
      // No text binaries, and nothing the text host would have to take.
      expect(Object.keys(digest(join(dir, "a"))).some((f) => f.endsWith(ENCODED_SUFFIX) || /\.part\d+\.txt$/.test(f))).toBe(false);
      const check = checkHostLimits(join(dir, "a"), BINARY_LIMITS);
      expect(check.problems).toEqual([]);
      // Deterministic: a second build is byte-identical, names, parts and index included.
      await buildWeb({ out: join(dir, "b"), ...opts });
      expect(digest(join(dir, "b"))).toEqual(digest(join(dir, "a")));
      rmSync(join(dir, "b"), { recursive: true, force: true });

      const site = await serve(dir);
      try {
        const assets = await openAssets(true, `${site.origin}/a/`);
        const world = await loadWorldFiles(assets, "sf");
        expect(world.colliders).toBe("pack");
        expect(world.tiles.length).toBe(world.manifest.tiles.length);
        expect(world.roads).not.toBeNull();
        expect(site.hits.filter((h) => h.includes("world.colliders")).sort()).toEqual(colliderParts.map((p) => `/a/${p.src}`).sort());
        const source = readFileSync(join(ROOT, "public", "tiles", "sf", "world.colliders.bin"));
        const joined = await assets.bytes("tiles/sf/world.colliders.bin");
        expect(joined.byteLength).toBe(source.byteLength);
        expect(sha(joined)).toBe(sha(source));
        const glb = Object.keys(index.files).find((f) => f.startsWith("tiles/sf/") && f.endsWith(".glb"))!;
        expect(sha(await assets.bytes(glb))).toBe(sha(readFileSync(join(ROOT, "public", glb))));
        expect(sha(await assets.bytes("models/player-car.glb"))).toBe(sha(readFileSync(join(ROOT, "public", "models", "player-car.glb"))));
        expect(sha(await assets.bytes("models/mixamo-motion.json"))).toBe(sha(readFileSync(join(ROOT, "public", "models", "mixamo-motion.json"))));
      } finally {
        await site.close();
      }
    },
    180_000,
  );
});
