// Unit tests (Vitest) for the harness's own helpers: the PNG decoder behind blank-frame
// checks, the geometry used by the SF road check, and the determinism scenario's coverage.
// Playwright ignores this file (it only runs *.spec.ts).

import { crc32, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { loadWorldFiles } from "../helpers.ts";
import { dmathDigest, makeWorld, runScenario } from "./determinism-scenario.ts";
import { distanceToPolyline, headingDelta } from "./fixtures.ts";
import { decodePng, imageStats, looksDrawn } from "./png.ts";

function chunk(type: string, body: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const tb = Buffer.concat([Buffer.from(type, "latin1"), Buffer.from(body)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(tb) >>> 0);
  return Buffer.concat([len, tb, crc]);
}

/** Encode with the given filter on each row (cycling), so the decoder sees every filter type. */
function encodePng(width: number, height: number, channels: number, data: Uint8Array, filters: number[]): Buffer {
  const colorType = { 1: 0, 2: 4, 3: 2, 4: 6 }[channels]!;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const f = filters[y % filters.length]!;
    raw[y * (stride + 1)] = f;
    for (let i = 0; i < stride; i++) {
      const x = data[y * stride + i]!;
      const a = i >= channels ? data[y * stride + i - channels]! : 0;
      const b = y > 0 ? data[(y - 1) * stride + i]! : 0;
      const c = i >= channels && y > 0 ? data[(y - 1) * stride + i - channels]! : 0;
      const p = a + b - c;
      const pred =
        f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1
        : Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      raw[y * (stride + 1) + 1 + i] = (x - pred) & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

function noise(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

describe("png decoder", () => {
  for (const channels of [1, 2, 3, 4]) {
    it(`round-trips ${channels}-channel images through all five filter types`, () => {
      const [w, h] = [37, 23];
      const data = noise(w * h * channels, channels * 7919);
      const img = decodePng(encodePng(w, h, channels, data, [0, 1, 2, 3, 4]));
      expect([img.width, img.height, img.channels]).toEqual([w, h, channels]);
      expect(Buffer.from(img.data).equals(Buffer.from(data))).toBe(true);
    });
  }

  it("rejects what it cannot decode", () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toThrow(/not a PNG/);
    const png = encodePng(2, 2, 3, new Uint8Array(12), [0]);
    png[8 + 8 + 8] = 16; // IHDR bit depth
    expect(() => decodePng(png)).toThrow(/unsupported/);
  });

  it("tells a flat frame from a drawn one", () => {
    const flat = decodePng(encodePng(64, 64, 4, new Uint8Array(64 * 64 * 4).fill(200), [0]));
    expect(looksDrawn(imageStats(flat))).toBe(false);
    const drawn = decodePng(encodePng(64, 64, 3, noise(64 * 64 * 3, 1), [4]));
    expect(looksDrawn(imageStats(drawn))).toBe(true);
    expect(imageStats(flat).std).toBeLessThan(1e-6);
  });
});

describe("geometry helpers", () => {
  it("distanceToPolyline measures to the nearest segment, including its ends", () => {
    const line: Array<[number, number]> = [[0, 0], [10, 0], [10, 10]];
    expect(distanceToPolyline(5, 3, line)).toBeCloseTo(3, 12);
    expect(distanceToPolyline(13, 5, line)).toBeCloseTo(3, 12);
    expect(distanceToPolyline(-4, -3, line)).toBeCloseTo(5, 12);
  });

  it("headingDelta is the short way round", () => {
    expect(headingDelta(0.1, 6.2)).toBeCloseTo(6.2 - 0.1 - 2 * Math.PI, 12);
    expect(headingDelta(6.2, 0.1)).toBeCloseTo(0.1 + 2 * Math.PI - 6.2, 12);
    expect(headingDelta(1, 1.5)).toBeCloseTo(0.5, 12);
  });
});

describe("determinism scenario", () => {
  const dev = loadWorldFiles("dev");
  const opts = { ticks: 3600, checkpointEvery: 15, seed: 20261020, spawn: dev.manifest.spawn };

  it("is a strong test: several players, joins and leaves, steering and collisions", () => {
    const r = runScenario(makeWorld(dev.tiles, dev.roads), opts);
    expect(r.checkpoints).toHaveLength(opts.ticks / opts.checkpointEvery);
    expect(r.stats.playersSeen).toEqual(["p1", "p2", "p3", "p4", "p5"]);
    expect(r.stats.hits).toBeGreaterThan(0);
    expect(r.stats.turned).toBeGreaterThan(5);
    expect(r.stats.maxSpeed).toBeGreaterThan(15);
  });

  it("repeats exactly in one engine (the cross-engine test compares against this)", () => {
    const a = runScenario(makeWorld(dev.tiles, dev.roads), { ...opts, ticks: 900 });
    const b = runScenario(makeWorld(dev.tiles, dev.roads), { ...opts, ticks: 900 });
    expect(b.checkpoints).toEqual(a.checkpoints);
    expect(b.finalJson).toBe(a.finalJson);
  });

  it("dmath digest is stable within an engine and covers every function", () => {
    const d = dmathDigest(2000);
    expect(Object.keys(d).sort()).toEqual(["datan", "datan2", "dcos", "dsin", "dtan", "hashState", "sqrt", "wrapAngle"]);
    expect(dmathDigest(2000)).toEqual(d);
  });
});
