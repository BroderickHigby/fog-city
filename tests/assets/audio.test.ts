// Sound effects (public/audio, built by assets/audio/generate.py): every sound in the manifest
// exists in both formats, decodes (real Vorbis and MPEG decoders, compiled to wasm, no
// network), has the documented length and a sane level, the spray loop has no seam, and the
// Moat Labs jingle plays the four notes the manifest names.

import { OggVorbisDecoder } from "@wasm-audio-decoders/ogg-vorbis";
import { MPEGDecoder } from "mpg123-decoder";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROOT, readJson } from "../helpers.ts";

interface SoundEntry {
  files: { ogg: string; mp3: string };
  durationS: number;
  loop: boolean;
  use: string;
  notes?: string[];
}

const manifest = readJson<{ version: number; sampleRate: number; sounds: Record<string, SoundEntry> }>("public/audio/manifest.json");
const REQUIRED = ["spray", "splash", "rust-creak", "melt-fizz", "moat-jingle"];
const MAX_BYTES = 200 * 1024;

const ogg = new OggVorbisDecoder();
const mp3 = new MPEGDecoder();
beforeAll(async () => {
  await ogg.ready;
  await mp3.ready;
});
afterAll(() => {
  ogg.free();
  mp3.free();
});

interface Pcm {
  samples: Float32Array;
  sampleRate: number;
}

async function decode(rel: string): Promise<Pcm> {
  const bytes = new Uint8Array(readFileSync(join(ROOT, "public", rel)));
  if (rel.endsWith(".ogg")) {
    await ogg.reset();
    const r = await ogg.decodeFile(bytes);
    expect(r.errors, rel).toEqual([]);
    return { samples: r.channelData[0]!, sampleRate: r.sampleRate };
  }
  await mp3.reset();
  const r = mp3.decode(bytes);
  expect(r.errors, rel).toEqual([]);
  return { samples: r.channelData[0]!.slice(0, r.samplesDecoded), sampleRate: r.sampleRate };
}

const peak = (x: Float32Array): number => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const rms = (x: Float32Array): number => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / Math.max(x.length, 1));

/** Energy of x at frequency f (Goertzel), normalised by length. */
function tone(x: Float32Array, sr: number, f: number): number {
  const w = (2 * Math.PI * f) / sr;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (const v of x) {
    const s = v + c * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return (s1 * s1 + s2 * s2 - c * s1 * s2) / x.length;
}

const NOTE_HZ: Record<string, number> = { A4: 440, B4: 493.88, D5: 587.33, E5: 659.26 };

describe("public/audio/manifest.json", () => {
  it("lists the wave-2 sounds, each as .ogg and .mp3", () => {
    expect(manifest.sampleRate).toBe(44_100);
    for (const name of REQUIRED) {
      const s = manifest.sounds[name];
      expect(s, name).toBeTruthy();
      expect(s!.files.ogg).toBe(`audio/${name}.ogg`);
      expect(s!.files.mp3).toBe(`audio/${name}.mp3`);
    }
    expect(manifest.sounds.spray!.loop).toBe(true);
    expect(manifest.sounds["moat-jingle"]!.notes).toHaveLength(4);
  });
});

describe.each(Object.entries(manifest.sounds))("%s", (name, s) => {
  it.each(["ogg", "mp3"] as const)("exists as .%s under 200 KB", (fmt) => {
    const size = statSync(join(ROOT, "public", s.files[fmt])).size;
    expect(size).toBeGreaterThan(1000);
    expect(size).toBeLessThan(MAX_BYTES);
  });

  it.each(["ogg", "mp3"] as const)("decodes from .%s at the documented length and a sane level", async (fmt) => {
    const { samples, sampleRate } = await decode(s.files[fmt]);
    expect(sampleRate).toBe(manifest.sampleRate);
    const dur = samples.length / sampleRate;
    if (fmt === "ogg") expect(Math.abs(dur - s.durationS), `${name} ${dur}s`).toBeLessThan(0.005); // Vorbis is gapless
    else {
      // MP3 adds encoder delay and frame padding (no LAME gapless header): up to ~0.06 s
      expect(dur).toBeGreaterThanOrEqual(s.durationS - 0.005);
      expect(dur).toBeLessThan(s.durationS + 0.08);
    }
    expect(samples.every(Number.isFinite)).toBe(true);
    const p = peak(samples);
    expect(p, `${name} peak`).toBeGreaterThan(0.3); // audible
    expect(p, `${name} peak`).toBeLessThanOrEqual(1.0); // not clipped
    expect(rms(samples), `${name} rms`).toBeGreaterThan(0.02);
  });
});

describe("spray", () => {
  it("loops without a seam: the level across the wrap matches the level inside", async () => {
    const { samples, sampleRate } = await decode(manifest.sounds.spray!.files.ogg);
    const w = Math.round(0.02 * sampleRate);
    const wrap = new Float32Array([...samples.subarray(samples.length - w), ...samples.subarray(0, w)]);
    const inside = samples.subarray(samples.length / 2 - w, samples.length / 2 + w);
    const ratio = rms(wrap) / rms(inside);
    expect(ratio).toBeGreaterThan(0.6);
    expect(ratio).toBeLessThan(1.6);
    // no click: the jump across the wrap is no bigger than the stream's own sample-to-sample steps
    let maxStep = 0;
    for (let i = 1; i < samples.length; i++) maxStep = Math.max(maxStep, Math.abs(samples[i]! - samples[i - 1]!));
    expect(Math.abs(samples[0]! - samples[samples.length - 1]!)).toBeLessThanOrEqual(maxStep);
  });
});

describe("moat-jingle", () => {
  it("plays its four notes in order (A4 D5 E5 B4)", async () => {
    const s = manifest.sounds["moat-jingle"]!;
    expect(s.notes).toEqual(["A4", "D5", "E5", "B4"]);
    const { samples, sampleRate } = await decode(s.files.ogg);
    const onsets = [0.0, 0.17, 0.34, 0.56];
    const hz = s.notes!.map((n) => NOTE_HZ[n]!);
    onsets.forEach((t0, k) => {
      const win = samples.subarray(Math.round((t0 + 0.02) * sampleRate), Math.round((t0 + 0.14) * sampleRate));
      const energy = hz.map((f) => tone(win, sampleRate, f));
      const best = energy.indexOf(Math.max(...energy));
      expect(best, `note ${k + 1} (${s.notes![k]})`).toBe(k);
    });
  });
});
