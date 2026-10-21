// The asset layer (src/io/assets.ts) and the web build's packer (scripts/build-web.ts): files
// packed, gzip-compressed and base64-encoded into .txt packs come back byte for byte through
// the index (file -> pack, offset, length), a pack is fetched once however many files it holds,
// and both layouts load a world's sim files the same way (src/io/world-load.ts). Served from a
// loopback server under a sub-path, as the page host does.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENCODED_SUFFIX, HOST_LIMITS, checkHostLimits, encode, packItems, type WebIndex } from "../../scripts/build-web.ts";
import { base64ToBytes, decodeGzBase64, looseAssets, packedAssets, type Assets } from "../../src/io/assets.ts";
import { loadWorldFiles } from "../../src/io/world-load.ts";
import { ROOT } from "../helpers.ts";

const bytesOf = (n: number, seed: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed * 7 + ((i >> 5) & 255)) & 255);

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
    const noisy = (seed: number): Uint8Array => {
      let x = seed * 2654435761 + 1;
      return Uint8Array.from({ length: 20_000 }, () => {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        return x & 255;
      });
    };
    const noise = [0, 1, 2, 3, 4].map((i) => ({ path: `n${i}`, bytes: noisy(i + 1) }));
    const split = packItems([{ key: "b", items: noise }], (n) => `q${n}`, 9, 60_000);
    expect(split.length).toBeGreaterThan(1);
    for (const p of split) expect(p.text.length).toBeLessThanOrEqual(60_000);
    expect(new Set(split.flatMap((p) => Object.keys(p.entries)))).toEqual(new Set(noise.map((n) => n.path)));
    expect(() => packItems([{ key: "c", items: [noise[0]!] }], () => "x", 9, 1000)).toThrow(/alone encodes/);
  });
});

describe("assets over HTTP, from a sub-path", () => {
  let server: Server;
  let dir: string;
  let base: string;
  const hits: string[] = [];
  const glbA = bytesOf(5000, 1);
  const glbB = bytesOf(7000, 2);
  const model = bytesOf(3000, 9);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "fogcity-assets-"));
    const site = join(dir, "sub", "path");
    const put = (rel: string, data: string | Uint8Array): void => {
      mkdirSync(dirname(join(site, rel)), { recursive: true });
      writeFileSync(join(site, rel), data);
    };
    const [pack] = packItems([{ key: "0,0", items: [{ path: "tiles/w/a.glb", bytes: glbA }, { path: "tiles/w/b.glb", bytes: glbB }] }], () => `tiles/w/packs/tiles-000.pack${ENCODED_SUFFIX}`);
    put(pack!.src, pack!.text);
    put(`models/m.glb${ENCODED_SUFFIX}`, encode(model));
    put("tiles/w/manifest.json", JSON.stringify({ hello: "world" }));
    const index: WebIndex = { version: 1, defaultWorld: "w", worlds: ["w"], files: { ...pack!.entries, "models/m.glb": { src: `models/m.glb${ENCODED_SUFFIX}`, offset: 0, length: model.byteLength } } };
    put("assets.index.json", JSON.stringify(index));
    // Loose files, as the dev server serves them.
    put("loose/tiles/w/a.glb", glbA);
    server = createServer((req, res) => {
      const url = decodeURIComponent((req.url ?? "/").split("?")[0]!);
      hits.push(url);
      try {
        const body = readFileSync(join(dir, url));
        res.writeHead(200, { "content-type": url.endsWith(".json") ? "application/json" : url.endsWith(".txt") ? "text/plain" : "application/octet-stream" });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/sub/path/`;
  });
  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("packed: slices each file out of its pack, fetching the pack once", async () => {
    const index = (await (await fetch(`${base}assets.index.json`)).json()) as WebIndex;
    const a: Assets = packedAssets(index, base);
    expect(a.mode).toBe("packed");
    expect(a.defaultWorld).toBe("w");
    expect(a.has("tiles/w/a.glb")).toBe(true);
    expect(a.has("tiles/w/a.collider.json")).toBe(false);
    hits.length = 0;
    const [ra, rb] = await Promise.all([a.bytes("tiles/w/a.glb"), a.bytes("tiles/w/b.glb")]);
    expect(ra).toEqual(glbA);
    expect(rb).toEqual(glbB);
    expect(await a.bytes("tiles/w/a.glb")).toEqual(glbA);
    expect(hits.filter((h) => h.includes("tiles-000"))).toHaveLength(1);
    expect(await a.bytes("models/m.glb")).toEqual(model);
    expect(await a.json("tiles/w/manifest.json")).toEqual({ hello: "world" });
    for (const h of hits) expect(h.startsWith("/sub/path/"), h).toBe(true);
    await expect(a.bytes("tiles/w/missing.glb")).rejects.toThrow(/not in this build/);
  });

  it("loose: every file at its own URL; a missing file fails with its name", async () => {
    const a = looseAssets(`${base}loose/`);
    expect(await a.bytes("tiles/w/a.glb")).toEqual(glbA);
    await expect(a.bytes("tiles/w/nope.glb")).rejects.toThrow(/HTTP 404/);
    await expect(a.json("tiles/w/nope.json")).rejects.toThrow(/HTTP 404/);
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
