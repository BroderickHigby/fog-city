// The asset layer (src/io/assets.ts) and the web build's packer (scripts/build-web.ts): files
// packed, gzip-compressed and base64-encoded into .txt packs come back byte for byte through
// the index (file -> pack, offset, length), a pack is fetched once however many files it holds,
// an encoded file over the per-file limit is written as parts that join back in index order
// (a missing, short or reordered part fails loudly, never a truncated decode), and both layouts
// load a world's sim files the same way (src/io/world-load.ts). Served from a loopback server
// under a sub-path, as the page host does. The last block builds the real SF world with a part
// limit low enough to split its collider pack, twice, and loads the world from the result.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ENCODED_SUFFIX,
  HOST_LIMITS,
  PACK_MAX_BYTES,
  buildWeb,
  checkHostLimits,
  encode,
  layoutEncoded,
  outDirRefusal,
  packItems,
  partName,
  splitEncoded,
  type WebIndex,
} from "../../scripts/build-web.ts";
import { base64ToBytes, decodeGzBase64, looseAssets, openAssets, packedAssets, type Assets } from "../../src/io/assets.ts";
import { RUNTIME_LAYERS, loadWorldFiles } from "../../src/io/world-load.ts";
import { ROOT, worldExists } from "../helpers.ts";

const bytesOf = (n: number, seed: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed * 7 + ((i >> 5) & 255)) & 255);
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

/** A loopback server for `dir`, recording each request's path and the most part files in flight at once. */
async function serve(dir: string, opts: { partDelayMs?: number } = {}): Promise<{ origin: string; hits: string[]; maxPartsInFlight: () => number; close: () => Promise<void> }> {
  const hits: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const server = createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? "/").split("?")[0]!);
    hits.push(url);
    const part = /\.part\d+\.txt$/.test(url);
    if (part) maxInFlight = Math.max(maxInFlight, ++inFlight);
    const answer = (): void => {
      if (part) inFlight--;
      try {
        const body = readFileSync(join(dir, url));
        res.writeHead(200, { "content-type": url.endsWith(".json") ? "application/json" : url.endsWith(".txt") ? "text/plain" : "application/octet-stream" });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end();
      }
    };
    if (part && opts.partDelayMs) setTimeout(answer, opts.partDelayMs);
    else answer();
  });
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
    put("future/assets.index.json", JSON.stringify({ version: 3, defaultWorld: "w", worlds: ["w"], files: {} }));
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
    await expect(openAssets(true, `${base}future/`)).rejects.toThrow(/unsupported version 3/);
  });

  it("loose: every file at its own URL; a missing file fails with its name", async () => {
    const a = looseAssets(`${base}loose/`);
    expect(await a.bytes("tiles/w/a.glb")).toEqual(glbA);
    await expect(a.bytes("tiles/w/nope.glb")).rejects.toThrow(/HTTP 404/);
    await expect(a.json("tiles/w/nope.json")).rejects.toThrow(/HTTP 404/);
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

describe("the web build of the real SF world, its collider pack in parts", () => {
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
      const opts = { worlds: ["sf"], level: 1, skipVite: true, partMaxBytes: PART_LIMIT };
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
        // Compared by hash: toEqual walks a 13 MB array element by element.
        const source = readFileSync(join(ROOT, "public", "tiles", "sf", "world.colliders.bin"));
        const joined = await assets.bytes("tiles/sf/world.colliders.bin");
        expect(joined.byteLength).toBe(source.byteLength);
        expect(sha(joined)).toBe(sha(source));
        const world = await loadWorldFiles(assets, "sf");
        expect(world.colliders).toBe("pack");
        expect(world.tiles.length).toBe(world.manifest.tiles.length);
        expect(world.roads).not.toBeNull();
        const glb = Object.keys(index.files).find((f) => f.startsWith("tiles/sf/") && f.endsWith(".glb"))!;
        expect(sha(await assets.bytes(glb))).toBe(sha(readFileSync(join(ROOT, "public", glb))));
        expect(sha(await assets.bytes("models/player-car.glb"))).toBe(sha(readFileSync(join(ROOT, "public", "models", "player-car.glb"))));
        // The integrated house kit and optional PBR detail use the same asset provider as
        // streamed tiles. A dev-server-only image or metadata file would otherwise silently
        // disappear after publishing. Keep the generic avatar and retired likeness separate.
        expect(assets.has("models/generic-player.glb")).toBe(true);
        expect(assets.has("models/player.glb")).toBe(false);
        for (const path of ["models/house-kit/house-kit.json", "models/textures/textures.json", "tiles/sf/storefronts.json"]) {
          expect(await assets.json(path), path).toEqual(JSON.parse(readFileSync(join(ROOT, "public", path), "utf8")));
        }
        for (const path of ["models/house-kit/bay-edwardian.glb", "models/textures/pavers_albedo.webp", "models/textures/paint_orm.webp"]) {
          expect(sha(await assets.bytes(path)), path).toBe(sha(readFileSync(join(ROOT, "public", path))));
        }
        const colliderHits = site.hits.filter((h) => h.includes("world.colliders"));
        expect(colliderHits.sort()).toEqual(colliderParts.map((p) => `/a/${p.src}`).sort());
      } finally {
        await site.close();
      }
    },
    120_000,
  );
});
