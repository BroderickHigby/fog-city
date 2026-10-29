// The original car-radio tracks (scripts/audio/compose-radio.ts): three hip-hop and three pop
// songs, each its own station, each a whole number of bars that loops, rendered
// deterministically, finite and inside the master ceiling. The encodes themselves (Opus and MP3
// length, loudness, budget) are checked with every other track in provenance.test.ts.
import { describe, expect, it } from "vitest";
import { readJson } from "../helpers.ts";
import type { MusicManifest } from "../../scripts/audio/build-music.ts";
import { RADIO_SONGS, Score, grid, loopSeconds, renderSong } from "../../scripts/audio/compose-radio.ts";
import { Bus, SR, midi, wrapTail } from "../../scripts/audio/radio-synth.ts";
import { RADIO_STATIONS } from "../../src/audio/radio.ts";

const music = readJson<MusicManifest>("public/audio/music/manifest.json");

describe("radio songs", () => {
  it("are three hip-hop and three pop songs, each distinct in tempo, key and style", () => {
    expect(RADIO_SONGS.filter((s) => s.genre === "hip-hop").map((s) => s.style)).toEqual(["boom-bap", "trap", "West Coast bounce"]);
    expect(RADIO_SONGS.filter((s) => s.genre === "pop")).toHaveLength(3);
    for (const key of ["id", "title", "bpm", "key", "style", "seed"] as const) expect(new Set(RADIO_SONGS.map((s) => s[key])).size, key).toBe(RADIO_SONGS.length);
  });

  it("each loop is a whole number of bars, 35 to 60 s, matching its encode", () => {
    for (const song of RADIO_SONGS) {
      expect(Number.isInteger(song.bars) && song.bars % 4 === 0, song.id).toBe(true);
      const s = loopSeconds(song);
      expect(Math.abs(s - (song.bars * 4 * 60) / song.bpm), song.id).toBeLessThan(1 / SR + 1e-9);
      expect(s, song.id).toBeGreaterThan(35);
      expect(s, song.id).toBeLessThan(60);
      const track = music.tracks.find((t) => t.id === song.id);
      expect(track, song.id).toBeTruthy();
      expect(Math.abs(track!.durationS - s), song.id).toBeLessThan(0.05);
    }
  });

  it("each has its own radio station, and every station plays a shipped track", () => {
    const ids = new Set(music.tracks.map((t) => t.id));
    for (const station of RADIO_STATIONS) if (station.trackId) expect(ids.has(station.trackId), station.id).toBe(true);
    for (const t of music.tracks.filter((x) => x.context === "radio")) expect(RADIO_STATIONS.filter((s) => s.trackId === t.id), t.id).toHaveLength(1);
    expect(new Set(RADIO_STATIONS.map((s) => s.name)).size).toBe(RADIO_STATIONS.length);
    // The new stations sit before Off, so the dial still wraps Off -> Runway FM.
    expect(RADIO_STATIONS[RADIO_STATIONS.length - 1]!.id).toBe("off");
  });

  it.each(RADIO_SONGS.map((s) => [s.id, s] as const))("%s renders deterministically, finite, stereo and inside the ceiling", (_id, song) => {
    const a = renderSong(song, 2), b = renderSong(song, 2);
    expect(a.loopSamples).toBe(Math.round((2 * 4 * 60 * SR) / song.bpm / 2) * 2);
    expect(a.left.length).toBe(a.loopSamples);
    expect(Buffer.from(a.left.buffer).equals(Buffer.from(b.left.buffer))).toBe(true);
    expect(Buffer.from(a.right.buffer).equals(Buffer.from(b.right.buffer))).toBe(true);
    let peak = 0, sum = 0, diff = 0;
    for (let i = 0; i < a.left.length; i++) {
      const l = a.left[i]!, r = a.right[i]!;
      expect(Number.isFinite(l) && Number.isFinite(r)).toBe(true);
      peak = Math.max(peak, Math.abs(l), Math.abs(r));
      sum += l * l + r * r;
      diff += (l - r) ** 2;
    }
    expect(peak).toBeLessThanOrEqual(0.94);
    expect(10 * Math.log10(sum / (2 * a.left.length))).toBeGreaterThan(-30);
    expect(diff).toBeGreaterThan(0); // real stereo, not a mono copy
  }, 60_000);
});

describe("seamless loop plumbing", () => {
  it("adds the tail past the loop end back onto the start", () => {
    const ch = new Float32Array([1, 2, 3, 4, 10, 20, 30]);
    expect([...wrapTail(ch, 4)]).toEqual([11, 22, 33, 4]);
  });

  it("puts a hit nudged ahead of the first downbeat at the loop's end, not off the front", () => {
    const song = RADIO_SONGS[0]!;
    const s = new Score(song, 1);
    s.play(s.main, new Float32Array([1, 1, 1, 1]), 0, 0, 1, { nudge: -2 / SR });
    expect(s.main.l[s.loop - 2]).toBeGreaterThan(0);
    expect(s.main.l[s.loop + 1]).toBeGreaterThan(0);
    const bus = new Bus(8);
    bus.add(new Float32Array([1, 1]), -1, 1);
    expect(bus.l[0]).toBeGreaterThan(0);
  });

  it("swings whole off-beat sixteenths only, and reads step patterns and note names", () => {
    const song = RADIO_SONGS[0]!;
    const s = new Score(song, 1);
    const step = s.stepS * SR;
    expect(s.at(0, 1)).toBe(Math.round((1 + song.swing) * step));
    expect(s.at(0, 2)).toBe(Math.round(2 * step));
    expect(s.at(0, 1.5)).toBe(Math.round(1.5 * step));
    expect(grid("x.o.g...")).toEqual([[0, 1], [2, 0.7], [4, 0.35]]);
    expect([midi("C4"), midi("A4"), midi("F#3"), midi("Bb1")]).toEqual([60, 69, 54, 34]);
  });
});
